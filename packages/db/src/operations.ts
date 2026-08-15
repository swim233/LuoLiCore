import { randomBytes } from 'node:crypto';
import type { Sqlite } from './database.js';

export class OperationsRepository {
  constructor(private readonly db: Sqlite) {}

  claimUpdate(updateId: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO processed_updates(update_id,ts) VALUES (?,?)').run(updateId, Date.now()).changes === 1;
  }

  insertLog(input: { level: string; kind: string; summary: string; traceId?: string; spanId?: string; parentSpanId?: string; chatId?: string; userId?: string; key?: string; data?: unknown; durationMs?: number }): number {
    const info = this.db.prepare(`INSERT INTO log_events(ts,level,kind,trace_id,span_id,parent_span_id,chat_id,user_id,key,summary,data_json,duration_ms)
      VALUES (@ts,@level,@kind,@traceId,@spanId,@parentSpanId,@chatId,@userId,@key,@summary,@data,@durationMs)`).run({
      ts: Date.now(), level: input.level, kind: input.kind, summary: input.summary, traceId: input.traceId ?? null,
      spanId: input.spanId ?? null, parentSpanId: input.parentSpanId ?? null, chatId: input.chatId ?? null,
      userId: input.userId ?? null, key: input.key ?? null, data: input.data ? JSON.stringify(input.data) : null,
      durationMs: input.durationMs ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  logs(limit = 100, traceId?: string): unknown[] {
    if (traceId) return this.db.prepare('SELECT * FROM log_events WHERE trace_id=? ORDER BY ts,id LIMIT ?').all(traceId, limit);
    return this.db.prepare('SELECT * FROM log_events ORDER BY ts DESC,id DESC LIMIT ?').all(limit);
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

  dashboard(): Record<string, unknown> {
    const turns = this.db.prepare(`SELECT COUNT(*) AS total,SUM(state='running') AS running,SUM(state='failed') AS failed,COALESCE(SUM(cost_usd),0) AS cost FROM turns`).get();
    const messages = this.db.prepare('SELECT COUNT(*) AS total FROM messages').get();
    const providers = this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(enabled),0) AS enabled FROM providers').get();
    return { turns, messages, providers };
  }
}

export class TurnRepository {
  constructor(private readonly db: Sqlite) {}

  create(input: { id: string; key: string; chatId: string; threadId: number | null; userId: string; role: string; triggerMessageId: number; triggerReason: string; baseCommitId: string | null }): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO turns(id,key,chat_id,thread_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,base_commit_id,state,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'running',?)`).run(input.id, input.key, input.chatId, input.threadId, input.userId, input.role, input.triggerMessageId, input.triggerReason, input.baseCommitId, now);
  }

  finish(id: string, input: { state: 'committed' | 'failed' | 'cancelled'; commitId?: string; rebased?: boolean; error?: string; cancelReason?: string }): void {
    this.db.prepare(`UPDATE turns SET state=?,commit_id=?,rebased=?,error=?,cancel_reason=?,finished_at=? WHERE id=?`).run(input.state,
      input.commitId ?? null, input.rebased ? 1 : 0, input.error ?? null, input.cancelReason ?? null, Date.now(), id);
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
