import { randomBytes } from 'node:crypto';
import type { Sqlite } from './database.js';

export class OperationsRepository {
  constructor(private readonly db: Sqlite) {}

  claimUpdate(updateId: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO processed_updates(update_id,ts) VALUES (?,?)').run(updateId, Date.now()).changes === 1;
  }

  /**
   * `fileRef`：超过 `logs.bodyMaxBytes` 的载荷被挪进 `logs/<day>/blobs/*.json` 之后的引用。
   * 它此前只藏在 `data_json` 里，`log_events.file_ref` 这一列**从来没被写过** —— 而 doc 03 的
   * DDL 里就有它，按那份 DDL 去查库的人会以为「没有 file_ref 就是没有大载荷」。
   * 两处都写：`data_json` 保持原样（解引用的路径认的是它），列也填上，让 DDL 说话算数。
   */
  insertLog(input: { level: string; kind: string; summary: string; traceId?: string; spanId?: string; parentSpanId?: string; chatId?: string; userId?: string; key?: string; data?: unknown; durationMs?: number; fileRef?: string }): number {
    const info = this.db.prepare(`INSERT INTO log_events(ts,level,kind,trace_id,span_id,parent_span_id,chat_id,user_id,key,summary,data_json,file_ref,duration_ms)
      VALUES (@ts,@level,@kind,@traceId,@spanId,@parentSpanId,@chatId,@userId,@key,@summary,@data,@fileRef,@durationMs)`).run({
      ts: Date.now(), level: input.level, kind: input.kind, summary: input.summary, traceId: input.traceId ?? null,
      spanId: input.spanId ?? null, parentSpanId: input.parentSpanId ?? null, chatId: input.chatId ?? null,
      userId: input.userId ?? null, key: input.key ?? null, data: input.data ? JSON.stringify(input.data) : null,
      fileRef: input.fileRef ?? null, durationMs: input.durationMs ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /**
   * @param minLevel 只取这个级别及以上。总览页的「最近错误」卡片要的是 `warn` 以上
   *   （docs/09 §3.1）—— 不分级别地取最近几条，结果几乎总是被 info 刷满，那张卡片就白挂了。
   */
  logs(limit = 100, traceId?: string, minLevel?: 'debug' | 'info' | 'warn' | 'error'): unknown[] {
    const ranked = ['debug', 'info', 'warn', 'error'];
    const allowed = minLevel ? ranked.slice(ranked.indexOf(minLevel)) : null;
    const levelClause = allowed ? ` AND level IN (${allowed.map(() => '?').join(',')})` : '';
    if (traceId) return this.db.prepare(`SELECT * FROM log_events WHERE trace_id=?${levelClause} ORDER BY ts,id LIMIT ?`).all(traceId, ...(allowed ?? []), limit);
    return this.db.prepare(`SELECT * FROM log_events${allowed ? ` WHERE level IN (${allowed.map(() => '?').join(',')})` : ''} ORDER BY ts DESC,id DESC LIMIT ?`).all(...(allowed ?? []), limit);
  }

  createSession(ttlHours: number, ip?: string, ua?: string): { id: string; csrf: string; expiresAt: number } {
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + ttlHours * 3_600_000;
    this.db.prepare('INSERT INTO sessions(id,created_at,expires_at,last_seen_at,ip,ua,csrf) VALUES (?,?,?,?,?,?,?)').run(id, now, expiresAt, now, ip ?? null, ua ?? null, csrf);
    return { id, csrf, expiresAt };
  }

  session(id: string): { id: string; csrf: string; expiresAt: number } | null {
    const row = this.db.prepare('SELECT id,csrf,expires_at AS expiresAt FROM sessions WHERE id=? AND expires_at>?').get(id, Date.now()) as { id: string; csrf: string; expiresAt: number } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(Date.now(), id);
    return row;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  }

  /**
   * @param timezone 趋势按**本地日**分桶。用 UTC 分桶的话，东八区的运维会看到每天的量在
   *   早上八点断开 —— 与配额 bucket（`quotaBucket`）用同一个时区口径。
   *
   * 四张指标卡是累计值，趋势是近 `days` 天的逐日量（docs/09 §3.1）。缺的那些天补 0 而不是跳过：
   * 折线图上「那天没有点」和「那天是 0」看起来是两回事。
   */
  dashboard(timezone = 'UTC', days = 7): Record<string, unknown> {
    const turns = this.db.prepare(`SELECT COUNT(*) AS total,SUM(state='running') AS running,SUM(state='failed') AS failed,COALESCE(SUM(cost_usd),0) AS cost FROM turns`).get();
    const messages = this.db.prepare('SELECT COUNT(*) AS total FROM messages').get();
    const providers = this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(enabled),0) AS enabled FROM providers').get();
    const since = Date.now() - days * 86_400_000;
    const day = (ts: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
    const buckets = new Map<string, { day: string; messages: number; turns: number; costUsd: number }>();
    for (let index = days - 1; index >= 0; index -= 1) {
      const name = day(Date.now() - index * 86_400_000);
      buckets.set(name, { day: name, messages: 0, turns: 0, costUsd: 0 });
    }
    for (const row of this.db.prepare('SELECT tg_date AS ts FROM messages WHERE tg_date>=?').all(since) as Array<{ ts: number }>) {
      const bucket = buckets.get(day(row.ts));
      if (bucket) bucket.messages += 1;
    }
    for (const row of this.db.prepare('SELECT COALESCE(started_at,queued_at) AS ts,COALESCE(cost_usd,0) AS cost FROM turns WHERE COALESCE(started_at,queued_at)>=?').all(since) as Array<{ ts: number; cost: number }>) {
      const bucket = buckets.get(day(row.ts));
      if (bucket) { bucket.turns += 1; bucket.costUsd += row.cost; }
    }
    return { turns, messages, providers, trend: [...buckets.values()] };
  }
}

export interface TurnSummary { state: string; steps: number; toolCalls: number; costUsd: number; rebased: number; durationMs: number }

export class TurnRepository {
  constructor(private readonly db: Sqlite) {}

  create(input: { id: string; key: string; chatId: string; threadId: number | null; userId: string; role: string; triggerMessageId: number; triggerReason: string; baseCommitId: string | null }): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO turns(id,key,chat_id,thread_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,base_commit_id,state,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'running',?)`).run(input.id, input.key, input.chatId, input.threadId, input.userId, input.role, input.triggerMessageId, input.triggerReason, input.baseCommitId, now);
  }

  /** 回一份结算后的统计：`turn.finished` 事件要的 steps/花费/耗时都在这一行上，
   *  调用方再查一次等于每轮多一条 SELECT，而 RETURNING 是白送的。 */
  finish(id: string, input: { state: 'committed' | 'failed' | 'cancelled'; commitId?: string; rebased?: boolean; error?: string; cancelReason?: string }): TurnSummary | null {
    const row = this.db.prepare(`UPDATE turns SET state=?,commit_id=?,rebased=?,error=?,cancel_reason=?,finished_at=? WHERE id=?
      RETURNING state,steps,tool_calls AS toolCalls,cost_usd AS costUsd,rebased,finished_at-COALESCE(started_at,queued_at,finished_at) AS durationMs`).get(input.state,
      input.commitId ?? null, input.rebased ? 1 : 0, input.error ?? null, input.cancelReason ?? null, Date.now(), id) as TurnSummary | undefined;
    return row ?? null;
  }

  active(chatId: string): unknown[] {
    return this.db.prepare("SELECT * FROM turns WHERE chat_id=? AND state IN ('queued','running') ORDER BY started_at").all(chatId);
  }


  cost(id: string): number {
    const row = this.db.prepare('SELECT cost_usd AS value FROM turns WHERE id=?').get(id) as { value: number } | undefined;
    return row?.value ?? 0;
  }
  incrementToolCall(id: string): void {
    this.db.prepare('UPDATE turns SET tool_calls=tool_calls+1 WHERE id=?').run(id);
  }
}
