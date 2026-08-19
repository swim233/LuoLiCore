import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { AlertDispatcher, CONSECUTIVE_TURN_FAILURE_ALERT, LogSink, QuotaGuard, TurnFailureStreak, configSchema, hostMatches } from '@luoli/core';
import { capMentions } from '@luoli/telegram';

/** 第五轮接线的告警链路 / 出网域名策略 / 输出护栏 / 配额预警。 */

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`);
  return { db, log };
}

describe('AlertDispatcher', () => {
  it('只发 alerts.on 里的类型，并按 dedupeMinutes 去重', async () => {
    const { db, log } = harness('alerts-dedupe');
    const sent: string[] = [];
    const alerts = new AlertDispatcher(() => configSchema.parse({ alerts: { on: ['all_providers_down'], dedupeMinutes: 60 } }).alerts,
      log, { owner: (text) => { sent.push(text); } });
    await alerts.raise('all_providers_down', '第一次');
    await alerts.raise('all_providers_down', '第二次');
    expect(sent).toHaveLength(1);
    // 不在 `on` 里的类型一次都不该发出去。
    await alerts.raise('db_write_failed', '不该出现');
    expect(sent.join('')).not.toContain('不该出现');
    // 同一类但不同对象（两个 plugin）各自去重。
    const perPlugin = new AlertDispatcher(() => configSchema.parse({ alerts: { on: ['plugin_auto_disabled'] } }).alerts, log, { owner: (text) => { sent.push(text); } });
    await perPlugin.raise('plugin_auto_disabled', 'a 挂了', {}, 'a');
    await perPlugin.raise('plugin_auto_disabled', 'b 挂了', {}, 'b');
    await perPlugin.raise('plugin_auto_disabled', 'a 又挂了', {}, 'a');
    expect(sent.filter((text) => text.includes('挂了'))).toHaveLength(2);
    closeDatabase(db);
  });

  /**
   * `db_write_failed` 的触发源就是「库写不进去」（`LogSink.onWriteFailure` → `fire`），
   * 而 `raise()` 第一件事是记一行 `alert.raised`。那次落库挡在投递前面的话，库坏了唯一该响的
   * 这条告警一定不响，而 `fire()` 的 `.catch()` 会把它咽得无声无息（docs/10 §6）。
   */
  it('记不下来也要发：log.event 抛出时 owner 照样收到告警', async () => {
    const { db, log } = harness('alerts-logthrows');
    const sent: string[] = [];
    // LogSink 自己现在也不抛了（入库失败返回 0），所以这里直接把 event 换成会抛的版本 ——
    // 这条不变量不该依赖 LogSink 的实现。
    Object.assign(log, { event: () => { throw new Error('log_sink_down'); } });
    const alerts = new AlertDispatcher(() => configSchema.parse({ alerts: { on: ['db_write_failed'] } }).alerts,
      log, { owner: (text) => { sent.push(text); } });
    await expect(alerts.raise('db_write_failed', '日志写入失败')).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('日志写入失败');
    closeDatabase(db);
  });

  it('投递失败不往外抛：告警链路自己坏了不能把调用方带崩', async () => {
    const { db, log } = harness('alerts-throw');
    const alerts = new AlertDispatcher(() => configSchema.parse({ alerts: { on: ['db_write_failed'] } }).alerts, log,
      { owner: () => { throw new Error('telegram 拒发'); } });
    await expect(alerts.raise('db_write_failed', '写不进去')).resolves.toBeUndefined();
    expect(() => alerts.fire('db_write_failed', '同步入口', {}, 'x')).not.toThrow();
    closeDatabase(db);
  });
});

/**
 * 连续失败计数从 `createTelegramBot` 的闭包里提出来（docs/28 · L-SCH-02）。语义一条都不许变：
 * 跨会话、成功一次归零、达到阈值才 fire —— 现在还要**跨入口**，定时轮次与 Telegram 轮次记在
 * 同一份里，否则「上游变黑洞」在没人聊天的部署里一次告警都不响。
 */
describe('TurnFailureStreak', () => {
  it('跨会话累计、成功归零、只在到阈值时 fire', () => {
    const fired: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const streak = new TurnFailureStreak({ fire: (kind, _summary, data) => { fired.push({ kind, ...(data ? { data } : {}) }); } }, 3);
    streak.failed('turn_timeout');
    streak.failed('turn_timeout');
    expect(fired).toHaveLength(0);
    expect(streak.count).toBe(2);
    // 中间成功一次就归零：连续才算「这个部署坏了」。
    streak.succeeded();
    expect(streak.count).toBe(0);
    streak.failed('a'); streak.failed('b');
    expect(fired).toHaveLength(0);
    streak.failed('turn_timeout');
    expect(fired).toEqual([{ kind: 'consecutive_turn_failures', data: { count: 3, lastError: 'turn_timeout' } }]);
    // 缺 alerts 的装配（没有 Telegram 通道时）不许炸，只是不发。
    const orphan = new TurnFailureStreak(undefined, 1);
    expect(() => orphan.failed('x')).not.toThrow();
    // docs/10 §6 的默认阈值就是 5，别让它悄悄漂。
    expect(CONSECUTIVE_TURN_FAILURE_ALERT).toBe(5);
  });
});

describe('tools.web.allowlist / denylist', () => {
  it('denylist 优先于 allowlist，`*.` 只匹配子域', () => {
    expect(hostMatches('example.com', ['example.com'])).toBe(true);
    expect(hostMatches('EXAMPLE.COM.', ['example.com'])).toBe(true);
    expect(hostMatches('a.example.com', ['*.example.com'])).toBe(true);
    // 裸域不该被 `*.example.com` 匹配上 —— 白名单里写通配却漏掉主域是常见误配，别替用户放行。
    expect(hostMatches('example.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('evil-example.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('anything', [])).toBe(false);
  });
});

describe('output.maxMentions', () => {
  it('超出的 @用户名 去掉 @ 只留名字，0 表示不限', () => {
    const text = '@alice 和 @bobby 还有 @carol1 都看一下';
    expect(capMentions(text, 0)).toBe(text);
    expect(capMentions(text, 3)).toBe(text);
    const capped = capMentions(text, 1);
    expect(capped).toContain('@alice');
    expect(capped).toContain(' bobby');
    expect(capped).not.toContain('@bobby');
    expect(capped).not.toContain('@carol1');
  });
});

describe('quota.warnAtRatio / lastRejection', () => {
  it('跨过预警线只提示一次，且能说出是哪一档挡的', () => {
    const path = './data/alerts-quota.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const guard = new QuotaGuard(db, 'UTC');
    const limits = { globalDaily: 1, globalMonthly: null, chatDaily: null, chatMonthly: null, userDaily: null, userMonthly: null };
    const reservation = guard.reserve({ chatId: 'c', userId: 'u', estimateUsd: 0.1, limits })!;
    expect(guard.warning(reservation, 0.8)).toBeNull();
    guard.commit(reservation, 0.85);
    const warning = guard.warning(reservation, 0.8);
    expect(warning).toMatchObject({ scope: 'global', window: 'day', limit: 1 });
    // 每个 bucket 只提示一次：否则过了 80% 之后每一轮回复后面都挂一句。
    expect(guard.warning(reservation, 0.8)).toBeNull();
    guard.release(reservation);
    // 超限时要说得出是哪一档挡的 —— global 超限才私聊 owner。
    expect(guard.reserve({ chatId: 'c', userId: 'u', estimateUsd: 5, limits })).toBeNull();
    expect(guard.lastRejection).toMatchObject({ scope: 'global', window: 'day', limit: 1 });
    closeDatabase(db);
  });
});
