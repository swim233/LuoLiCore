import { ulid } from 'ulid';
import type { Role } from '@luoli/shared';
import type { LogSink } from '../log/sink.js';

/**
 * 一条阻塞式人机提示的通用原语（`docs/05 §6.1`）：**发一条带选项的消息、等人点、把结果回灌给
 * 正在等的调用方**。三个消费者共用它 —— inline keyboard 审批（已接）、`agent.askEscalateToUser`
 * 转人工、以及将来 ACP 的逐条 permission。所以 `kind` 与 `decidableBy` 从一开始就在签名里：
 * 事后再加这两个维度会改到所有调用点。
 *
 * 依赖方向是 `core → telegram` **不允许**，所以这里只定 `PromptChannel`，实现在
 * `packages/telegram/src/prompts.ts`，由 `main.ts` 注入（照 `TelegramToolBridge` 那个形状）。
 */

/** `callback_data` 的命名空间。`c:` 已被 `/cancel` 占用；这里是 ask。 */
export const PROMPT_CALLBACK_PREFIX = 'a:';
/**
 * Bot API 给 `callback_data` 的上界是 **64 字节**。`a:` + ULID(26) + `:` + 一位下标 = 30 字节，
 * 留着的余量足够，但**不许把任意长度的东西塞进去**（工具名、审批 id 之外的什么串）——
 * 超了 Telegram 直接 400，而那一刻按钮已经在屏幕上了。`tests/interaction.prompts.test.ts` 焊住它。
 */
export const PROMPT_CALLBACK_MAX_BYTES = 64;
/** 键盘挂在一条消息上，被 `segmentTelegramText` 切开就有一段没有按钮 —— 所以正文硬截断而不是分段。 */
export const PROMPT_TEXT_MAX = 700;
/**
 * `PendingPrompts` 自己那个 timer 比发起方的 TTL 长这么多。**TTL 的唯一所有者是发起方**
 * （审批是 `DatabaseApprovalBroker`：它已经有 timer + 落库 `expired` + SSE 广播），这里这一个
 * 只负责把点不动的按钮收掉。两边都写 expired 就有两份真相。
 */
export const PROMPT_TTL_GRACE_MS = 5_000;
/** 下标压在一位数以内，`callback_data` 的长度因此是常量。超出的选项会被砍掉并记一条 warn。 */
export const PROMPT_MAX_OPTIONS = 8;
/** 有界：无界 Map 记「最近裁决过什么」正是 `docs/reviews/27 · R-07` 那一类。 */
const RECENT_MAX = 256;

export interface PromptOption { id: string; label: string }

/** 谁在等这条提示。审批已接；另两档留着接线（`docs/00 §2.2`），语义未定之前不许有第二个实现。 */
export type PromptKind = 'approval' | 'acp_permission' | 'agent_ask';

export interface PromptRequest {
  kind: PromptKind;
  chatId: string;
  threadId: number | null;
  /** `owner` = 有效角色必须是 owner；`initiator` = 发起人自己或 owner。判据在 `resolve()`。 */
  decidableBy: 'owner' | 'initiator';
  initiatorUserId: string;
  text: string;
  options: readonly PromptOption[];
  ttlMs: number;
  abortSignal?: AbortSignal;
  /**
   * 把这一次点击落成事实；返回 false 表示「底下那条请求已经不属于点的人了」（被另一条通道裁决过、
   * 或已过期）。审批传 `DatabaseApprovalBroker.decide` —— 那句
   * `UPDATE … WHERE state='pending' AND expires_at>?` 是 WebUI 与 Telegram 之间**唯一**的原子
   * 抢夺点，而注册表这边的 `settled` 标志只挡得住本进程内对同一条消息的重复点。
   */
  claim?: (optionId: string, actor: string) => boolean;
}

export interface PromptOutcome {
  status: 'chosen' | 'expired' | 'cancelled';
  optionId?: string;
  /** `user:<tgId>`。落库时当 `decided_by`。 */
  actor?: string;
}

/** 投递层拿到的东西：它不需要懂 kind 之外的任何语义，token 已经算好了。 */
export interface PromptPost {
  kind: PromptKind;
  chatId: string;
  threadId: number | null;
  text: string;
  buttons: readonly { label: string; token: string }[];
}
export interface PromptTarget { chatId: string; messageId: number }

export interface PromptChannel {
  /**
   * 判据是「**bot 起来了**」而不是「有人正在看」—— 后者根本测不出来，而 owner 的手机推送不需要
   * 他此刻盯着屏幕。审批的可用性判据读的就是这个（`docs/05 §6`）。
   *
   * **给了 `chatId` 就还要答「那个会话里点得动吗」。** 有效角色是 `min(用户角色, 会话角色)`
   * （D9，`docs/05 §2.2` 那张表），所以 `decidableBy:'owner'` 在一个 `trusted` 群里**无人可满足**
   * —— 连 owner 本人在那儿也是 `trusted`。不答这一问的话可用性就比可裁决性宽：库里挂上 pending
   * 行、屏幕上贴出一排点不动的按钮，然后这一轮干等满 `ttlMs` —— 正是 `docs/22 · D-APPR-01`
   * 要消灭的形态，只是换了个来路。
   */
  available(chatId?: string): boolean;
  post(post: PromptPost): Promise<PromptTarget | null>;
  /**
   * 收尾一条提示。消息被删掉时的 400 由实现自己吞掉 —— 没有哪个等待者该因此受影响。
   *
   * **给了 `text` 就连正文一起换掉，而且是同一次 API 调用。** 只撤键盘的话那条消息会停在
   * 「N 秒内没人处理就会自动拒绝」上，而那句话此刻已经不成立 —— `docs/21 §12`「界面在说谎」
   * 专门清过这一类。分成「撤键盘 + 改正文」两次调用则要在 `perChatPerMinute` 那 20 个槽位里
   * 排两回队，而它们说的是同一件事。不知道结局是什么（启动时那趟扫描之外没有这种情形）才不传。
   */
  settle(target: PromptTarget, text?: string): Promise<void>;
}

export type PromptResolution =
  | { status: 'accepted'; kind: PromptKind; optionId: string; label: string }
  /** 本进程记得这条已经被点过了。与 `unknown` 是两句不同的话。 */
  | { status: 'settled' }
  /** `claim` 说底下那条请求已经不是 pending 了（另一条通道先到，或已过期）。 */
  | { status: 'stale' }
  /** 查不到 `promptId`：进程重启过，或早已被最近裁决表淘汰。**只有这一支该顺手把键盘撤掉** —— 没有等待者会替它撤。 */
  | { status: 'unknown' }
  /** 提示还挂着，但这个下标上没有选项。只有伪造的 `callback_data` 到得了这里，所以**一个字节都不许动**
   *  —— 当成 `unknown` 处理的话，一次伪造就能把一条活着的提示的键盘撕掉，那条审批的 Telegram 侧就哑了。 */
  | { status: 'invalid' }
  | { status: 'forbidden'; required: 'owner' | 'initiator' };

export interface PromptHandle {
  promptId: string;
  /** 永不 reject。发不出去时以 `cancelled` 收尾。 */
  outcome: Promise<PromptOutcome>;
  /** 投递结果。发起方要它去落 `approvals.tg_message_id`（启动时收拾残留键盘的待办队列）。 */
  posted: Promise<PromptTarget | null>;
  cancel(): void;
}

export function promptToken(promptId: string, index: number): string {
  return `${PROMPT_CALLBACK_PREFIX}${promptId}:${index}`;
}
/** `promptId` 里不会有 `:`（ULID），但按最后一个冒号切仍然更稳 —— 别让 token 格式变成暗契约。 */
export function parsePromptToken(data: string): { promptId: string; index: number } | null {
  if (!data.startsWith(PROMPT_CALLBACK_PREFIX)) return null;
  const rest = data.slice(PROMPT_CALLBACK_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0 || cut === rest.length - 1) return null;
  const index = Number(rest.slice(cut + 1));
  if (!Number.isInteger(index) || index < 0 || index >= PROMPT_MAX_OPTIONS) return null;
  return { promptId: rest.slice(0, cut), index };
}

interface Waiter {
  request: PromptRequest;
  options: readonly PromptOption[];
  finish(outcome: PromptOutcome, dismiss: boolean): void;
}

export class PendingPrompts {
  readonly #waiters = new Map<string, Waiter>();
  /** promptId → 上次选中的 label。只为了把「已经处理过了」与「已过期（进程重启过）」分开讲。 */
  readonly #recent = new Map<string, string>();
  /**
   * 已经收尾过的消息 → 那次收尾的形态与结果。两张表都有界 —— 无界地记「最近发生过什么」正是
   * `docs/reviews/27 · R-07`。`landed` **永不 reject**（失败折成 `false`）：调用方拿它当
   * 「这次收尾真落地了吗」的凭据，而一个会抛的凭据只会变成 unhandledRejection。
   */
  readonly #dismissed = new Map<string, { rewritten: boolean; landed: Promise<boolean> }>();

  constructor(private readonly channel: PromptChannel, private readonly log?: LogSink) {}

  available(chatId?: string): boolean { return this.channel.available(chatId); }

  ask(request: PromptRequest): PromptHandle {
    const promptId = ulid();
    const options = request.options.slice(0, PROMPT_MAX_OPTIONS);
    if (!options.length) throw new Error('prompt requires at least one option');
    if (options.length !== request.options.length) {
      this.log?.event({ level: 'warn', kind: 'prompt.options_capped', summary: `${request.kind} 的选项超过 ${PROMPT_MAX_OPTIONS} 个，已截断`, chatId: request.chatId, data: { kind: request.kind, given: request.options.length } });
    }
    let settled = false;
    let target: PromptTarget | null = null;
    // `finish` 收到的那个 dismiss 意图要留住：投递落地时它才拿得到 target，而 `dispose()` 明确
    // 要求**不撤**（那几次编辑会被紧随其后的 `bot.stop()` 掐断）。只看 `settled` 就把它撤了。
    let dismissWhenPosted = true;
    const { promise: outcome, resolve: settleOutcome } = Promise.withResolvers<PromptOutcome>();
    const { promise: posted, resolve: settlePosted } = Promise.withResolvers<PromptTarget | null>();
    const finish = (result: PromptOutcome, dismiss: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.abortSignal?.removeEventListener('abort', onAbort);
      this.#waiters.delete(promptId);
      dismissWhenPosted = dismiss;
      if (result.status === 'chosen' && result.optionId) this.#remember(promptId, options.find((option) => option.id === result.optionId)?.label ?? result.optionId);
      // 投递还没落地时 target 还是 null —— 下面 post 的 then 里会补这一次撤销。
      if (dismiss && target) this.#dismiss(target);
      settleOutcome(result);
    };
    const onAbort = (): void => finish({ status: 'cancelled' }, true);
    const timer = setTimeout(() => finish({ status: 'expired' }, true), request.ttlMs + PROMPT_TTL_GRACE_MS);
    timer.unref?.();
    if (request.abortSignal?.aborted) { settlePosted(null); finish({ status: 'cancelled' }, false); return { promptId, outcome, posted, cancel: () => undefined }; }
    const text = request.text.length > PROMPT_TEXT_MAX ? `${request.text.slice(0, PROMPT_TEXT_MAX - 1)}…` : request.text;
    const buttons = options.map((option, index) => ({ label: option.label, token: promptToken(promptId, index) }));
    // 上界断言排在注册等待者**之前**：抛在后面会留下一个没人收尾的等待者与一个活着的 timer。
    // token 是本文件算的，越界只会是本文件的 bug，而它的表现是「按钮已经在屏幕上了，点下去 400」。
    for (const button of buttons) if (Buffer.byteLength(button.token, 'utf8') > PROMPT_CALLBACK_MAX_BYTES) { clearTimeout(timer); throw new Error(`prompt callback token too long: ${button.token.length}`); }
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });
    this.#waiters.set(promptId, { request, options, finish });
    void Promise.resolve(this.channel.post({ kind: request.kind, chatId: request.chatId, threadId: request.threadId, text, buttons })).then((result) => {
      target = result;
      settlePosted(result);
      // 发出去之前就被裁决/取消掉了（WebUI 抢先、轮次 abort）：这条键盘一出生就该撤。
      if (result && settled && dismissWhenPosted) this.#dismiss(result);
    }).catch((error: unknown) => {
      settlePosted(null);
      this.log?.event({ level: 'warn', kind: 'prompt.post_failed', summary: `${request.kind} 提示发不出去`, chatId: request.chatId, data: { kind: request.kind, error: error instanceof Error ? error.message : String(error) } });
      // 发不出去就没有等待的意义了 —— 但**发起方的语义不由这里决定**：审批那边照旧等它自己的
      // TTL / WebUI 裁决，这里只是把这条 outcome 收尾，免得留一个永不 settle 的 Promise。
      finish({ status: 'cancelled' }, false);
    });
    return { promptId, outcome, posted, cancel: () => finish({ status: 'cancelled' }, true) };
  }

  /**
   * 一次点击。**同步返回**，好让调用方（`packages/telegram/src/bot.ts` 的 `a:` 分支）能先
   * `answerCallbackQuery` 再去 fire-and-forget 编辑键盘 —— 超约 15 秒不答，客户端上就是一个
   * 转不停的圈。撤键盘这一跳不在本函数里。
   *
   * 顺序是「本进程记得吗 → 会话对得上吗 → 角色够吗 → 底下那条请求还在吗」：角色不够时
   * **等待者一动不动**，而不是被一次越权点击消耗掉。
   *
   * **`actor.chatId` 必须等于提示所在的会话。** 按钮就在那条消息上，正常点击不可能来自别处；
   * 而 `role` 是**按 callback 所在的会话**算出来的有效角色 —— 不绑会话的话，一个人在自己是
   * owner 的群里对着另一个会话的 promptId 发一次 callback（非官方客户端能构造任意
   * `callback_data`）就能替那个会话裁决。ULID 猜不出来只是让它不实用，不是让它不成立。
   *
   * 注册表是**进程内**的（`docs/01 §3.1`）：将来真跑多实例时，落在没有这个等待者的实例上的
   * 点击会回 `unknown`。那是 fail-safe 的一侧（不会伪造出一次批准，库里那一行照旧等自己的 TTL），
   * 但话说错了 —— 要横向扩展得先把这条通道搬到库上或加一层路由。
   */
  resolve(token: string, actor: { userId: string; role: Role; chatId: string }): PromptResolution {
    const parsed = parsePromptToken(token);
    if (!parsed) return { status: 'unknown' };
    const waiter = this.#waiters.get(parsed.promptId);
    if (!waiter) return this.#recent.has(parsed.promptId) ? { status: 'settled' } : { status: 'unknown' };
    if (waiter.request.chatId !== actor.chatId) return { status: 'unknown' };
    const { request } = waiter;
    const allowed = request.decidableBy === 'owner'
      ? actor.role === 'owner'
      : actor.role === 'owner' || actor.userId === request.initiatorUserId;
    if (!allowed) return { status: 'forbidden', required: request.decidableBy };
    const option = waiter.options[parsed.index];
    if (!option) return { status: 'invalid' };
    const who = `user:${actor.userId}`;
    // **先记账再 claim。** `claim` 会同步走进发起方的收尾逻辑（审批那条路会顺手把这条提示的键盘
    // 撤掉），中途再回来读注册表就晚了 —— 「这条被点过」这件事没人记得的话，同一条消息第二次点
    // 回的是「已过期（进程重启过）」而不是「已经处理过了」。这次点击无论 claim 成不成都算消耗掉：
    // 是同一个人点同一条消息，重来一次的答案不会变。
    this.#waiters.delete(parsed.promptId);
    this.#remember(parsed.promptId, option.label);
    if (request.claim && !request.claim(option.id, who)) {
      // 库里那一行已经不是 pending 了：另一条通道先到，或已过期。
      waiter.finish({ status: 'cancelled' }, true);
      return { status: 'stale' };
    }
    waiter.finish({ status: 'chosen', optionId: option.id, actor: who }, true);
    this.log?.event({ level: 'info', kind: 'prompt.resolved', summary: `${request.kind} → ${option.id}`, chatId: request.chatId, userId: actor.userId, data: { kind: request.kind, optionId: option.id, decidableBy: request.decidableBy } });
    return { status: 'accepted', kind: request.kind, optionId: option.id, label: option.label };
  }

  /** 关停：清 timer、把等待者收尾。**不撤键盘** —— 那几次编辑会被紧随其后的 `bot.stop()` 掐断，
   *  而残留键盘由下一次启动那趟扫描负责（`docs/05 §6.1`），两条路里那一条才是可靠的。 */
  dispose(): void {
    for (const waiter of [...this.#waiters.values()]) waiter.finish({ status: 'cancelled' }, false);
    this.#waiters.clear();
  }

  /**
   * 收尾一条别人手上的提示（发起方的句柄、启动时那趟残留扫描）；失败一律吞掉（消息可能早被删了）。
   *
   * **返回「这次收尾真落地了吗」**，而不是 void：调用方那边常有一份「屏幕上还有按钮」的待办要销
   * （审批是 `approvals.tg_message_id`），而销待办的前提是那次编辑真的回来了。返回的 Promise
   * 永不 reject。
   */
  dismiss(target: PromptTarget, text?: string): Promise<boolean> { return this.#dismiss(target, text); }

  /**
   * 同一条键盘被要求收尾两次是**常态**而不是异常：发起方拿着自己的句柄收（审批的
   * `ApprovalReceipt.settle`，它知道结局是什么因而带得出正文），注册表这边收尾时也收（它只知道
   * 「不必再点了」）。第二次编辑在 Telegram 那边是一个 `message is not modified` 400，吞得掉但白占
   * 一格 `perChatPerMinute` 预算 —— 那个桶正是投递侧要抢的（`docs/28 · L-TG-01` 那一串）。
   *
   * 所以去重只挡**同档或降档**的第二次：撤过键盘之后又来了一份正文仍然要编辑。正常时序里带正文的
   * 那条先到（发起方的 `settle` 句柄与 `tg_message_id` 是同一个 `.then` 里置上的，而任何真实裁决都
   * 隔着一次网络往返），于是全程只有一次编辑；但那是时序而不是不变量 —— 收尾在句柄落地**之前**就
   * 到达时（轮次开轮即被 abort、TTL 压到毫秒），宁可多花一次 `perChatPerMinute` 预算补上那次编辑，
   * 也不能把「N 秒内没人处理就会自动拒绝」留在屏幕上（`docs/21 §12`）。
   */
  #dismiss(target: PromptTarget, text?: string): Promise<boolean> {
    const key = `${target.chatId}:${target.messageId}`;
    const known = this.#dismissed.get(key);
    // 去重命中时交回**那一次**的结果，而不是一个凭空的 false：调用方拿它去销待办，谎报失败会让
    // 一条已经收拾干净的消息永远留在待办队列里，每次启动都被重编辑一遍。
    if (known && (known.rewritten || text === undefined)) return known.landed;
    const landed = Promise.resolve(this.channel.settle(target, text)).then(() => true).catch((error: unknown) => {
      this.log?.event({ level: 'debug', kind: 'prompt.settle_failed', summary: 'prompt settle failed', chatId: target.chatId, data: { messageId: target.messageId, rewrote: text !== undefined, error: error instanceof Error ? error.message : String(error) } });
      return false;
    });
    this.#dismissed.set(key, { rewritten: text !== undefined, landed });
    while (this.#dismissed.size > RECENT_MAX) this.#dismissed.delete(this.#dismissed.keys().next().value!);
    return landed;
  }

  #remember(promptId: string, label: string): void {
    this.#recent.set(promptId, label);
    while (this.#recent.size > RECENT_MAX) this.#recent.delete(this.#recent.keys().next().value!);
  }
}
