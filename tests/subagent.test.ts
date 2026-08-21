import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { AgentManager, AgentResultStore, LogSink, ToolRegistry, UsageLedger, configSchema, registerCatalogTools, runSubAgent } from '@luoli/core';
import type { ModelRegistry, ToolExecutionContext } from '@luoli/core';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import type { RuntimeTurnContext } from '@luoli/shared';

function harness() {
  const path = './data/subagent.test.db';
  const results = './data/subagent-results';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(results, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const manager = new AgentManager(db, new AgentResultStore(results), [{ name: 'researcher', description: 'r', modelAlias: 'low', maxSteps: 3, minRole: 'limited', tools: [], resultMaxChars: 4, instructions: 'r' }, { name: 'coder', description: 'c', modelAlias: 'high', maxSteps: 3, minRole: 'trusted', tools: [], resultMaxChars: 100, instructions: 'c' }], 3, 10);
  return { db, manager };
}

describe('subagent contracts', () => {
  it('enforces role, depth and result paging without putting transcript in context', () => {
    const { db, manager } = harness();
    const limited = manager.createMain('turn-limited', 'limited', 'main');
    expect(() => manager.spawn(limited, 'coder', 'complete this coding task')).toThrow('权限不足');
    const trusted = manager.createMain('turn-trusted', 'trusted', 'main');
    const { run } = manager.spawn(trusted, 'researcher', 'complete this research task');
    expect(run.effectiveRole).toBe('limited');
    const result = manager.finish(run, 'abcdef');
    expect(result).toMatchObject({ summary: 'abcd', truncated: true });
    expect(manager.result(run.id, 2, 3)).toEqual({ content: 'cde', nextOffset: 5 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count).toBe(0);
    closeDatabase(db);
  });

  it('keeps ask and answer as distinct audit rows', () => {
    const { db, manager } = harness();
    const parent = manager.createMain('turn-ask', 'trusted', 'main');
    const { run } = manager.spawn(parent, 'researcher', 'complete this research task');
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
    const { run } = manager.spawn(parent, 'researcher', 'complete this research task');
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
    manager.finish(run, 'late completion');
    expect(db.prepare('SELECT state,error,result_summary FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({
      state: 'failed',
      error: 'stream_interrupted',
      result_summary: null,
    });
    closeDatabase(db);
  });
});

/**
 * `AC-TOOL-052`：子 agent 的目录**不受折叠影响**。
 *
 * `definition.tools` 白名单本来就是比折叠更强的表达（docs/07 §4.1），所以白名单里的工具全部常驻、
 * 逐条带描述 —— 与按需暴露之前逐字节一致；而 `search_tools` 一道闸挡在外面：子 agent 拿到的是
 * 父轮**同一个** turn 对象，让它展开只会往父轮共享的 `expandedTools` 里写，对它自己毫无作用。
 */
describe('AC-TOOL-052 · 子 agent 的工具目录与折叠正交', () => {
  const MCP_DESCRIPTION = '把给进来的文本原样回一遍，用来验证这台 server 还活着';
  const ok = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
  type ToolSpec = { type: string; name: string; description?: string; inputSchema?: unknown };

  function wired(slug: string) {
    const path = `./data/${slug}.test.db`;
    const results = `./data/${slug}-results`;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmSync(results, { recursive: true, force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, quota: { requirePricing: false }, approval: { enabled: false } });
    const log = new LogSink(new OperationsRepository(db), `./data/${slug}-logs`);
    // 折叠开着才有可折叠的东西：`search_tools` 的 `available()` 第二道闸问的正是 `hasDeferrable`。
    const tools = new ToolRegistry(log, { request: async () => true },
      { maxRegistered: 20, maxCallsPerTurn: 5, maxConsecutiveErrors: 3, catalog: { deferExternal: true } });
    registerCatalogTools(tools, { log });
    tools.registerExternal({ name: 'mcp__fixture__echo', description: MCP_DESCRIPTION, inputSchema: z.object({ text: z.string() }),
      minRole: 'limited', source: 'mcp', execute: () => ({ ok: true }) });
    // 标注而不是 `satisfies`：`expandedTools` 是这条用例的断言对象，字面量类型上没有它。
    const turn: RuntimeTurnContext = { turnId: 'turn-sub-defer', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted',
      isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [],
      abortSignal: new AbortController().signal, config };
    const seen: ToolSpec[][] = [];
    const model = { specificationVersion: 'v4' as const, provider: 'test', modelId: 'low-1', supportedUrls: {},
      doGenerate: async (options: { tools?: ToolSpec[] }) => { seen.push(options.tools ?? []); return ok as never; },
      doStream: async () => ok as never };
    const info = { id: 'low-1', providerId: 'p1', modelId: 'low-1', contextWindow: 128_000, maxOutput: 4096,
      capabilities: JSON.stringify({ vision: false }), priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 };
    // 只实现 `runSubAgent` 真正用到的那几个方法（省掉 `provider` 之后连 fallback 链都不经过）。
    const registry = { resolve: () => model as unknown as LanguageModel, settings: () => ({}), info: () => info,
      infoByModelId: (id: string) => id === 'low-1' ? info : null, supportsVision: () => false } as unknown as ModelRegistry;
    const manager = new AgentManager(db, new AgentResultStore(results),
      // `minRole: 'trusted'` ⇒ 有效角色 = min(父 trusted, 这个) = trusted，白名单那个工具才够得着。
      [{ name: 'researcher', description: 'r', modelAlias: 'low', maxSteps: 1, minRole: 'trusted',
        tools: ['mcp__fixture__echo'], resultMaxChars: 100, instructions: 'r', injectMemory: false }], 3, 10);
    return { db, config, log, tools, turn, seen, registry, manager, ledger: new UsageLedger(db) };
  }

  it('白名单里的折叠工具照旧逐条带描述下发，search_tools 一道闸挡在外面', async () => {
    const { db, log, tools, turn, seen, registry, manager, ledger } = wired('subagent-defer');
    const context = (agentKind: 'main' | 'sub'): ToolExecutionContext => ({ turn, workspace: './data', agentKind });
    // 同一个 turn、同一个角色，只差 `agentKind` —— 那道闸就是这一条判据本身。
    expect(tools.activeNames('trusted', context('main'))).toContain('search_tools');
    expect(tools.activeNames('trusted', context('sub'))).not.toContain('search_tools');
    const parent = manager.createMain(turn.turnId, 'trusted', 'main');
    const { run, definition } = manager.spawn(parent, 'researcher', 'echo something back for me please');
    await runSubAgent(run, definition, 'echo something back for me please', undefined, turn,
      { db, agents: manager, registry, tools, ledger, log, workspace: './data' });
    const dispatched = seen[0]!;
    expect(dispatched.map((entry) => entry.name)).toEqual(['mcp__fixture__echo']);
    // 白名单是比折叠更强的表达：描述与 schema 一个字节都不少，与按需暴露之前一致。
    expect(dispatched[0]!.description).toBe(MCP_DESCRIPTION);
    expect(dispatched[0]!.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
    // 它一个字都没往父轮的展开集里写 —— 唯一的写入方是主 agent 那条路上的 `search_tools`。
    expect(turn.expandedTools).toBeUndefined();
    closeDatabase(db);
  });
});
