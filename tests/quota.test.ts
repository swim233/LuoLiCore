import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QuotaGuard } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

describe('quota reservation', () => {
  it('atomically prevents concurrent overspending', () => {
    const path = './data/quota.test.db';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const guard = new QuotaGuard(db, 'UTC');
    const limits = { globalDaily: 0.04, globalMonthly: null, chatDaily: 0.04, chatMonthly: null, userDaily: 0.04, userMonthly: null };
    const accepted = Array.from({ length: 5 }, () => guard.reserve({ chatId: 'c', userId: 'u', estimateUsd: 0.02, limits }));
    expect(accepted.filter(Boolean)).toHaveLength(2);
    for (const reservation of accepted.filter((value) => value !== null)) guard.release(reservation);
    closeDatabase(db);
  });
});

/**
 * `quota.rateLimit` 的按小时次数是**防人刷**的（docs/10 §5.1「与金额无关的防滥用」），
 * 而定时任务的频率在创建时就由 `schedule.minIntervalMinutes` / `maxPerChat` 管住了。
 * 本轮活体测试里用定时任务跑的 38 轮把 owner 自己挡在了门外（docs/28 · L-QUOTA-02）——
 * 挡的是真人，机器那边一次也没被拦。金额额度（`reserve`）不受这条影响。
 */
describe('canStart：定时轮次不吃频率闸', () => {
  const path = './data/quota-schedule-rate.test.db';
  const limits = { chatId: 'c', userId: 'u', turnsPerUserPerHour: 2, turnsPerChatPerHour: 3, concurrentPerUser: 5 };
  const insert = (id: string, reason: string | null): void => {
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_reason,state,started_at)
      VALUES (?,'chat:c','c','u','owner',?,'committed',?)`).run(id, reason, Date.now());
  };
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const guard = new QuotaGuard(db, 'UTC');

  it('人开的轮次照旧数，定时开的一轮都不数', () => {
    for (let index = 0; index < 20; index += 1) insert(`s-${index}`, 'schedule');
    // 20 条定时轮次摆在同一小时里：两档上限（人 2 / 会话 3）都远远越过了，但一条都不算。
    expect(guard.canStart({ ...limits, inFlight: 0 })).toBe(true);
    expect(guard.lastStartRejection).toBeNull();
    insert('m-1', 'mention'); insert('m-2', 'private');
    expect(guard.canStart({ ...limits, inFlight: 0 })).toBe(false);
    expect(guard.lastStartRejection).toBe('rate_user');
    // 会话那一档同理：换个人说话，前面两条真人轮次仍然记在这个会话上。
    expect(guard.canStart({ ...limits, userId: 'other', inFlight: 0 })).toBe(true);
    insert('m-3', 'mention');
    expect(guard.canStart({ ...limits, userId: 'other', inFlight: 0 })).toBe(false);
    expect(guard.lastStartRejection).toBe('rate_chat');
    closeDatabase(db);
  });
});
