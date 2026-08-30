import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QuotaGuard } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

function setup() {
  const path = './data/quota-concurrency.test.db';
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  return { db, quota: new QuotaGuard(db, 'UTC') };
}

describe('quota call lifecycle', () => {
  it('admits exactly the number of concurrent turns covered by reservations', () => {
    const { db, quota } = setup();
    const limits = { globalDaily: 0.04, globalMonthly: null, chatDaily: 0.04, chatMonthly: null, userDaily: 0.04, userMonthly: null };
    const accepted = Array.from({ length: 5 }, () => quota.reserve({ chatId: 'c', userId: 'u', estimateUsd: 0.02, limits })).filter((value) => value !== null);
    expect(accepted).toHaveLength(2);
    for (const reservation of accepted) {
      quota.commit(reservation, 0.005);
      quota.commit(reservation, 0.005);
      expect(quota.status(reservation).committed).toBeCloseTo(0.01, 12);
      expect(quota.status(reservation).remaining).toBeCloseTo(0.01, 12);
      quota.release(reservation);
    }
    const counters = db.prepare("SELECT cost_usd AS cost,reserved_usd AS reserved FROM quota_counters WHERE scope='global' AND window='day'").get() as { cost: number; reserved: number };
    expect(counters.cost).toBeCloseTo(0.02, 12);
    expect(counters.reserved).toBe(0);
    closeDatabase(db);
  });
});
