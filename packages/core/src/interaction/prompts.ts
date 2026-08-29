import { ulid } from "ulid";
import type { Role } from "@luoli/shared";
import type { LogSink } from "../log/sink.js";

/**
 * 阻塞式人机提示的通用原语（`docs/05 §6.1`）：发送一条带选项的消息、等待用户点击、将结果回传给
 * 正在等待的调用方。三个使用方共用它 —— inline keyboard 审批（已接入）、`agent.askEscalateToUser`
 * 转人工，以及后续 ACP 的逐条 permission。因此 `kind` 与 `decidableBy` 自始即在签名中：
 * 事后补充这两个维度会改动全部调用点。
 *
 * 依赖方向 `core → telegram` 不被允许，因此此处只定义 `PromptChannel`，实现位于
 * `packages/telegram/src/prompts.ts`，由 `main.ts` 注入（形态同 `TelegramToolBridge`）。
 */

/** `callback_data` 的命名空间。`c:` 已被 `/cancel` 占用；此处用于 ask。 */
export const PROMPT_CALLBACK_PREFIX = "a:";
/**
 * Bot API 对 `callback_data` 的上界是 64 字节。`a:` + ULID(26) + `:` + 一位下标 = 30 字节，
 * 余量充足，但不得放入任意长度的内容（工具名，或审批 id 之外的其它字符串）——
 * 超出时 Telegram 直接返回 400，而此时按钮已显示在界面上。`tests/interaction.prompts.test.ts` 约束它。
 */
export const PROMPT_CALLBACK_MAX_BYTES = 64;
/** 键盘挂在单条消息上，被 `segmentTelegramText` 分段后会有一段没有按钮 —— 因此正文硬截断而非分段。 */
export const PROMPT_TEXT_MAX = 700;
/**
 * `PendingPrompts` 自身 timer 相对发起方 TTL 的额外时长。TTL 的唯一所有者是发起方
 * （审批为 `DatabaseApprovalBroker`：它已具备 timer、写库 `expired` 与 SSE 广播），此处的 timer
 * 只负责回收已失效的按钮。两侧都写入 expired 会产生两份真相来源。
 */
export const PROMPT_TTL_GRACE_MS = 5_000;
/** 下标限制在一位数以内，`callback_data` 的长度因此为常量。超出的选项会被裁剪并记录一条 warn。 */
export const PROMPT_MAX_OPTIONS = 8;
/** 容量有界：用无界 Map 记录最近的裁决结果正属 `docs/reviews/27 · R-07` 一类问题。 */
const RECENT_MAX = 256;

export interface PromptOption {
  id: string;
  label: string;
}

/** 该提示的等待方。审批已接入；另两档待接线（`docs/00 §2.2`），语义确定前不允许出现第二个实现。 */
export type PromptKind = "approval" | "acp_permission" | "agent_ask";

export interface PromptRequest {
  kind: PromptKind;
  chatId: string;
  threadId: number | null;
  /** `owner` 表示有效角色必须为 owner；`initiator` 表示发起人本人或 owner。判据见 `resolve()`。 */
  decidableBy: "owner" | "initiator";
  initiatorUserId: string;
  text: string;
  options: readonly PromptOption[];
  ttlMs: number;
  abortSignal?: AbortSignal;
  /**
   * 将本次点击落定为事实；返回 false 表示底层请求已不再属于点击者（已被另一条通道裁决，
   * 或已过期）。审批场景传入 `DatabaseApprovalBroker.decide` —— 其中的
   * `UPDATE … WHERE state='pending' AND expires_at>?` 是 WebUI 与 Telegram 之间唯一的原子
   * 竞争点，而注册表侧的 `settled` 标志只能阻止本进程内对同一条消息的重复点击。
   */
  claim?: (optionId: string, actor: string) => boolean;
}

export interface PromptOutcome {
  status: "chosen" | "expired" | "cancelled";
  optionId?: string;
  /** `user:<tgId>`。写库时作为 `decided_by`。 */
  actor?: string;
}

/** 传给投递层的数据：它无需理解 kind 之外的任何语义，token 已计算完成。 */
export interface PromptPost {
  kind: PromptKind;
  chatId: string;
  threadId: number | null;
  text: string;
  buttons: readonly { label: string; token: string }[];
}
export interface PromptTarget {
  chatId: string;
  messageId: number;
}

export interface PromptChannel {
  /**
   * 判据是 bot 已启动，而不是有人正在查看 —— 后者无法检测，且 owner 的手机推送不要求其此刻
   * 盯着屏幕。审批的可用性判据读取的正是该值（`docs/05 §6`）。
   *
   * 传入 `chatId` 时还需回答该会话中是否可裁决。群内的有效角色封顶 `trusted`，
   * `decidableBy:'owner'` 在任何群里都无人可满足，因此审批提示只投递到 owner 私聊 ——
   * 传入的必须是提示**实际落地**的那个会话。不做这一判定时可用性会宽于可裁决性：库中挂上
   * pending 行、界面上显示一排无法点击的按钮，随后本轮空等满 `ttlMs` —— 正是
   * `docs/22 · D-APPR-01` 要消除的形态，只是来源不同。
   */
  available(chatId?: string): boolean;
  post(post: PromptPost): Promise<PromptTarget | null>;
  /**
   * 收尾一条提示。消息被删除时的 400 由实现自身吞掉 —— 不应有任何等待者因此受影响。
   *
   * 传入 `text` 时连同正文一并替换，且在同一次 API 调用中完成。仅撤除键盘的话该消息会停留在
   * 超时将自动拒绝的表述上，而该表述此刻已不成立 —— `docs/21 §12` 的界面失真专项清理过这一类。
   * 拆成撤键盘与改正文两次调用则需在 `perChatPerMinute` 的 20 个槽位中排队两次，
   * 而两者表达的是同一件事。只有在无法确定结局时（除启动扫描外不存在该情形）才不传。
   */
  settle(target: PromptTarget, text?: string): Promise<void>;
}

export type PromptResolution =
  | { status: "accepted"; kind: PromptKind; optionId: string; label: string }
  /** 本进程已记录该条被点击过。与 `unknown` 表达的是不同的含义。 */
  | { status: "settled" }
  /** `claim` 表明底层请求已不再是 pending（另一条通道先到达，或已过期）。 */
  | { status: "stale" }
  /** 查不到 `promptId`：进程曾重启，或已被最近裁决表淘汰。只有该分支应顺带撤除键盘 —— 没有等待者会代为撤除。 */
  | { status: "unknown" }
  /** 提示仍存在，但该下标上没有选项。只有伪造的 `callback_data` 能到达此处，因此不做任何修改
   *  —— 若按 `unknown` 处理，一次伪造即可撤除一条有效提示的键盘，该审批的 Telegram 侧随即失效。 */
  | { status: "invalid" }
  | { status: "forbidden"; required: "owner" | "initiator" };

export interface PromptHandle {
  promptId: string;
  /** 永不 reject。无法发送时以 `cancelled` 收尾。 */
  outcome: Promise<PromptOutcome>;
  /** 投递结果。发起方据此写入 `approvals.tg_message_id`（启动时处理残留键盘的待办队列）。 */
  posted: Promise<PromptTarget | null>;
  cancel(): void;
}

export function promptToken(promptId: string, index: number): string {
  return `${PROMPT_CALLBACK_PREFIX}${promptId}:${index}`;
}
/** `promptId` 中不含 `:`（ULID），但按最后一个冒号切分更稳妥 —— 避免 token 格式成为隐式契约。 */
export function parsePromptToken(
  data: string,
): { promptId: string; index: number } | null {
  if (!data.startsWith(PROMPT_CALLBACK_PREFIX)) return null;
  const rest = data.slice(PROMPT_CALLBACK_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  const index = Number(rest.slice(cut + 1));
  if (!Number.isInteger(index) || index < 0 || index >= PROMPT_MAX_OPTIONS)
    return null;
  return { promptId: rest.slice(0, cut), index };
}

interface Waiter {
  request: PromptRequest;
  options: readonly PromptOption[];
  finish(outcome: PromptOutcome, dismiss: boolean): void;
}

export class PendingPrompts {
  readonly #waiters = new Map<string, Waiter>();
  /** promptId → 上次选中的 label。仅用于区分已处理与已过期（进程曾重启）两种情形。 */
  readonly #recent = new Map<string, string>();
  /**
   * 已收尾的消息 → 该次收尾的形态与结果。两张表容量均有界 —— 无界地记录近期事件正属
   * `docs/reviews/27 · R-07`。`landed` 永不 reject（失败折算为 `false`）：调用方将其作为
   * 收尾是否真正生效的凭据，而会抛出的凭据只会变成 unhandledRejection。
   */
  readonly #dismissed = new Map<
    string,
    { rewritten: boolean; landed: Promise<boolean> }
  >();

  constructor(
    private readonly channel: PromptChannel,
    private readonly log?: LogSink,
  ) {}

  available(chatId?: string): boolean {
    return this.channel.available(chatId);
  }

  ask(request: PromptRequest): PromptHandle {
    const promptId = ulid();
    const options = request.options.slice(0, PROMPT_MAX_OPTIONS);
    if (!options.length) throw new Error("prompt requires at least one option");
    if (options.length !== request.options.length) {
      this.log?.event({
        level: "warn",
        kind: "prompt.options_capped",
        summary: `${request.kind} 的选项超过 ${PROMPT_MAX_OPTIONS} 个，已截断`,
        chatId: request.chatId,
        data: { kind: request.kind, given: request.options.length },
      });
    }
    let settled = false;
    let target: PromptTarget | null = null;
    // `finish` 收到的 dismiss 意图需保留：只有投递落地时才能获得 target，而 `dispose()` 明确
    // 要求不撤除（那几次编辑会被随后的 `bot.stop()` 中断）。仅依据 `settled` 判定会误撤。
    let dismissWhenPosted = true;
    const { promise: outcome, resolve: settleOutcome } =
      Promise.withResolvers<PromptOutcome>();
    const { promise: posted, resolve: settlePosted } =
      Promise.withResolvers<PromptTarget | null>();
    const finish = (result: PromptOutcome, dismiss: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.abortSignal?.removeEventListener("abort", onAbort);
      this.#waiters.delete(promptId);
      dismissWhenPosted = dismiss;
      if (result.status === "chosen" && result.optionId)
        this.#remember(
          promptId,
          options.find((option) => option.id === result.optionId)?.label ??
            result.optionId,
        );
      // 投递尚未落地时 target 仍为 null —— 下方 post 的 then 中会补上这次撤除。
      if (dismiss && target) this.#dismiss(target);
      settleOutcome(result);
    };
    const onAbort = (): void => finish({ status: "cancelled" }, true);
    const timer = setTimeout(
      () => finish({ status: "expired" }, true),
      request.ttlMs + PROMPT_TTL_GRACE_MS,
    );
    timer.unref?.();
    if (request.abortSignal?.aborted) {
      settlePosted(null);
      finish({ status: "cancelled" }, false);
      return { promptId, outcome, posted, cancel: () => undefined };
    }
    const text =
      request.text.length > PROMPT_TEXT_MAX
        ? `${request.text.slice(0, PROMPT_TEXT_MAX - 1)}…`
        : request.text;
    const buttons = options.map((option, index) => ({
      label: option.label,
      token: promptToken(promptId, index),
    }));
    // 上界断言排在注册等待者之前：置于其后抛出会遗留一个无人收尾的等待者与一个仍在运行的 timer。
    // token 由本文件计算，越界只可能是本文件的缺陷，其表现是按钮已显示而点击后返回 400。
    for (const button of buttons)
      if (Buffer.byteLength(button.token, "utf8") > PROMPT_CALLBACK_MAX_BYTES) {
        clearTimeout(timer);
        throw new Error(
          `prompt callback token too long: ${button.token.length}`,
        );
      }
    request.abortSignal?.addEventListener("abort", onAbort, { once: true });
    this.#waiters.set(promptId, { request, options, finish });
    void Promise.resolve(
      this.channel.post({
        kind: request.kind,
        chatId: request.chatId,
        threadId: request.threadId,
        text,
        buttons,
      }),
    )
      .then((result) => {
        target = result;
        settlePosted(result);
        // 发送前即已被裁决或取消（WebUI 抢先、轮次 abort）：该键盘创建后即应撤除。
        if (result && settled && dismissWhenPosted) this.#dismiss(result);
      })
      .catch((error: unknown) => {
        settlePosted(null);
        this.log?.event({
          level: "warn",
          kind: "prompt.post_failed",
          summary: `${request.kind} 提示投递失败`,
          chatId: request.chatId,
          data: {
            kind: request.kind,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        // 无法发送即无等待意义 —— 但发起方的语义不由此处决定：审批侧仍等待其自身的
        // TTL 或 WebUI 裁决，此处只是收尾该 outcome，避免留下一个永不 settle 的 Promise。
        finish({ status: "cancelled" }, false);
      });
    return {
      promptId,
      outcome,
      posted,
      cancel: () => finish({ status: "cancelled" }, true),
    };
  }

  /**
   * 处理一次点击。同步返回，以便调用方（`packages/telegram/src/bot.ts` 的 `a:` 分支）先执行
   * `answerCallbackQuery` 再以 fire-and-forget 方式编辑键盘 —— 超过约 15 秒未响应，客户端上会
   * 持续显示加载状态。撤除键盘不在本函数内完成。
   *
   * 判定顺序为：本进程是否已记录 → 会话是否匹配 → 角色是否满足 → 底层请求是否仍存在。
   * 角色不满足时等待者保持不变，而不是被一次越权点击消耗掉。
   *
   * `actor.chatId` 必须等于提示所在的会话。按钮位于该条消息上，正常点击不可能来自别处；
   * 而 `role` 是按 callback 所在会话计算出的有效角色 —— 不绑定会话的话，用户针对另一会话的
   * promptId 发送一次 callback（非官方客户端可构造任意 `callback_data`）即可代该会话裁决。
   * ULID 难以猜测只是降低可行性，并不消除该问题。
   *
   * 这条绑定同时把 `decidableBy:'owner'` 落到了实处：审批提示只投递到 owner 私聊，而私聊的
   * 有效角色就是用户自身的角色（群内封顶 `trusted`），因此能通过会话绑定的点击必然来自 owner
   * 本人的私聊。投递目标即裁决绑定，两者是同一个 `request.chatId`。
   *
   * 注册表是进程内的（`docs/01 §3.1`）：将来实际运行多实例时，落到没有该等待者的实例上的
   * 点击会返回 `unknown`。那是 fail-safe 的一侧（不会伪造出一次批准，库中该行仍等待自身 TTL），
   * 但结论表述不准确 —— 横向扩展前需先将该通道迁移到数据库或增加一层路由。
   */
  resolve(
    token: string,
    actor: { userId: string; role: Role; chatId: string },
  ): PromptResolution {
    const parsed = parsePromptToken(token);
    if (!parsed) return { status: "unknown" };
    const waiter = this.#waiters.get(parsed.promptId);
    if (!waiter)
      return this.#recent.has(parsed.promptId)
        ? { status: "settled" }
        : { status: "unknown" };
    if (waiter.request.chatId !== actor.chatId) return { status: "unknown" };
    const { request } = waiter;
    const allowed =
      request.decidableBy === "owner"
        ? actor.role === "owner"
        : actor.role === "owner" || actor.userId === request.initiatorUserId;
    if (!allowed) return { status: "forbidden", required: request.decidableBy };
    const option = waiter.options[parsed.index];
    if (!option) return { status: "invalid" };
    const who = `user:${actor.userId}`;
    // 先记录再 claim。`claim` 会同步进入发起方的收尾逻辑（审批路径会顺带撤除该提示的键盘），
    // 之后再回来读取注册表已经过晚 —— 若无人记录该条已被点击，同一条消息第二次点击返回的会是
    // 已过期（进程曾重启）而非已处理。本次点击无论 claim 是否成功都计为已消耗：
    // 同一用户点击同一条消息，重复一次的结果不会改变。
    this.#waiters.delete(parsed.promptId);
    this.#remember(parsed.promptId, option.label);
    if (request.claim && !request.claim(option.id, who)) {
      // 库中该行已不是 pending：另一条通道先到达，或已过期。
      waiter.finish({ status: "cancelled" }, true);
      return { status: "stale" };
    }
    waiter.finish({ status: "chosen", optionId: option.id, actor: who }, true);
    this.log?.event({
      level: "info",
      kind: "prompt.resolved",
      summary: `${request.kind} → ${option.id}`,
      chatId: request.chatId,
      userId: actor.userId,
      data: {
        kind: request.kind,
        optionId: option.id,
        decidableBy: request.decidableBy,
      },
    });
    return {
      status: "accepted",
      kind: request.kind,
      optionId: option.id,
      label: option.label,
    };
  }

  /** 关停：清除 timer、收尾等待者。不撤除键盘 —— 那几次编辑会被随后的 `bot.stop()` 中断，
   *  而残留键盘由下一次启动时的扫描处理（`docs/05 §6.1`），两条路径中后者才可靠。 */
  dispose(): void {
    for (const waiter of [...this.#waiters.values()])
      waiter.finish({ status: "cancelled" }, false);
    this.#waiters.clear();
  }

  /**
   * 收尾由其它持有方管理的提示（发起方的句柄、启动时的残留扫描）；失败一律吞掉（消息可能已被删除）。
   *
   * 返回该次收尾是否真正生效，而非 void：调用方通常有一份界面上仍有按钮的待办需要销除
   * （审批为 `approvals.tg_message_id`），而销除待办的前提是该次编辑确实成功返回。返回的 Promise
   * 永不 reject。
   */
  dismiss(target: PromptTarget, text?: string): Promise<boolean> {
    return this.#dismiss(target, text);
  }

  /**
   * 同一条键盘被要求收尾两次是常态而非异常：发起方持自身句柄收尾（审批的
   * `ApprovalReceipt.settle`，它知晓结局因而能给出正文），注册表侧收尾时也会执行一次（它只知道
   * 无需再点击）。第二次编辑在 Telegram 侧返回 `message is not modified` 400，可以吞掉但会占用
   * 一格 `perChatPerMinute` 预算 —— 该配额正是投递侧需要争取的（`docs/28 · L-TG-01` 一系列）。
   *
   * 因此去重只拦截同档或降档的第二次：撤除键盘之后再收到带正文的收尾仍需执行编辑。正常时序下带
   * 正文的那条先到达（发起方的 `settle` 句柄与 `tg_message_id` 在同一个 `.then` 中设置，而任何真实
   * 裁决都需经过一次网络往返），因此全程只有一次编辑；但那是时序而非不变量 —— 收尾在句柄落地之前
   * 到达时（轮次开启即被 abort、TTL 压缩至毫秒级），宁可多消耗一次 `perChatPerMinute` 预算补上该次
   * 编辑，也不能把超时将自动拒绝的表述留在界面上（`docs/21 §12`）。
   */
  #dismiss(target: PromptTarget, text?: string): Promise<boolean> {
    const key = `${target.chatId}:${target.messageId}`;
    const known = this.#dismissed.get(key);
    // 去重命中时返回该次的实际结果，而不是构造一个 false：调用方据此销除待办，错误上报失败会使
    // 一条已处理完毕的消息永久留在待办队列中，每次启动都被重新编辑一遍。
    if (known && (known.rewritten || text === undefined)) return known.landed;
    const landed = Promise.resolve(this.channel.settle(target, text))
      .then(() => true)
      .catch((error: unknown) => {
        this.log?.event({
          level: "debug",
          kind: "prompt.settle_failed",
          summary: "prompt settle failed",
          chatId: target.chatId,
          data: {
            messageId: target.messageId,
            rewrote: text !== undefined,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      });
    this.#dismissed.set(key, { rewritten: text !== undefined, landed });
    while (this.#dismissed.size > RECENT_MAX)
      this.#dismissed.delete(this.#dismissed.keys().next().value!);
    return landed;
  }

  #remember(promptId: string, label: string): void {
    this.#recent.set(promptId, label);
    while (this.#recent.size > RECENT_MAX)
      this.#recent.delete(this.#recent.keys().next().value!);
  }
}
