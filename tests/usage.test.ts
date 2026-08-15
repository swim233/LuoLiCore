import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UsageLedger } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

describe('usage ledger', () => {
  it('prices four token classes and keeps turn sum exact', () => {
    const path = './data/usage.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state) VALUES ('turn','chat:1','1','1','owner','running')`).run();
    const ledger = new UsageLedger(db);
    const cost = ledger.record({ turnId: 'turn', chatId: '1', userId: '1', providerId: 'p', modelId: 'm', modelAlias: 'main',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50,
      priceIn: 2, priceOut: 4, priceCacheRead: 0.5, priceCacheWrite: 3, latencyMs: 10, finishReason: 'stop', ok: true });
    expect(cost).toBeCloseTo(0.0044, 12);
    const turn = db.prepare('SELECT cost_usd AS cost FROM turns WHERE id=?').get('turn') as { cost: number };
    expect(turn.cost).toBeCloseTo(ledger.turnCost('turn'), 12);
    closeDatabase(db);
  });
});
