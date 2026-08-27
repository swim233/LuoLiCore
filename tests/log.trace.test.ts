import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { code, codeIndex, source } from './support/source.js';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { AgentManager, AgentResultStore, ContextEngine, LogSink, PromptAssembler, PromptDocuments, Sandbox, ToolRegistry, UsageLedger, configSchema, registerBuiltins, runMainAgent, runSubAgent } from '@luoli/core';
import type { ApprovalBroker, ModelRegistry, SandboxRunEvent, ToolExecutionContext } from '@luoli/core';

/**
 * trace **是一棵树**这件事的唯一防线。
 *
 * `parent_span_id` 此前在全仓只出现在四处 —— 类型声明、写库、读出、前端展示 —— **没有任何调用点
 * 传过它**：staging 库 `total 15841 / with_span 11354 / with_parent 0`，浏览器里展开一条 trace，
 * 13 个节点的 `marginLeft` 全是 `0px`。读出侧甚至修过一次，修完之后**正确地读着一个永远是 NULL
 * 的列**（docs/28 · L-LOG-04）。所以这里跑一轮假上游 + 假工具 + 假子 agent，直接查库断言
 * `docs/10 §1` 那张图的四条边真的落下来了：
 *
 * ① turn 根 → `ctx.open` / `prompt.build` / `model.call` / `ctx.commit`
 * ② `model.call` → `tool.call`
 * ③ `tool.call` → `agent.spawn` / `agent.run`
 * ④ `agent.run` → 子 agent 的 `model.call` / `agent.end`
 *
 * 单测看不见这个盲区的原因也在这里：工具与上下文的用例一律把 `LogSink` stub 成 `{span:()=>…}`，
 * 于是「有没有真的落进 log_events」从来没有人问过。这个文件用真 sink、真库。
 */

const USAGE = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
function step(content: unknown[], finish: 'stop' | 'tool-calls') {
  return { content, finishReason: { unified: finish, raw: finish }, usage: USAGE, warnings: [] };
}
function candidate(id: string, run: () => unknown) {
  return { specificationVersion: 'v4' as const, provider: 'test', modelId: id, supportedUrls: {},
    doGenerate: async () => run() as never, doStream: async () => run() as never };
}
function info(modelId: string) {
  return { id: modelId, providerId: 'p1', modelId, contextWindow: 128_000, maxOutput: 4096, capabilities: '{}',
    priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 };
}
/** 只实现 `runMainAgent` / `runSubAgent` 真正用到的那几个方法。 */
function registryFor(chains: Record<string, Array<{ model: ReturnType<typeof candidate>; info: ReturnType<typeof info> }>>): ModelRegistry {
  return {
    chain: (alias: string) => chains[alias] ?? [],
    resolve: (alias: string) => (chains[alias] ?? chains.main!)[0]!.model as unknown as LanguageModel,
    settings: () => ({}),
    aliases: () => Object.keys(chains),
    info: (alias: string) => (chains[alias] ?? [])[0]?.info ?? null,
    supportsVision: () => false,
    infoByModelId: (modelId: string) => Object.values(chains).flat().find((entry) => entry.info.modelId === modelId)?.info ?? null,
    aliasOf: (modelId: string) => Object.entries(chains).find(([, chain]) => chain.some((entry) => entry.info.modelId === modelId))?.[0] ?? null,
    markProviderDown: () => undefined,
    isDown: () => false,
    recordFailure: () => false,
    recordSuccess: () => undefined,
  } as unknown as ModelRegistry;
}

interface SpanRow { kind: string; spanId: string | null; parentSpanId: string | null; traceId: string | null }

async function runTracedTurn(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  for (const directory of [`./data/${name}-memory`, `./data/${name}-logs`, `./data/${name}-results`]) rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, quota: { requirePricing: false, enabled: false },
    memory: { dir: `./data/${name}-memory` }, approval: { enabled: false }, logs: { level: 'debug' } });
  // 真 sink、真库：level=debug 才收得到 `prompt.build` 与 `agent.progress`（两条都是 debug）。
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`, [], { level: 'debug', console: 'off' });
  const archive = new ArchiveRepository(db);
  const context = new ContextEngine(db, archive, log);
  const documents = new PromptDocuments(db, config.memory.dir);
  documents.ensure();
  const broker: ApprovalBroker = { request: async () => true };
  const tools = new ToolRegistry(log, broker, { maxRegistered: 20, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
  const agents = new AgentManager(db, new AgentResultStore(`./data/${name}-results`),
    [{ name: 'researcher', description: 'r', modelAlias: 'low', maxSteps: 2, minRole: 'limited', tools: [], resultMaxChars: 400, instructions: 'r' }], 3, 10);
  const ledger = new UsageLedger(db);
  const models = registryFor({
    main: [{ model: candidate('main-model', () => mainStep()), info: info('main-model') }],
    low: [{ model: candidate('sub-model', () => step([{ type: 'text', text: '查完了' }], 'stop')), info: info('sub-model') }],
  });

  const trigger = archive.scope('chat', null).append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in',
    fromKind: 'user', fromUserId: 'u', fromName: 'U', fromUsername: null, kind: 'text', text: '去查一下', tgDate: Date.now(),
    raw: {}, triggered: true, triggerReason: 'mention' });
  const turn = await context.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'u',
    effectiveRole: 'trusted', isPrivate: true, trigger, abortSignal: new AbortController().signal, config });

  // **派子 agent 的那个工具**：它把 `context.parentSpanId`（= 本次 `tool.call` 的 span）交给
  // `runSubAgent`，也就是 `docs/10 §7` 第 4 条那条边。真实路径是 `spawn_agent`，形状一模一样。
  tools.register({ name: 'dig', description: '派 researcher 去查', inputSchema: z.object({ q: z.string() }),
    policy: { minRole: 'limited', approval: 'never', scope: 'workspace', source: 'builtin' }, sourcePriority: 100, timeoutMs: null,
    execute: async (input, executionContext: ToolExecutionContext) => {
      const parent = agents.createMain(turn.turnId, 'trusted', 'main');
      const spawned = agents.spawn(parent, 'researcher', `${input.q} —— 这段任务足够长了`);
      const result = await runSubAgent(spawned.run, spawned.definition, input.q, undefined, turn,
        { db, agents, registry: models, tools, ledger, log, workspace: './data',
          ...(executionContext.parentSpanId ? { parentSpanId: executionContext.parentSpanId } : {}) });
      return { ok: true, summary: result.summary };
    } });

  let calls = 0;
  const mainStep = (): unknown => {
    calls += 1;
    if (calls === 1) return step([{ type: 'tool-call', toolCallId: 'call-1', toolName: 'dig', input: JSON.stringify({ q: '洛璃' }) }], 'tool-calls');
    // 第二步顺手给一个非法参数的工具调用：`tool.error` 走的是 AI SDK 内部校验那一路，
    // `ToolRegistry.execute` 根本不会被调到（docs/28 · L-LOG-03）。
    if (calls === 2) return step([{ type: 'tool-call', toolCallId: 'call-2', toolName: 'dig', input: JSON.stringify({ q: 42 }) }], 'tool-calls');
    return step([{ type: 'text', text: '查到了' }], 'stop');
  };

  const answer = await runMainAgent(turn, { config, db, registry: models, tools, prompts: new PromptAssembler(), documents,
    ledger, log, workspace: './data', context, agents });
  context.appendDelta(turn, { id: turn.turnId, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: answer || '空' }], pruneLevel: 0 });
  await context.commitTurn(turn);

  const rows = db.prepare('SELECT kind,span_id AS spanId,parent_span_id AS parentSpanId,trace_id AS traceId FROM log_events ORDER BY id').all() as SpanRow[];
  return { db, log, turn, rows, answer };
}

const of = (rows: SpanRow[], kind: string): SpanRow[] => rows.filter((row) => row.kind === kind);
const one = (rows: SpanRow[], kind: string): SpanRow => {
  const found = of(rows, kind);
  expect(found.length, `期望恰好一条 ${kind}，实际 ${found.length} 条`).toBe(1);
  return found[0]!;
};

describe('trace 是一棵真的树', () => {
  it('四条边全部落库，且父子 kind 对得上', async () => {
    const { db, turn, rows } = await runTracedTurn('log-trace-tree');
    // 这一条是整节的判据：全库为 NULL 正是 L-LOG-04 的实测结果。
    expect(rows.filter((row) => row.parentSpanId !== null).length, 'with_parent 仍然是 0').toBeGreaterThan(0);
    const root = turn.rootSpanId!;
    expect(root, 'openTurn 没有生成 trace 根').toBeTruthy();

    // ① turn 根 → 轮次级事件。
    for (const kind of ['ctx.open', 'prompt.build', 'ctx.commit']) {
      expect(one(rows, kind).parentSpanId, `${kind} 没挂在 turn 根上`).toBe(root);
      expect(one(rows, kind).traceId, `${kind} 没进这一轮的 trace`).toBe(turn.turnId);
    }
    const modelCalls = of(rows, 'model.call');
    // 主 agent 三步 + 子 agent 一步。
    expect(modelCalls.length).toBe(4);
    const mainCalls = modelCalls.filter((row) => row.parentSpanId === root);
    expect(mainCalls.length, '主 agent 的 model.call 没挂在 turn 根上').toBe(3);

    // ② `model.call` → `tool.call`：同一步内的工具调用共享那一步的 span。
    const toolCall = one(rows, 'tool.call');
    expect(mainCalls.map((row) => row.spanId)).toContain(toolCall.parentSpanId);

    // ③ `tool.call` → 子 agent。
    expect(one(rows, 'agent.spawn').parentSpanId).toBe(toolCall.spanId);
    const agentRun = one(rows, 'agent.run');
    expect(agentRun.parentSpanId, 'agent.run 没挂在派发它的 tool.call 之下').toBe(toolCall.spanId);

    // ④ `agent.run` → 子 agent 内部。
    const subCalls = modelCalls.filter((row) => row.parentSpanId === agentRun.spanId);
    expect(subCalls.length, '子 agent 的 model.call 没挂在 agent.run 之下').toBe(1);
    expect(one(rows, 'agent.end').parentSpanId).toBe(agentRun.spanId);
    expect(of(rows, 'agent.progress').every((row) => row.parentSpanId === agentRun.spanId)).toBe(true);

    // 每一条带父的行，父都要么是本轮某个真实 span，要么是 turn 根 —— 悬挂父意味着某处传错了。
    const spans = new Set(rows.map((row) => row.spanId).filter((id): id is string => id !== null));
    spans.add(root);
    const dangling = rows.filter((row) => row.parentSpanId && !spans.has(row.parentSpanId)).map((row) => row.kind);
    expect(dangling, '这些行的 parent_span_id 指向一个不存在的 span').toEqual([]);
    closeDatabase(db);
  });

  /**
   * `AC-LOG-003` 要「展开任一 `tool.call` 能看出…是否经审批」，而这份载荷此前只有 `{input}` ——
   * 两个字段一个都不在。「是否沙箱」由挂在它之下的 `sandbox.run` 子行回答（上一条用例）；
   * 「是否经审批」在别处**无从得知**：不需要审批的调用在 `approvals` 表里根本没有行，
   * 「没找到行」与「这张表没记上」长得一模一样。
   */
  it('tool.call 的载荷说得出这次要不要审批', async () => {
    const { db } = await runTracedTurn('log-trace-approval');
    const payload = db.prepare("SELECT data_json AS data FROM log_events WHERE kind='tool.call'").pluck().get() as string;
    expect(JSON.parse(payload)).toMatchObject({ approval: { required: false } });
    closeDatabase(db);
  });

  it('模型给非法工具参数时落一条 tool.error，而 tool.call 一条都不多', async () => {
    const { db, rows } = await runTracedTurn('log-trace-tool-error');
    // AI SDK 在内部就把 `{q: 42}` 拒了（`AI_InvalidToolInputError`），`ToolRegistry.execute` 没被调到 ——
    // 所以 `tool.call` 只有成功那一次，而这条 `tool.error` 是唯一的痕迹（docs/28 · L-LOG-03）。
    expect(of(rows, 'tool.call')).toHaveLength(1);
    const error = one(rows, 'tool.error');
    expect(error.traceId).toBeTruthy();
    const payload = db.prepare("SELECT level,data_json AS data FROM log_events WHERE kind='tool.error'").get() as { level: string; data: string };
    expect(payload.level).toBe('warn');
    expect(JSON.parse(payload.data)).toMatchObject({ tool: 'dig', toolCallId: 'call-2' });
    // 它挂在**那一步**的 model.call 之下，不是挂在 turn 根上。
    expect(of(rows, 'model.call').map((row) => row.spanId)).toContain(error.parentSpanId);
    closeDatabase(db);
  });

  it('子 agent 的花费与 model.call 记的是同一个候选', async () => {
    const { db, rows } = await runTracedTurn('log-trace-served');
    const summaries = db.prepare("SELECT summary FROM log_events WHERE kind='model.call' ORDER BY id").pluck().all() as string[];
    // 摘要里写的是**真正出力的那个候选**（provider/model），而不是 AI SDK 报的链首（docs/28 · L-PROV-01）。
    expect(summaries.filter((summary) => summary === 'p1/main-model')).toHaveLength(3);
    expect(summaries.filter((summary) => summary === 'p1/sub-model')).toHaveLength(1);
    // 没有 fallback 时 level 不许被抬成 warn。
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='model.call' AND level='warn'").pluck().get()).toBe(0);
    expect(of(rows, 'model.call')).toHaveLength(4);
    closeDatabase(db);
  });

  /**
   * `turn.start` / `turn.end` 由两个**开轮入口**发，而它们各自要起一个真进程才跑得起来 ——
   * 所以这一条是源码级断言（先例：`regression.round10.test.ts` 的「非流式兜底路径也带引用」）。
   * 判据本身很硬：根 span 只能由 `turn.start` 声明，否则整棵树没有根。
   */
  /**
   * `docs/29 · M-LOG-02`：`sandbox.run` 有 `turnId` 但**没有 `parentSpanId`** —— 注释自承
   * 「`turnId` 让它进得了那一轮的 trace」，进得了 trace 却**进不了树**。Trace 视图按
   * `parentSpanId` 算缩进，于是它被画在 0px、与 `turn.start` 同级；一轮里 3 次 `tool.call python`
   * 对应的 3 条 `sandbox.run` 只能按时间戳猜配对，并发沙箱调用时连时间戳都不够。
   *
   * 走的是**真的** `registerBuiltins` + 真的 `Sandbox`：自己在用例里拼一个 `sandbox.run(...)`
   * 只能证明 `Sandbox` 会回声这个字段，证明不了 `bash` 那条路真的把它递了下去 —— 而漏掉的
   * 正是「递下去」这一步。
   */
  it('sandbox.run 挂在调用它的那次 tool.call 之下，而不是 depth 0', async () => {
    const runs: SandboxRunEvent[] = [];
    const spans: string[] = [];
    let seq = 0;
    // 记下每条 span 的 id：判据是「`sandbox.run` 的父 = 那次 `tool.call` 自己的 span」，
    // 而 `tool.call` 是这里唯一会开的 span。
    const log = { span: () => { const id = `span-${seq += 1}`; spans.push(id); return { id, end: () => undefined }; }, event: () => undefined } as unknown as LogSink;
    // owner + bypassRoles 含 owner = 直接在宿主上跑，不需要 docker。
    const sandbox = new Sandbox({ mode: 'none', bypassRoles: ['owner'], dockerBin: 'docker', image: 'none', network: 'none',
      memoryMb: 128, cpus: 1, pidsLimit: 16, readOnlyRoot: true, tmpfsMb: 8, workspaceDir: './data', hostWorkspaceDir: '',
      defaultTimeoutMs: 10_000, maxTimeoutMs: 10_000, maxOutputBytes: 4096 }, false, false, undefined, undefined, (event) => runs.push(event));
    const registry = new ToolRegistry(log, { request: async () => true } as ApprovalBroker, { maxRegistered: 200, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    // `schedule.deliverable` 是 `available()` 里被无条件调的 —— 缺了它 `active()` 整个抛，
    // 而那个抛在 `#eligible` 里被吞掉，表现是 `bash` 静静地不在目录里。
    registerBuiltins(registry, { sandbox, log, schedule: { deliverable: () => false } } as never);
    const turn = { turnId: 'trace-sandbox', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner',
      isPrivate: true, baseCommitId: null, config: configSchema.parse({ access: { bootstrapOwnerId: '1' } }),
      snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal };
    const done = await registry.execute('bash', { command: 'echo trace-probe', description: '探针' }, { turn, workspace: './data', agentKind: 'main' } as never);
    expect(done, `bash 没跑起来：${JSON.stringify(done)}`).toMatchObject({ ok: true });

    expect(spans, '这次调用没开出 tool.call 的 span').toHaveLength(1);
    expect(runs, '沙箱一次都没被调到').toHaveLength(1);
    expect(runs[0]!.parentSpanId, 'sandbox.run 仍然没有父 —— 在 Trace 视图里会画在 depth 0').toBe(spans[0]);
  }, 30_000);

  it('两个开轮入口都把 turn.start 的 spanId 设成 trace 根', () => {
    for (const path of ['packages/telegram/src/bot.ts', 'packages/core/src/schedule/runner.ts']) {
      const text = source(path);
      const at = codeIndex(text, "kind: 'turn.start'");
      expect(at, `${path} 里找不到 turn.start`).toBeGreaterThan(0);
      // 取一个窗口而不是「同一行」：那次 `.event({...})` 本来就跨着七八行，「同一行」这个判据
      // 只在 `kind` 与 `spanId` 恰好挤在一起时成立 —— 换个 printWidth 就不成立了。
      const call = text.slice(at, at + 500);
      expect(call, `${path} 的 turn.start 没有把 spanId 设成 turn.rootSpanId`).toContain(code('spanId: turn.rootSpanId'));
      expect(call, `${path} 的 turn.start 没带 waitedMs`).toContain(code('waitedMs'));
      // `turn.queued` 只在真的排过队时才落 —— 无条件记等于每轮多一行 info（docs/10 §2）。
      expect(text).toContain(code("kind: 'turn.queued'"));
      expect(text).toContain(code('.available('));
    }
  });
});
