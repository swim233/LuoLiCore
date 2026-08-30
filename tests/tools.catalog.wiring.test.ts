import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { AgentManager, AgentResultStore, ContextEngine, LogSink, PromptAssembler, PromptDocuments, ToolRegistry, UsageLedger,
  builtinPolicy, configSchema, newToolScope, registerCatalogTools, runLwWorker, runMainAgent } from '@luoli/core';
import type { ApprovalBroker, Config, LwWorkerRuntimeEvent, ModelRegistry, ToolExecutionContext } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';
import { logRows as loggedRows } from './support/logs.js';

/**
 * 工具目录按需暴露在请求体与运行时层的契约（`AC-TOOL-020`、`AC-TOOL-047`、`AC-TOOL-050`–`052`、
 * 改写后的 `AC-PROMPT-003`）。手法参照 `agent.model-wiring.test.ts`（`AC-PROMPT-008` 的先例）：
 * 断言只落在真正递交到 provider 那一层的两样内容上，即 `options.prompt`（易变段中的目录文本）
 * 与 `options.tools`（本步的 tools 数组，带完整 JSON Schema）。
 *
 * 工具下沉给 lw-worker 之后这条链断成了两半，两半各有自己的失效形态：
 *
 * - **提示词那一半留在主 agent 身上**。TOOL CATALOG 描述的已经是 **worker 能做什么**
 *   （`assembleMainPrompt` 用 `agentKind:'lw'` 另取一次 `activeView()`，再滤掉
 *   `WORKER_INTERNAL_TOOLS`），折叠摘要行也在这里 —— 主 agent 据此判断值不值得派一个出去。
 *   而它自己那一步能发出的工具由 RUNTIME 的「可用工具」行给出，两者不再同源。
 * - **tools 数组那一半在 worker 身上**。`search_tools` 的展开、skill 的收窄、`repairToolCall`
 *   的自愈全部发生在 `runLwWorker` 的 `prepareStep`，而展开集挂在**本次 run** 上（`newToolScope()`），
 *   随 run 消亡。
 *
 * 于是主 agent 那一侧的判据是「一个折叠工具都发不出去、连 `search_tools` 都没有」，worker 那一侧的
 * 判据是「展开之后下一步真的发得出去、而另一个 run 从头折叠」。仅断言 `activeView()` /
 * `assembleMainPrompt()` 的返回值不够：中间还隔着 `toolSetFor` 的开轮冻结、`prepareStep` 的每步
 * 三重交集、`repairToolCall` 的改写，以及 AI SDK 按 `activeTools` 收缩 toolSet 那一步。
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

/** 只实现两条 agent 路径实际使用的那几个方法；其余留空，多使用一个会在类型层面报错。 */
function registryFor(chains: Record<string, Array<{ model: ReturnType<typeof candidate>; info: ReturnType<typeof info> }>>): ModelRegistry {
  const down: string[] = [];
  const failures = new Map<string, number>();
  const fake = {
    chain: (alias: string) => chains[alias] ?? [],
    resolve: (alias: string) => (chains[alias] ?? Object.values(chains)[0]!)[0]!.model as unknown as LanguageModel,
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

function makeTurn(config: Config, turnId: string): RuntimeTurnContext {
  return { turnId, key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted',
    isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [{ id: 'u', role: 'user', origin: 'trigger', parts: [{ type: 'text', text: '你好' }], tokens: 4 }],
    abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext;
}

function harness(name: string, patch: Partial<Config> = {}, maxRegistered = 40, maxCallsPerTurn = 20) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  rmSync(`./data/${name}-results`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, quota: { requirePricing: false },
    provider: { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 2 },
    memory: { dir: `./data/${name}-memory` }, approval: { enabled: false }, ...patch });
  const log = new LogSink(new OperationsRepository(db));
  const broker: ApprovalBroker = { request: async () => true };
  const documents = new PromptDocuments(db, config.memory.dir);
  documents.ensure();
  const turn = makeTurn(config, 'turn-1');
  // registry 的 limits 与本轮 config 必须使用同一份 catalog：折叠判据走 `#limits()` getter，
  // 而 `search_tools` 的展开额度读取 `turn.config`，两处不一致时测出的是一个并不存在的部署。
  const tools = new ToolRegistry(log, broker, { maxRegistered, maxCallsPerTurn, maxConsecutiveErrors: 3, catalog: config.tools.catalog });
  registerCatalogTools(tools, { log });
  const agents = new AgentManager(db, new AgentResultStore(`./data/${name}-results`), 10);
  const dependencies = { config, db, tools, prompts: new PromptAssembler(), documents,
    ledger: new UsageLedger(db), log, workspace: './data', context: new ContextEngine(db, new ArchiveRepository(db), log) };
  return { db, config, turn, dependencies, agents };
}
type Harness = ReturnType<typeof harness>;

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
 * 剧本项是函数而非静态数据：轮内的那几件事（MCP reconcile 移除一台 server、新增一台）都需要发生在
 * 某一步的中间，而 `doGenerate` 正是该位置：它排在本步 `prepareStep` 之后、下一步 `prepareStep`
 * 之前。改 run 内状态（载入一个带 `allowed-tools` 的 skill）则不能走这里 —— 那三个集合已经挂在
 * `ToolExecutionContext` 上、只有工具够得着，因此另有一个 `load_skill` 桩。
 */
function recorder(steps: WireStep[], script: Array<() => unknown> = []) {
  return { model: { ...candidate('m1', () => ok),
    doGenerate: async (options: { prompt: PromptMessage[]; tools?: WireTool[] }) => {
      steps.push({ prompt: options.prompt, tools: options.tools ?? [] });
      return (script[steps.length - 1]?.() ?? ok) as never;
    } } as ReturnType<typeof candidate>, info: info('m1') };
}

const logRows = (db: ReturnType<typeof openDatabase>): Array<{ kind: string; summary: string; data: string | null }> =>
  loggedRows(db);

/** 主 agent 跑一轮。它的别名是 `agent.main.modelAlias`（默认 `main`）。 */
async function main(harnessed: Harness, steps: WireStep[], script: Array<() => unknown> = []): Promise<void> {
  await runMainAgent(harnessed.turn, { ...harnessed.dependencies, registry: registryFor({ main: [recorder(steps, script)] }) });
}
/**
 * 派一个 lw-worker 跑一次，返回它的 step 事件。
 *
 * 走 `createMain` + `spawn` 而不是 `createDryRun`：后者自造一个 `dryrun:` 前缀的 turnId，
 * 与日志里的 traceId、`maxCallsPerTurn` 的按轮状态就都不是同一个 turn 了 —— 而
 * 「`search_tools` 自己在 admit() 上失败」那条用例正是靠共用同一份按轮状态才成立。
 */
async function worker(harnessed: Harness, steps: WireStep[], script: Array<() => unknown> = []): Promise<LwWorkerRuntimeEvent[]> {
  const { turn, dependencies, agents, db } = harnessed;
  const parent = agents.createMain(turn.turnId, turn.effectiveRole, 'main');
  const run = agents.spawn(parent, '干活', 'low');
  const events: LwWorkerRuntimeEvent[] = [];
  await runLwWorker(run, '干活', undefined, turn, { db, agents, tools: dependencies.tools,
    registry: registryFor({ low: [recorder(steps, script)] }), ledger: dependencies.ledger, log: dependencies.log,
    workspace: './data', onEvent: (event) => { events.push(event); } });
  return events;
}
/**
 * worker 的消息不进 `turn.delta`（它只收到一段任务文本，产出经 `agents.finish` 落库），
 * 因此工具结果只能从 `onEvent` 的 step 事件里取 —— 那是 worker 侧唯一对外暴露它们的口子。
 */
function toolResultOf(events: readonly LwWorkerRuntimeEvent[], toolCallId: string): { toolName: string; value: unknown } | null {
  for (const event of events) {
    if (event.type !== 'step') continue;
    for (const entry of event.toolResults as Array<{ toolCallId: string; toolName: string; part: { output: { value: unknown } } }>)
      if (entry.toolCallId === toolCallId) return { toolName: entry.toolName, value: entry.part.output.value };
  }
  return null;
}
const matchesOf = (events: readonly LwWorkerRuntimeEvent[], toolCallId: string): unknown =>
  (toolResultOf(events, toolCallId)?.value as { matches?: unknown } | undefined)?.matches;

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
/**
 * worker 侧的常驻对照工具（`source: 'builtin'` ⇒ 不被 `deferExternal` 折叠）。
 *
 * 名字不在 `MAIN_AGENT_TOOLS` 里，因此它同时也是「主 agent 调不到」的样本：`toolCallableBy`
 * 在 `#eligible()` 与 `admit()` 两处都把它挡在主 agent 之外。
 */
function registerResident(tools: ToolRegistry, name: string, description: string): void {
  tools.register({ name, description, inputSchema: z.object({}),
    policy: { minRole: 'trusted', approval: 'never', scope: 'chat', source: 'builtin' }, sourcePriority: 100, execute: () => ({ ok: true }) });
}
/** 主 agent 侧的样本：`MAIN_ONLY_TOOLS` 里的投递通道，worker 一侧看不到它。 */
function registerMainSide(tools: ToolRegistry, description = '发一条消息'): void {
  tools.register({ name: 'send_message', description, inputSchema: z.object({}),
    policy: builtinPolicy('send_message'), sourcePriority: 100, execute: () => ({ ok: true }) });
}
/** 两侧都给的只读查询（`MAIN_AGENT_TOOLS` 里那几件）。它同时出现在主 agent 的目录与 tools 数组中，
 *  `AC-TOOL-050` 的去重判据因此仍然有牙 —— 其余工具两处本就不相交，统计不出重复。 */
function registerShared(tools: ToolRegistry, name: 'context_stats' | 'memory_read', description: string): void {
  tools.register({ name, description, inputSchema: z.object({}),
    policy: builtinPolicy(name), sourcePriority: 100, execute: () => ({ ok: true }) });
}
/**
 * `load_skill` 的桩：真正的 loader 需要一整套 skill 目录，而这里要验的是收窄何时生效。
 *
 * 写进的是 `context.skillAllowedTools`。`execute()` 交给工具的是 context 的**浅拷贝**，三个 Set
 * 是同一批引用，因此 `.add()` 落在本次 run 那一份上 —— 写成重新赋值的话改动只活到本次调用返回。
 */
function registerNarrowing(tools: ToolRegistry, allowed: readonly string[]): void {
  tools.register({ name: 'load_skill', description: '载入一个 skill 的正文', inputSchema: z.object({}),
    policy: builtinPolicy('load_skill'), sourcePriority: 80,
    execute: (_input: unknown, context: ToolExecutionContext) => {
      for (const name of allowed) context.skillAllowedTools.add(name);
      return { ok: true };
    } });
}
/** 开轮冻结的 toolSet 即 worker 视角此刻的 `active()`。每一步的键集都必须是它的子集，否则 SDK 直接报错。 */
const frozenFor = (harnessed: Harness): Set<string> => new Set(harnessed.dependencies.tools
  .activeNames(harnessed.turn.effectiveRole, { turn: harnessed.turn, workspace: './data', agentKind: 'lw', ...newToolScope() }));

describe('折叠工具目录 · 主 agent 那一侧', () => {
  /**
   * `AC-TOOL-047` 第一段，改写后的主体：折叠工具在主 agent 的请求体中只保留一个名字。
   *
   * 四处各自独立，缺任意一处即失效：目录正文不得包含它的描述、tools 数组不得包含它的 schema、
   * 摘要行必须给出名字与展开指引（只给名字而不给出路时模型会直接调用并撞上 `NoSuchToolError`，
   * `docs/14 §3 T20 ①`），而 TOOL CATALOG 与 RUNTIME 的可用工具行现在描述的是两个不同的主体 ——
   * 前者是 worker 能做什么，后者是主 agent 自己这一步能发出什么。
   */
  it('主 agent 的 tools 数组里没有折叠工具，连 search_tools 都没有；折叠摘要只在正文里', async () => {
    const harnessed = harness('catalog-wiring-main-side');
    registerMainSide(harnessed.dependencies.tools);
    registerResident(harnessed.dependencies.tools, 'bash', '跑一条命令');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    const step = steps[0]!;
    expect(namesOf(step)).toEqual(['send_message']);
    const wire = JSON.stringify(step.tools);
    expect(countOf(wire, ISSUE_PROP)).toBe(0);
    expect(countOf(wire, LIST_PROP)).toBe(0);
    const block = volatileOf(step);
    expect(block).not.toContain(ISSUE_DESC);
    expect(block).not.toContain(LIST_DESC);
    // 组摘要那一行是主 agent 得知「派个 worker 出去还能再检索出一批工具」的唯一入口。
    expect(block).toContain('【折叠工具 · 共 2 个，worker 检索后才可用；需要其中任何一项，把要求写进 task 派 worker】');
    expect(block).toContain('- [mcp:gh] 2 个：mcp__gh__create_issue, mcp__gh__list_issues');
    // 目录列的是 worker 能做什么：`bash` 在其中，而主 agent 自己的 `send_message` 不在
    // （worker 调不到它）。`search_tools` 同样不在 —— 它是 worker→父的内部通道，列进来会让模型
    // 以为自己可以派一个 worker 去检索工具。
    expect(catalogNames(block)).toEqual(['bash']);
    // 改写后的 `AC-PROMPT-003`「不多不少」落在 RUNTIME 那一行上：它已是主 agent 唯一的工具清单。
    expect(runtimeToolNames(block)).toEqual(namesOf(step));
    expect(block).toContain('；worker 另有 2 个折叠工具，派它去用');
    closeDatabase(harnessed.db);
  });

  /**
   * 自愈钩子随折叠一并搬去了 worker，主 agent 这一侧一条都不落。
   *
   * 留在主 agent 那边是恒返回 `null` 的死代码（它的折叠集恒为空），而恒真的判据与红着的判据对
   * 「谁来守住这件事」是同一个答案 —— 因此这里断的是「一条 `tool.repaired` 都没有」，
   * 它在自愈被误搬回主 agent 时会立刻变红。
   */
  it('主 agent 硬调 worker 的工具：不改写成检索，落回 NoSuchToolError', async () => {
    const harnessed = harness('catalog-wiring-main-nosuchtool');
    registerMainSide(harnessed.dependencies.tools);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps, [() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c1')]);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(0);
    const failed = (JSON.parse(JSON.stringify(harnessed.turn.delta)) as Array<{ parts: Array<{ type?: string; toolCallId?: string; output?: { type?: string; value?: unknown } }> }>)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool-result' && part.toolCallId === 'c1')!;
    expect(failed.output!.type).toBe('error-text');
    // SDK 的错误文本会把本步 active 名单一并写进上下文，因此它同时证明主 agent 手里只有那一件。
    expect(String(failed.output!.value)).toBe(`AI_NoSuchToolError: Model tried to call unavailable tool 'mcp__gh__create_issue'. Available tools: send_message.`);
    closeDatabase(harnessed.db);
  });

  /**
   * `AC-TOOL-050`：同一份 description 不得在一条请求体中出现两次。
   *
   * 样本必须取两侧都给的只读查询（`memory_read` / `context_stats`）：其余工具在目录（worker 视角）
   * 与 tools 数组（主 agent 视角）中本就不相交，拿它们做样本统计不出任何重复，用例会恒真。
   */
  it('residentDescriptions=false：两侧都给的工具，描述在整条请求体里至多出现一次', async () => {
    const harnessed = harness('catalog-wiring-dedup', { tools: { catalog: { residentDescriptions: false } } } as Partial<Config>);
    const statsDesc = '甲工具：报一次上下文水位';
    const memoryDesc = '乙工具：读出一条已记下的事实';
    registerShared(harnessed.dependencies.tools, 'context_stats', statsDesc);
    registerShared(harnessed.dependencies.tools, 'memory_read', memoryDesc);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    expect(namesOf(steps[0]!)).toEqual(['context_stats', 'memory_read']);
    const whole = wholeRequest(steps[0]!);
    for (const description of [statsDesc, memoryDesc]) expect(countOf(whole, description)).toBe(1);
    // 折叠的那两个：schema 与描述在整条请求体中均为 0 次，只有名字出现在摘要行。
    expect(countOf(whole, ISSUE_PROP)).toBe(0);
    expect(countOf(whole, ISSUE_DESC)).toBe(0);
    expect(countOf(whole, LIST_DESC)).toBe(0);
    // 常驻段压缩为一行名字清单，并保留常驻工具字样：KERNEL 中引用 TOOL CATALOG 的常驻部分
    // 需要一个可对应的锚点。
    expect(volatileOf(steps[0]!)).toContain('worker 常驻工具：context_stats, memory_read');
    closeDatabase(harnessed.db);
  });

  it('residentDescriptions=true（默认）：常驻段逐行带描述，于是同一份描述发两遍', async () => {
    const harnessed = harness('catalog-wiring-dedup-off');
    const statsDesc = '甲工具：报一次上下文水位';
    registerShared(harnessed.dependencies.tools, 'context_stats', statsDesc);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    expect(volatileOf(steps[0]!)).toContain(`- context_stats: ${statsDesc}`);
    expect(volatileOf(steps[0]!)).not.toContain('worker 常驻工具：');
    // 共两份：TOOL CATALOG 一行与 tools 数组一件。这正是 `residentDescriptions=false` 要消除的那一份。
    expect(countOf(wholeRequest(steps[0]!), statsDesc)).toBe(2);
    closeDatabase(harnessed.db);
  });

  /**
   * 改写后的 `AC-PROMPT-003` 的回归部分：关闭折叠后目录里一行摘要都没有。
   * 折叠集为空时 `search_tools` 的 `available()` 也为假，整个元工具不进入 worker 的目录。
   */
  it('deferExternal=false：MCP 工具逐条回到目录正文，一行折叠摘要都没有', async () => {
    const harnessed = harness('catalog-wiring-defer-off', { tools: { catalog: { deferExternal: false } } } as Partial<Config>);
    registerMainSide(harnessed.dependencies.tools);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    const block = volatileOf(steps[0]!);
    expect(block).toContain(`- mcp__gh__create_issue: ${ISSUE_DESC}`);
    expect(block).toContain(`- mcp__gh__list_issues: ${LIST_DESC}`);
    expect(block).not.toContain('折叠工具');
    expect(block).not.toContain('search_tools 按关键词');
    // 逐条列进目录不等于主 agent 能调：那两个照旧只能派一个 worker 去用。
    expect(namesOf(steps[0]!)).toEqual(['send_message']);
    closeDatabase(harnessed.db);
  });

  /**
   * 改写后的 `AC-PROMPT-003`：`includeToolCatalog=false` 时 RUNTIME 那行是唯一的工具清单，
   * 折叠部分只报出数量。该行现在恒显（目录描述的是 worker，与它不再重复），因此关闭目录
   * 验的是「关掉之后模型仍然知道还有折叠工具可检索」。
   */
  it('includeToolCatalog=false：RUNTIME 那行只列主 agent 的工具，折叠的只报个数', async () => {
    const harnessed = harness('catalog-wiring-runtime-line', { prompt: { includeToolCatalog: false } } as Partial<Config>);
    registerMainSide(harnessed.dependencies.tools);
    registerResident(harnessed.dependencies.tools, 'bash', '跑一条命令');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    const block = volatileOf(steps[0]!);
    expect(block).toContain('可用工具：send_message；worker 另有 2 个折叠工具，派它去用');
    expect(runtimeToolNames(block)).toEqual(namesOf(steps[0]!));
    expect(block).not.toContain('=== TOOL CATALOG ===');
    // 关闭目录后折叠组摘要也随之消失，该后缀于是成为模型得知仍有工具可检索的唯一入口。
    expect(block).not.toContain('【折叠工具');
    expect(namesOf(steps[0]!)).toEqual(['send_message']);
    closeDatabase(harnessed.db);
  });
});

describe('折叠工具目录 · worker 那一侧', () => {
  /**
   * `AC-TOOL-047` 第一段的 tools 数组那一半：折叠工具位于开轮冻结的 toolSet 内（`active()` 等于
   * 常驻并集折叠），只是不在本步的 `activeTools` 中；SDK 会按 `activeTools` 再收缩一次，
   * 因此 provider 收到的数组中不含它们，一个字节的 schema 都没有。
   */
  it('第 0 步：折叠工具的 schema 一个字节都不在 worker 的 tools 数组里', async () => {
    const harnessed = harness('catalog-wiring-worker-step0');
    registerResident(harnessed.dependencies.tools, 'bash', '跑一条命令');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await worker(harnessed, steps);
    expect(namesOf(steps[0]!)).toEqual(['bash', 'search_tools']);
    const wire = JSON.stringify(steps[0]!.tools);
    expect(countOf(wire, ISSUE_PROP)).toBe(0);
    expect(countOf(wire, LIST_PROP)).toBe(0);
    // 冻结集里它们都在：摘要行报出的名字必须能被检索出来并真的下发。
    expect(frozenFor(harnessed)).toContain('mcp__gh__create_issue');
    closeDatabase(harnessed.db);
  });

  /**
   * `AC-TOOL-047` 第二、三段：检索 → 下一步确实可调用 → **另一个 run** 从头折叠。
   *
   * 第三段现在比改动前更强。展开集此前挂在 `turn.expandedTools` 上，只能验到「换一个 turn 之后
   * 回到折叠态」；挪到 `newToolScope()` 之后，同一个 turn、同一个注册表、只换一次 run 就应当回到
   * 折叠态 —— 这正是挪位置买到的东西：worker A 展开的工具不会出现在 worker B 与主轮的
   * `prepareStep` 里（`docs/05 §3.12` 不变量 4）。缺这一条，挪位置这件事就没有判据在守。
   */
  it('检索命中之后那一步 schema 才下发，另一个 run 回到折叠态', async () => {
    const harnessed = harness('catalog-wiring-expand-then-reset');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await worker(harnessed, steps, [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] })]);
    expect(namesOf(steps[0]!)).toEqual(['search_tools']);
    // 命中的那个进入 activeTools，未命中的仍保持折叠：检索是按需的，而非一次性全部放开。
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    const expanded = steps[1]!.tools.find((entry) => entry.name === 'mcp__gh__create_issue')!;
    expect(JSON.stringify(expanded.inputSchema)).toContain(ISSUE_PROP);
    expect(expanded.description).toBe(ISSUE_DESC);
    expect(JSON.stringify(steps[1]!.tools)).not.toContain(LIST_PROP);
    const expandedEvents = logRows(harnessed.db).filter((row) => row.kind === 'tool.expanded');
    expect(expandedEvents).toHaveLength(1);
    expect(expandedEvents[0]!.summary).toBe('search_tools: 1 matched, 1 expanded');
    // 同一个 turn、同一个 ToolRegistry，只换一次 run。
    const next: WireStep[] = [];
    await worker(harnessed, next);
    expect(namesOf(next[0]!)).toEqual(['search_tools']);
    expect(JSON.stringify(next[0]!.tools)).not.toContain(ISSUE_PROP);
    closeDatabase(harnessed.db);
  });

  /** `AC-TOOL-051` 前半：展开集在 run 内只增不减，第二次检索不得覆盖第一次的结果。 */
  it('一个 run 内检索两次：第一次展开的工具在第二次之后仍在 activeTools 里', async () => {
    const harnessed = harness('catalog-wiring-monotonic');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('search_tools', { names: ['mcp__gh__list_issues'] }, 'c2')];
    await worker(harnessed, steps, script);
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    expect(namesOf(steps[2]!)).toEqual(['search_tools', 'mcp__gh__create_issue', 'mcp__gh__list_issues']);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.expanded').map((row) => row.summary))
      .toEqual(['search_tools: 1 matched, 1 expanded', 'search_tools: 1 matched, 1 expanded']);
    closeDatabase(harnessed.db);
  });

  /**
   * `AC-TOOL-051` 与改写后的 `AC-PROMPT-003`：先扩张后收窄、收窄优先，且每一步的键集恒等于
   * `(常驻 ∪ 已展开) ∩ skill 允许集`，并始终是开轮时刻冻结的 toolSet 的子集。
   *
   * 三件事合并验证是因为它们只有一个共同实现点（`prepareStep` 的三重过滤）：分开验证时，
   * 收窄生效但顺序颠倒这一档（先按收窄计算再并入展开集）会让三条断言各自通过。
   *
   * 收窄由一个 `load_skill` 桩触发而不再由剧本直接改 turn：那三个集合已经挂在
   * `ToolExecutionContext` 上，只有工具够得着 —— 而这恰好也是生产路径的形状。
   */
  it('skill 收窄压过展开，search_tools 因豁免留下并如实报 narrowed', async () => {
    const harnessed = harness('catalog-wiring-narrowed');
    registerResident(harnessed.dependencies.tools, 'bash', '跑一条命令');
    registerNarrowing(harnessed.dependencies.tools, ['bash']);
    registerGithub(harnessed.dependencies.tools);
    const frozen = frozenFor(harnessed);
    const steps: WireStep[] = [];
    const script = [
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c2'),
      // 载入一个 `allowed-tools: [bash]` 的 skill。收窄自下一步起生效。
      () => toolCall('load_skill', {}, 'c3'),
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c4'),
    ];
    const events = await worker(harnessed, steps, script);
    expect(namesOf(steps[0]!)).toEqual(['bash', 'load_skill', 'search_tools']);
    expect(namesOf(steps[1]!)).toEqual(['bash', 'load_skill', 'search_tools', 'mcp__gh__create_issue']);
    // 收窄之后：已展开的 MCP 工具被过滤（展开改变的是可见性而非权限），`search_tools` 与
    // `load_skill` 因豁免留下，白名单中的 bash 保留。缺少 `search_tools` 即意味着收窄同时
    // 关闭了检索通道。
    expect(namesOf(steps[3]!)).toEqual(['bash', 'load_skill', 'search_tools']);
    for (const step of steps) for (const name of namesOf(step)) expect(frozen.has(name)).toBe(true);
    // 被拦截的必须如实报告 narrowed：否则模型会对着一个已展开却不可调用的工具重试至步数耗尽。
    expect(matchesOf(events, 'c4')).toEqual([{ name: 'mcp__gh__create_issue', description: ISSUE_DESC, group: 'mcp:gh', status: 'narrowed' }]);
    closeDatabase(harnessed.db);
  });

  /**
   * `AC-TOOL-051` 的 unregister 方向：移除一台 server 后，那些名字在下一步自动退出可见集，整段不抛错。
   *
   * `toolSet` 在 run 开始时冻结，而 `activeNamesForStep` 每步重新计算，本方向属于新集合小于冻结集，
   * 向 SDK 报出一个已不存在的名字即产生运行时报错。
   */
  it('run 中摘掉一台 MCP server：已展开的名字下一步掉出 tools 数组，整段不抛', async () => {
    const harnessed = harness('catalog-wiring-unregister');
    registerGithub(harnessed.dependencies.tools);
    // 保留一个其他来源的折叠工具：`unregisterBySource('mcp')` 之后若折叠集完全为空，
    // `search_tools` 自身的 `available()` 也随之为假、整份目录回退为常驻（`docs/05 §3.12` 不变量 3），
    // 该情形下 `options.tools` 恒为空数组，本用例要断言的那些名字已退出就无法观察。
    harnessed.dependencies.tools.registerExternal({ name: 'custom_helper', description: '丁：模型自撰写的那一个',
      inputSchema: z.object({}), minRole: 'limited', source: 'custom', execute: () => ({ ok: true }) });
    const steps: WireStep[] = [];
    const script = [
      () => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => { harnessed.dependencies.tools.unregisterBySource('mcp'); return toolCall('search_tools', { query: 'gh' }, 'c2'); },
    ];
    await expect(worker(harnessed, steps, script)).resolves.toBeDefined();
    expect(namesOf(steps[1]!)).toEqual(['search_tools', 'mcp__gh__create_issue']);
    expect(namesOf(steps[2]!)).toEqual(['search_tools']);
    // 展开集仍记着它（run 内只增不减），只是注册表里已经没有这件工具，因此第二次检索一无所获。
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.expanded').map((row) => row.summary))
      .toEqual(['search_tools: 1 matched, 1 expanded', 'search_tools: 0 matched, 0 expanded']);
    closeDatabase(harnessed.db);
  });

  /**
   * `AC-TOOL-051` 的 register 方向：run 中新增一台 server，它不进入本次 run 的 tools 数组，但也不得抛错。
   *
   * 这是两个方向中更危险的一个：新工具确实会被 `search_tools` 检索到并记入 `expandedTools`
   * （检索域是实时的注册表），于是 `activeNamesForStep` 会把一个冻结的 toolSet 中不存在的键报给
   * SDK，`prepareStep` 末尾那道 `name in toolSet` 交集正是为此而设。
   *
   * ⚠ 本用例无法拦截那道交集被删除的情形，这不是用例写得宽松：ai@7.0.65 的 `filterActiveTools`
   * 是纯交集（`Object.entries(tools).filter(([n]) => activeTools.includes(n))`），多报的名字被静默
   * 丢弃，而 `activeTools` 本身不经由任何回调或日志暴露。所以本方向能断言的只有三件：整段不抛错、
   * 新增的那个完全不下发，以及 `search_tools` 仍对它报 `expanded`（最后一件正是风险来源，
   * 缺少它本用例就退化为「一个从未被检索到的工具未出现」这类同义反复）。
   */
  it('run 中新挂一个工具：它不进本次 run 的 tools 数组，也不让 SDK 报 activeTools/toolSet 脱节', async () => {
    const harnessed = harness('catalog-wiring-register-midturn');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => {
      harnessed.dependencies.tools.registerExternal({ name: 'mcp__jira__create_ticket', description: '丙：新挂上来的那台 server',
        inputSchema: z.object({ luoliTicketMarker: z.string() }), minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
      return toolCall('search_tools', { names: ['mcp__jira__create_ticket'] }, 'c1');
    }];
    const events = await worker(harnessed, steps, script);
    // 而 `search_tools` 对它返回 `status:'expanded'`，这是本方向尚存的一处不实描述（docs/07 §2.2）：
    // 「下一步即可直接调用」对一个冻结的 toolSet 中不存在的键并不成立，它在本次 run 内永远发不出去。
    // 固定这条断言是为了在真正修复（重建 toolSet 或把新增名字排除出检索域）时它会失败。
    expect(matchesOf(events, 'c1')).toEqual([{ name: 'mcp__jira__create_ticket', description: '丙：新挂上来的那台 server', group: 'mcp:jira', status: 'expanded' }]);
    expect(namesOf(steps[1]!)).toEqual(['search_tools']);
    expect(JSON.stringify(steps[1]!.tools)).not.toContain('luoliTicketMarker');
    closeDatabase(harnessed.db);
  });
});

/**
 * 自愈钩子（`docs/05 §3.12` 的自愈段），现在只在 worker 这一侧。折叠使模型调用不可下发的工具从
 * 罕见幻觉变为常规事件，仅靠提示词引导等于依赖模型自行想到去检索；`repairToolCall` 把该次调用
 * 改写为 `search_tools({names:[原名]})`，代价与模型自行先检索一次相同（多一个 step）。
 *
 * 判据都用于防止死循环，因此各有一个用例：若改写为检索而检索又不推进状态，
 * 就会形成调用 X → NoSuchToolError → 改写 → 检索原地返回 → 再调用 X 的循环，直至耗尽步数上限。
 */
describe('折叠工具目录 · worker 侧的 repairToolCall 自愈', () => {
  it('硬调折叠工具：改写成一次检索，下一步那个工具的 schema 真的下发', async () => {
    const harnessed = harness('catalog-wiring-repair');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    const events = await worker(harnessed, steps, [() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c1')]);
    const interesting = logRows(harnessed.db).filter((row) => ['tool.repaired', 'tool.expanded', 'tool.call'].includes(row.kind));
    expect(interesting.map((row) => row.kind)).toEqual(['tool.repaired', 'tool.expanded', 'tool.call']);
    expect(interesting[0]!.summary).toBe('mcp__gh__create_issue → search_tools');
    expect(JSON.parse(interesting[0]!.data!)).toMatchObject({ tool: 'mcp__gh__create_issue', into: 'search_tools', reason: 'deferred_not_expanded' });
    // 真正执行的是改写后的那次调用：模型收到的结果来自 `search_tools`，而不是一次不存在的调用。
    expect(interesting[2]!.summary).toBe('search_tools');
    expect(toolResultOf(events, 'c1')?.toolName).toBe('search_tools');
    const expanded = steps[1]!.tools.find((entry) => entry.name === 'mcp__gh__create_issue')!;
    expect(JSON.stringify(expanded.inputSchema)).toContain(ISSUE_PROP);
    closeDatabase(harnessed.db);
  });

  /**
   * 防死循环闸 ①：被 skill 收窄拦截的只改写一次。`search_tools` 对它返回 `status:'narrowed'`
   * 但仍记入 `expandedTools`，这一笔正是该闸的另一半（见 `tools/catalog-meta.ts` 中的
   * 注释）：不记录时第二次强行调用又会被改写为同一次检索，形成循环。
   */
  it('skill 收窄挡着的折叠工具：只改写一次，第二次硬调落回 NoSuchToolError', async () => {
    const harnessed = harness('catalog-wiring-repair-once');
    registerResident(harnessed.dependencies.tools, 'bash', '跑一条命令');
    registerNarrowing(harnessed.dependencies.tools, ['bash']);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('load_skill', {}, 'c0'),
      () => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, 'c1'),
      () => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'y' }, 'c2')];
    await worker(harnessed, steps, script);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(1);
    // 收窄仍在拦截，因此展开之后它依旧无法下发，但它已进入展开集，第二次不再改写。
    expect(namesOf(steps[2]!)).toEqual(['bash', 'load_skill', 'search_tools']);
    // worker 侧的 `tool.error` 是 SDK 内部拦下的那类失败唯一的凭据（`ToolRegistry.execute`
    // 根本不会被调用），此前整段缺失。
    const errors = logRows(harnessed.db).filter((row) => row.kind === 'tool.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.summary).toContain('NoSuchToolError');
    expect(JSON.parse(errors[0]!.data!)).toMatchObject({ tool: 'mcp__gh__create_issue', toolCallId: 'c2' });
    closeDatabase(harnessed.db);
  });

  /**
   * 防死循环闸 ②：展开额度用满时一次都不改写。该档位下 `search_tools` 返回 `expansion_limit`
   * 且不写入 `expandedTools`，因此闸 ① 无法拦住它；而它的 hint 是使用 names 精确指定，改写产生的
   * 调用本身就是 `names:[X]`，模型按 hint 操作同样没有出路，是三者中唯一会无限循环的。
   */
  it('maxExpandedPerTurn 用满：硬调另一个折叠工具时一条 tool.repaired 都不落', async () => {
    const harnessed = harness('catalog-wiring-repair-budget', { tools: { catalog: { maxExpandedPerTurn: 1 } } } as Partial<Config>);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    const script = [() => toolCall('search_tools', { names: ['mcp__gh__create_issue'] }, 'c1'),
      () => toolCall('mcp__gh__list_issues', { [LIST_PROP]: 'open' }, 'c2')];
    await worker(harnessed, steps, script);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.expanded').map((row) => row.summary))
      .toEqual(['search_tools: 1 matched, 1 expanded']);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(0);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.error')[0]!.summary).toContain('NoSuchToolError');
    closeDatabase(harnessed.db);
  });

  /**
   * 防死循环闸 ⓿：同一个名字在本次 run 只改写一次。
   *
   * ①②③ 各自对应一种检索无法推进状态的成因，而成因不止这三种：`search_tools` 自身也可能在
   * `admit()` 处失败，包括 `tools.maxCallsPerTurn` 用满（本例）、运维把它的 `approval` 覆盖为 `always`
   * 而审批被拒、轮内连续失败达到 `maxConsecutiveErrors` 之前的那几次。这些档位一律不写入
   * `expandedTools`，因此闸 ① 永远拦不住第二次。缺少 ⓿ 时实测同一个折叠工具被连续改写 11 次，
   * 仅靠 `maxSteps` 兜底，即 11 次无效的模型调用。按名字判定一次，成因有多少种都无需枚举。
   *
   * `maxCallsPerTurn` 的计数挂在 turn 上而非 run 上，因此 worker 用掉的额度确实会耗尽本轮的份额
   * —— 这条用例同时是那件事的凭据。
   */
  it('search_tools 自己在 admit() 上失败：同一个名字只改写一次，之后落回 NoSuchToolError', async () => {
    const harnessed = harness('catalog-wiring-repair-admit-fail', {}, 40, 1);
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    // 第 0 步用掉 `maxCallsPerTurn=1` 的额度（展开另一个工具），此后每一步都强行调用同一个折叠工具。
    const script: Array<() => unknown> = [() => toolCall('search_tools', { names: ['mcp__gh__list_issues'] }, 'c0')];
    for (let index = 1; index < 6; index += 1) script.push(() => toolCall('mcp__gh__create_issue', { [ISSUE_PROP]: 'x' }, `c${index}`));
    const events = await worker(harnessed, steps, script);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(1);
    // 改写产生的那次检索自身撞上额度限制，因此展开集中只有第 0 步那一个，闸 ① 因而拦不住第二次。
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.expanded').map((row) => row.summary))
      .toEqual(['search_tools: 1 matched, 1 expanded']);
    expect(JSON.stringify(toolResultOf(events, 'c1')?.value)).toContain('tool_call_limit_exceeded');
    const failures = logRows(harnessed.db).filter((row) => row.kind === 'tool.error');
    expect(failures.map((row) => JSON.parse(row.data!) as { toolCallId: string }).map((data) => data.toolCallId))
      .toEqual(['c2', 'c3', 'c4', 'c5']);
    closeDatabase(harnessed.db);
  });

  /**
   * 防死循环闸 ③（另一半）：完全虚构的名字不改写。把一个不存在的名字送去检索只会得到空结果，
   * 而模型会认为自己已经查找过；一句明确的 `NoSuchToolError` 优于一次看似有进展的往返。
   *
   * 附带记录一项实测：SDK 的那句错误文本会把整份 active 名单写入上下文（`Available tools: …`）。
   * 折叠节省的开销在该档位会部分抵消，因此不改写的档位应尽可能窄。
   */
  it('幻觉工具名不改写，照旧走 NoSuchToolError', async () => {
    const harnessed = harness('catalog-wiring-repair-hallucinated');
    registerGithub(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await worker(harnessed, steps, [() => toolCall('nope_nope', {}, 'c1')]);
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.repaired')).toHaveLength(0);
    const errors = logRows(harnessed.db).filter((row) => row.kind === 'tool.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.summary).toContain(`AI_NoSuchToolError: Model tried to call unavailable tool 'nope_nope'. Available tools: search_tools.`);
    closeDatabase(harnessed.db);
  });
});

/**
 * `AC-TOOL-020`：目录被 `tools.maxRegistered` 静默截断这件事必须明确告知。
 *
 * 三件事各自独立：RUNTIME 中的那一行（面向模型，取自主 agent 提示词里那次 worker 视角的
 * `activeView()`）、`tool.registry_truncated` warn（面向运维，挂在 `active()` 上，因此现在由
 * 真正跑起来的 worker 落一条），以及折叠摘要中只允许出现截断后的名字（摘要中报出 `toolSet` 里
 * 不存在的名字时，模型派 worker 去展开它即产生 AI SDK 层的运行时报错）。
 */
describe('折叠工具目录 · maxRegistered 截断告知', () => {
  /** 排序为 `sourcePriority desc, name asc`，因此 `maxRegistered=2` 保留 search_tools(80) 与 aaa(40)。 */
  function registerThree(tools: ToolRegistry): void {
    for (const suffix of ['aaa', 'bbb', 'ccc']) {
      tools.registerExternal({ name: `mcp__gh__${suffix}`, description: `折叠 ${suffix}`,
        inputSchema: z.object({}), minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
    }
  }

  it('截断时 RUNTIME 有告知行、折叠摘要只列留下来的名字，worker 跑起来落一条 warn', async () => {
    const harnessed = harness('catalog-wiring-truncated', {}, 2);
    registerMainSide(harnessed.dependencies.tools);
    registerThree(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    const block = volatileOf(steps[0]!);
    expect(block).toContain('工具目录已截断：共注册 4 个，按来源优先级仅保留前 2 个，其余本轮不可用（tools.maxRegistered）。');
    // 被截断的工具一个都不得进入摘要：模型按摘要派 worker 去检索，展开得到的会是冻结 toolSet 中不存在的键。
    expect(block).toContain('- [mcp:gh] 1 个：mcp__gh__aaa');
    expect(block).not.toContain('mcp__gh__bbb');
    expect(block).not.toContain('mcp__gh__ccc');
    expect(namesOf(steps[0]!)).toEqual(['send_message']);
    // ⚠ 运维那一份凭据现在只在 worker 真的跑起来时才落。warn 只挂在 `active()` 上，而主 agent
    // 那次 `active()` 走的是它自己那份小集合（不触顶）；被截断的是 worker 的合格集，而
    // `assembleMainPrompt` 取它用的是 `activeView()`，那条路径有意不写日志（否则同一轮会按
    // `#eligible()` 的调用次数重复输出）。于是「模型看得见截断、而本轮没派 worker 时运维看不见」
    // 成立 —— 固定这条断言是为了在补上主 agent 侧那条 warn 时它会失败，而不是让这个缺口无声。
    expect(logRows(harnessed.db).filter((row) => row.kind === 'tool.registry_truncated')).toHaveLength(0);
    const workerSteps: WireStep[] = [];
    await worker(harnessed, workerSteps);
    const warns = logRows(harnessed.db).filter((row) => row.kind === 'tool.registry_truncated');
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]!.data!)).toMatchObject({ total: 4, visible: 2 });
    expect(namesOf(workerSteps[0]!)).toEqual(['search_tools']);
    closeDatabase(harnessed.db);
  });

  /**
   * 该行不受 `prompt.runtimeBlock.show.*` 控制：那三个开关决定是否显示某类状态，
   * 而这一行说明的是本轮部分工具根本不存在。三个全部关闭后它仍然存在。
   */
  it('三个 runtimeBlock 开关全关掉，截断告知行照样在', async () => {
    const harnessed = harness('catalog-wiring-truncated-show-off',
      { prompt: { runtimeBlock: { showQuota: false, showContextWatermark: false, showWorkspace: false } } } as Partial<Config>, 2);
    registerMainSide(harnessed.dependencies.tools);
    registerThree(harnessed.dependencies.tools);
    const steps: WireStep[] = [];
    await main(harnessed, steps);
    const block = volatileOf(steps[0]!);
    expect(block).toContain('工具目录已截断：共注册 4 个，按来源优先级仅保留前 2 个，其余本轮不可用（tools.maxRegistered）。');
    // 确认开关确实生效，否则上面那条断言不具备说明力。
    expect(block).not.toContain('上下文容量：');
    expect(block).not.toContain('工作目录：');
    closeDatabase(harnessed.db);
  });
});
