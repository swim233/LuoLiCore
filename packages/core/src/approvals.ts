import { ulid } from 'ulid';
import type { ApprovalVerdict, ApprovalRisk, ApprovalBroker, RegisteredTool, ToolExecutionContext } from './tools/registry.js';
import type { Config } from './config/schema.js';
import type { EventBus } from './events.js';
import type { LogSink } from './log/sink.js';
import type { Sqlite } from '@luoli/db';

/**
 * 审批交互只在 WebUI 画了一半：doc 05 §6 里的 Telegram inline keyboard 一行没实现，
 * 而绝大多数轮次都从 Telegram 发起。旧实现每 500ms 轮询数据库、整整等满 `approval.ttlMs`，
 * 发起人对着沉默的机器人干等三分钟，最后仍然是「未获批准」——这正是「摘除比伪造安全」
 * （docs/16 §5）要摘掉的形状。现在当场拒绝，并把原因交给模型用它自己的话讲出来。
 */
const NO_CHANNEL_HINT = '该操作按审批策略需要人工批准，但当前没有可用的审批通道（Telegram 审批交互未实现，见 docs/05 §6 🚧），因此这一步没有执行。请用你自己的说话方式告诉用户这件事，并给出不需要审批的替代做法。';

export class DatabaseApprovalBroker implements ApprovalBroker {
  readonly #config: () => Readonly<Config>;
  /** 传 getter 时每次读都取最新值：`approval.enabled` 标着热更新，吃快照等于开关点了没用（docs/20 · W-CFG-02）。 */
  constructor(private readonly db: Sqlite, config: Readonly<Config> | (() => Readonly<Config>), private readonly events: EventBus, private readonly log: LogSink) {
    this.#config = typeof config === 'function' ? config : () => config;
  }
  readonly #remembered = new Map<string, boolean>();
  releaseTurn(turnId: string): void {
    for (const key of this.#remembered.keys()) if (key.startsWith(`${turnId}:`)) this.#remembered.delete(key);
  }

  async request(tool: RegisteredTool, input: unknown, context: ToolExecutionContext, risk: ApprovalRisk): Promise<ApprovalVerdict> {
    const config = this.#config();
    if (!config.approval.enabled) return { approved: true };
    const rememberedKey = `${context.turn.turnId}:${tool.name}:${JSON.stringify(input)}`;
    if (config.approval.rememberWithinTurn && this.#remembered.has(rememberedKey)) {
      const remembered = this.#remembered.get(rememberedKey)!;
      return remembered ? { approved: true } : { approved: false, hint: NO_CHANNEL_HINT };
    }
    if (context.turn.effectiveRole === 'owner' && config.approval.skipForOwner) {
      this.log.event({ level: 'info', kind: 'approval.decided', summary: `${tool.name} auto-approved`, traceId: context.turn.turnId, data: { channel: 'auto', role: 'owner', risk } });
      if (config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, true);
      return { approved: true };
    }
    // 记录仍然要留：运维得知道什么被挡了、挡了多少次，哪怕当下没人能批。
    const id = ulid();
    const now = Date.now();
    this.db.prepare(`INSERT INTO approvals(id,turn_id,agent_run_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at,decided_by,decided_at,decision_channel)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, context.turn.turnId, context.agentRunId ?? null, context.turn.chatId, context.turn.initiatorUserId, tool.name, JSON.stringify(input), risk, 'denied', now, now, 'system', now, 'none');
    this.events.emit('approval.decided', { id, tool: tool.name, risk, chatId: context.turn.chatId, approved: false, actor: 'system', channel: 'none' });
    this.log.event({ level: 'warn', kind: 'approval.denied', summary: `${tool.name} denied: no approval channel`, traceId: context.turn.turnId, data: { id, risk, tool: tool.name } });
    if (config.approval.rememberWithinTurn) this.#remembered.set(rememberedKey, false);
    return { approved: false, hint: NO_CHANNEL_HINT };
  }

  decide(id: string, approved: boolean, actor: string, channel: 'telegram' | 'webui'): boolean {
    const info = this.db.prepare(`UPDATE approvals SET state=?,decided_by=?,decided_at=?,decision_channel=? WHERE id=? AND state='pending' AND expires_at>?`).run(approved ? 'approved' : 'denied', actor, Date.now(), channel, id, Date.now());
    if (info.changes) this.events.emit('approval.decided', { id, approved, actor, channel });
    return info.changes === 1;
  }
}
