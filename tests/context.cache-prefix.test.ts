import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, LogSink, PromptAssembler, PromptDocuments, ToolRegistry, UsageLedger, configSchema, runMainAgent } from '@luoli/core';
import type { ApprovalBroker, ModelRegistry } from '@luoli/core';
import type { LanguageModel } from 'ai';

/**
 * 跨轮可缓存前缀（docs/04 §2.1）。
 *
 * 所有 provider 的前缀缓存都从第 0 个字节起逐字节比对，**但比对的对象是「上一条请求」而不是
 * 「上一条请求的全部」**：实测（deepseek 官方直连）真前缀同样满命中 99.7% —— 共同前缀之后
 * 尾巴换成什么都不影响前面那段。所以要保住的不变量只有一条：
 *
 *     第 N 轮请求去掉末尾易变段之后，必须逐字节是第 N+1 轮请求的前缀。
 *
 * 它一破，整段历史的缓存就一起没了。历史上破它的两种方式都出现过：
 * ① 把每轮都变的东西（分钟时钟）留在稳定段里 —— 前缀在第一条 system 上就分叉；
 * ② 活跃期内推进 `window_start` —— 前缀最前面几条消息被换掉。
 *
 * `agent.model-wiring.test.ts` 断言的是**一轮之内**易变段的位置，测不到跨轮：那里的 turn 是手搓的，
 * snapshot 固定不动。这里走真的 `openTurn → commitTurn → openTurn`，让历史真的长出来。
 */
const ok = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };

type PromptMessage = { role: string; content: unknown; providerOptions?: unknown };
interface Captured { prompt: PromptMessage[]; tools: unknown }

function harness(name: string, active: { windowMs: number } = { windowMs: 600_000 }) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-memory`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const archive = new ArchiveRepository(db);
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`);
  const engine = new ContextEngine(db, archive, log);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' },
    quota: { requirePricing: false }, approval: { enabled: false }, memory: { dir: `./data/${name}-memory` },
    context: { limit: { tokens: 4000, maxMessages: 6, minKeepTurns: 1 }, active: { tokens: 40_000, maxMessages: 100, ...active } } });
  const documents = new PromptDocuments(db, config.memory.dir);
  documents.ensure();
  const broker: ApprovalBroker = { request: async () => true };
  const captured: Captured[] = [];
  const model = { specificationVersion: 'v4' as const, provider: 'test', modelId: 'first', supportedUrls: {},
    doGenerate: async (options: { prompt: PromptMessage[]; tools?: unknown }) => {
      captured.push({ prompt: options.prompt, tools: options.tools ?? null });
      return ok as never;
    },
    doStream: async () => ok as never };
  const info = { id: 'first', providerId: 'p1', modelId: 'first', contextWindow: 128_000, maxOutput: 4096,
    capabilities: '[]', priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 };
  const registry = { chain: () => [{ model, info }], resolve: () => model as unknown as LanguageModel, settings: () => ({}),
    aliases: () => ['main'], info: () => info, infoByModelId: () => info, aliasOf: () => 'main',
    // 每次成功服务都会走一次（连续失败计数归零，`docs/04 §5.3`）；这条链上没有失败，所以是空实现。
    recordSuccess: () => {}, markProviderDown: () => {} } as unknown as ModelRegistry;
  const dependencies = { config, db, registry, tools: new ToolRegistry(log, broker, { maxRegistered: 10, maxCallsPerTurn: 5, maxConsecutiveErrors: 3 }),
    prompts: new PromptAssembler(), documents, ledger: new UsageLedger(db), log, workspace: './data', context: engine };
  return { db, archive, engine, config, dependencies, captured };
}

/** 一整轮：真的开轮 → 跑 runMainAgent → 把回答追进 delta → 提交。 */
async function exchange(h: ReturnType<typeof harness>, id: number): Promise<void> {
  const trigger = h.archive.scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: id, direction: 'in',
    fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: `turn ${id}`,
    tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
  const current = await h.engine.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user',
    effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config: h.config });
  await runMainAgent(current, h.dependencies);
  h.engine.appendDelta(current, { id: `a${id}`, role: 'assistant', origin: 'assistant',
    parts: [{ type: 'text', text: `answer ${id}` }], tokens: 4, pruneLevel: 0 });
  await h.engine.commitTurn(current);
}

/** 去掉末尾那条易变段之后的部分 —— 这一段必须原样出现在下一轮请求的开头。 */
const cacheable = (prompt: PromptMessage[]): string[] => prompt.slice(0, -1).map((message) => JSON.stringify(message));
const whole = (prompt: PromptMessage[]): string[] => prompt.map((message) => JSON.stringify(message));

describe('cross-turn cacheable prefix', () => {
  it('keeps turn N minus its volatile tail as a byte-exact prefix of turn N+1', async () => {
    const h = harness('cache-prefix-append');
    for (let id = 1; id <= 4; id += 1) await exchange(h, id);
    expect(h.captured).toHaveLength(4);
    for (let index = 0; index + 1 < h.captured.length; index += 1) {
      const previous = cacheable(h.captured[index]!.prompt);
      const next = whole(h.captured[index + 1]!.prompt);
      // 前缀必须真的长出来，否则「是前缀」可以靠请求没变蒙混过去。
      expect(next.length).toBeGreaterThan(previous.length);
      expect(next.slice(0, previous.length)).toEqual(previous);
    }
  });

  it('holds the system block and tool schemas byte-identical across turns', async () => {
    const h = harness('cache-prefix-stable');
    for (let id = 1; id <= 3; id += 1) await exchange(h, id);
    const systems = h.captured.map((entry) => entry.prompt.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n'));
    // 稳定段里一个每轮都变的字节都不能有：时钟、水位、额度都归易变段（docs/06 §1）。
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain('=== KERNEL ===');
    expect(systems[0]).not.toContain('=== RUNTIME ===');
    // tools schema 排在请求体最前面，它一变，后面整段历史都不再命中。
    expect(new Set(h.captured.map((entry) => JSON.stringify(entry.tools))).size).toBe(1);
  });

  it('only breaks the prefix when the window actually moves', async () => {
    // 反证：活跃期关掉之后 limit.maxMessages=6 每轮都要推进 window_start，前缀必然断。
    // 这条不是「期望的行为」，而是把「裁剪 = 缓存全灭」这件事钉成可执行的断言 —— 它变绿
    // 说明有人在活跃期外做了别的补偿，那时该来改这个测试而不是让它静默失效。
    const h = harness('cache-prefix-pruned', { windowMs: 0 });
    for (let id = 1; id <= 6; id += 1) await exchange(h, id);
    const broken = h.captured.some((entry, index) => {
      if (index === 0) return false;
      const previous = cacheable(h.captured[index - 1]!.prompt);
      return !whole(entry.prompt).slice(0, previous.length).every((line, position) => line === previous[position]);
    });
    expect(broken).toBe(true);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM context_commits WHERE kind='prune'").get()).toMatchObject({ count: expect.any(Number) });
    closeDatabase(h.db);
  });
});
