import { ulid } from 'ulid';
import type { ApprovalVerdict, ApprovalRisk, ApprovalBroker, RegisteredTool, ToolExecutionContext } from './tools/registry.js';
import type { Config } from './config/schema.js';
import type { EventBus } from './events.js';
import type { LogSink } from './log/sink.js';
import type { Sqlite } from '@luoli/db';

const DENIED_HINT = '该操作需要人工批准，但管理员已拒绝，因此没有执行。请说明操作未获批准，并给出不需要该操作的替代做法。';
const EXPIRED_HINT = '该操作需要人工批准，但审批窗口已过期，因此没有执行。请说明审批已超时，并让用户在仍需执行时重新发起。';
const CANCELLED_HINT = '该操作等待审批时所属轮次已取消，因此没有执行。';
const UNAVAILABLE_HINT = '该操作需要 owner 批准，但当前没有可用的审批通道，因此没有执行。请说明审批通道不可用，并给出不需要该操作的替代做法。';

interface PendingApproval {
  finish(approved: boolean, hint?: string): void;
}

export class DatabaseApprovalBroker implements ApprovalBroker {
  readonly #config: () => Readonly<Config>;
  /** 连 hint 一起记：只记布尔的话，同轮重试一次过期/取消的调用会拿到「管理员已拒绝」，
   *  模型据此告诉用户「被拒了」，而真相是没人来得及看。 */
  readonly #remembered = new Map<string, { approved: boolean; hint?: string }>();
  readonly #pending = new Map<string, PendingApproval>();

  /**
   * 传 getter时每次读都取最新值：approval.enabled / ttlMs 热更新后下一次请求立即生效。
   *
   * @param notifyInitiator 给**发起人**的回执（`docs/22 · D-APPR-01`）。有裁决通道时这一轮会
   *   静静挂满 `ttlMs`（默认 180 秒），而 Telegram 那边一个字都没有 —— 用户看到的就是 bot 收了
   *   消息然后沉默三分钟。回执发不出去不影响审批本身，所以这里吞掉它的异常。
   */
  constructor(private readonly db: Sqlite, config: Readonly<Config> | (() => Readonly<Config>), private readonly events: EventBus, private readonly log: LogSink,
    private readonly notifyInitiator?: (input: { chatId: string; threadId: number | null; tool: string; risk: ApprovalRisk; ttlMs: number }) => Promise<unknown> | unknown) {
    this.#config = typeof config === 'function' ? config : () => config;
    this.db.prepare("UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE state='pending' AND expires_at<=?").run(Date.now(), Date.now());
  }

  releaseTurn(turnId: string): void {
    for (const key of this.#remembered.keys()) if (key.startsWith(`${turnId}:`)) this.#remembered.delete(key);
  }

  async request(tool: RegisteredTool, input: unknown, context: ToolExecutionContext, risk: ApprovalRisk): Promise<ApprovalVerdict> {
    const config = this.#config();
    if (!config.approval.enabled) return { approved: true };
    if (context.turn.abortSignal.aborted) return { approved: false, hint: CANCELLED_HINT };
    const rememberedKey = `${context.turn.turnId}:${tool.name}:${JSON.stringify(input)}`;
    if (config.approval.rememberWithinTurn && this.#remembered.has(rememberedKey)) {
      const previous = this.#remembered.get(rememberedKey)!;
      return previous.approved ? { approved: true } : { approved: false, hint: previous.hint ?? DENIED_HINT };
    }
    if (context.turn.effectiveRole === 'owner' && config.approval.skipForOwner) {
      this.log.event({ level: 'info', kind: 'approval.decided', summary: `${tool.name} auto-approved`, traceId: context.turn.turnId, data: { channel: 'auto', role: 'owner', risk } });
      if (config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, { approved: true });
      return { approved: true };
    }
    // 数的是裁决通道，不是订阅者：main.ts 的 config.changed 订阅者常驻，用 subscriberCount
    // 判断等于这段永远走不到，非 owner 照旧静默干等满 ttlMs（docs/24 · R-APPR-01）。
    if (this.events.channelCount === 0) {
      this.log.event({ level: 'warn', kind: 'approval.unavailable', summary: `${tool.name} approval channel unavailable`, traceId: context.turn.turnId, data: { risk } });
      if (config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, { approved: false, hint: UNAVAILABLE_HINT });
      return { approved: false, hint: UNAVAILABLE_HINT };
    }

    const id = ulid();
    const now = Date.now();
    const expiresAt = now + config.approval.ttlMs;
    this.db.prepare(`INSERT INTO approvals(id,turn_id,agent_run_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, context.turn.turnId, context.agentRunId ?? null, context.turn.chatId, context.turn.initiatorUserId, tool.name, JSON.stringify(input), risk, 'pending', now, expiresAt);

    // 回执在**插入 pending 行之后**发：先落库再通知，通知失败也不会留下一个没人知道的等待。
    try {
      void Promise.resolve(this.notifyInitiator?.({ chatId: context.turn.chatId, threadId: context.turn.threadId, tool: tool.name, risk, ttlMs: config.approval.ttlMs }))
        .catch((error: unknown) => this.log.event({ level: 'warn', kind: 'approval.receipt_failed', summary: 'initiator receipt failed', traceId: context.turn.turnId, data: { error: error instanceof Error ? error.message : String(error) } }));
    } catch { /* 同步抛也不能影响审批 */ }
    return new Promise<ApprovalVerdict>((resolve) => {
      let settled = false;
      const abort = (): void => {
        const changed = this.db.prepare("UPDATE approvals SET state='denied',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'").run(Date.now(), id).changes;
        if (changed) this.events.emit('approval.decided', { id, tool: tool.name, risk, chatId: context.turn.chatId, approved: false, actor: 'system', channel: 'system' });
        finish(false, CANCELLED_HINT);
      };
      const finish = (approved: boolean, hint?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.turn.abortSignal.removeEventListener('abort', abort);
        this.#pending.delete(id);
        if (config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, approved ? { approved } : { approved, hint: hint ?? DENIED_HINT });
        resolve(approved ? { approved: true } : { approved: false, hint: hint ?? DENIED_HINT });
      };
      const timer = setTimeout(() => {
        const changed = this.db.prepare("UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'").run(Date.now(), id).changes;
        if (changed) {
          this.events.emit('approval.decided', { id, tool: tool.name, risk, chatId: context.turn.chatId, approved: false, actor: 'system', channel: 'system', state: 'expired' });
          this.log.event({ level: 'warn', kind: 'approval.expired', summary: `${tool.name} approval expired`, traceId: context.turn.turnId, data: { id, risk } });
        }
        finish(false, EXPIRED_HINT);
      }, config.approval.ttlMs);
      timer.unref?.();
      this.#pending.set(id, { finish });
      context.turn.abortSignal.addEventListener('abort', abort, { once: true });
      this.events.emit('approval.pending', { id, turnId: context.turn.turnId, agentRunId: context.agentRunId ?? null, tool: tool.name, input, risk,
        chatId: context.turn.chatId, requesterUserId: context.turn.initiatorUserId, requestedAt: now, expiresAt });
      this.log.event({ level: 'warn', kind: 'approval.pending', summary: `${tool.name} awaits approval`, traceId: context.turn.turnId, data: { id, risk, expiresAt } });
    });
  }

  decide(id: string, approved: boolean, actor: string, channel: 'telegram' | 'webui'): boolean {
    const now = Date.now();
    const row = this.db.prepare('SELECT tool_name AS tool,risk,chat_id AS chatId,expires_at AS expiresAt,state FROM approvals WHERE id=?').get(id) as { tool: string; risk: string; chatId: string; expiresAt: number; state: string } | undefined;
    if (!row) return false;
    if (row.state === 'pending' && row.expiresAt <= now) {
      const changed = this.db.prepare("UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'").run(now, id).changes;
      if (changed) {
        this.events.emit('approval.decided', { id, tool: row.tool, risk: row.risk, chatId: row.chatId, approved: false, actor: 'system', channel: 'system', state: 'expired' });
        this.log.event({ level: 'warn', kind: 'approval.expired', summary: `${row.tool} approval expired`, data: { id, risk: row.risk } });
        this.#pending.get(id)?.finish(false, EXPIRED_HINT);
      }
      return false;
    }
    const changed = this.db.prepare(`UPDATE approvals SET state=?,decided_by=?,decided_at=?,decision_channel=? WHERE id=? AND state='pending' AND expires_at>?`)
      .run(approved ? 'approved' : 'denied', actor, now, channel, id, now).changes;
    if (!changed) return false;
    this.events.emit('approval.decided', { id, tool: row.tool, risk: row.risk, chatId: row.chatId, approved, actor, channel });
    this.log.event({ level: approved ? 'info' : 'warn', kind: 'approval.decided', summary: `${row.tool} ${approved ? 'approved' : 'denied'}`, data: { id, actor, channel, risk: row.risk } });
    this.#pending.get(id)?.finish(approved, approved ? undefined : DENIED_HINT);
    return true;
  }
}
