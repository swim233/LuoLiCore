import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, PromptAssembler, PromptDocuments, ToolRegistry, UsageLedger, configSchema, registerCatalogTools, runMainAgent } from '@luoli/core';
import type { ApprovalBroker, Config, ModelRegistry } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 工具目录按需暴露的**请求体 / 运行时层**契约（`AC-TOOL-020`、`AC-TOOL-047`、`AC-TOOL-050`–`052`、
 * 改写后的 `AC-PROMPT-003`）。手法照 `agent.model-wiring.test.ts`（`AC-PROMPT-008` 的先例）：
 * 断言只落在**真正递到 provider 那一层**的两样东西上 —— `options.prompt`（易变段里的目录文本）
 * 与 `options.tools`（本步的 tools 数组，带完整 JSON Schema）。
 *
 * 只断言 `activeView()` / `assembleMainPrompt()` 的返回值不够：中间还隔着 `toolSetFor` 的开轮冻结、
 * `prepareStep` 的每步三重交集、`repairToolCall` 的改写、以及 AI SDK 自己按 `activeTools` 收缩
 * toolSet 那一步 —— 折叠这套机制的每一个失效形态（摘要里报了个 toolSet 里没有的名字、展开了却
 * 发不出去、schema 白发一遍）都只在这两样东西上才看得见。
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

/** 只实现 runMainAgent 真正用到的那几个方法；其余留空，多用一个就会在类型上报出来。 */
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

/** 每一轮都要一个**新的** turn 对象：`expandedTools` 随 turn 消亡，「下一轮回到折叠态」测的就是这一条。 */
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
  // registry 的 limits 与本轮 config 必须给**同一份** catalog：折叠判据走 `#limits()` getter，
  // 而 `search_tools` 的展开额度读 `turn.config` —— 两处不一致时测出来的是一个不存在的部署。
  const tools = new ToolRegistry(log, broker, { maxRegistered, maxCallsPerTurn, maxConsecutiveErrors: 3, catalog: config.tools.catalog });
  registerCatalogTools(tools, { log });
  const dependencies = { config, db, tools, prompts: new PromptAssembler(), documents,
    ledger: new UsageLedger(db), log, workspace: './data', context: new ContextEngine(db, new ArchiveRepository(db), log) };
  return { db, config, turn, dependencies };
}

type PromptMessage = { role: string; content: unknown; providerOptions?: unknown };
/** provider 收到的一件 function tool：`inputSchema` 是**完整 JSON Schema**，折叠要省的就是它。 */
type WireTool = { name: string; description?: string; inputSchema?: unknown };
type WireStep = { prompt: PromptMessage[]; tools: WireTool[] };

const textOf = (message: PromptMessage): string => Array.isArray(message.content)
  ? (message.content as Array<{ text?: unknown }>).map((part) => typeof part?.text === 'string' ? part.text : '').join('')
  : String(message.content);
/** 易变段 = 请求体最后那条 user 消息（`docs/06 §1`：TOOL CATALOG + 记忆 + RUNTIME 都在里面）。 */
const volatileOf = (step: WireStep): string => textOf(step.prompt.at(-1)!);
const namesOf = (step: WireStep): string[] => step.tools.map((entry) => entry.name);
/** 「整条请求体」= instructions（prompt 里那条 system）+ 全部消息 + tools 数组。`AC-TOOL-050` 数的就是这一串。 */
const wholeRequest = (step: WireStep): string => `${JSON.stringify(step.prompt)}${JSON.stringify(step.tools)}`;
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * 易变段在 step ≥ 1 时**不再是最后一条消息** —— SDK 把这一步的 tool-call / tool-result 追在它后面。
 * 按 `=== RUNTIME ===` 认那一条，而不是 `at(-1)`：认错了「展开之后正文一个字节都没动」会假绿。
 */
const volatileIn = (step: WireStep): string => textOf(step.prompt.find((message) => textOf(message).includes('=== RUNTIME ==='))!);
/** 易变段里某一块的正文（`=== NAME ===` 到下一个块标记之间）。 */
const blockOf = (text: string, name: string): string => {
  const head = `=== ${name} ===`;
  const at = text.indexOf(head);
  if (at < 0) return '';
  const rest = text.slice(at + head.length);
  const end = rest.search(/\n=== /);
  return end < 0 ? rest : rest.slice(0, end);
};
/** TOOL CATALOG 常驻段里**逐条**列出的工具名。折叠组那几行是 `- [组名] N 个：…`，skill 是 `- skill:x: …`，都不匹配。 */
const catalogNames = (text: string): string[] => [...blockOf(text, 'TOOL CATALOG').matchAll(/^- ([a-z_][a-z_0-9]*): /gm)].map((match) => match[1]!);
/** RUNTIME 的「可用工具」行里那串名字（折叠计数后缀在 `；` 之后，不算在内）。 */
const runtimeToolNames = (text: string): string[] => (/^可用工具：([^；\n]*)/m.exec(blockOf(text, 'RUNTIME'))?.[1] ?? '').split(', ').filter(Boolean);

const toolCall = (name: string, input: unknown, id = `c-${name}`) => ({ ...ok,
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });

/**
 * 抓每一步的请求体，并按剧本决定这一步回什么。
 *
 * 剧本项是函数而不是死数据：轮**中**的那几件事（MCP reconcile 摘掉一台 server、新挂一台、载入一个
 * 带 `allowed-tools` 的 skill）都要发生在某一步的**中间**，而 `doGenerate` 正是那个位置 ——
 * 它排在本步 `prepareStep` 之后、下一步 `prepareStep` 之前，与「某个工具的 execute 里改 turn 对象」
 * 在时序上等价，但不必为此往目录里多塞一个工具（多一个工具就多一份描述，`AC-TOOL-050` 那条计数
 * 断言会跟着漂）。
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

/** 折叠工具的 schema 里那个独一无二的属性名 —— 断言「一个字节都没发出去」就是数它。 */
const ISSUE_PROP = 'luoliIssueTitleMarker';
const LIST_PROP = 'luoliIssueStateMarker';
/** 每个折叠工具一段独一无二的描述：断言「不在 TOOL CATALOG 正文里」要数的是它，而不是名字（名字在摘要行里）。 */
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
   * `AC-TOOL-047` 第一段：**折叠工具在第 0 步的请求体里只剩一个名字。**
   *
   * 三处各自独立，缺一个折叠就白折：目录正文不许有它的描述、tools 数组不许有它的 schema、
   * 而摘要行必须给出名字 + 个数 + 组名 + 展开指引（只给名字不给出路的话模型直接调过去撞
   * `NoSuchToolError`，`docs/14 §3 T20 ①`）。
   */
  it('第 0 步：折叠工具不在目录正文、schema 一个字节都不在 tools 数组里，只留一行组摘要', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-folded-step0');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const step = steps[0]!;
    // 折叠的两个**在**开轮冻结的 toolSet 里（`active()` = 常驻 ∪ 折叠），只是不在本步的
    // `activeTools` 里 —— SDK 按 `activeTools` 再收一次，所以 provider 手上这份数组里压根没有它们。
    expect(namesOf(step)).toEqual(['search_tools']);
    const wire = JSON.stringify(step.tools);
    expect(countOf(wire, ISSUE_PROP)).toBe(0);
    expect(countOf(wire, LIST_PROP)).toBe(0);
    const block = volatileOf(step);
    expect(block).not.toContain(ISSUE_DESC);
    expect(block).not.toContain(LIST_DESC);
    // 组摘要那两行是模型唯一能知道「还有东西可取」的入口。
    expect(block).toContain('【折叠工具 · 共 2 个，本步不可直接调用；用 search_tools 按关键词或名字展开】');
    expect(block).toContain('- [mcp:gh] 2 个：mcp__gh__create_issue, mcp__gh__list_issues');
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-047` 第二、三段：**检索 → 下一步真能调 → 下一轮回到折叠态。**
   *
   * 「下一轮回到折叠态」用的是**同一个 registry** 加一个新的 turn 对象：展开集只活在
   * `turn.expandedTools` 上、不持久化（持久化会造出「server 早删了而展开集还记着」这类腐烂，
   * `docs/05 §3.12`）。registry 换掉就测不到这条 —— 换掉之后连折叠集都是新的。
   */
  it('检索命中之后那一步 schema 才下发，下一轮第一步回到折叠态', async () => {
    const { db, config, turn, dependencies } = harness('catalog-wiring-expand-then-reset');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const registry = registryFor({ main: [recorder(steps, [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] })])] });
    await runMainAgent(turn, { ...dependencies, registry });
    expect(namesOf(steps[0]!)).toEqual(['search_tools']);
    // 命中的那一个进了 activeTools，没命中的那一个照旧折叠着 —— 检索是按需的，不是「一次全放开」。
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
   * `AC-TOOL-050`：**同一份 description 不许在一条请求体里出现两次。**
   *
   * 两处各发一遍时贵的是易变段那一份（每 step 重发），而描述的权威副本本来就是 tools 数组那一份
   * （还带完整 JSON Schema）。数「全文出现次数」而不是 token 数：数值随描述文本腐烂，
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
    // 折叠的那两个：schema 与描述在整条请求体里都是 0 次，只有名字出现在摘要行。
    expect(countOf(whole, ISSUE_PROP)).toBe(0);
    expect(countOf(whole, ISSUE_DESC)).toBe(0);
    expect(countOf(whole, LIST_DESC)).toBe(0);
    // 常驻段压成一行名字清单，且带上「常驻工具」四个字 —— KERNEL 里「见 TOOL CATALOG 的**常驻部分**」
    // 需要一个能对上的锚点。
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
    // 两份：TOOL CATALOG 一行 + tools 数组一件。这正是 `residentDescriptions=false` 要消掉的那一份。
    expect(countOf(wholeRequest(steps[0]!), alphaDesc)).toBe(2);
    closeDatabase(db);
  });

  /** `AC-TOOL-051` 前半：展开集**轮内只增不减** —— 第二次检索不许把第一次的成果冲掉。 */
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
   * `AC-TOOL-051` + 改写后的 `AC-PROMPT-003`：**先扩张后收窄，收窄永远赢**，而每一步的键集恒等于
   * `(常驻 ∪ 已展开) ∩ skill 允许集`，且始终是**开轮那一刻**冻结的 toolSet 的子集。
   *
   * 三件事一起测是因为它们只有一个共同的实现点（`prepareStep` 那条三重过滤）：分开测的话
   * 「收窄生效了但顺序反了」这一档（先按收窄算再并上展开集）三条断言会各自全绿。
   */
  it('skill 收窄压过展开，search_tools 因豁免留下并如实报 narrowed', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-narrowed');
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    // 开轮冻结的 toolSet = 这一刻的 `active()`。每一步的键集都必须是它的子集，否则 AI SDK 直接报错。
    const frozen = new Set(dependencies.tools.activeNames('trusted', { turn, workspace: './data', agentKind: 'main' }));
    const steps: WireStep[] = [];
    const script = [
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c2'),
      // 载入一个 `allowed-tools: [bash]` 的 skill。收窄从**下一步**起生效，而本步这次检索的
      // `execute()` 排在它之后 —— 于是同一次调用就能看到「命中了却调不动」这一档。
      () => { turn.skillAllowedTools = new Set(['bash']); return toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c3'); },
    ];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect(namesOf(steps[0]!)).toEqual(['bash', 'search_tools']);
    expect(namesOf(steps[1]!)).toEqual(['bash', 'search_tools', 'mcp__gh__create_issue']);
    // 收窄之后：已展开的 MCP 工具被滤掉（展开改变的是可见性，不是权限），`search_tools` 与
    // 白名单里的 bash 留下。少了 `search_tools` 就等于收窄顺手把检索通道也关了。
    expect(namesOf(steps[3]!)).toEqual(['bash', 'search_tools']);
    for (const step of steps) for (const name of namesOf(step)) expect(frozen.has(name)).toBe(true);
    // 被挡住的必须如实报 narrowed：不说的话模型会对着一个「已展开」却调不动的工具重试到步数耗尽。
    // 按 `type` 一起筛：同一个 `toolCallId` 在 delta 里有配对的两条（tool-call 与 tool-result）。
    const matches = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { value?: { matches?: Array<{ name: string; status: string }> } } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c3')!.output!.value!.matches!;
    expect(matches).toEqual([{ name: 'mcp__gh__create_issue', description: ISSUE_DESC, group: 'mcp:gh', status: 'narrowed' }]);
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-051` 的 unregister 方向：**摘掉一台 server，那些名字下一步自动掉出可见集，整轮不抛。**
   *
   * `toolSet` 开轮冻结，而 `activeNamesForStep` 每步 fresh —— 这个方向是「fresh 集合比冻结集小」，
   * 报一个已经不存在的名字给 SDK 就是运行时报错。
   */
  it('轮中摘掉一台 MCP server：已展开的名字下一步掉出 tools 数组，整轮不抛', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-unregister');
    registerGithub(dependencies.tools);
    // 留一个**别的来源**的折叠工具：`unregisterBySource('mcp')` 之后折叠集若整个空掉，
    // `search_tools` 自己的 `available()` 也跟着为假、整份目录回退常驻（`docs/05 §3.12` 不变量 3）
    // —— 那一档 `options.tools` 恒为空数组，这条用例要断的「那些名字掉出去了」就被淹掉了。
    dependencies.tools.registerExternal({ name: 'custom_helper', description: '丁：模型自撰写的那一个',
      inputSchema: z.object({}), minRole: 'limited', source: 'custom', execute: () => ({ ok: true }) });
    const steps: WireStep[] = [];
    const script = [
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => { dependencies.tools.unregisterBySource('mcp'); return toolCall('search_tools', { query: 'gh' }, 'c2'); },
    ];
    await expect(runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) })).resolves.toBe('ok');
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    // 展开集还记着它（`expandedTools` 只增不减），但注册表里已经没有这个工具了。
    expect(turn.expandedTools!.has('mcp__gh__create_issue')).toBe(true);
    expect(namesOf(steps[2]!)).toEqual(['search_tools']);
    closeDatabase(db);
  });

  /**
   * `AC-TOOL-051` 的 register 方向：**轮中新挂一台 server，它不进本轮的 tools 数组，但也不许炸。**
   *
   * 这是两个方向里更危险的那个：新工具**真的会**被 `search_tools` 检索到并记进 `expandedTools`
   * （检索域是活的注册表），于是 `activeNamesForStep` 会把一个开轮冻结的 toolSet 里没有的键报给
   * SDK —— `prepareStep` 末尾那道 `name in toolSet` 交集就是为它准备的。
   *
   * ⚠ **这条用例挡不住「那道交集被删掉」**，而这不是用例写松了：ai@7.0.65 的 `filterActiveTools`
   * 是纯交集（`Object.entries(tools).filter(([n]) => activeTools.includes(n))`），多报的名字被静默
   * 丢掉，`activeTools` 本身又不经由任何回调 / 日志露出来（`onStepStart` 只带 provider / modelId /
   * messages / instructions），于是那道交集在这个 SDK 版本上**没有任何外部可观察行为** ——
   * 实测把它删掉，全量 1048 条一条都不红。所以这个方向能断言的只有下面三件：整轮不抛、新挂的那个
   * 一个字节都不下发、以及**它照旧被记进了展开集**（最后这件正是危险的来源，少了它这条用例就退化成
   * 「一个从未被检索到的工具没出现」的同义反复）。
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
    // 检索确实展开了它 —— 所以下一步那道交集是唯一挡着 SDK 报错的东西，不是一句「反正不会发生」。
    expect(turn.expandedTools!.has('mcp__jira__create_ticket')).toBe(true);
    // 而 `search_tools` 对它回的是 `status:'expanded'`：**本方向尚存的那句假话**（docs/07 §2.2）——
    // 「下一步就能直接调用」对一个开轮冻结的 toolSet 里没有的键不成立，它这一轮永远发不出去。
    // 钉住它是为了哪天真修好（重建 toolSet 或把新挂的名字挡在检索域外）这条断言会红，而不是
    // 让「两个方向都成立」继续在文档里当真话。
    const matches = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { value?: { matches?: unknown } } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c1')!.output!.value!.matches;
    expect(matches).toEqual([{ name: 'mcp__jira__create_ticket', description: '丙：新挂上来的那台 server', group: 'mcp:jira', status: 'expanded' }]);
    expect(namesOf(steps[1]!)).toEqual(['search_tools']);
    expect(JSON.stringify(steps[1]!.tools)).not.toContain('luoliTicketMarker');
    closeDatabase(db);
  });

  /**
   * 改写后的 `AC-PROMPT-003` 的正面半边：**开轮那一刻正文里的工具清单恰等于本步 tools 数组，
   * 无多无少；而展开之后正文刻意不再跟着变。**
   *
   * 后半句正是这条 AC 被改写的理由。提示词**每轮只装一次**（`assembleMainPrompt` 在开轮那一刻跑，
   * `prepareStep` 从不返回 `instructions`），所以「正文与本 step 的 `activeTools` 一致」在展开那一步
   * 之后必然为假 —— 要它成立就得每步重装、于是每步重发整个易变段，而那恰好是折叠要消灭的开销。
   * 折了这一刀不等于模型看不见展开的工具：描述与完整 schema 已经在 tools 数组里（上面那条用例断的
   * 就是它）。所以这里断的是「正文一个字节都没动」，而不是「正文跟着 tools 数组走」。
   */
  it('第 0 步：正文的工具清单与 tools 数组无多无少；展开之后正文一个字节都不动', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-prompt003');
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1')];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    const opening = volatileOf(steps[0]!);
    // 无多无少，两个方向一起：目录正文逐条列的名字**恰是**本步 tools 数组，序也一致
    // （两处同源于开轮那一次 `activeView()`）。step 0 的 `expandedTools` 恒空，所以这一刻它就是常驻集。
    expect(catalogNames(opening)).toEqual(['bash', 'search_tools']);
    expect(catalogNames(opening)).toEqual(namesOf(steps[0]!));
    // 折叠的两个只在摘要行里露名字：它们不在 activeTools 里，所以也不许进逐条清单。
    expect(blockOf(opening, 'TOOL CATALOG')).toContain('- [mcp:gh] 2 个：mcp__gh__create_issue, mcp__gh__list_issues');
    expect(catalogNames(opening)).not.toContain('mcp__gh__create_issue');
    // 展开之后：tools 数组多了一个（描述与 schema 都在里面），而正文**逐字节不变** ——
    // 连折叠摘要那句「共 2 个」都没动，它仍然把刚展开的那个算在折叠里。
    expect(namesOf(steps[1]!)).toEqual(['bash', 'search_tools', 'mcp__gh__create_issue']);
    expect(volatileIn(steps[1]!)).toBe(opening);
    closeDatabase(db);
  });

  /**
   * 改写后的 `AC-PROMPT-003` 的回归半边：**关掉折叠 ⇒ 与按需暴露之前逐字节同形。**
   * 折叠集为空时 `search_tools` 的 `available()` 也为假，整个元工具不进目录。
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
    // 折叠集为空 ⇒ 元工具自己也不出现（`docs/05 §3.12` 不变量 3）。
    expect(block).not.toContain('search_tools 按关键词');
    closeDatabase(db);
  });

  /**
   * 改写后的 `AC-PROMPT-003`：**RUNTIME 的「可用工具」行 == 开轮常驻集**，折叠的只报一个数。
   * 默认 `includeToolCatalog=true` 时那一行刻意**不出现**（与 TOOL CATALOG 的常驻段纯重复，
   * 而它在易变段每步重发），所以要测它得先把目录关掉。
   */
  it('includeToolCatalog=false：RUNTIME 那行只列常驻工具，折叠的只报个数', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-runtime-line', { prompt: { includeToolCatalog: false } } as Partial<Config>);
    registerResident(dependencies.tools, 'bash', '跑一条命令');
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const block = volatileOf(steps[0]!);
    expect(block).toContain('可用工具：bash, search_tools；另有 2 个折叠工具，用 search_tools 检索');
    // 「无多无少」在这一档落在 RUNTIME 那一行上（目录关掉之后它是唯一的工具清单）。
    expect(runtimeToolNames(block)).toEqual(namesOf(steps[0]!));
    expect(block).not.toContain('=== TOOL CATALOG ===');
    // 目录关掉之后折叠组摘要也跟着没了 —— 那个后缀于是是模型唯一能知道「还有东西可取」的入口。
    expect(block).not.toContain('【折叠工具');
    expect(namesOf(steps[0]!)).toEqual(['bash', 'search_tools']);
    closeDatabase(db);
  });
});

/**
 * 自愈钩子（`docs/05 §3.12` 的「自愈」段）。折叠把「模型调了个发不出去的工具」从罕见幻觉变成常规
 * 事件，光靠提示词引导是在赌模型「想到」去检索；`repairToolCall` 把这一次调用改写成
 * `search_tools({names:[原名]})`，代价与它自己先搜一次一样（多一个 step）。
 *
 * 三条判据都是**防死循环**的，所以每条各有一个用例：改写成检索而检索又不会让状态往前一格，
 * 就是「调 X → NoSuchToolError → 改写 → 检索原地返回 → 再调 X → …」一路烧到步数上限。
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
    // 上下文里留下的是**改写后**那一次调用：模型下一轮读到的是「我搜过它」，而不是一次不存在的调用。
    const call = (JSON.parse(JSON.stringify(turn.delta)) as Array<{ parts: Array<{ type?: string; toolName?: string; input?: unknown }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-call')!;
    expect(call.toolName).toBe('search_tools');
    expect(call.input).toEqual({ names: ['mcp__gh__create_issue'] });
    const expanded = steps[1]!.tools.find((entry) => entry.name === 'mcp__gh__create_issue')!;
    expect(JSON.stringify(expanded.inputSchema)).toContain(ISSUE_PROP);
    closeDatabase(db);
  });

  /**
   * 防死循环闸 ①：**skill 收窄挡着的只改写一次。** `search_tools` 对它回 `status:'narrowed'`
   * 却**照样记进 `expandedTools`** —— 那一笔正是这条闸的另一半（`tools/catalog-meta.ts` 里那段
   * 注释）：不记的话第二次硬调又会被改写成同一次检索，一路打转。
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
    // 收窄挡着，所以展开之后它照旧发不出去 —— 但它进了展开集，第二次于是不再改写。
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
   * 防死循环闸 ②：**展开额度满了就一次都不改写。** 这一档 `search_tools` 会回 `expansion_limit`
   * 且**不写** `expandedTools`，所以闸 ① 拦不住它；而它的 hint 是「用 names 精确点名」而改写出来的
   * 调用本来就是 `names:[X]` —— 模型照 hint 做也没有出路，是三条里唯一会无限打转的。
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
   * 防死循环闸 ⓿：**同一个名字本轮只改写一次。**
   *
   * ①②③ 各自点名一种「检索不会往前一格」的成因，而成因不止那三种 —— `search_tools` 自己也会在
   * `admit()` 上失败：`tools.maxCallsPerTurn` 用满（本例）、运维把它的 `approval` 覆盖成 `always`
   * 而审批被拒、轮内连续失败到 `maxConsecutiveErrors` 之前那几次。这些档位一律**不写**
   * `expandedTools`，于是闸 ① 永远拦不住第二次。没有 ⓿ 时实测同一个折叠工具被连着改写 **11 次**，
   * 只有 `maxSteps` 兜住 —— 11 次白付的模型调用。按名字判一次，成因有多少种都不必枚举。
   */
  it('search_tools 自己在 admit() 上失败：同一个名字只改写一次，之后落回 NoSuchToolError', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-repair-admit-fail', {}, 40, 1);
    registerGithub(dependencies.tools);
    const steps: WireStep[] = [];
    // 第 0 步把 `maxCallsPerTurn=1` 那一格用掉（展开另一个工具），此后每一步都硬调同一个折叠工具。
    const script: Array<() => unknown> = [() => toolCall('search_tools', { names: ['mcp__gh__list_issues'] }, 'c0')];
    for (let index = 1; index < 6; index += 1) script.push(() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, `c${index}`));
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
    expect(logRows(db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(1);
    // 那一次改写出来的检索自己撞在额度上，所以展开集里只有第 0 步那一个 —— 闸 ① 因此拦不住第二次。
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
   * 防死循环闸 ③（另一半）：**纯幻觉名字不改写。** 把一个不存在的名字喂给检索只会得到空结果，
   * 而模型会以为自己找过了 —— 一句明确的 `NoSuchToolError` 比一次假装有进展的往复强。
   *
   * 顺带记一笔实测：SDK 那句错误文本会把**整份 active 名单**抄进上下文（`Available tools: …`）。
   * 折叠省下来的钱在这一档会还回去一部分，所以「不改写」的档位越窄越好。
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
 * `AC-TOOL-020`：**目录被 `tools.maxRegistered` 静默截断这件事必须说出来。**
 *
 * 三件事各自独立：RUNTIME 里那一行（给模型的）、`tool.registry_truncated` warn（给运维的）、
 * 以及折叠摘要里只许出现截断后的名字（摘要里报一个 `toolSet` 里压根没有的名字，模型展开它就是
 * AI SDK 层的运行时报错）。此前只落地了中间那一件，模型对自己少了什么完全不知情。
 */
describe('deferred tool catalog · maxRegistered 截断告知', () => {
  /** 排序是 `sourcePriority desc, name asc`，所以 `maxRegistered=2` 留下 search_tools(80) + aaa(40)。 */
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
    // 恰好一条：`#eligible()` 被目录视图、`prepareStep` 的每步取数、`repairToolCall` 反复调用，
    // warn 却只挂在 `active()` 上（`toolSetFor` 开轮那一次）—— 落在共用的那条过滤链里就会按调用
    // 次数刷屏，而运维要的是「这一轮截断了」一条。
    const warns = logRows(db).filter((row) => row.kind === 'tool.registry_truncated');
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]!.data!)).toMatchObject({ total: 4, visible: 2 });
    // 被砍掉的一个都不许进摘要 —— 模型按摘要检索，展开出来的会是冻结 toolSet 里没有的键。
    expect(block).toContain('- [mcp:gh] 1 个：mcp__gh__aaa');
    expect(block).not.toContain('mcp__gh__bbb');
    expect(block).not.toContain('mcp__gh__ccc');
    expect(namesOf(steps[0]!)).toEqual(['search_tools']);
    closeDatabase(db);
  });

  /**
   * 那一行**不受 `prompt.runtimeBlock.show.*` 管**：那三个开关管的是「要不要显示某类状态」，
   * 而这一行说的是「有些工具本轮压根不存在」。三个全关掉之后它还在。
   */
  it('三个 runtimeBlock 开关全关掉，截断告知行照样在', async () => {
    const { db, turn, dependencies } = harness('catalog-wiring-truncated-show-off',
      { prompt: { runtimeBlock: { showQuota: false, showContextWatermark: false, showWorkspace: false } } } as Partial<Config>, 2);
    registerThree(dependencies.tools);
    const steps: WireStep[] = [];
    await runMainAgent(turn, { ...dependencies, registry: registryFor({ main: [recorder(steps)] }) });
    const block = volatileOf(steps[0]!);
    expect(block).toContain('工具目录已截断：共注册 4 个，按来源优先级仅保留前 2 个，其余本轮不可用（tools.maxRegistered）。');
    // 开关真的生效了 —— 否则上面那条断言什么都没证明。
    expect(block).not.toContain('上下文水位：');
    expect(block).not.toContain('工作目录：');
    closeDatabase(db);
  });
});
