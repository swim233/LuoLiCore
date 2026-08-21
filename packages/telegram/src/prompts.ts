import type { Bot } from 'grammy';
import type { ApprovalOutcome, LogSink, PromptChannel, PromptPost, PromptResolution, PromptTarget } from '@luoli/core';
import type { Role } from '@luoli/shared';

export interface TelegramPromptDependencies {
  /** 懒取：`PendingPrompts` 在 bot 建起来之前就装配好了（照 `TelegramTools` 那个形状）。 */
  bot(): Bot | null;
  /**
   * 「这个会话里点得动吗」。有效角色是 `min(用户角色, 会话角色)`（D9，`docs/05 §2.2` 那张表），
   * 所以 `decidableBy:'owner'` 只在**会话本身也是 owner 档**的地方满足得了 —— 一个 `trusted` 群里
   * 连 owner 本人都是 `trusted`。缺它时退回「只判 bot 起没起」，也就是可用性比可裁决性宽一档。
   */
  decidable?(chatId: string): boolean;
  log?: LogSink;
}

/**
 * `PromptChannel` 的 Telegram 实现（`docs/05 §6.1`）。core 只定接口 —— 依赖方向
 * `core → telegram` 不允许，而 `main.ts` 用 `bot()` getter 把这个实现塞进去，
 * **presence 即开关**：没有 Telegram 入口时 `available()` 为假。
 */
export class TelegramPromptChannel implements PromptChannel {
  constructor(private readonly dependencies: TelegramPromptDependencies) {}

  /**
   * 「bot 起来了」而不是「有人正在看」：后者测不出来，而 owner 的手机推送不需要他盯着屏幕。
   * 给了 `chatId` 就再问一句「那儿点得动吗」—— 少问这一句，可用性就比可裁决性宽，表现是
   * 「贴了一排点不动的按钮，然后这一轮干等满 ttlMs」。
   */
  available(chatId?: string): boolean {
    if (this.dependencies.bot() === null) return false;
    return chatId === undefined || this.dependencies.decidable?.(chatId) !== false;
  }

  /**
   * **不传 `parse_mode`、不分段。** 键盘挂在一条消息上，被 `segmentTelegramText` 切成两条就有
   * 一条没有按钮；而正文里任何 `*` `_` `[` 都会让 MarkdownV2 400，`sendWithFallback` 的降级会把
   * 消息重发一遍 —— 那时屏幕上就有两条各带一套按钮的消息，键盘状态彻底乱了。正文的硬截断在
   * core 侧（`PROMPT_TEXT_MAX`），这里只管发。
   */
  async post(post: PromptPost): Promise<PromptTarget | null> {
    const api = this.dependencies.bot()?.api;
    if (!api) return null;
    const sent = await api.sendMessage(post.chatId, post.text, {
      reply_markup: { inline_keyboard: [post.buttons.map((button) => ({ text: button.label, callback_data: button.token }))] },
      ...(post.threadId === null ? {} : { message_thread_id: post.threadId }),
    });
    this.dependencies.log?.event({ level: 'debug', kind: 'prompt.posted', summary: `${post.kind} → ${post.chatId}`, chatId: post.chatId, data: { kind: post.kind, messageId: sent.message_id, options: post.buttons.length } });
    return { chatId: post.chatId, messageId: sent.message_id };
  }

  /**
   * 收尾一条提示。带 `text` 时走 `editMessageText`：**撤键盘与改正文是同一次调用** —— 省略
   * `reply_markup` 就等于把键盘撤掉，而分成两次要在 `perChatPerMinute` 那 20 个槽位里排两回队，
   * 说的还是同一件事。不带 `text` 时只撤键盘（`editMessageReplyMarkup`）。
   *
   * 正文照 `post()` 同一套规矩：**不传 `parse_mode`**（一个 `*` 就 400，而这里没有 `sendWithFallback`
   * 那样的降级可退）。**失败一律吞掉记 debug**：用户把那条消息删了、或者同一条消息被收尾第二次
   * （`message is not modified`），都会回 400，而这两件事都不该影响任何等待者。
   */
  async settle(target: PromptTarget, text?: string): Promise<void> {
    const api = this.dependencies.bot()?.api;
    if (!api) return;
    try { await (text === undefined ? api.editMessageReplyMarkup(target.chatId, target.messageId) : api.editMessageText(target.chatId, target.messageId, text)); }
    catch (error) {
      this.dependencies.log?.event({ level: 'debug', kind: 'prompt.settle_failed', summary: text === undefined ? 'keyboard removal rejected' : 'receipt rewrite rejected', chatId: target.chatId, data: { messageId: target.messageId, rewrote: text !== undefined, error: error instanceof Error ? error.message : String(error) } });
    }
  }
}

/**
 * 一条审批收场之后回执该写什么（`docs/13 · AC-APV-004`）。原正文里那句「N 秒内没人处理就会自动
 * 拒绝」在任何一种收场之后都已经不成立 —— 让它停在屏幕上正是 `docs/21 §12`「界面在说谎」清过的
 * 那一类，所以撤键盘的同时把正文换掉。
 *
 * **五种收场读起来必须各不相同**：对着这条消息的人要能区分「有人在 Telegram 点了」「有人在
 * WebUI 裁了」「没人管、超时了」「这一轮被取消了」「进程重启、这条作废了」。前两种是「有人做过
 * 决定」，后三种是「没人做过决定」，而模型交回的 hint 也是照这个分的（`DENIED_HINT` /
 * `EXPIRED_HINT` / `CANCELLED_HINT`）。
 *
 * 说的是 `channel` 而不是 `decided_by`：后者在 Telegram 那条路上是 `user:<tgId>`，一串数字对群里
 * 其他人什么都不是，还顺手把 owner 的 Telegram id 抖了出去。裁决权只给 owner，所以「谁」是常量。
 */
export function approvalSettledText(tool: string, outcome: ApprovalOutcome): string {
  // `decide()` 那条路一定带 `channel`；缺了就把整个括号省掉，而不是留一个「（owner ）」。
  const who = outcome.channel === 'telegram' ? '（owner 在 Telegram 点的）' : outcome.channel === 'webui' ? '（owner 在 WebUI 的审批页裁的）' : '';
  switch (outcome.kind) {
    case 'approved': return `✅ ${tool} 已批准${who}，正在执行。`;
    case 'denied': return `🚫 ${tool} 被拒绝${who}，没有执行。`;
    case 'expired': return `⌛ ${tool} 的审批窗口到点了，没人裁决，按拒绝处理 —— 没有执行。`;
    case 'cancelled': return `⛔ ${tool} 还在等审批时这一轮被取消了，审批一并作废 —— 没有执行。`;
    case 'stale': return `♻️ ${tool} 的这条审批赶上了进程重启，已作废 —— 没有执行，要的话重新说一次。`;
  }
}

/**
 * `approvals.state` → 启动扫描那一趟（`staleKeyboards()`）该说的收场。
 *
 * 只分两档，因为这一趟能看见的**真实**状态也只有两种：`DatabaseApprovalBroker` 的构造函数先把
 * TTL 已过的 pending 行扫成 `expired`（那句话「窗口到点了」重启前后都成立），剩下的 pending 行是
 * 「重启够快、TTL 还没到」—— 等待者是进程内的 Promise，跨不了重启，所以它既没被裁决过、也永远
 * 不会被唤醒。`approved` / `denied` 带着一个没清掉的 `tg_message_id` 活到这里只有一个来路：
 * `decide()` 改完状态、`finish()` 还没清那一列的瞬间进程死了。那种行同样归 `stale` ——
 * 决定是做过的，但承接它的那一轮已经没了，「已作废、要的话重新说一次」对屏幕前的人才是真话。
 */
export function staleApprovalOutcome(state: string): ApprovalOutcome {
  return { kind: state === 'expired' ? 'expired' : 'stale' };
}

/**
 * 「你确实是 owner，但**在这个会话里**不是」这一句单独讲。`resolveEffectiveRole` 把 owner 在一个
 * `trusted` 群里压成 `trusted`（D9，`docs/05 §2.2` 那张表），于是部署方本人点自己的审批会收到
 * `promptAckText` 的「只有 owner 能裁决这条请求。」—— 那句话对他是纯粹的谎。返回 `null` 表示
 * 这一条不适用，交回 `promptAckText`。
 */
export function promptDeniedByChat(resolution: PromptResolution, userRole: Role, effectiveRole: Role): { text: string; show_alert: boolean } | null {
  if (resolution.status !== 'forbidden' || resolution.required !== 'owner') return null;
  if (userRole !== 'owner' || effectiveRole === 'owner') return null;
  return { text: `你在这个会话里的权限是 ${effectiveRole}（会话本身不是 owner 档），按钮在这儿点不动 —— 去 WebUI 的审批页裁决。`, show_alert: true };
}

/**
 * 一次点击该回什么话。`show_alert` 只给「这次点击什么都没做」的那几种 —— 成功的那一次用轻提示，
 * 弹窗会让每一次正常裁决都多一步点击。
 *
 * 「已经处理过了」与「已过期（进程重启过）」是两句不同的话，对点的人是不同的信息：前者说明有人
 * （可能是他自己）已经做过决定，后者说明这条请求根本没人接手过。
 */
export function promptAckText(resolution: PromptResolution): { text: string; show_alert?: boolean } {
  switch (resolution.status) {
    case 'accepted': return { text: `已${resolution.label}` };
    case 'settled': return { text: '这条请求已经处理过了。', show_alert: true };
    case 'invalid': return { text: '这个选项不在这条请求上。', show_alert: true };
    case 'stale': return { text: '这条请求已经被处理或已过期，这次点击没有生效。', show_alert: true };
    case 'unknown': return { text: '这条请求已过期（进程重启过），需要重新发起。', show_alert: true };
    case 'forbidden': return { text: resolution.required === 'owner' ? '只有 owner 能裁决这条请求。' : '只有发起人或 owner 能裁决这条请求。', show_alert: true };
  }
}
