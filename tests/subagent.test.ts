import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { code, codeIndex, source } from './support/source.js';
import { AgentManager, AgentResultStore, LogSink, ToolRegistry, UsageLedger, configSchema, newToolScope, registerCatalogTools, runLwWorker } from '@luoli/core';
import type { ModelRegistry, ToolExecutionContext } from '@luoli/core';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import type { RuntimeTurnContext } from '@luoli/shared';

function harness() {
  const path = './data/subagent.test.db';
  const results = './data/subagent-results';
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(results, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  return { db, manager: new AgentManager(db, new AgentResultStore(results), 10) };
}

describe('worker contracts', () => {
  it('有效角色照抄父 run，结果按给定上限截断且 transcript 不进上下文', () => {
    const { db, manager } = harness();
    const limited = manager.createMain('turn-limited', 'limited', 'main');
    // 旧口径会把它收窄到 `min(父, definition.minRole)`；现在 worker 是主 agent 的执行面，收窄它
    // 等于让主 agent 用得到的工具在它手里报权限不足。
    expect(manager.spawn(limited, 'complete this task', 'low').effectiveRole).toBe('limited');
    const trusted = manager.createMain('turn-trusted', 'trusted', 'main');
    const run = manager.spawn(trusted, 'complete this research task', 'low');
    expect(run.effectiveRole).toBe('trusted');
    // 上限由调用方给出（`summary` 档取 `agent.worker.resultMaxChars`，`full` 档取 `maxResultChars`）。
    const result = manager.finish(run, 'abcdef', 4);
    expect(result).toMatchObject({ summary: 'abcd', truncated: true });
    expect(manager.result(run.id, 2, 3)).toEqual({ content: 'cde', nextOffset: 5 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count).toBe(0);
    closeDatabase(db);
  });

  it('keeps ask and answer as distinct audit rows', () => {
    const { db, manager } = harness();
    const parent = manager.createMain('turn-ask', 'trusted', 'main');
    const run = manager.spawn(parent, 'complete this research task', 'low');
    const ask = manager.ask(run, parent, { question: 'which?' });
    manager.answer(ask, 'safe', 'rule');
    const rows = db.prepare('SELECT kind,payload_json AS payload FROM agent_messages ORDER BY created_at,id').all() as Array<{ kind: string; payload: string }>;
    expect(rows.map((row) => row.kind).sort()).toEqual(['answer', 'ask']);
    expect(rows.find((row) => row.kind === 'ask')?.payload).toContain('which');
    expect(rows.find((row) => row.kind === 'answer')?.payload).toContain('safe');
    closeDatabase(db);
  });

  it('records timeout answers without overwriting the ask', () => {
    const { db, manager } = harness();
    const parent = manager.createMain('turn-timeout', 'trusted', 'main');
    const run = manager.spawn(parent, 'complete this research task', 'low');
    const ask = manager.ask(run, parent, { question: 'need input' });
    manager.answer(ask, null, 'timeout');
    expect(db.prepare('SELECT state FROM agent_messages WHERE id=?').pluck().get(ask)).toBe('timeout');
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages WHERE kind='answer'").pluck().get()).toBe(1);
    closeDatabase(db);
  });

  it('keeps an interrupted main run failed when its final result arrives late', () => {
    const { db, manager } = harness();
    const run = manager.createMain('turn-interrupted', 'trusted', 'main');
    manager.fail(run, 'stream_interrupted');
    manager.finish(run, 'late completion', 4000);
    expect(db.prepare('SELECT state,error,result_summary FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({
      state: 'failed',
      error: 'stream_interrupted',
      result_summary: null,
    });
    closeDatabase(db);
  });
});

/**
 * 渐进披露的三个集合挂在**本次 run** 上（`newToolScope()`），不挂在 turn 上。
 *
 * 这是 per-run 改造的核心判据：worker 与主轮共享同一个 `turn` 对象，三个集合写在 turn 上时
 * ① 两个并行 worker 会互相看见对方展开的工具，② 一个 worker 载入带 `allowed-tools` 的 skill
 * 会去收窄**主轮**（`docs/05 §3.12` 不变量 4）。共享一份 Set 时这一族必红。
 */
describe('worker 的展开集与收窄集是 per-run 的', () => {
  const MCP_A = 'mcp__fixture__alpha';
  const MCP_B = 'mcp__fixture__beta';
  const ok = { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
  type ToolSpec = { type: string; name: string };
  type Call = { prompt: Array<{ content: unknown }>; tools?: ToolSpec[] };

  function wired(slug: string) {
    const path = `./data/${slug}.test.db`;
    const results = `./data/${slug}-results`;
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmSync(results, { recursive: true, force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, quota: { requirePricing: false }, approval: { enabled: false } });
    const log = new LogSink(new OperationsRepository(db));
    // 折叠开着才有可折叠的东西：`search_tools` 的第二道闸问的正是 `hasDeferrable`。
    const tools = new ToolRegistry(log, { request: async () => true },
      { maxRegistered: 20, maxCallsPerTurn: 10, maxConsecutiveErrors: 3, catalog: { deferExternal: true } });
    registerCatalogTools(tools, { log });
    for (const name of [MCP_A, MCP_B])
      tools.registerExternal({ name, description: `${name} 的说明`, inputSchema: z.object({ text: z.string() }),
        minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
    const turn: RuntimeTurnContext = { turnId: 'turn-per-run', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted',
      isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
      abortSignal: new AbortController().signal, config };
    // 每一步记下这次请求真正带上的工具名 —— SDK 先按 `activeTools` 过滤 toolSet 再发出去，
    // 因此这个数组就是「本步可发出的工具集」，比断言我们自己算出来的中间量更实。
    const seen: Array<{ task: string; tools: string[] }> = [];
    /**
     * B 的最后一步必须发生在 A 展开之后，否则「B 看不到 alpha」可能只是因为 B 先跑完了 ——
     * 那样这条用例在共享一份 `expandedTools` 时也照样绿，等于什么都不挡。
     */
    let expanded: () => void = () => undefined;
    const afterExpansion = new Promise<void>((settle) => { expanded = settle; });
    tools.register({ name: 'hold_the_line', description: '', inputSchema: z.object({}),
      policy: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'builtin' }, sourcePriority: 100,
      execute: async () => { await afterExpansion; return { ok: true }; } });
    const taskOf = (call: Call): string => JSON.stringify(call.prompt).includes('alpha') ? 'A' : 'B';
    const model = { specificationVersion: 'v4' as const, provider: 'test', modelId: 'low-1', supportedUrls: {},
      doGenerate: async (call: Call) => {
        const task = taskOf(call);
        seen.push({ task, tools: (call.tools ?? []).map((entry) => entry.name) });
        const step = seen.filter((entry) => entry.task === task).length;
        if (task === 'A') {
          // 第一步检索并展开 alpha；第二步（展开已经落进它自己那份集合）放 B 继续。
          if (step === 1) return { ...ok, content: [{ type: 'tool-call', toolCallId: 'a1', toolName: 'search_tools', input: JSON.stringify({ names: [MCP_A] }) }] } as never;
          expanded();
          return ok as never;
        }
        if (step === 1) return { ...ok, content: [{ type: 'tool-call', toolCallId: 'b1', toolName: 'hold_the_line', input: '{}' }] } as never;
        return ok as never;
      },
      doStream: async () => ok as never };
    const info = { id: 'low-1', providerId: 'p1', modelId: 'low-1', contextWindow: 128_000, maxOutput: 4096,
      capabilities: JSON.stringify({ vision: false }), priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 };
    const registry = { resolve: () => model as unknown as LanguageModel, settings: () => ({}), info: () => info,
      infoByModelId: (id: string) => id === 'low-1' ? info : null, supportsVision: () => false } as unknown as ModelRegistry;
    const manager = new AgentManager(db, new AgentResultStore(results), 10);
    return { db, config, log, tools, turn, seen, registry, manager, ledger: new UsageLedger(db) };
  }

  it('A 展开的工具不在 B 的 activeTools 里，也没写进父轮', async () => {
    const { db, log, tools, turn, seen, registry, manager, ledger } = wired('worker-per-run');
    const parent = manager.createMain(turn.turnId, 'trusted', 'main');
    const dependencies = { db, agents: manager, registry, tools, ledger, log, workspace: './data' };
    await Promise.all([
      runLwWorker(manager.spawn(parent, 'go read alpha for me please', 'low'), 'go read alpha for me please', undefined, turn, dependencies),
      runLwWorker(manager.spawn(parent, 'wait until the other one is done', 'low'), 'wait until the other one is done', undefined, turn, dependencies),
    ]);
    const stepsOf = (task: string) => seen.filter((entry) => entry.task === task);
    // A 检索之前看不到 alpha（它是折叠的），检索之后的那一步能发出它。
    expect(stepsOf('A')[0]!.tools).not.toContain(MCP_A);
    expect(stepsOf('A').at(-1)!.tools).toContain(MCP_A);
    // B 从头到尾一次都不该看到它 —— 共享一个 `expandedTools` 时这一行必红。
    // B 的最后一步由 `hold_the_line` 顶在 A 展开之后，所以这不是「B 先跑完了」。
    expect(stepsOf('B').length).toBeGreaterThan(1);
    expect(stepsOf('B').every((entry) => !entry.tools.includes(MCP_A))).toBe(true);
    // 谁都没展开过 beta。
    expect(seen.every((entry) => !entry.tools.includes(MCP_B))).toBe(true);
    // 父轮一个字都没被写 —— `RuntimeTurnContext` 上已经没有这三个集合了。
    expect((turn as unknown as Record<string, unknown>).expandedTools).toBeUndefined();
    expect((turn as unknown as Record<string, unknown>).skillAllowedTools).toBeUndefined();
    expect((turn as unknown as Record<string, unknown>).loadedSkills).toBeUndefined();
    closeDatabase(db);
  });

  /**
   * skill 收窄那一半。走 `admit()` 而不是真载入一个 skill：判据是**这一份收窄归谁**，
   * 而 `load_skill` 把它写进 `context.skillAllowedTools` 的那一行由下面的源码断言钉住。
   */
  it('一个 worker 的 skill 收窄集不影响共享同一个 turn 的另一侧', () => {
    const { db, tools, turn } = wired('worker-per-run-skill');
    const a: ToolExecutionContext = { turn, workspace: './data', agentKind: 'lw', ...newToolScope() };
    const b: ToolExecutionContext = { turn, workspace: './data', agentKind: 'lw', ...newToolScope() };
    a.skillAllowedTools.add('read_file');
    expect(tools.admit(MCP_A, a)).toMatchObject({ ok: false, reason: 'skill_narrowed' });
    expect(tools.admit(MCP_A, b)).toMatchObject({ ok: true });
    expect(b.skillAllowedTools.size).toBe(0);
    closeDatabase(db);
  });

  /**
   * `load_skill` 的两条落点。判据长在源码结构上：正文进谁的消息序列这件事，行为化要装一整套
   * SkillLoader + ContextEngine 才看得见，而真正会退化的是这两行本身。
   */
  it('load_skill 写的是 per-run 的那份，正文只在主 agent 一档才 appendDelta', () => {
    const body = source('packages/core/src/tools/builtins.ts');
    expect(body).toContain(code('if (context.loadedSkills.has(input.name))'));
    expect(body).toContain(code('context.loadedSkills.add(input.name);'));
    expect(body).toContain(code('for (const name of allowed) context.skillAllowedTools.add(name);'));
    // 写进 turn 就是往主轮的收窄集里写。
    expect(body).not.toContain(code('context.turn.skillAllowedTools'));
    expect(body).not.toContain(code('context.turn.loadedSkills'));
    // 正文的 appendDelta 必须排在 `agentKind === "main"` 之后：worker 那一档靠工具返回值把正文
    // 带进它自己的消息序列，走 appendDelta 会把它写进主 agent 的上下文并持久化。
    const gate = codeIndex(body, 'if (context.agentKind === "main")');
    const append = codeIndex(body, 'dependencies.context.appendDelta(context.turn, { id: crypto.randomUUID(), role: "user", origin: "note", parts: [ { type: "text", text: `${NOTE_PREFIX}以下是 Skill');
    expect(gate).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(gate);
    closeDatabase(wired('worker-per-run-source').db);
  });
});

/**
 * worker 是叶子（`docs/04 §3.3`）。真正的闸是 `toolCallableBy()`：三个派发工具都在
 * `MAIN_ONLY_TOOLS` 里，因此 worker 侧既拿不到目录项也过不了 `admit()`。
 */
describe('worker 是叶子', () => {
  function bench(slug: string) {
    const path = `./data/${slug}.test.db`;
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: false } });
    const log = new LogSink(new OperationsRepository(db));
    const tools = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 50, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    for (const name of ['spawn_worker', 'spawn_harness', 'spawn_acp', 'read_worker_result'])
      tools.register({ name, description: '', inputSchema: z.object({}), policy: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' }, sourcePriority: 90, execute: () => ({ ok: true }) });
    const turn: RuntimeTurnContext = { turnId: `turn-${slug}`, key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner',
      isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
      abortSignal: new AbortController().signal, config };
    return { db, tools, turn };
  }

  it('worker 侧 admit 三个派发工具一律拒，主 agent 侧照旧放行', () => {
    const { db, tools, turn } = bench('worker-leaf-admit');
    const worker: ToolExecutionContext = { turn, workspace: './data', agentKind: 'lw', ...newToolScope() };
    const main: ToolExecutionContext = { turn, workspace: './data', agentKind: 'main', ...newToolScope() };
    for (const name of ['spawn_worker', 'spawn_harness', 'spawn_acp', 'read_worker_result']) {
      expect(tools.admit(name, worker), name).toMatchObject({ ok: false, error: 'tool_unavailable_for_worker', reason: 'worker' });
      expect(tools.admit(name, main), name).toMatchObject({ ok: true });
    }
    // 目录一侧同源：`#eligible()` 与 `admit()` 用的是同一个 `toolCallableBy()`。
    expect(tools.activeNames('owner', worker)).toEqual([]);
    expect(tools.activeNames('owner', main).sort()).toEqual(['read_worker_result', 'spawn_acp', 'spawn_harness', 'spawn_worker']);
    closeDatabase(db);
  });

  it('AgentManager.spawn 还有一条兜底的 depth 判据', () => {
    const { db, manager } = harness();
    const main = manager.createMain('turn-leaf', 'trusted', 'main');
    const worker = manager.spawn(main, 'a task that would like to delegate', 'low');
    expect(() => manager.spawn(worker, 'a nested task', 'low')).toThrow('worker 不能再派发 worker');
    closeDatabase(db);
  });
});

/**
 * `spawn_worker` 的两个档位与那层信封。
 *
 * `untrustedOutput: true` 是这一层的本体：worker 是外部内容进主上下文的唯一通道，它读过的网页
 * 与文件在它那侧是包过的，写成产出交回来就洗白了。两个档位都要包 —— `full` 只是更长，不是更可信。
 */
describe('spawn_worker 的 resultMode 与不可信信封', () => {
  it('summary 截到 resultMaxChars，full 截到 maxResultChars，两档都带信封', async () => {
    const { db, manager } = harness();
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: false },
      agent: { worker: { resultMaxChars: 8, maxResultChars: 40 } } });
    const log = new LogSink(new OperationsRepository(db));
    const tools = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 10, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    const parent = manager.createMain('turn-result-mode', 'trusted', 'main');
    const long = 'x'.repeat(100);
    // 注册一个与 `spawn_worker` 同形的壳：判据是 `untrustedOutput` 与两档上限怎么落到 `finish()` 上，
    // 而真正跑一个 worker 需要一整套假上游 —— 那是上面那一族在测的东西。
    tools.register({ name: 'spawn_worker', description: '', untrustedOutput: true,
      inputSchema: z.object({ resultMode: z.enum(['summary', 'full']).default('summary') }),
      policy: { minRole: 'limited', approval: 'never', scope: 'chat', source: 'agent' }, sourcePriority: 90,
      execute: (input) => {
        const worker = config.agent.worker;
        const run = manager.spawn(parent, `task ${input.resultMode}`, 'low');
        return { ok: true, ...manager.finish(run, long, input.resultMode === 'full' ? worker.maxResultChars : worker.resultMaxChars) };
      } });
    const turn: RuntimeTurnContext = { turnId: 'turn-result-mode', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted',
      isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
      abortSignal: new AbortController().signal, config };
    const context: ToolExecutionContext = { turn, workspace: './data', agentKind: 'main', ...newToolScope() };
    const summary = await tools.execute('spawn_worker', { resultMode: 'summary' }, context) as { content: string };
    const full = await tools.execute('spawn_worker', { resultMode: 'full' }, context) as { content: string };
    // 两档都经 `untrusted()` 包装：随机 nonce 的开闭标记，模型据此知道边界内是数据不是指令。
    for (const output of [summary, full]) {
      expect(String(output.content)).toContain('<untrusted-content');
      expect(String(output.content)).toContain('</untrusted-content');
    }
    // summary 截到 8，full 不截到 8 —— 但仍按构造有界（40），不是无上限。
    const rows = db.prepare("SELECT result_summary AS text FROM agent_runs WHERE worker_kind='lw' ORDER BY started_at,id").all() as Array<{ text: string }>;
    expect(rows.map((row) => row.text.length)).toEqual([8, 40]);
    closeDatabase(db);
  });
});

/**
 * `allowedDirs` 为空且未开 `workspaceFallback` 时，两条外部路径**都不进工具目录**。
 *
 * 这是缺省工作目录那件事唯一的安全断言，两条要成对写：只改了 `spawn_harness` 而漏掉 `spawn_acp`
 * 的话，一个本应整体关闭的功能会从另一条路上开着（`docs/04 §6.1.1`、`docs/14` T8/T17）。
 */
describe('外部 worker 的目录白名单为空 = 整体关闭', () => {
  const spec = (patch: Record<string, unknown>) => configSchema.parse({ access: { bootstrapOwnerId: '1' }, approval: { enabled: false },
    agent: { harness: patch.harness ?? {}, acp: patch.acp ?? {} } });

  function catalog(config: ReturnType<typeof spec>, slug: string) {
    const path = `./data/${slug}.test.db`;
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db));
    const tools = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 50, maxCallsPerTurn: 10, maxConsecutiveErrors: 3 });
    // 只装这两个工具的壳。**这里的 `available()` 是 `builtins.ts` 那两条的副本**，因此本组用例
    // 问的是「注册表拿到这样一条判据时会不会把工具挡在目录外」，**不是**「生产代码里那条判据还在不在」
    // —— 副本与原件之间没有任何东西相连，删掉生产那一条这几条照样绿。原件由下面那条源码级断言守。
    tools.register({ name: 'spawn_harness', description: '', inputSchema: z.object({}),
      policy: { minRole: 'owner', approval: 'always', scope: 'global', source: 'agent' }, sourcePriority: 90,
      available: (role, context) => {
        const harness = (context.turn.config as typeof config).agent.harness;
        return role === 'owner' && context.turn.isPrivate && (harness.allowedDirs.length > 0 || harness.workspaceFallback);
      },
      execute: () => ({ ok: true }) });
    tools.register({ name: 'spawn_acp', description: '', inputSchema: z.object({}),
      policy: { minRole: 'owner', approval: 'always', scope: 'global', source: 'agent' }, sourcePriority: 90,
      available: (role, context) => {
        const acp = (context.turn.config as typeof config).agent.acp;
        return role === 'owner' && context.turn.isPrivate && acp.enabled
          && (acp.allowedDirs.length > 0 || acp.workspaceFallback) && acp.agents.some((agent) => agent.enabled);
      },
      execute: () => ({ ok: true }) });
    const turn: RuntimeTurnContext = { turnId: `turn-${slug}`, key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'owner',
      isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
      abortSignal: new AbortController().signal, config };
    const context: ToolExecutionContext = { turn, workspace: './data', agentKind: 'main', ...newToolScope() };
    return { db, names: tools.activeNames('owner', context) };
  }

  it('两条路都不进目录', () => {
    const { db, names } = catalog(spec({ acp: { enabled: true, agents: [{ name: 'omp', command: 'omp', enabled: true }] } }), 'external-off');
    expect(names).not.toContain('spawn_harness');
    expect(names).not.toContain('spawn_acp');
    closeDatabase(db);
  });

  it('各自开了 workspaceFallback 之后各自回到目录里', () => {
    const { db, names } = catalog(spec({ harness: { workspaceFallback: true },
      acp: { enabled: true, workspaceFallback: true, agents: [{ name: 'omp', command: 'omp', enabled: true }] } }), 'external-fallback');
    expect(names).toContain('spawn_harness');
    expect(names).toContain('spawn_acp');
    closeDatabase(db);
  });

  it('列了目录同样进得来 —— 两个条件是「或」', () => {
    const { db, names } = catalog(spec({ harness: { allowedDirs: [resolve('./data')] },
      acp: { enabled: true, allowedDirs: [resolve('./data')], agents: [{ name: 'omp', command: 'omp', enabled: true }] } }), 'external-dirs');
    expect(names).toContain('spawn_harness');
    expect(names).toContain('spawn_acp');
    closeDatabase(db);
  });

  /**
   * 生产代码里那两条 `available()` **还在**。
   *
   * 上面三条跑的是副本，装不起真的 `spawn_harness` / `spawn_acp`：它们的注册要一整套依赖
   * （AcpManager、sandbox.plan、approvals broker、telegram 卡片）。装配这套依赖是 `composeRuntime`
   * （`apps/bot/src/compose.ts`）的事，用例不重做一遍。判据因此长在源码结构上，按 `CLAUDE.md`
   * 走 `source()` / `code()`。
   *
   * 实测过它会咬人：把 `builtins.ts` 里那个析取整段换成 `true`，上面三条**一条都不红**，
   * 这一条红。缺了它，本次唯一一处放宽准入的改动就没有任何判据在守
   * —— 而「声称一个不存在的保证比没有保证更糟」（`docs/05 §4`）。
   */
  it('生产代码的 available() 里那道「白名单为空且未开 fallback 即整体关闭」还在', () => {
    const text = source('packages/core/src/tools/builtins.ts');
    for (const snippet of [
      'harness.allowedDirs.length > 0 || harness.workspaceFallback',
      'acp.allowedDirs.length > 0 || acp.workspaceFallback',
    ]) {
      expect(text, `builtins.ts 里找不到 ${snippet} —— 缺省工作目录那件事只有这一道闸`
        + '（owner + 仅私聊、一次审批是另外两道，docs/14 T8/T17）').toContain(code(snippet));
    }
    // owner + 仅私聊那两道一并钉住：它们这次一个字都不该改。
    expect(codeIndex(text, 'role === "owner" && context.turn.isPrivate'), 'harness 的准入门变了').toBeGreaterThan(-1);
  });
});
