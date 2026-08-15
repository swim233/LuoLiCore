import type { Sqlite } from '@luoli/db';

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
  rows: Array<{ scope: 'global' | 'chat' | 'user'; subject: string; window: 'day' | 'month'; bucket: string }>;
  committed: number;
}

function bucket(now: Date, timezone: string, window: 'day' | 'month'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return window === 'day' ? parts : parts.slice(0, 7);
}

export class QuotaGuard {
  constructor(private readonly db: Sqlite, private readonly timezone: string) {}

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
          rows.push({ scope: entry.scope, subject: entry.subject, window, bucket: currentBucket });
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
    this.db.transaction(() => {
      for (const row of reservation.rows) this.db.prepare(`UPDATE quota_counters SET cost_usd=cost_usd+?,reserved_usd=MAX(0,reserved_usd-?),turns=turns+1,updated_at=?
        WHERE scope=? AND subject=? AND window=? AND bucket=?`).run(actualUsd, release, Date.now(), row.scope, row.subject, row.window, row.bucket);
      reservation.amount = Math.max(0, reservation.amount - release);
      reservation.committed += actualUsd;
    })();
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
