import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, PromptAssembler, PromptDocuments, ToolRegistry, UsageLedger, configSchema, registerCatalogTools, runMainAgent } from '@luoli/core';
import type { ApprovalBroker, Config, ModelRegistry } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 工具目录按需暴露在请求体与运行时层的契约（`AC-TOOL-020`、`AC-TOOL-047`、`AC-TOOL-050`–`052`、
 * 改写后的 `AC-PROMPT-003`）。手法参照 `agent.model-wiring.test.ts`（`AC-PROMPT-008` 的先例）：
 * 断言只落在真正递交到 provider 那一层的两样内容上，即 `options.prompt`（易变段中的目录文本）
 * 与 `options.tools`（本步的 tools 数组，带完整 JSON Schema）。
 *
 * 仅断言 `activeView()` / `assembleMainPrompt()` 的返回值不够：中间还隔着 `toolSetFor` 的开轮冻结、
 * `prepareStep` 的每步三重交集、`repairToolCall` 的改写，以及 AI SDK 按 `activeTools` 收缩
 * toolSet 那一步。折叠机制的每一种失效形态（摘要中报出 toolSet 里不存在的名字、已展开却
 * 发不出去、schema 重复下发）都只在这两样内容上才可观察。
 */
function candidate(id: string, run: () => unknown) {
  return { specificationVersion: 'v4' as const, provider: 'test', modelId: id, supportedUrls: {},
    doGenerate: async () => run() as never, doStream: async () => run() as never };
}

const ok = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };

function info(modelId: string, vision = false) {
  return { id: modelId, providerId: 'p1', modelId, contextWindow: 128_000, maxOutput: 4096, capabilities: JSON.stringify({ vision }),
    priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 };
}

/** 只实现 runMainAgent 实际使用的那几个方法；其余留空，多使用一个会在类型层面报错。 */
function registryFor(chains: Record<string, Array<{ model: ReturnType<typeof candidate>; info: ReturnType<typeof info> }>>): ModelRegistry {
  const down: string[] = [];
  const failures = new Map<string, number>();
  const fake = {
    chain: (alias: string) => chains[alias] ?? [],
    resolve: (alias: string) => (chains[alias] ?? chains.main!)[0]!.model as unknown as LanguageModel,
    settings: () => ({}),
    aliases: () => Object.keys(chains),
    info: (alias: string) => (chains[alias] ?? [])[0]?.info ?? null,
    supportsVision: (alias: string) => {
      const row = chains[alias]?.[0]?.info;
      return row ? (JSON.parse(row.capabilities) as { vision?: unknown }).vision === true : false;
    },
    infoByModelId: (modelId: string) => Object.values(chains).flat().find((entry) => entry.info.modelId === modelId)?.info ?? null,
    aliasOf: (modelId: string, prefer?: string) => Object.entries(chains).find(([alias, chain]) => chain.some((entry) => entry.info.modelId === modelId) && (!prefer || alias === prefer))?.[0]
      ?? Object.entries(chains).find(([, chain]) => chain.some((entry) => entry.info.modelId === modelId))?.[0] ?? null,
    markProviderDown: (modelId: string) => { down.push(modelId); },
    isDown: (entry: { id: string }) => down.includes(entry.id),
    recordFailure: (entry: { id: string }, _reason: string, limit: number) => {
      const count = (failures.get(entry.id) ?? 0) + 1;
      failures.set(entry.id, count);
      if (count < limit) return false;
      down.push(entry.id);
      return true;
    },
    recordSuccess: (entry: { id: string }) => {
      failures.delete(entry.id);
      const at = down.indexOf(entry.id);
      if (at >= 0) down.splice(at, 1);
    },
    down, failures,
  };
  return fake as unknown as ModelRegistry;
}

/** 每一轮都需要一个新的 turn 对象：`expandedTools` 随 turn 消亡，下一轮回到折叠态验证的正是这一点。 */
function makeTurn(config: Config, turnId: string): RuntimeTurnContext {
  return { turnId, key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted',
    isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [{ id: 'u', role: 'user', origin: 'trigger', parts: [{ type: 'text', text: '你好' }], tokens: 4 }],
    abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext;
}

function harness(name: string, patch: Partial<Config> = {}, maxRegistered = 40, maxCallsPerTurn = 20) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, quota: { requirePricing: false },
    provider: { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 2 },
    memory: { dir: `./data/${name}-memory` }, approval: { enabled: false }, ...patch });
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`);
  const broker: ApprovalBroker = { request: async () => true };
  const documents = new PromptDocuments(db, config.memory.dir);
  documents.ensure();
  const turn = makeTurn(config, 'turn-1');
  // registry 的 limits 与本轮 config 必须使用同一份 catalog：折叠判据走 `#limits()` getter，
  // 而 `search_tools` 的展开额度读取 `turn.config`，两处不一致时测出的是一个并不存在的部署。
  const tools = new ToolRegistry(log, broker, { maxRegistered, maxCallsPerTurn, maxConsecutiveErrors: 3, catalog: config.tools.catalog });
  registerCatalogTools(tools, { log });
  const dependencies = { config, db, tools, prompts: new PromptAssembler(), documents,
    ledger: new UsageLedger(db), log, workspace: './data', context: new ContextEngine(db, new ArchiveRepository(db), log) };
  return { db, config, turn, dependencies };
}

type PromptMessage = { role: string; content: unknown; providerOptions?: unknown };
/** provider 收到的一件 function tool：`inputSchema` 是完整 JSON Schema，折叠要节省的正是它。 */
type WireTool = { name: string; description?: string; inputSchema?: unknown };
type WireStep = { prompt: PromptMessage[]; tools: WireTool[] };

const textOf = (message: PromptMessage): string => Array.isArray(message.content)
  ? (message.content as Array<{ text?: unknown }>).map((part) => typeof part?.text === 'string' ? part.text : '').join('')
  : String(message.content);
/** 易变段即请求体最后那条 user 消息（`docs/06 §1`：TOOL CATALOG、记忆与 RUNTIME 都在其中）。 */
const volatileOf = (step: WireStep): string => textOf(step.prompt.at(-1)!);
const namesOf = (step: WireStep): string[] => step.tools.map((entry) => entry.name);
/** 整条请求体等于 instructions（prompt 中那条 system）加全部消息加 tools 数组。`AC-TOOL-050` 统计的正是这一串。 */
const wholeRequest = (step: WireStep): string => `${JSON.stringify(step.prompt)}${JSON.stringify(step.tools)}`;
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * 易变段在 step ≥ 1 时不再是最后一条消息：SDK 会把这一步的 tool-call / tool-result 追加在它之后。
 * 按 `=== RUNTIME ===` 定位，而非 `at(-1)`：定位错误会让展开之后正文未改动这条断言假通过。
 */
const volatileIn = (step: WireStep): string => textOf(step.prompt.find((message) => textOf(message).includes('=== RUNTIME ==='))!);
/** 易变段中某一块的正文（`=== NAME ===` 到下一个块标记之间）。 */
const blockOf = (text: string, name: string): string => {
  const head = `=== ${name} ===`;
  const at = text.indexOf(head);
  if (at < 0) return '';
  const rest = text.slice(at + head.length);
  const end = rest.search(/\n=== /);
  return end < 0 ? rest : rest.slice(0, end);
};
/** TOOL CATALOG 常驻段中逐条列出的工具名。折叠组那几行形如 `- [组名] N 个：…`，skill 形如 `- skill:x: …`，均不匹配。 */
const catalogNames = (text: string): string[] => [...blockOf(text, 'TOOL CATALOG').matchAll(/^- ([a-z_][a-z_0-9]*): /gm)].map((match) => match[1]!);
/** RUNTIME 的可用工具行中的名字串（折叠计数后缀位于 `；` 之后，不计入）。 */
const runtimeToolNames = (text: string): string[] => (/^可用工具：([^；\n]*)/m.exec(blockOf(text, 'RUNTIME'))?.[1] ?? '').split(', ').filter(Boolean);

const toolCall = (name: string, input: unknown, id = `c-${name}`) => ({ ...ok,
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });

/**
 * 捕获每一步的请求体，并按剧本决定该步返回什么。
 *
 * 剧本项是函数而非静态数据：轮内的那几件事（MCP reconcile 移除一台 server、新增一台、载入一个
 * 带 `allowed-tools` 的 skill）都需要发生在某一步的中间，而 `doGenerate` 正是该位置：
 * 它排在本步 `prepareStep` 之后、下一步 `prepareStep` 之前，与在某个工具的 execute 中修改 turn 对象
 * 时序等价，但无需为此向目录额外加入一个工具（多一个工具即多一份描述，`AC-TOOL-050` 的计数
 * 断言会随之漂移）。
 */
function recorder(steps: WireStep[], script: Array<() => unknown> = []) {
  return { model: { ...candidate('m1', () => ok),
    doGenerate: async (options: { prompt: PromptMessage[]; tools?: WireTool[] }) => {
      steps.push({ prompt: options.prompt, tools: options.tools ?? [] });
      return (script[steps.length - 1]?.() ?? ok) as never;
    } } as ReturnType<typeof candidate>, info: info('m1') };
}

const logRows = (db: ReturnType<typeof openDatabase>): Array<{ kind: string; summary: string; data: string | null }> =>
  db.prepare('SELECT kind,summary,data_json AS data FROM log_events ORDER BY rowid').all() as Array<{ kind: string; summary: string; data: string | null }>;

/** 折叠工具 schema 中那个唯一的属性名，断言其完全未下发即统计它的出现次数。 */
const ISSUE_PROP = 'luoliIssueTitleMarker';
const LIST_PROP = 'luoliIssueStateMarker';
/** 每个折叠工具一段唯一的描述：断言其不出现在 TOOL CATALOG 正文中要统计的是它，而不是名字（名字在摘要行中）。 */
const ISSUE_DESC = '甲：在仓库里开一个新的工单并把正文写进去';
const LIST_DESC = '乙：把仓库里现有的工单按状态列出来';

function registerGithub(tools: ToolRegistry): void {
  tools.registerExternal({ name: 'mcp__gh__create_issue', description: ISSUE_DESC,
    inputSchema: z.object({ [ISSUE_PROP]: z.string() }), minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
  tools.registerExternal({ name: 'mcp__gh__list_issues', description: LIST_DESC,
    inputSchema: z.object({ [LIST_PROP]: z.string() }), minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
}
/** 常驻侧的对照工具（`source: 'builtin'` ⇒ 不被 `deferExternal` 折叠）。 */
function registerResident(tools: ToolRegistry, name: string, description: string): void {
  tools.register({ name, description, inputSchema: z.object({}),
    policy: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' }, sourcePriority: 100, execute: () => ({ ok: true }) });
}

describe('deferred tool catalog · 请求体层', () => {
  /**
   * `AC-TOOL-047` 第一段：折叠工具在第 0 步的请求体中只保留一个名字。
   *
   * 三处各自独立，缺任意一处折叠即失效：目录正文不得包含它的描述、tools 数组不得包含它的 schema、
   * 摘要行必须给出名字、数量、组名与展开指引（只给名字而不给出路时，模型会直接调用并撞上
   * `NoSuchToolError`，`docs/14 §3 T20 ①`）。
   */
  it('第 0 步：折叠工具不在目录正文、schema 一个字节都不在 tools 数组里，只留一行组摘要', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-folded-step0');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const step = steps[0]!;
    // 折叠的两个位于开轮冻结的 toolSet 内（`active()` 等于常驻并集折叠），只是不在本步的
    // `activeTools` 中；SDK 会按 `activeTools` 再收缩一次，因此 provider 收到的数组中不含它们。
    expect(namesOf(step)).toEqual(['search_tools']);
    const wire = JSON.stringify(step.tools);
    expect(countOf(wire, ISSUE_PROP)).toBe(0);
    expect(countOf(wire, LIST_PROP)).toBe(0);
    const block = volatileOf(step);
    expect(block).not.toContain(ISSUE_DESC);
    expect(block).not.toContain(LIST_DESC);
    // 组摘要那两行是模型得知仍有工具可检索的唯一入口。
    expect(block).toContain('【折叠工具 · 共 2 个，本步不可直接调用；用 search_tools 按关键词或名字展开】');
    expect(block).toContain('- [mcp:gh] 2 个：mcp__gh__create_issue, mcp__gh__list_issues');
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-047` 第二、三段：检索 → 下一步确实可调用 → 下一轮回到折叠态。
   *
   * 下一轮回到折叠态使用的是同一个 registry 加一个新的 turn 对象：展开集只存在于
   * `turn.expandedTools`，不持久化（持久化会产生 server 已删除而展开集仍记录的陈旧状态，
   * `docs/05 §3.12`）。更换 registry 就测不到这条，更换之后连折叠集都是新的。
   */
  it('检索命中之后那一步 schema 才下发，下一轮第一步回到折叠态', async () => {
    const { db, config, turn, dependencies } = harness('catalog-wiring-expand-then-reset');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const registry = registryFor({ main: [recorder(steps, [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] })])] });
    await runMainAgent(turn, { ...dependencies, registry });
    expect(namesOf(steps[0]!)).toEqual(['search_tools']);
    // 命中的那个进入 activeTools，未命中的仍保持折叠：检索是按需的，而非一次性全部放开。
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    const expanded = steps[1]!.tools.find((entry) => entry.name === 'mcp__gh__create_issue')!;
    expect(JSON.stringify(expanded.inputSchema)).toContain(ISSUE_PROP);
    expect(expanded.description).toBe(ISSUE_DESC);
    expect(JSON.stringify(steps[1]!.tools)).not.toContain(LIST_PROP);
    const expandedEvents = logRows(db).filter((row) => row.kind === 'tool.expanded');
    expect(expandedEvents).toHaveLength(1);
    expect(expandedEvents[0]!.summary).toBe('search_tools: 1 matched, 1 expanded');
    // 下一轮：同一个 registry、同一个 ToolRegistry，只换 turn 对象。
    const next: WireStep[] = [];
    await runMainAgent(makeTurn(config, 'turn-2'), { ...dependencies, registry: registryFor({ main: [recorder(next)] }) });
    expect(namesOf(next[0]!)).toEqual(['search_tools']);
    expect(JSON.stringify(next[0]!.tools)).not.toContain(ISSUE_PROP);
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-050`：同一份 description 不得在一条请求体中出现两次。
   *
   * 两处各发一份时成本高的是易变段那一份（每 step 重发），而描述的权威副本本就是 tools 数组那一份
   * （且带完整 JSON Schema）。统计全文出现次数而非 token 数：数值会随描述文本变动而失效，
   * 结构断言等价且稳定。
   */
  it('residentDescriptions=false：常驻描述在整条请求体里至多出现一次', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-dedup', { tools: { catalog: { residentDescriptions: false } } } as Partial<Config>);
    const alphaDesc = '甲工具：把一个东西挪到另一个地方';
    const betaDesc = '乙工具：读一段字节然后原样交回';
    registerResident(dependencies.tools, 'alpha', alphaDesc);
    registerResident(dependencies.tools, 'beta', betaDesc);
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const whole = wholeRequest(steps[0]!);
    for (const description of [alphaDesc, betaDesc]) expect(countOf(whole, description)).toBe(1);
    // 元工具自己也是常驻的，同一条规矩。
    const meta = steps[0]!.tools.find((entry) => entry.name === 'search_tools')!;
    expect(countOf(whole, meta.description!)).toBe(1);
    // 折叠的那两个：schema 与描述在整条请求体中均为 0 次，只有名字出现在摘要行。
    expect(countOf(whole, ISSUE_PROP)).toBe(0);
    expect(countOf(whole, ISSUE_DESC)).toBe(0);
    expect(countOf(whole, LIST_DESC)).toBe(0);
    // 常驻段压缩为一行名字清单，并保留常驻工具字样：KERNEL 中引用 TOOL CATALOG 的常驻部分
    // 需要一个可对应的锚点。
    expect(volatileOf(steps[0]!)).toContain('常驻工具（可直接调用）：alpha, beta, search_tools');
    closeDatabase(db);
  });

  it('residentDescriptions=true（默认）：常驻段逐行带描述，于是同一份描述发两遍', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-dedup-off');
    const alphaDesc = '甲工具：把一个东西挪到另一个地方';
    registerResident(dependencies.tools, 'alpha', alphaDesc);
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    expect(volatileOf(steps[0]!)).toContain(`- alpha: ${alphaDesc}`);
    expect(volatileOf(steps[0]!)).not.toContain('常驻工具（可直接调用）：');
    // 共两份：TOOL CATALOG 一行与 tools 数组一件。这正是 `residentDescriptions=false` 要消除的那一份。
    expect(countOf(wholeRequest(steps[0]!), alphaDesc)).toBe(2);
    closeDatabase(db);
  });

  /** `AC-TOOL-051` 前半：展开集在轮内只增不减，第二次检索不得覆盖第一次的结果。 */
  it('一轮内检索两次：第一次展开的工具在第二次之后仍在 activeTools 里', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-monotonic');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('search_tools', { names: ['mcp__gh__list_issues'] }, 'c2')];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    expect(namesOf(steps[2]!)).toEqual(['search_tools', 'mcp__gh__create_issue', 'mcp__gh__list_issues']);
    expect([...turn.expandedTools!]).toEqual(['mcp__gh__create_issue', 'mcp__gh__list_issues']);
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-051` 与改写后的 `AC-PROMPT-003`：先扩张后收窄、收窄优先，且每一步的键集恒等于
   * `(常驻 ∪ 已展开) ∩ skill 允许集`，并始终是开轮时刻冻结的 toolSet 的子集。
   *
   * 三件事合并验证是因为它们只有一个共同实现点（`prepareStep` 的三重过滤）：分开验证时，
   * 收窄生效但顺序颠倒这一档（先按收窄计算再并入展开集）会让三条断言各自通过。
   */
  it('skill 收窄压过展开，search_tools 因豁免留下并如实报 narrowed', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-narrowed');
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    // 开轮冻结的 toolSet 即此刻的 `active()`。每一步的键集都必须是它的子集，否则 AI SDK 直接报错。
    const frozen = new Set(dependencies.tools.activeNames('trusted', { turn, workspace: './data', agentKind: 'main' }));
    const steps: WireStep[] = [];
    const script = [
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c2'),
      // 载入一个 `allowed-tools: [bash]` 的 skill。收窄自下一步起生效，而本步这次检索的
      // `execute()` 排在它之后，因此同一次调用即可观察到命中但不可调用这一档。
      () => { turn.skillAllowedTools = new Set(['bash']); return toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c3'); },
    ];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect(namesOf(steps[0]!)).toEqual(['bash', 'search_tools']);
    expect(namesOf(steps[1]!)).toEqual(['bash', 'search_tools', 'mcp__gh__create_issue']);
    // 收窄之后：已展开的 MCP 工具被过滤（展开改变的是可见性而非权限），`search_tools` 与
    // 白名单中的 bash 保留。缺少 `search_tools` 即意味着收窄同时关闭了检索通道。
    expect(namesOf(steps[3]!)).toEqual(['bash', 'search_tools']);
    for (const step of steps) for (const name of namesOf(step)) expect(frozen.has(name)).toBe(true);
    // 被拦截的必须如实报告 narrowed：否则模型会对着一个已展开却不可调用的工具重试至步数耗尽。
    // 按 `type` 一并筛选：同一个 `toolCallId` 在 delta 中有配对的两条（tool-call 与 tool-result）。
    const matches = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { value?: { matches?: Array<{ name: string; status: string }> } } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c3')!.output!.value!.matches!;
    expect(matches).toEqual([{ name: 'mcp__gh__create_issue', description: ISSUE_DESC, group: 'mcp:gh', status: 'narrowed' }]);
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-051` 的 unregister 方向：移除一台 server 后，那些名字在下一步自动退出可见集，整轮不抛错。
   *
   * `toolSet` 在开轮时冻结，而 `activeNamesForStep` 每步重新计算，本方向属于新集合小于冻结集，
   * 向 SDK 报出一个已不存在的名字即产生运行时报错。
   */
  it('轮中摘掉一台 MCP server：已展开的名字下一步掉出 tools 数组，整轮不抛', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-unregister');
    registerGithub(dependencies.tools);
    // 保留一个其他来源的折叠工具：`unregisterBySource('mcp')` 之后若折叠集完全为空，
    // `search_tools` 自身的 `available()` 也随之为假、整份目录回退为常驻（`docs/05 §3.12` 不变量 3），
    // 该情形下 `options.tools` 恒为空数组，本用例要断言的那些名字已退出就无法观察。
    dependencies.tools.registerExternal({ name: 'custom_helper', description: '丁：模型自撰写的那一个',
      inputSchema: z.object({}), minRole: 'limited', source: 'custom', execute: () => ({ ok: true }) });
    const steps: WireStep[] = [];
    const script = [
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => { dependencies.tools.unregisterBySource('mcp'); return toolCall('search_tools', { query: 'gh' }, 'c2'); },
    ];
    await expect(runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) })).resolves.toBe('ok');
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    // 展开集仍记录着它（`expandedTools` 只增不减），但注册表中已不存在该工具。
    expect(turn.expandedTools!.has('mcp__gh__create_issue')).toBe(true);
    expect(namesOf(steps[2]!)).toEqual(['search_tools']);
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-051` 的 register 方向：轮内新增一台 server，它不进入本轮的 tools 数组，但也不得抛错。
   *
   * 这是两个方向中更危险的一个：新工具确实会被 `search_tools` 检索到并记入 `expandedTools`
   * （检索域是实时的注册表），于是 `activeNamesForStep` 会把一个开轮冻结的 toolSet 中不存在的键报给
   * SDK，`prepareStep` 末尾那道 `name in toolSet` 交集正是为此而设。
   *
   * ⚠ 本用例无法拦截那道交集被删除的情形，这不是用例写得宽松：ai@7.0.65 的 `filterActiveTools`
   * 是纯交集（`Object.entries(tools).filter(([n]) => activeTools.includes(n))`），多报的名字被静默
   * 丢弃，而 `activeTools` 本身不经由任何回调或日志暴露（`onStepStart` 只带 provider / modelId /
   * messages / instructions），因此那道交集在该 SDK 版本上没有任何外部可观察行为：
   * 实测删除它后全量 1048 条用例无一失败。所以本方向能断言的只有三件：整轮不抛错、新增的那个
   * 完全不下发，以及它仍被记入展开集（最后一件正是风险来源，缺少它本用例就退化为
   * 一个从未被检索到的工具未出现这类同义反复）。
   */
  it('轮中新挂一个工具：它不进本轮 tools 数组，也不让 SDK 报 activeTools/toolSet 脱节', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-register-midturn');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => {
      dependencies.tools.registerExternal({ name: 'mcp__jira__create_ticket', description: '丙：新挂上来的那台 server',
        inputSchema: z.object({ luoliTicketMarker: z.string() }), minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
      return toolCall('search_tools', { names: ['mcp__jira__create_ticket'] }, 'c1');
    }];
    await expect(runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) })).resolves.toBe('ok');
    // 检索确实展开了它，因此下一步那道交集是唯一阻止 SDK 报错的机制，而非一句不会发生的推断。
    expect(turn.expandedTools!.has('mcp__jira__create_ticket')).toBe(true);
    // 而 `search_tools` 对它返回 `status:'expanded'`，这是本方向尚存的一处不实描述（docs/07 §2.2）：
    // 下一步即可直接调用对一个开轮冻结的 toolSet 中不存在的键并不成立，它在本轮永远无法下发。
    // 固定这条断言是为了在真正修复（重建 toolSet 或把新增名字排除出检索域）时它会失败，而不是
    // 让两个方向都成立这一说法继续留在文档中。
    const matches = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { value?: { matches?: unknown } } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c1')!.output!.value!.matches;
    expect(matches).toEqual([{ name: 'mcp__jira__create_ticket', description: '丙：新挂上来的那台 server', group: 'mcp:jira', status: 'expanded' }]);
    expect(namesOf(steps[1]!)).toEqual(['search_tools']);
    expect(JSON.stringify(steps[1]!.tools)).not.toContain('luoliTicketMarker');
    closeDatabase(db);
  });

  /**
   * 改写后的 `AC-PROMPT-003` 的正向部分：开轮时刻正文中的工具清单恰好等于本步 tools 数组，
   * 不多不少；而展开之后正文有意不再跟随变化。
   *
   * 后半句正是这条 AC 被改写的原因。提示词每轮只装配一次（`assembleMainPrompt` 在开轮时刻执行，
   * `prepareStep` 从不返回 `instructions`），因此正文与本 step 的 `activeTools` 一致在展开那一步
   * 之后必然不成立；要使其成立就需每步重装，从而每步重发整个易变段，而那正是折叠要消除的开销。
   * 做出这一取舍并不意味着模型看不到已展开的工具：描述与完整 schema 已在 tools 数组中（上一条用例
   * 断言的正是它）。因此这里断言的是正文完全未改动，而不是正文跟随 tools 数组变化。
   */
  it('第 0 步：正文的工具清单与 tools 数组无多无少；展开之后正文一个字节都不动', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-prompt003');
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1')];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    const opening = volatileOf(steps[0]!);
    // 双向断言不多不少：目录正文逐条列出的名字恰为本步 tools 数组，顺序也一致
    // （两处同源于开轮时那次 `activeView()`）。step 0 的 `expandedTools` 恒为空，因此此刻它即常驻集。
    expect(catalogNames(opening)).toEqual(['bash', 'search_tools']);
    expect(catalogNames(opening)).toEqual(namesOf(steps[0]!));
    // 折叠的两个只在摘要行中出现名字：它们不在 activeTools 中，因此也不得进入逐条清单。
    expect(blockOf(opening, 'TOOL CATALOG')).toContain('- [mcp:gh] 2 个：mcp__gh__create_issue, mcp__gh__list_issues');
    expect(catalogNames(opening)).not.toContain('mcp__gh__create_issue');
    // 展开之后：tools 数组增加一个（描述与 schema 都在其中），而正文逐字节不变，
    // 连折叠摘要中的数量也未变化，它仍把刚展开的那个计入折叠。
    expect(namesOf(steps[1]!)).toEqual(['bash', 'search_tools', 'mcp__gh__create_issue']);
    expect(volatileIn(steps[1]!)).toBe(opening);
    closeDatabase(db);
  });

  /**
   * 改写后的 `AC-PROMPT-003` 的回归部分：关闭折叠后与按需暴露之前逐字节一致。
   * 折叠集为空时 `search_tools` 的 `available()` 也为假，整个元工具不进入目录。
   */
  it('deferExternal=false：MCP 工具逐条回到目录正文与 tools 数组，一行折叠摘要都没有', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-defer-off', { tools: { catalog: { deferExternal: false } } } as Partial<Config>);
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    expect(namesOf(steps[0]!)).toEqual(['mcp__gh__create_issue', 'mcp__gh__list_issues']);
    const wire = JSON.stringify(steps[0]!.tools);
    expect(wire).toContain(ISSUE_PROP);
    expect(wire).toContain(LIST_PROP);
    const block = volatileOf(steps[0]!);
    expect(block).toContain(`- mcp__gh__create_issue: ${ISSUE_DESC}`);
    expect(block).toContain(`- mcp__gh__list_issues: ${LIST_DESC}`);
    expect(block).not.toContain('折叠工具');
    // 折叠集为空时元工具自身也不出现（`docs/05 §3.12` 不变量 3）。
    expect(block).not.toContain('search_tools 按关键词');
    closeDatabase(db);
  });

  /**
   * 改写后的 `AC-PROMPT-003`：RUNTIME 的可用工具行等于开轮常驻集，折叠部分只报出数量。
   * 默认 `includeToolCatalog=true` 时该行有意不出现（与 TOOL CATALOG 的常驻段完全重复，
   * 而它在易变段每步重发），因此验证它需要先关闭目录。
   */
  it('includeToolCatalog=false：RUNTIME 那行只列常驻工具，折叠的只报个数', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-runtime-line', { prompt: { includeToolCatalog: false } } as Partial<Config>);
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const block = volatileOf(steps[0]!);
    expect(block).toContain('可用工具：bash, search_tools；另有 2 个折叠工具，使用 search_tools 检索');
    // 不多不少这一判据在该档位落在 RUNTIME 那一行上（关闭目录后它是唯一的工具清单）。
    expect(runtimeToolNames(block)).toEqual(namesOf(steps[0]!));
    expect(block).not.toContain('=== TOOL CATALOG ===');
    // 关闭目录后折叠组摘要也随之消失，该后缀于是成为模型得知仍有工具可检索的唯一入口。
    expect(block).not.toContain('【折叠工具');
    expect(namesOf(steps[0]!)).toEqual(['bash', 'search_tools']);
    closeDatabase(db);
  });
});

/**
 * 自愈钩子（`docs/05 §3.12` 的自愈段）。折叠使模型调用不可下发的工具从罕见幻觉变为常规
 * 事件，仅靠提示词引导等于依赖模型自行想到去检索；`repairToolCall` 把该次调用改写为
 * `search_tools({names:[原名]})`，代价与模型自行先检索一次相同（多一个 step）。
 *
 * 三条判据都用于防止死循环，因此各有一个用例：若改写为检索而检索又不推进状态，
 * 就会形成调用 X → NoSuchToolError → 改写 → 检索原地返回 → 再调用 X 的循环，直至耗尽步数上限。
 */
describe('deferred tool catalog · repairToolCall 自愈', () => {
  it('硬调折叠工具：改写成一次检索，下一步那个工具的 schema 真的下发', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-repair');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c1')];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    const interesting = logRows(db).filter((row) => ['tool.repaired', 'tool.expanded', 'tool.call'].includes(row.kind));
    expect(interesting.map((row) => row.kind)).toEqual(['tool.repaired', 'tool.expanded', 'tool.call']);
    expect(interesting[0]!.summary).toBe('mcp__gh__create_issue → search_tools');
    expect(JSON.parse(interesting[0]!.data!)).toMatchObject({ tool: 'mcp__gh__create_issue', into: 'search_tools', reason: 'deferred_not_expanded' });
    // 上下文中保留的是改写后的那次调用：模型下一轮读到的是已检索过该工具，而不是一次不存在的调用。
    const call = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolName?: string; input?: unknown }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-call')!;
    expect(call.toolName).toBe('search_tools');
    expect(call.input).toEqual({ names: ['mcp__gh__create_issue'] });
    const expanded = steps[1]!.tools.find((entry) => entry.name === 'mcp__gh__create_issue')!;
    expect(JSON.stringify(expanded.inputSchema)).toContain(ISSUE_PROP);
    closeDatabase(db);
  });

  /**
   * 防死循环闸 ①：被 skill 收窄拦截的只改写一次。`search_tools` 对它返回 `status:'narrowed'`
   * 但仍记入 `expandedTools`，这一笔正是该闸的另一半（见 `tools/catalog-meta.ts` 中的
   * 注释）：不记录时第二次强行调用又会被改写为同一次检索，形成循环。
   */
  it('skill 收窄挡着的折叠工具：只改写一次，第二次硬调落回 NoSuchToolError', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-repair-once');
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    turn.skillAllowedTools = new Set(['bash']);
    const steps: WireStep[] = [];
    const script = [() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c1'),
      () => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'y' }, 'c2')];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect(logRows(db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(1);
    // 收窄仍在拦截，因此展开之后它依旧无法下发，但它已进入展开集，第二次不再改写。
    expect(turn.expandedTools!.has('mcp__gh__create_issue')).toBe(true);
    expect(namesOf(steps[1]!)).toEqual(['bash', 'search_tools']);
    const results = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { type?: string; value?: unknown } }> }>)
      .flatMap((message) => message.parts).filter((part) => part.type === 'tool-result');
    const failed = results.find((part) => part.toolCallId === 'c2')!;
    expect(failed.output!.type).toBe('error-text');
    expect(String(failed.output!.value)).toContain('NoSuchToolError');
    closeDatabase(db);
  });

  /**
   * 防死循环闸 ②：展开额度用满时一次都不改写。该档位下 `search_tools` 返回 `expansion_limit`
   * 且不写入 `expandedTools`，因此闸 ① 无法拦住它；而它的 hint 是使用 names 精确指定，改写产生的
   * 调用本身就是 `names:[X]`，模型按 hint 操作同样没有出路，是三者中唯一会无限循环的。
   */
  it('maxExpandedPerTurn 用满：硬调另一个折叠工具时一条 tool.repaired 都不落', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-repair-budget', { tools: { catalog: { maxExpandedPerTurn: 1 } } } as Partial<Config>);
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('mcp__gh__list_issues', { [LIST_PROP]: 'open' }, 'c2')];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect([...turn.expandedTools!]).toEqual(['mcp__gh__create_issue']);
    expect(logRows(db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(0);
    const failed = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { type?: string; value?: unknown } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c2')!;
    expect(String(failed.output!.value)).toContain('NoSuchToolError');
    closeDatabase(db);
  });

  /**
   * 防死循环闸 ⓿：同一个名字在本轮只改写一次。
   *
   * ①②③ 各自对应一种检索无法推进状态的成因，而成因不止这三种：`search_tools` 自身也可能在
   * `admit()` 处失败，包括 `tools.maxCallsPerTurn` 用满（本例）、运维把它的 `approval` 覆盖为 `always`
   * 而审批被拒、轮内连续失败达到 `maxConsecutiveErrors` 之前的那几次。这些档位一律不写入
   * `expandedTools`，因此闸 ① 永远拦不住第二次。缺少 ⓿ 时实测同一个折叠工具被连续改写 11 次，
   * 仅靠 `maxSteps` 兜底，即 11 次无效的模型调用。按名字判定一次，成因有多少种都无需枚举。
   */
  it('search_tools 自己在 admit() 上失败：同一个名字只改写一次，之后落回 NoSuchToolError', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-repair-admit-fail', {}, 40, 1);
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    // 第 0 步用掉 `maxCallsPerTurn=1` 的额度（展开另一个工具），此后每一步都强行调用同一个折叠工具。
    const script: Array<() => unknown> = [() => toolCall('search_tools', { names: ['mcp__gh__list_issues'] }, 'c0')];
    for (let index = 1; index < 6; index += 1) script.push(() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, `c${index}`));
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect(logRows(db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(1);
    // 改写产生的那次检索自身撞上额度限制，因此展开集中只有第 0 步那一个，闸 ① 因而拦不住第二次。
    expect([...turn.expandedTools!]).toEqual(['mcp__gh__list_issues']);
    const results = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { type?: string; value?: unknown } }> }>)
      .flatMap((message) => message.parts).filter((part) => part.type === 'tool-result');
    expect(JSON.stringify(results.find((part) => part.toolCallId === 'c1')!.output!.value)).toContain('tool_call_limit_exceeded');
    for (const id of ['c2', 'c3', 'c4', 'c5']) {
      expect(String(results.find((part) => part.toolCallId === id)!.output!.value)).toContain('NoSuchToolError');
    }
    closeDatabase(db);
  });

  /**
   * 防死循环闸 ③（另一半）：完全虚构的名字不改写。把一个不存在的名字送去检索只会得到空结果，
   * 而模型会认为自己已经查找过；一句明确的 `NoSuchToolError` 优于一次看似有进展的往返。
   *
   * 附带记录一项实测：SDK 的那句错误文本会把整份 active 名单写入上下文（`Available tools: …`）。
   * 折叠节省的开销在该档位会部分抵消，因此不改写的档位应尽可能窄。
   */
  it('幻觉工具名不改写，照旧走 NoSuchToolError', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-repair-hallucinated');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, [() => toolCall('nope_nope', {}, 'c1')])] }) });
    expect(logRows(db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(0);
    expect(turn.expandedTools).toBeUndefined();
    const failed = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { type?: string; value?: unknown } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c1')!;
    expect(failed.output!.type).toBe('error-text');
    expect(String(failed.output!.value)).toBe(`AI_NoSuchToolError: Model tried to call unavailable tool 'nope_nope'. Available tools: search_tools.`);
    closeDatabase(db);
  });
});

/**
 * `AC-TOOL-020`：目录被 `tools.maxRegistered` 静默截断这件事必须明确告知。
 *
 * 三件事各自独立：RUNTIME 中的那一行（面向模型）、`tool.registry_truncated` warn（面向运维），
 * 以及折叠摘要中只允许出现截断后的名字（摘要中报出 `toolSet` 里不存在的名字时，模型展开它即产生
 * AI SDK 层的运行时报错）。此前只实现了中间那一件，模型对自身缺少哪些工具完全不知情。
 */
describe('deferred tool catalog · maxRegistered 截断告知', () => {
  /** 排序为 `sourcePriority desc, name asc`，因此 `maxRegistered=2` 保留 search_tools(80) 与 aaa(40)。 */
  function registerThree(tools: ToolRegistry): void {
    for (const suffix of ['aaa', 'bbb', 'ccc']) {
      tools.registerExternal({ name: `mcp__gh__${suffix}`, description: `折叠 ${suffix}`,
        inputSchema: z.object({}), minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
    }
  }

  it('截断时 RUNTIME 有告知行、库里有 warn，且折叠摘要只列留下来的名字', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-truncated', {}, 2);
    registerThree(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const block = volatileOf(steps[0]!);
    expect(block).toContain('工具目录已截断：共注册 4 个，按来源优先级仅保留前 2 个，其余本轮不可用（tools.maxRegistered）。');
    // 恰好一条：`#eligible()` 会被目录视图、`prepareStep` 的每步取数、`repairToolCall` 反复调用，
    // 而 warn 只挂在 `active()` 上（`toolSetFor` 开轮那一次）；放在共用的过滤链中会按调用
    // 次数重复输出，而运维需要的是本轮发生截断这一条记录。
    const warns = logRows(db).filter((row) => row.kind === 'tool.registry_truncated');
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]!.data!)).toMatchObject({ total: 4, visible: 2 });
    // 被截断的工具一个都不得进入摘要：模型按摘要检索，展开得到的会是冻结 toolSet 中不存在的键。
    expect(block).toContain('- [mcp:gh] 1 个：mcp__gh__aaa');
    expect(block).not.toContain('mcp__gh__bbb');
    expect(block).not.toContain('mcp__gh__ccc');
    expect(namesOf(steps[0]!)).toEqual(['search_tools']);
    closeDatabase(db);
  });

  /**
   * 该行不受 `prompt.runtimeBlock.show.*` 控制：那三个开关决定是否显示某类状态，
   * 而这一行说明的是本轮部分工具根本不存在。三个全部关闭后它仍然存在。
   */
  it('三个 runtimeBlock 开关全关掉，截断告知行照样在', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-truncated-show-off',
      { prompt: { runtimeBlock: { showQuota: false, showContextWatermark: false, showWorkspace: false } } } as Partial<Config>, 2);
    registerThree(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const block = volatileOf(steps[0]!);
    expect(block).toContain('工具目录已截断：共注册 4 个，按来源优先级仅保留前 2 个，其余本轮不可用（tools.maxRegistered）。');
    // 确认开关确实生效，否则上面那条断言不具备说明力。
    expect(block).not.toContain('上下文容量：');
    expect(block).not.toContain('工作目录：');
    closeDatabase(db);
  });
});
