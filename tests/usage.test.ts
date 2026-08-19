import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEDGER_CACHE_COST_REPAIR_KEY, UsageLedger, pricedInputTokens, repairLedgerCacheCost } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase, readAppKv, type Sqlite } from '@luoli/db';

function database(name: string): { db: Sqlite; close: () => void } {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  return { db, close: () => { closeDatabase(db); } };
}

const turn = (db: Sqlite, id: string, chatId = '1', userId = '1'): void => {
  db.prepare('INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state) VALUES (?,?,?,?,?,?)')
    .run(id, `chat:${chatId}`, chatId, userId, 'owner', 'running');
};

describe('usage ledger', () => {
  it('prices four token classes and keeps turn sum exact', () => {
    const { db, close } = database('usage');
    turn(db, 'turn');
    const ledger = new UsageLedger(db);
    // `inputTokens` 是 AI SDK 的 total —— 超集，含 cacheRead。计价的是 700 = 1000-200-100。
    const cost = ledger.record({ turnId: 'turn', chatId: '1', userId: '1', providerId: 'p', modelId: 'm', modelAlias: 'main',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50,
      priceIn: 2, priceOut: 4, priceCacheRead: 0.5, priceCacheWrite: 3, latencyMs: 10, finishReason: 'stop', ok: true });
    expect(cost).toBeCloseTo((700 * 2 + 500 * 4 + 200 * 0.5 + 100 * 3) / 1e6, 12);
    const row = db.prepare('SELECT cost_usd AS cost FROM turns WHERE id=?').get('turn') as { cost: number };
    expect(row.cost).toBeCloseTo(ledger.turnCost('turn'), 12);
    close();
  });

  /**
   * 这一条钉的是 `docs/reviews/28 · L-COST-01`：旧公式在 `inputTokens` 与 `cacheReadTokens`
   * 之上各收一次钱，而 AI SDK 的 `inputTokens` 是含缓存的**超集**（三家 provider 一致）。
   * 一次 91% 前缀命中的真实调用因此高估 9.4 倍。
   */
  it('缓存命中的 token 不重复计价 —— 靶子是报告里那次真实调用', () => {
    const { db, close } = database('usage-cache');
    turn(db, 'turn');
    const ledger = new UsageLedger(db);
    const cost = ledger.record({ turnId: 'turn', chatId: '1', userId: '1', providerId: 'p', modelId: 'm', modelAlias: 'main',
      inputTokens: 28_082, outputTokens: 25, cacheReadTokens: 25_600, cacheWriteTokens: 0, noCacheTokens: 2482, reasoningTokens: 0,
      priceIn: 0.14, priceOut: 0.28, priceCacheRead: 0.0028, priceCacheWrite: 0, latencyMs: 10, ok: true });
    expect(cost).toBeCloseTo(0.00042616, 12);
    // 旧口径那个数字留在断言里当反向靶子：谁把公式改回去，这一行会说出高估了多少倍。
    expect(0.00401016 / cost).toBeCloseTo(9.4, 1);
    close();
  });

  it('noCacheTokens 缺失时按相减回落，而不是回落到 total', () => {
    // SDK 换大版本让那个字段消失时，「少扣一次缓存」是账目偏高（可查），「按 total 计价」是翻倍。
    expect(pricedInputTokens({ inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 100 })).toBe(700);
    expect(pricedInputTokens({ inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 100, noCacheTokens: 650 })).toBe(650);
    // 上游报了个自相矛盾的 usage（缓存比总输入还多）时不能变成负数计价。
    expect(pricedInputTokens({ inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0 })).toBe(0);
  });
});

describe('repairLedgerCacheCost · 存量账目重算（L-COST-01）', () => {
  /** 直接插 ledger 行而不走 `record()`：要造的正是**旧口径**的行。 */
  const legacyRow = (db: Sqlite, id: number, turnId: string, chatId: string, userId: string, ts: number,
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, price: { in: number; out: number; cacheRead: number }): number => {
    const cost = (usage.input * price.in + usage.output * price.out + usage.cacheRead * price.cacheRead) / 1e6;
    db.prepare(`INSERT INTO usage_ledger(id,ts,turn_id,chat_id,user_id,provider_id,model_id,model_alias,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_ms,ok)
      VALUES (?,?,?,?,?,'p','m','main',?,?,?,?,0,?,10,1)`)
      .run(id, ts, turnId, chatId, userId, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost);
    return cost;
  };

  function fixture(name: string): { db: Sqlite; close: () => void; ts: number } {
    const { db, close } = database(name);
    db.prepare(`INSERT INTO providers(id,name,kind,enabled,created_at,updated_at) VALUES ('p','ksm','openai-compatible',1,0,0)`).run();
    db.prepare(`INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,price_cache_read,price_cache_write,created_at,updated_at)
      VALUES ('mm','p','m',128000,8192,'{}',0.14,0.28,0.0028,0,0,0)`).run();
    // 同一天、同一个会话，好让日/月两个账期都覆盖得到。
    const ts = Date.UTC(2026, 7, 18, 4, 0, 0);
    turn(db, 'turn-a'); turn(db, 'turn-b');
    return { db, close, ts };
  }

  it('重算受影响的行、按 SUM 修正 turns，并把配额计数一起落下来', () => {
    const { db, close, ts } = fixture('ledger-repair');
    const oldA = legacyRow(db, 1, 'turn-a', '1', '1', ts, { input: 28_082, output: 25, cacheRead: 25_600, cacheWrite: 0 }, { in: 0.14, out: 0.28, cacheRead: 0.0028 });
    const oldB = legacyRow(db, 2, 'turn-b', '1', '1', ts, { input: 10_000, output: 100, cacheRead: 8000, cacheWrite: 0 }, { in: 0.14, out: 0.28, cacheRead: 0.0028 });
    // 没有缓存命中的那一行：两个公式同值，修复必须一个字都不动它。
    const oldC = legacyRow(db, 3, 'turn-b', '1', '1', ts, { input: 500, output: 10, cacheRead: 0, cacheWrite: 0 }, { in: 0.14, out: 0.28, cacheRead: 0.0028 });
    db.prepare('UPDATE turns SET cost_usd=? WHERE id=?').run(oldA, 'turn-a');
    db.prepare('UPDATE turns SET cost_usd=? WHERE id=?').run(oldB + oldC, 'turn-b');
    for (const [scope, subject, window, bucket, cost] of [['global', 'global', 'day', '2026-08-18', oldA + oldB + oldC],
      ['user', '1', 'day', '2026-08-18', oldA + oldB + oldC], ['chat', '1', 'month', '2026-08', oldA + oldB + oldC]] as const) {
      db.prepare('INSERT INTO quota_counters(scope,subject,window,bucket,cost_usd,reserved_usd,turns,updated_at) VALUES (?,?,?,?,?,0,3,0)')
        .run(scope, subject, window, bucket, cost);
    }

    const result = repairLedgerCacheCost(db, 'UTC');
    expect(result).not.toBeNull();
    expect(result!.scanned).toBe(3);
    expect(result!.affected).toBe(2);          // 第三行没命中缓存，不进这个数
    expect(result!.rewritten).toBe(2);
    expect(result!.skipped).toBe(0);

    const rows = db.prepare('SELECT id,cost_usd AS cost FROM usage_ledger ORDER BY id').all() as Array<{ id: number; cost: number }>;
    expect(rows[0]!.cost).toBeCloseTo((2482 * 0.14 + 25 * 0.28 + 25_600 * 0.0028) / 1e6, 12);
    expect(rows[1]!.cost).toBeCloseTo((2000 * 0.14 + 100 * 0.28 + 8000 * 0.0028) / 1e6, 12);
    expect(rows[2]!.cost).toBe(oldC);          // 一个字都没动

    // `turns.cost_usd` 与 ledger 之和必须逐位相等（docs/10 §7 第 3 条）。
    for (const id of ['turn-a', 'turn-b']) {
      const turnRow = db.prepare('SELECT cost_usd AS cost FROM turns WHERE id=?').get(id) as { cost: number };
      const sum = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS value FROM usage_ledger WHERE turn_id=?').pluck().get(id) as number;
      expect(Math.abs(turnRow.cost - sum)).toBeLessThan(1e-12);
    }
    const total = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS value FROM usage_ledger').pluck().get() as number;
    for (const counter of db.prepare('SELECT scope,cost_usd AS cost FROM quota_counters').all() as Array<{ scope: string; cost: number }>) {
      expect(counter.cost).toBeCloseTo(total, 12);
    }
    close();
  });

  it('定价此后改过的行原样留下 —— 只改我们自己算错的那些', () => {
    const { db, close, ts } = fixture('ledger-repair-skip');
    // 按 0.20 的旧价记的账，而库里现在的定价是 0.14：旧公式复现不出这个数，不许碰。
    const stale = legacyRow(db, 1, 'turn-a', '1', '1', ts, { input: 10_000, output: 100, cacheRead: 8000, cacheWrite: 0 }, { in: 0.20, out: 0.28, cacheRead: 0.0028 });
    const result = repairLedgerCacheCost(db, 'UTC');
    expect(result!.affected).toBe(1);
    expect(result!.rewritten).toBe(0);
    expect(result!.skipped).toBe(1);
    expect(db.prepare('SELECT cost_usd AS cost FROM usage_ledger WHERE id=1').pluck().get()).toBe(stale);
    close();
  });

  it('门闸挡住第二次运行', () => {
    const { db, close, ts } = fixture('ledger-repair-once');
    legacyRow(db, 1, 'turn-a', '1', '1', ts, { input: 10_000, output: 100, cacheRead: 8000, cacheWrite: 0 }, { in: 0.14, out: 0.28, cacheRead: 0.0028 });
    expect(repairLedgerCacheCost(db, 'UTC')!.rewritten).toBe(1);
    expect(readAppKv<boolean>(db, LEDGER_CACHE_COST_REPAIR_KEY)).toBe(true);
    expect(repairLedgerCacheCost(db, 'UTC')).toBeNull();
    close();
  });

  it('明细已过保留期的账期算不回来时原样留下', () => {
    const { db, close, ts } = fixture('ledger-repair-stale-counter');
    legacyRow(db, 1, 'turn-a', '1', '1', ts, { input: 10_000, output: 100, cacheRead: 8000, cacheWrite: 0 }, { in: 0.14, out: 0.28, cacheRead: 0.0028 });
    // 计数器里记着 $5，而 ledger 里只剩这一条 —— 聚合出来远小于库里那个数，说明明细被清过。
    db.prepare(`INSERT INTO quota_counters(scope,subject,window,bucket,cost_usd,reserved_usd,turns,updated_at) VALUES ('global','global','day','2026-08-18',5,0,300,0)`).run();
    // 另一个账期压根不在 ledger 里。
    db.prepare(`INSERT INTO quota_counters(scope,subject,window,bucket,cost_usd,reserved_usd,turns,updated_at) VALUES ('global','global','day','2026-07-01',2,0,10,0)`).run();
    const result = repairLedgerCacheCost(db, 'UTC');
    // 第一行会被下调到聚合值（只降不升成立），第二行没有聚合值 → stale。
    expect(result!.countersStale).toBe(1);
    expect(db.prepare(`SELECT cost_usd FROM quota_counters WHERE bucket='2026-07-01'`).pluck().get()).toBe(2);
    close();
  });
});
