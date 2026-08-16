import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { AgentManager, AgentResultStore, ContextEngine, LogSink, PromptAssembler, PromptDocuments, QuotaGuard, ToolRegistry, UsageLedger, configSchema, runMainAgent, runSubAgent } from '@luoli/core';
import type { ApprovalBroker, Config, ModelRegistry } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 跨边界契约：**`prepareStep` 存在时，模型包装仍然生效**。
 *
 * `ToolLoopAgent` 的 prepareStep 每一步都会重设 model，构造时传进去的那个从第 0 步起就再没被用过。
 * 于是 provider.maxRetries、别名 fallback 链、markProviderDown、以及用来区分「上游挂了」和
 * 「模型没话说」的 onExhausted 全部变成死代码 —— 而 `agent.retry.test.ts` 只测了
 * `fallbackLanguageModel` 本身，测不到它在 agent 里还生不生效（docs/20 · W-AGENT-01）。
 */
function candidate(id: string, run: () => unknown) {
  return { specificationVersion: 'v4' as const, provider: 'test', modelId: id, supportedUrls: {},
    doGenerate: async () => run() as never, doStream: async () => run() as never };
}

const ok = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };

function info(modelId: string) {
  return { id: modelId, providerId: 'p1', modelId, contextWindow: 128_000, maxOutput: 4096, capabilities: '[]',
    priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 };
}

/** 只实现 runMainAgent 真正用到的那几个方法；其余留空，多用一个就会在类型上报出来。 */
function registryFor(chains: Record<string, Array<{ model: ReturnType<typeof candidate>; info: ReturnType<typeof info> }>>): ModelRegistry {
  const down: string[] = [];
  const fake = {
    chain: (alias: string) => chains[alias] ?? [],
    resolve: (alias: string) => (chains[alias] ?? chains.main!)[0]!.model as unknown as LanguageModel,
    settings: () => ({}),
    aliases: () => Object.keys(chains),
    info: (alias: string) => (chains[alias] ?? [])[0]?.info ?? null,
    infoByModelId: (modelId: string) => Object.values(chains).flat().find((entry) => entry.info.modelId === modelId)?.info ?? null,
    aliasOf: (modelId: string, prefer?: string) => Object.entries(chains).find(([alias, chain]) => chain.some((entry) => entry.info.modelId === modelId) && (!prefer || alias === prefer))?.[0]
      ?? Object.entries(chains).find(([, chain]) => chain.some((entry) => entry.info.modelId === modelId))?.[0] ?? null,
    markProviderDown: (modelId: string) => { down.push(modelId); },
    down,
  };
  return fake as unknown as ModelRegistry;
}

function harness(name: string, patch: Partial<Config> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, quota: { requirePricing: false }, provider: { maxRetries: 1, retryBaseMs: 1, retryMaxMs: 2 },
    memory: { dir: `./data/${name}-memory` }, approval: { enabled: false }, ...patch });
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`);
  const broker: ApprovalBroker = { request: async () => true };
  const documents = new PromptDocuments(db, config.memory.dir);
  documents.ensure();
  const turn = { turnId: 'turn-1', key: 'chat:1', chatId: '1', threadId: null, initiatorUserId: '2', effectiveRole: 'trusted',
    isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [{ id: 'u', role: 'user', origin: 'trigger', parts: [{ type: 'text', text: '你好' }], tokens: 4 }],
    abortSignal: new AbortController().signal, config } satisfies RuntimeTurnContext;
  const dependencies = { config, db, tools: new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 5, maxConsecutiveErrors: 3 }),
    prompts: new PromptAssembler(), documents, ledger: new UsageLedger(db), log, workspace: './data',
    context: new ContextEngine(db, new ArchiveRepository(db), log) };
  return { db, config, turn, dependencies, quota: new QuotaGuard(db, 'UTC') };
}

describe('model wiring through prepareStep', () => {
  // 缓存边界的端到端断言：走完整条 runMainAgent，看真正递到模型那一层的是什么。
  // 只断言 PromptAssembler 的输出不够 —— 中间还隔着 `Instructions` 数组、AI SDK 的 standardizePrompt
  // 和 prepareStep 的每步重设，任何一环把两段合回一条，改动就白做了（docs/06 §1）。
  it('sends the volatile block as a separate system message so the cached prefix stays byte-identical', async () => {
    const { db, turn, dependencies } = harness('wiring-prompt-cache');
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const registry = registryFor({ main: [{ model: { ...candidate('first', () => ok),
      doGenerate: async (options: { prompt: Array<{ role: string; content: unknown }> }) => { prompts.push(options.prompt); return ok as never; } } as ReturnType<typeof candidate>, info: info('first') }] });
    await runMainAgent(turn, { ...dependencies, registry });
    const system = prompts[0]!.filter((message) => message.role === 'system').map((message) => String(message.content));
    expect(system).toHaveLength(2);
    expect(system[0]).toContain('=== KERNEL ===');
    // 每轮都变的那三块一个字都不能落在缓存段里 —— 分钟精度的时钟就够让整段前缀作废。
    for (const header of ['=== RUNTIME ===', '=== PUBMEMORY ===', '=== PRIMEMORY ===']) expect(system[0]).not.toContain(header);
    expect(system[1]).toContain('=== RUNTIME ===');
    expect(system[1]).toContain('现在：');
    closeDatabase(db);
  });

  it('still falls back to the next candidate even though prepareStep resets the model', async () => {
    const { db, turn, dependencies } = harness('wiring-fallback');
    let firstCalls = 0;
    let secondCalls = 0;
    const registry = registryFor({ main: [
      { model: candidate('first', () => { firstCalls += 1; throw Object.assign(new Error('busy'), { statusCode: 503 }); }), info: info('first') },
      { model: candidate('second', () => { secondCalls += 1; return ok; }), info: info('second') },
    ] });
    await expect(runMainAgent(turn, { ...dependencies, registry })).resolves.toBe('ok');
    // maxRetries=1 → 第一个候选试 2 次，然后才轮到第二个。包装被绕开时 firstCalls 会是 1 且整轮直接失败。
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(1);
    closeDatabase(db);
  });

  it('surfaces the upstream failure instead of an empty answer when the whole chain is down', async () => {
    const { db, turn, dependencies } = harness('wiring-exhausted');
    const registry = registryFor({ main: [
      { model: candidate('first', () => { throw Object.assign(new Error('bad gateway'), { statusCode: 502 }); }), info: info('first') },
    ] });
    // 上游彻底故障时 AI SDK 把错误吞成空串。onExhausted 抓不到那一份的话，调用方看到的是
    // 「模型这轮没吐出任何正文」——正是 7038222 那次修复想消灭的误报。
    await expect(runMainAgent(turn, { ...dependencies, registry })).rejects.toThrow('bad gateway');
    closeDatabase(db);
  });

  it('marks the provider down when credentials are rejected mid-agent', async () => {
    const { db, turn, dependencies } = harness('wiring-401');
    const registry = registryFor({ main: [
      { model: candidate('first', () => { throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); }), info: info('first') },
      { model: candidate('second', () => ok), info: info('second') },
    ] });
    await expect(runMainAgent(turn, { ...dependencies, registry })).rejects.toThrow('unauthorized');
    expect((registry as unknown as { down: string[] }).down).toEqual(['first']);
    closeDatabase(db);
  });

  // 用量报表看得见、配额拦不住，比单纯漏记更难排查：`usage_ledger` 里有这笔钱，
  // 而日/月计数器只在 quota.commit() 里递增，子 agent 此前一次都没调过（docs/20 · W-QUOTA-01）。
  it('commits sub-agent spend into the same quota reservation as the main agent', async () => {
    const { db, turn, dependencies, quota } = harness('wiring-subquota');
    const registry = registryFor({ main: [{ model: candidate('m1', () => ok), info: info('m1') }] });
    const manager = new AgentManager(db, new AgentResultStore('./data/wiring-subquota-results'),
      [{ name: 'researcher', description: 'r', modelAlias: 'main', maxSteps: 2, minRole: 'limited', tools: [], resultMaxChars: 100, instructions: 'r', injectMemory: false }], 3, 10);
    const reservation = quota.reserve({ chatId: turn.chatId, userId: turn.initiatorUserId, estimateUsd: 0.01,
      limits: { globalDaily: 10, globalMonthly: 10, chatDaily: 10, chatMonthly: 10, userDaily: 10, userMonthly: 10 } })!;
    expect(reservation).toBeTruthy();
    const parent = manager.createMain(turn.turnId, 'trusted', 'main');
    const { run, definition } = manager.spawn(parent, 'researcher', 'do the research task please');
    await runSubAgent(run, definition, 'do the research task please', undefined, turn,
      { db, agents: manager, registry, tools: dependencies.tools, ledger: dependencies.ledger, log: dependencies.log, workspace: './data',
        provider: { maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1 }, quota, reservation });
    const ledgerTotal = dependencies.ledger.turnCost(turn.turnId);
    const counted = db.prepare("SELECT cost_usd AS cost FROM quota_counters WHERE scope='user' AND window='day'").pluck().get() as number;
    expect(ledgerTotal).toBeGreaterThan(0);
    expect(counted).toBeCloseTo(ledgerTotal, 12);
    closeDatabase(db);
  });

  it('records the real alias for a fallback candidate instead of guessing low', async () => {
    const { db, turn, dependencies } = harness('wiring-alias');
    const registry = registryFor({
      main: [
        { model: candidate('first', () => { throw Object.assign(new Error('busy'), { statusCode: 503 }); }), info: info('first') },
        { model: candidate('second', () => ok), info: info('second') },
      ],
      low: [{ model: candidate('cheap', () => ok), info: info('cheap') }],
    });
    await runMainAgent(turn, { ...dependencies, registry });
    const rows = db.prepare('SELECT model_id AS modelId,model_alias AS alias FROM usage_ledger').all() as Array<{ modelId: string; alias: string }>;
    expect(rows).toEqual([{ modelId: 'second', alias: 'main' }]);
    closeDatabase(db);
  });
});
