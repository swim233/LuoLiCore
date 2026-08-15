import { ulid } from 'ulid';
import type { ApprovalRisk, ApprovalBroker, RegisteredTool, ToolExecutionContext } from './tools/registry.js';
import type { Config } from './config/schema.js';
import type { EventBus } from './events.js';
import type { LogSink } from './log/sink.js';
import type { Sqlite } from '@luoli/db';

export class DatabaseApprovalBroker implements ApprovalBroker {
  constructor(private readonly db: Sqlite, private readonly config: Readonly<Config>, private readonly events: EventBus, private readonly log: LogSink) {}
  readonly #remembered = new Map<string, boolean>();
  releaseTurn(turnId: string): void {
    for (const key of this.#remembered.keys()) if (key.startsWith(`${turnId}:`)) this.#remembered.delete(key);
  }

  async request(tool: RegisteredTool, input: unknown, context: ToolExecutionContext, risk: ApprovalRisk): Promise<boolean> {
    if (!this.config.approval.enabled) return true;
    const rememberedKey = `${context.turn.turnId}:${tool.name}:${JSON.stringify(input)}`;
    if (this.config.approval.rememberWithinTurn && this.#remembered.has(rememberedKey)) return this.#remembered.get(rememberedKey)!;
    if (context.turn.effectiveRole === 'owner' && this.config.approval.skipForOwner) {
      this.log.event({ level: 'info', kind: 'approval.decided', summary: `${tool.name} auto-approved`, traceId: context.turn.turnId, data: { channel: 'auto', role: 'owner', risk } });
      if (this.config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, true);
      return true;
    }
    const id = ulid();
    const now = Date.now();
    const expiresAt = now + this.config.approval.ttlMs;
    this.db.prepare(`INSERT INTO approvals(id,turn_id,agent_run_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, context.turn.turnId, context.agentRunId ?? null, context.turn.chatId, context.turn.initiatorUserId, tool.name, JSON.stringify(input), risk, 'pending', now, expiresAt);
    this.events.emit('approval.pending', { id, tool: tool.name, risk, chatId: context.turn.chatId, expiresAt });
    this.log.event({ level: 'info', kind: 'approval.requested', summary: tool.name, traceId: context.turn.turnId, data: { id, expiresAt, risk } });
    return new Promise<boolean>((resolve) => {
      const timer = setInterval(() => {
        const row = this.db.prepare('SELECT state FROM approvals WHERE id=?').get(id) as { state: string } | undefined;
        if (row?.state === 'approved' || row?.state === 'denied') {
          clearInterval(timer);
          const approved = row.state === 'approved';
          if (this.config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, approved);
          resolve(approved);
        } else if (Date.now() >= expiresAt) {
          clearInterval(timer);
          this.db.prepare("UPDATE approvals SET state='expired' WHERE id=? AND state='pending'").run(id);
          if (this.config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, false);
          resolve(false);
        }
      }, 500);
      context.turn.abortSignal.addEventListener('abort', () => { clearInterval(timer); resolve(false); }, { once: true });
    });
  }

  decide(id: string, approved: boolean, actor: string, channel: 'telegram' | 'webui'): boolean {
    const info = this.db.prepare(`UPDATE approvals SET state=?,decided_by=?,decided_at=?,decision_channel=? WHERE id=? AND state='pending' AND expires_at>?`).run(approved ? 'approved' : 'denied', actor, Date.now(), channel, id, Date.now());
    if (info.changes) this.events.emit('approval.decided', { id, approved, actor, channel });
    return info.changes === 1;
  }
}
