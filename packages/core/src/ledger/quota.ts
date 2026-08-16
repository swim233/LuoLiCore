import type { Sqlite } from '@luoli/db';
import type { EventBus } from '../events.js';

export interface QuotaLimits {
  globalDaily: number | null;
  chatDaily: number | null;
  userDaily: number | null;
  globalMonthly: number | null;
  chatMonthly: number | null;
  userMonthly: number | null;
}

export interface QuotaReservation {
  amount: number;
  /** `limit` 跟着行走：结算时要发 `quota` 事件（docs/09 §5），而那时已经拿不到本轮的限额了。 */
  rows: Array<{ scope: 'global' | 'chat' | 'user'; subject: string; window: 'day' | 'month'; bucket: string; limit: number }>;
  committed: number;
}

/** 导出而不是留成模块私有：WebUI 要判断一行计数器是不是「当前这个窗口」，
 *  在服务端重写一遍 Intl 调用只会在时区/格式上和记账侧漂移开。 */
export function quotaBucket(now: Date, timezone: string, window: 'day' | 'month'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return window === 'day' ? parts : parts.slice(0, 7);
}
const bucket = quotaBucket;

export class QuotaGuard {
  constructor(private readonly db: Sqlite, private readonly timezone: string, private readonly events?: EventBus) {}

  reserve(input: { chatId: string; userId: string; estimateUsd: number; limits: QuotaLimits }): QuotaReservation | null {
    const now = new Date();
    const scopes: Array<{ scope: 'global' | 'chat' | 'user'; subject: string; daily: number | null; monthly: number | null }> = [
      { scope: 'global', subject: 'global', daily: input.limits.globalDaily, monthly: input.limits.globalMonthly },
      { scope: 'chat', subject: input.chatId, daily: input.limits.chatDaily, monthly: input.limits.chatMonthly },
      { scope: 'user', subject: input.userId, daily: input.limits.userDaily, monthly: input.limits.userMonthly },
    ];
    return this.db.transaction(() => {
      const rows: QuotaReservation['rows'] = [];
      for (const entry of scopes) {
        for (const window of ['day', 'month'] as const) {
          const limit = window === 'day' ? entry.daily : entry.monthly;
          if (limit === null) continue;
          const currentBucket = bucket(now, this.timezone, window);
          const current = this.db.prepare('SELECT cost_usd AS cost,reserved_usd AS reserved FROM quota_counters WHERE scope=? AND subject=? AND window=? AND bucket=?').get(entry.scope, entry.subject, window, currentBucket) as { cost: number; reserved: number } | undefined;
          if ((current?.cost ?? 0) + (current?.reserved ?? 0) + input.estimateUsd > limit) return null;
          rows.push({ scope: entry.scope, subject: entry.subject, window, bucket: currentBucket, limit });
        }
      }
      for (const row of rows) this.db.prepare(`INSERT INTO quota_counters(scope,subject,window,bucket,reserved_usd,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(scope,subject,window,bucket) DO UPDATE SET reserved_usd=reserved_usd+excluded.reserved_usd,updated_at=excluded.updated_at`).run(row.scope, row.subject, row.window, row.bucket, input.estimateUsd, Date.now());
      return { amount: input.estimateUsd, committed: 0, rows };
    })();
  }

  commit(reservation: QuotaReservation, actualUsd: number): void {
    if (actualUsd <= 0) return;
    const release = Math.min(reservation.amount, actualUsd);
    // RETURNING 而不是 run() 之后再查一遍：结算发生在每一步模型调用之后，这里多一条 SELECT
    // 就是每轮多几十次。已花掉的额度是「配额」事件唯一有意义的载荷，顺手带回来。
    const settled: Array<{ scope: string; subject: string; window: string; bucket: string; spent: number; limit: number }> = [];
    this.db.transaction(() => {
      for (const row of reservation.rows) {
        const after = this.db.prepare(`UPDATE quota_counters SET cost_usd=cost_usd+?,reserved_usd=MAX(0,reserved_usd-?),turns=turns+1,updated_at=?
          WHERE scope=? AND subject=? AND window=? AND bucket=? RETURNING cost_usd AS cost,reserved_usd AS reserved`)
          .get(actualUsd, release, Date.now(), row.scope, row.subject, row.window, row.bucket) as { cost: number; reserved: number } | undefined;
        if (after) settled.push({ scope: row.scope, subject: row.subject, window: row.window, bucket: row.bucket, spent: after.cost + after.reserved, limit: row.limit });
      }
      reservation.amount = Math.max(0, reservation.amount - release);
      reservation.committed += actualUsd;
    })();
    // 事务提交之后再广播：订阅方（WebUI）收到事件就会回来读这几行，先发会读到旧值。
    for (const row of settled) this.events?.emit('quota', row);
  }

  release(reservation: QuotaReservation): void {
    for (const row of reservation.rows) this.db.prepare(`UPDATE quota_counters SET reserved_usd=CASE WHEN reserved_usd-? < 1e-12 THEN 0 ELSE reserved_usd-? END,updated_at=? WHERE scope=? AND subject=? AND window=? AND bucket=?`).run(reservation.amount, reservation.amount, Date.now(), row.scope, row.subject, row.window, row.bucket);
    reservation.amount = 0;
  }

  canStart(input: { chatId: string; userId: string; turnsPerUserPerHour: number; turnsPerChatPerHour: number; concurrentPerUser: number }): boolean {
    const since = Date.now() - 3_600_000;
    const user = this.db.prepare('SELECT COUNT(*) AS count,SUM(state IN (\'queued\',\'running\')) AS concurrent FROM turns WHERE initiator_user_id=? AND started_at>=?').get(input.userId, since) as { count: number; concurrent: number | null };
    if (user.count >= input.turnsPerUserPerHour || (user.concurrent ?? 0) >= input.concurrentPerUser) return false;
    const chat = this.db.prepare('SELECT COUNT(*) AS count FROM turns WHERE chat_id=? AND started_at>=?').get(input.chatId, since) as { count: number };
    return chat.count < input.turnsPerChatPerHour;
  }

  canSpend(reservation: QuotaReservation, maxTurnCost: number): boolean {
    return reservation.committed < maxTurnCost;
  }

  status(reservation: QuotaReservation): { committed: number; remaining: number } {
    return { committed: reservation.committed, remaining: reservation.amount };
  }
}

export function modelCost(input: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, price: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number {
  return (input.input * price.input + input.output * price.output + (input.cacheRead ?? 0) * (price.cacheRead ?? 0) + (input.cacheWrite ?? 0) * (price.cacheWrite ?? 0)) / 1_000_000;
}
