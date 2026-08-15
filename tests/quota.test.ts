import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QuotaGuard } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

describe('quota reservation', () => {
  it('atomically prevents concurrent overspending', () => {
    const path = './data/quota.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
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
