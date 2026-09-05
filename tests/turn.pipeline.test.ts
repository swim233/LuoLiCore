import { mkdirSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ArchiveRepository,
  OperationsRepository,
  TurnRepository,
  closeDatabase,
  migrateDatabase,
  openDatabase,
} from '@luoli/db';
import {
  ContextEngine,
  EventBus,
  LogSink,
  MemoryStore,
  QuotaGuard,
  ToolRegistry,
  TurnConcurrency,
  TurnRegistry,
  configSchema,
  runTurn,
} from '@luoli/core';
import type { Config } from '@luoli/core';
import { code, source } from './support/source.js';

/**
 * T3.7：`runTurn()` 四条不变量的故障注入（`docs/02` §10.6）。
 *
 * 不经 `ScheduledJobRunner` / `startTestRuntime`：直接装 `ContextEngine` + 真实 SQLite +
 * `runTurn()`，理由是这里要断的是管线本身（并发/配额/清理），而不是 schedule 或 SDK 各自的
 * 触发前判定——那两侧分别由 `tests/schedule.test.ts`（既有 37 条用例，本任务未改动其判据、
 * 全部仍通过）与后续 T3.6 的用例覆盖。
 */
function harness(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm'])
    rmSync(`${path}${suffix}`, { force: true });
  const directory = `./data/${name}-logs`;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const memoryDir = `./data/${name}-memory`;
  rmSync(memoryDir, { recursive: true, force: true });
  mkdirSync(memoryDir, { recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({
    access: { bootstrapOwnerId: '1' },
    general: { timezone: 'UTC' },
    quota: { enabled: false },
    ...extra,
  }) as Config;
  const events = new EventBus();
  const log = new LogSink(new OperationsRepository(db), [], { level: 'debug', console: 'off' });
  const archive = new ArchiveRepository(db);
  const context = new ContextEngine(db, archive);
  const turns = new TurnRepository(db);
  const registry = new TurnRegistry();
  const concurrency = new TurnConcurrency(config.concurrency);
  const quota = new QuotaGuard(db, config.general.timezone, events);
  const memory = new MemoryStore(db, memoryDir, 1500, 3000);
  const tools = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  const scoped = archive.scope('c1', null);
  let seq = 2_000_000_000;
  // 触发消息的归档与 id 分配是调用方的事（`buildTrigger`）：这里用最简形式，不重复
  // `ScheduledJobRunner#appendTrigger` 的合成 id 分配与冲突核对逻辑——那条判据已由
  // `tests/schedule.test.ts` 的「合成触发消息撞号时抛 schedule_trigger_conflict」覆盖。
  const buildTrigger = () =>
    scoped.append({
      chatId: 'c1',
      messageThreadId: null,
      tgMessageId: (seq += 1),
      direction: 'in',
      fromKind: 'system',
      fromUserId: '7',
      fromName: '探针',
      fromUsername: null,
      kind: 'text',
      text: '触发',
      tgDate: Date.now(),
      raw: {},
      triggered: true,
      triggerReason: 'schedule',
    });
  return {
    db,
    log,
    context,
    turns,
    registry,
    concurrency,
    quota,
    memory,
    tools,
    config,
    buildTrigger,
    dependencies: { context, turns, registry, concurrency, quota, tools, memory, log },
    close: () => closeDatabase(db),
  };
}

describe('runTurn() 故障注入（四条不变量）', () => {
  it('① 产出回调抛出：槽位与配额释放，turn 已 abort，turns.finish 已执行', async () => {
    // `perKey:1 / global:1 / queueMax:0`：并发槽的释放判据必须在「不释放就再也开不了第二轮」
    // 的装配下才有判别力——默认配置（`perKey:3/global:8`）下即使 `release()` 被删掉，
    // `available()` 的断言依旧会通过（1 个未释放的槽不影响 3/8 的阈值判定），测不出
    // R-BOT-01（docs/19:246）真正要挡的东西。
    const h = harness('pipeline-produce-throws', {
      quota: { enabled: true, minReserveUsd: 1, global: { daily: 100 } },
      concurrency: { mode: 'parallel', perKey: 1, global: 1, queueMax: 0 },
    });
    const reservation = h.quota.reserve({
      chatId: 'c1',
      userId: '7',
      estimateUsd: 1,
      limits: { globalDaily: 100, chatDaily: null, userDaily: null, globalMonthly: null, chatMonthly: null, userMonthly: null },
    });
    expect(reservation).not.toBeNull();
    const result = await runTurn({
      dependencies: h.dependencies,
      chatId: 'c1', threadId: null, key: 'chat:c1', initiatorUserId: '7', effectiveRole: 'trusted', isPrivate: true,
      config: h.config, turnTimeoutMs: 30_000, triggerReason: 'schedule', reservation,
      buildTrigger: h.buildTrigger,
      produce: () => { throw new Error('produce boom'); },
    });
    expect(result).toMatchObject({ ok: false, stage: 'turn', code: 'failed', timedOut: false, error: 'produce boom' });
    // 并发槽释放（R-BOT-01 头号判据，`TurnConcurrency` 本身，不是 `TurnRegistry`）：
    // `active` 归零、同一 key 立即 `available()`——槽位没还的话两者都会卡在「已占用」。
    expect(h.concurrency.active).toBe(0);
    expect(h.concurrency.available('chat:c1')).toBe(true);
    // TurnRegistry 无残留：既不是排队态的 pendingId，也不是已开轮态的 turnId（与并发槽是两件
    // 独立的清理，各自可能单独遗漏，因此分两条断言）。
    expect(h.registry.size).toBe(0);
    // 配额释放：预留的 reserved_usd 归零（commit() 从未被调用，因此也没有 cost_usd）。
    const counter = h.db.prepare("SELECT reserved_usd AS reserved, cost_usd AS cost FROM quota_counters WHERE scope='global'").get() as { reserved: number; cost: number } | undefined;
    expect(counter).toMatchObject({ reserved: 0, cost: 0 });
    // abortTurn 已执行（真实引擎，未 mock）且 turns.finish 已记录为 failed——不是永久卡在 running。
    expect(h.db.prepare('SELECT state,error FROM turns').get()).toMatchObject({ state: 'failed', error: 'produce boom' });
    h.close();
  });

  it('② abortTurn 抛出：turns.finish 仍执行（记 failed 而非永久 running），槽位释放', async () => {
    const h = harness('pipeline-abort-throws', {
      concurrency: { mode: 'parallel', perKey: 1, global: 1, queueMax: 0 },
    });
    Object.assign(h.context, {
      commitTurn: () => Promise.reject(new Error('commit boom')),
      abortTurn: () => Promise.reject(new Error('cleanup 也失败了')),
    });
    const result = await runTurn({
      dependencies: h.dependencies,
      chatId: 'c1', threadId: null, key: 'chat:c1', initiatorUserId: '7', effectiveRole: 'trusted', isPrivate: true,
      config: h.config, turnTimeoutMs: 30_000, triggerReason: 'schedule', reservation: null,
      buildTrigger: h.buildTrigger,
      produce: () => Promise.resolve('正文'),
      deliver: () => Promise.resolve({ ok: true }),
    });
    // `turns.finish` 记的是 commitTurn 失败的原始错误，不是 abortTurn 清理失败的错误——两者是
    // 不同的失败原因，前者才是本轮真正未完成的理由。
    expect(result).toMatchObject({ ok: false, stage: 'turn', code: 'failed', error: 'commit boom' });
    expect(h.db.prepare('SELECT state,error FROM turns').get()).toMatchObject({ state: 'failed', error: 'commit boom' });
    // 清理失败自身也要留下记录，否则认领未释放无法排查（同 `tests/schedule.test.ts` 的同名判据）。
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='ctx.abort' AND level='error'").pluck().get()).toBe(1);
    // 并发槽释放：`abortTurn` 自身抛出不得阻止 `finally` 里的 `release()`（同上，perKey:1/global:1
    // 使这条判据在删掉 `release()` 时必定转红）。
    expect(h.concurrency.active).toBe(0);
    expect(h.concurrency.available('chat:c1')).toBe(true);
    // TurnRegistry 不因 abortTurn 抛出而卡住（与并发槽是两条独立的清理）。
    expect(h.registry.size).toBe(0);
    h.close();
  });

  it('③ silenced=true：不投递但 appendDelta + commitTurn 已发生（context_commits 推进）', async () => {
    const h = harness('pipeline-silenced');
    let delivered = 0;
    const result = await runTurn({
      dependencies: h.dependencies,
      chatId: 'c1', threadId: null, key: 'chat:c1', initiatorUserId: '7', effectiveRole: 'trusted', isPrivate: true,
      config: h.config, turnTimeoutMs: 30_000, triggerReason: 'schedule', reservation: null, silenceable: true,
      buildTrigger: h.buildTrigger,
      produce: async (turn) => {
        // 由调用方在产出阶段置位——真实入口是 `stay_silent` 工具，这里直接模拟其效果，
        // 判据只关心 `runTurn()` 如何响应 `turn.silenced`，不重复工具那一层的权限判定
        // （已由 `tests/schedule.test.ts` 的「本轮不用汇报」describe 块覆盖）。
        Object.assign(turn, { silenced: true, silenceReason: '没什么可说的' });
        return '查过了，没有更新。';
      },
      deliver: () => { delivered += 1; return Promise.resolve({ ok: true }); },
    });
    expect(result).toMatchObject({ ok: true, silenced: true, answer: '查过了，没有更新。' });
    // 不投递：deliver 一次都没被调用。
    expect(delivered).toBe(0);
    // 上下文推进：一次 commit，触发消息与产出两行都进了 context_messages。
    expect(h.db.prepare('SELECT COUNT(*) FROM context_commits').pluck().get()).toBe(1);
    const rows = h.db.prepare("SELECT role, origin FROM context_messages WHERE key='chat:c1' ORDER BY ordinal").all() as Array<{ role: string; origin: string }>;
    expect(rows).toEqual([
      { role: 'user', origin: 'trigger' },
      { role: 'assistant', origin: 'assistant' },
    ]);
    expect(h.db.prepare('SELECT state FROM turns').pluck().get()).toBe('committed');
    h.close();
  });

  it('④ 队列满：返回 turn_queue_full 且配额已释放，无 turns running 残留', async () => {
    const h = harness('pipeline-queue-full', {
      concurrency: { mode: 'parallel', perKey: 1, global: 1, queueMax: 0 },
      quota: { enabled: true, minReserveUsd: 1, global: { daily: 100 } },
    });
    // 占满唯一的槽位：直接调用 concurrency（不经 runTurn()），模拟另一条轮次正在跑。
    const holder = new AbortController();
    const releaseHolder = await h.concurrency.acquire('chat:c1', holder.signal);
    const reservation = h.quota.reserve({
      chatId: 'c1',
      userId: '7',
      estimateUsd: 1,
      limits: { globalDaily: 100, chatDaily: null, userDaily: null, globalMonthly: null, chatMonthly: null, userMonthly: null },
    });
    expect(reservation).not.toBeNull();
    let queuedNotified = false;
    const result = await runTurn({
      dependencies: h.dependencies,
      chatId: 'c1', threadId: null, key: 'chat:c1', initiatorUserId: '7', effectiveRole: 'trusted', isPrivate: true,
      config: h.config, turnTimeoutMs: 30_000, triggerReason: 'schedule', reservation,
      buildTrigger: h.buildTrigger,
      produce: () => Promise.resolve('不会被调用'),
      onQueued: () => { queuedNotified = true; },
    });
    expect(result).toMatchObject({ ok: false, stage: 'queue', code: 'turn_queue_full' });
    // `onQueued` 判据是 `!concurrency.available(key)`，先于 `acquire()` 触发，因此无法区分
    // 「会排队等待」与「队列已满、即将被拒」——触发之后紧跟着 `stage:'queue'` 失败是预期行为，
    // 不是缺陷（`docs/02` §10.6）。
    expect(queuedNotified).toBe(true);
    // 配额已释放：从未进入产出阶段，reserved_usd 应归零。
    const counter = h.db.prepare("SELECT reserved_usd AS reserved FROM quota_counters WHERE scope='global'").get() as { reserved: number } | undefined;
    expect(counter?.reserved ?? 0).toBe(0);
    // 没有 turns 残留：并发闸之后才有 openTurn/turns.create，队列满时连一行都不会写。
    expect(h.db.prepare('SELECT COUNT(*) FROM turns').pluck().get()).toBe(0);
    expect(h.registry.size).toBe(0);
    // 并发槽未被误占：被拒的这次尝试不应让 `active` 多算一份——此刻唯一占着槽的仍是 holder。
    expect(h.concurrency.active).toBe(1);
    expect(h.concurrency.available('chat:c1')).toBe(false);
    releaseHolder();
    // holder 一放，槽位立即可用：证明刚才被拒的那次尝试没有留下任何残留占用。
    expect(h.concurrency.active).toBe(0);
    expect(h.concurrency.available('chat:c1')).toBe(true);
    h.close();
  });
});

describe('runner.ts 接入（源码断言）', () => {
  it('runner.ts 中不再出现 openTurn(', () => {
    expect(source('packages/core/src/schedule/runner.ts')).not.toContain(code('openTurn('));
  });

  it('runner.ts 改用 runTurn()', () => {
    expect(source('packages/core/src/schedule/runner.ts')).toContain(code('await runTurn({'));
  });
});
