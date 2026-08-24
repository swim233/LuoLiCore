import { ulid } from "ulid";
import type {
  ApprovalVerdict,
  ApprovalRisk,
  ApprovalBroker,
  RegisteredTool,
  ToolExecutionContext,
} from "./tools/registry.js";
import type { Config } from "./config/schema.js";
import type { EventBus } from "./events.js";
import type { PendingPrompts } from "./interaction/prompts.js";
import type { LogSink } from "./log/sink.js";
import type { Sqlite } from "@luoli/db";

const DENIED_HINT =
  "该操作需要人工批准，但管理员已拒绝，因此没有执行。请说明操作未获批准，并给出不需要该操作的替代做法。";
const EXPIRED_HINT =
  "该操作需要人工批准，但审批窗口已过期，因此没有执行。请说明审批已超时，并让用户在仍需执行时重新发起。";
const CANCELLED_HINT = "该操作等待审批时所属轮次已取消，因此没有执行。";
const UNAVAILABLE_HINT =
  "该操作需要 owner 批准，但当前没有可用的审批通道，因此没有执行。请说明审批通道不可用，并给出不需要该操作的替代做法。";

interface PendingApproval {
  finish(
    approved: boolean,
    hint: string | undefined,
    outcome: ApprovalOutcome,
  ): void;
}

/**
 * 一条审批是怎么收场的。`channel` 只在有人真的裁决过时才有 —— 过期与轮次取消都是系统写的
 * （`decided_by='system'`），没有通道可言。
 *
 * **回执正文说的是 `channel`，不是 `decided_by`。** 后者有三种格式：Telegram 那条写 `user:<tgId>`、
 * WebUI 写字面量 `owner`、系统写 `system`（`docs/03` 的 `approvals` 段）。把第一种贴进一条群消息
 * 既讲不清（一串数字对群里其他人什么都不是），又顺手把 owner 的 Telegram id 抖了出去。裁决权本来
 * 就只给 owner（`allowInitiator` 已永久摘除），所以「谁」是常量，值得说的只有「在哪儿裁的」。
 */
export interface ApprovalOutcome {
  /** `stale` = 进程重启后启动扫描收拾的那一批：没人裁决过，这条请求随进程一起作废了。 */
  kind: "approved" | "denied" | "expired" | "cancelled" | "stale";
  channel?: "telegram" | "webui";
}

/** 启动时要收拾的一条残留回执。带 `state` / `tool` 是为了把正文换成**当时真正的结局**。 */
export interface StaleReceipt {
  chatId: string;
  messageId: number;
  state: string;
  tool: string;
}

/**
 * 一条**不是工具调用**、但要走同一条审批链的请求（`requestExternal` / `recordDecided`）。
 *
 * @property toolName 落进 `approvals.tool_name`，也是 `approval.rules` 匹配用的那个名字。
 * @property exemptOwnerSkip **反过来豁免 `approval.skipForOwner`。**
 *   那个开关的前提是「owner 自己让 bot 做的事不必再问 owner 一次」—— 发起人与裁决人是同一个人。
 *   ACP 的 `session/request_permission` 不是这个形状：动作的发起人是一台**外部 agent**，owner 只是
 *   那个把它放进来的人，两者不是同一个主体。而 `skipForOwner` 默认为真、ACP 又是 owner-only，
 *   所以不在这里反过来的话，整条逐条审批**一行都不会生效**（每一次都直接 `approved: true`）。
 *   ⚠️ 看着像 bug，不是 —— 改回去等于把逐条审批静默摘掉，而屏幕上、文档里都还写着它在。
 */
export interface ExternalApprovalRequest {
  toolName: string;
  input: unknown;
  context: ToolExecutionContext;
  risk: ApprovalRisk;
  exemptOwnerSkip?: boolean;
}

/**
 * 回执回调的返回值。两样东西都是可选的 —— 没有 Telegram 入口（或回执只是一条纯文本）时全空。
 *
 * @property tgMessageId 落进 `approvals.tg_message_id`。那一列是**启动时收拾残留回执**的待办
 *   队列（`docs/05 §6.1`）：不写的话重启后屏幕上留着一排点不动的按钮。
 * @property settle 裁决落定（Telegram 点的、WebUI 抢先、TTL、轮次取消）时收尾那条回执：撤键盘
 *   **并把正文换成结局**。不撤的话另一条通道上那两个按钮还在，而它们此刻已经点不动了；不改正文
 *   的话那条消息停在「N 秒内没人处理就会自动拒绝」上，而那句话已经不成立（`docs/21 §12`）。
 *   **返回「那次编辑真落地了吗」** —— `tg_message_id` 只在为真时才清（见 `staleKeyboards`）。
 * @property delivered 显式的 `false` = 这条回执**发不出去**（Telegram 拒收）。屏幕上一个字都没有，
 *   所以它不是「回执失败但审批照旧」那一档 —— 当 WebUI 也没有裁决通道时，这一刻语义上就是
 *   「没有可用的审批通道」，见 `request()` 里那段。缺省（`undefined`）表示「没试过投递」，
 *   例如没有 Telegram 入口、或回执只是一条不带按钮的纯文本。
 */
export interface ApprovalReceipt {
  tgMessageId?: number;
  settle?: (outcome: ApprovalOutcome) => Promise<boolean> | boolean;
  delivered?: boolean;
}

export class DatabaseApprovalBroker implements ApprovalBroker {
  readonly #config: () => Readonly<Config>;
  /** 连 hint 一起记：只记布尔的话，同轮重试一次过期/取消的调用会拿到「管理员已拒绝」，
   *  模型据此告诉用户「被拒了」，而真相是没人来得及看。 */
  readonly #remembered = new Map<
    string,
    { approved: boolean; hint?: string }
  >();
  readonly #pending = new Map<string, PendingApproval>();

  /**
   * 传 getter时每次读都取最新值：approval.enabled / ttlMs 热更新后下一次请求立即生效。
   *
   * @param notifyInitiator 给**发起人**的回执（`docs/22 · D-APPR-01`）。有裁决通道时这一轮会
   *   静静挂满 `ttlMs`（默认 180 秒），而 Telegram 那边一个字都没有 —— 用户看到的就是 bot 收了
   *   消息然后沉默三分钟。回执发不出去不影响审批本身，所以这里吞掉它的异常。**入参带 `id`**：
   *   回执上要挂 inline keyboard，而按钮的 `callback_data` 得能指回这一行。
   * @param prompts Telegram 侧的阻塞式人机通道（`docs/05 §6.1`）。这里**只用来判可用性**，而且是
   *   **按会话**问的：`decidableBy:'owner'` 在一个 `trusted` 群里无人可满足（D9 把 owner 也压成
   *   `trusted`），只判「bot 起没起」就会挂上一条谁都点不动的 pending 行。提示的正文与选项由装配方
   *   （`main.ts`）经 `notifyInitiator` 给出，裁决照旧回到 `decide()`。
   */
  constructor(
    private readonly db: Sqlite,
    config: Readonly<Config> | (() => Readonly<Config>),
    private readonly events: EventBus,
    private readonly log: LogSink,
    private readonly notifyInitiator?: (input: {
      id: string;
      chatId: string;
      threadId: number | null;
      requesterUserId: string;
      tool: string;
      risk: ApprovalRisk;
      ttlMs: number;
    }) => Promise<ApprovalReceipt | void> | ApprovalReceipt | void,
    private readonly prompts?: Pick<PendingPrompts, "available">,
  ) {
    this.#config = typeof config === "function" ? config : () => config;
    this.db
      .prepare(
        "UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE state='pending' AND expires_at<=?",
      )
      .run(Date.now(), Date.now());
  }

  releaseTurn(turnId: string): void {
    for (const key of this.#remembered.keys())
      if (key.startsWith(`${turnId}:`)) this.#remembered.delete(key);
  }

  /**
   * 启动时要收拾的残留回执（`docs/05 §6.1`）：读出来一次，顺手把这一列清空 —— 它是「屏幕上还有
   * 一排点不动的按钮」的待办队列，不是历史记录，不清就每次重启都去编辑同一批历史消息。
   *
   * 判据比 `state<>'pending'` 宽一档是故意的：新进程里**任何** pending 行都不可能还有等待者
   * （Promise 跨不了进程），而上面那句只把 `expires_at` 已过的标成 `expired` —— 重启够快时
   * 一条 TTL 未到的 pending 行会带着一个永远唤不醒任何人的键盘留在屏幕上。
   *
   * **清列的前提是收尾已落地。** 这一列是待办队列不是历史记录，所以「那次 `editMessageText` 没
   * 回来」就等于「这条还没办完」—— 裁决落定那条路（`finish`）因此只在收尾真发出去之后才清它。
   * 反过来清的表现是：消息被删 / 网络抖 / 429 各来一次，那排按钮就永久没人收（关停竞态只是其中
   * 一条来路，不是唯一那条）。本函数自己是**读完即清**的：这一趟本来就要把整列重排一遍待办，
   * 收尾失败的那些下次启动照旧扫不到 —— 但它们的等待者早就没了，最坏是屏幕上留一排点了会
   * 如实回「已过期（进程重启过）」的按钮，而不是一条会误导人的活按钮。
   *
   * 连 `state` / `tool_name` 一起读出来：正文要换成**当时真正的结局**（构造函数刚扫成 `expired`
   * 的那些说「窗口到点了」，TTL 未到的那些说「随进程作废」），而不是一律换成同一句。分档的判据在
   * `staleApprovalOutcome()`（`packages/telegram/src/prompts.ts`，文案与它同处一地）。
   */
  staleKeyboards(): StaleReceipt[] {
    const rows = this.db
      .prepare(
        "SELECT chat_id AS chatId,tg_message_id AS messageId,state,tool_name AS tool FROM approvals WHERE tg_message_id IS NOT NULL",
      )
      .all() as StaleReceipt[];
    if (rows.length)
      this.db
        .prepare(
          "UPDATE approvals SET tg_message_id=NULL WHERE tg_message_id IS NOT NULL",
        )
        .run();
    return rows;
  }

  /**
   * 回执**发不出去**（Telegram 拒收），而 Telegram 是这次审批唯一的裁决通道。
   *
   * 这一刻语义上与 `request()` 开头那道「两条通道都没有」的闸完全相同，所以走同一条口径：当场落定
   * 并交回 `UNAVAILABLE_HINT`，而不是让这一轮白占 `concurrency` 槽、配额预留与 `turnTimeoutMs`
   * 预算干等满 `ttlMs`（默认 180 秒）—— 那正是 [reviews/20 §0.0] 裁决要消灭的形态，只是换了个来路：
   * 闸放行的那一刻通道还在，是投递那一下才死的。
   *
   * **两边都要看**（与 `request()` 那处判据同一形状）：WebUI 还挂着 SSE 时投递失败只是锦上添花那
   * 一半没了，审批照旧等它的裁决 —— 那才是「回执失败不影响审批本身」。
   *
   * 落 `expired` 而不是 `denied`：`denied + decided_by='system'` 在这张表里已经是「轮次被取消」的
   * 意思，而这一条压根没送到人眼前。`state` 受 CHECK 约束（`pending|approved|denied|expired`），
   * 说得清「窗口结束、没人裁决」的只有 `expired`；真正说清缘由的是那条 `approval.unavailable`
   * warn —— 它本来就是「没有裁决通道」这件事的日志 kind，`data.reason` 分开两种来路。
   */
  #receiptUndeliverable(
    id: string,
    tool: string,
    risk: ApprovalRisk,
    chatId: string,
    turnId: string,
  ): void {
    if (this.events.channelCount !== 0) return;
    const changed = this.db
      .prepare(
        "UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'",
      )
      .run(Date.now(), id).changes;
    if (!changed) return;
    this.events.emit("approval.decided", {
      id,
      tool,
      risk,
      chatId,
      approved: false,
      actor: "system",
      channel: "system",
      state: "expired",
    });
    this.log.event({
      level: "warn",
      kind: "approval.unavailable",
      summary: `${tool} approval receipt undeliverable`,
      traceId: turnId,
      data: { id, risk, reason: "receipt_undeliverable" },
    });
    // 屏幕上一个字都没有（那正是走到这里的原因），所以这一档只与落库的 `state` 对齐，
    // 不会有任何正文被它改写。
    this.#pending.get(id)?.finish(false, UNAVAILABLE_HINT, { kind: "expired" });
  }

  async request(
    tool: RegisteredTool,
    input: unknown,
    context: ToolExecutionContext,
    risk: ApprovalRisk,
  ): Promise<ApprovalVerdict> {
    return this.#request({ toolName: tool.name, input, context, risk });
  }

  /**
   * 不是工具调用、但需要走同一条审批链的那些（`docs/05 §3.5.3`）。第一个消费者是 ACP 的
   * `session/request_permission`：动作发起人是一台外部 agent，而它问过来的每一步都要落进
   * `approvals` 表、走同一套 `approval.rules` / TTL / 双通道裁决 —— 那张表与那套规则**只有一份**，
   * 让 ACP 自己再建一套等于让「审批」这个词在这个项目里有两种意思。
   *
   * `tool_name` 由调用方给（ACP 恒为 `acp_permission`）。它不必是一个注册过的工具 ——
   * `ApprovalRules.evaluate` 只吃名字与 `JSON.stringify(input)`，而这条路的 input 里已经有
   * `"kind":"execute"` 这类足够精准的判据；为每种 kind 编一个假工具名只会污染工具页与
   * `tools.overrides` 的键空间（那张表只认注册过的工具，多出来的键运维改了也没用）。
   */
  async requestExternal(
    request: ExternalApprovalRequest,
  ): Promise<ApprovalVerdict> {
    return this.#request(request);
  }

  /**
   * 一条**已经有结论**的审批：不问人，只留凭据。
   *
   * ACP 的 `allow_always` / `reject_always` 命中会话内那份记忆时走它 —— 不落这一行的话，
   * 「批了一次之后它接着改了 40 个文件」在审计里只剩最初那一条，而那正是 always 这一档最需要
   * 被数出来的地方。`decided_by` 由调用方给（`acp:always`），好让它与真人裁决（`user:<tgId>` /
   * `owner`）和系统裁决（`system`）在同一列里分得开（`docs/03` 的 `approvals` 段）。
   *
   * **`decision_channel` 不是 `decided_by` 的副本**：前者的取值域是通道（`telegram` / `webui` /
   * `system` / `acp`），后者是主体。把裁决者原样写进通道列，审批卡上那一格就是同一个字符串印两遍
   * （它渲染的正是 `decided_by · decision_channel`，`docs/21 §18`），而按通道分桶的查询会多出一个
   * 取值域外的桶。
   */
  recordDecided(
    request: ExternalApprovalRequest & {
      approved: boolean;
      decidedBy: string;
      channel: string;
    },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO approvals(id,turn_id,agent_run_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at,decided_by,decided_at,decision_channel)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ulid(),
        request.context.turn.turnId,
        request.context.agentRunId ?? null,
        request.context.turn.chatId,
        request.context.turn.initiatorUserId,
        request.toolName,
        JSON.stringify(request.input),
        request.risk,
        request.approved ? "approved" : "denied",
        now,
        now,
        request.decidedBy,
        now,
        request.channel,
      );
  }

  async #request(request: ExternalApprovalRequest): Promise<ApprovalVerdict> {
    const { toolName, input, context, risk } = request;
    const config = this.#config();
    if (!config.approval.enabled) return { approved: true };
    if (context.turn.abortSignal.aborted)
      return { approved: false, hint: CANCELLED_HINT };
    const rememberedKey = `${context.turn.turnId}:${toolName}:${JSON.stringify(input)}`;
    if (
      config.approval.rememberWithinTurn &&
      this.#remembered.has(rememberedKey)
    ) {
      const previous = this.#remembered.get(rememberedKey)!;
      return previous.approved
        ? { approved: true }
        : { approved: false, hint: previous.hint ?? DENIED_HINT };
    }
    if (
      context.turn.effectiveRole === "owner" &&
      config.approval.skipForOwner &&
      !request.exemptOwnerSkip
    ) {
      this.log.event({
        level: "info",
        kind: "approval.decided",
        summary: `${toolName} auto-approved`,
        traceId: context.turn.turnId,
        data: { channel: "auto", role: "owner", risk },
      });
      if (config.approval.rememberWithinTurn)
        this.#remembered.set(rememberedKey, { approved: true });
      return { approved: true };
    }
    // 数的是裁决通道，不是订阅者：main.ts 的 config.changed 订阅者常驻，用 subscriberCount
    // 判断等于这段永远走不到，非 owner 照旧静默干等满 ttlMs（docs/24 · R-APPR-01）。
    //
    // **两条通道都没有才当场拒**（docs/05 §6）：WebUI 的 SSE 之外还有 Telegram 回执上的 inline
    // keyboard。少判后一条的话，新通道在「没人开浏览器」的部署里永远走不到 —— 而那恰好是它唯一
    // 有用的场景。Telegram 那一半问的**不是**「有人正在看」（测不出来，owner 的手机推送也不需要
    // 他盯着屏幕），而是「bot 起来了**且这个会话里点得动**」：`decidableBy:'owner'` 在一个
    // `trusted` 群里无人可满足（D9 把 owner 也压成 `trusted`），把它算成有通道就等于挂一条谁都
    // 点不动的 pending 行再干等满 ttlMs。
    //
    // 这道闸判的是**放行那一刻**通道在不在。投递那一下才死掉的那种由 `#receiptUndeliverable`
    // 接住，口径与这里完全相同 —— 两处必须一起看：只挡这一处的话，`post` 被 Telegram 拒收
    // 就又回到「干等满 ttlMs 而屏幕上一个字都没有」（reviews/20 §0.0 换了个来路）。
    if (
      this.events.channelCount === 0 &&
      this.prompts?.available(context.turn.chatId) !== true
    ) {
      this.log.event({
        level: "warn",
        kind: "approval.unavailable",
        summary: `${toolName} approval channel unavailable`,
        traceId: context.turn.turnId,
        data: { risk },
      });
      if (config.approval.rememberWithinTurn)
        this.#remembered.set(rememberedKey, {
          approved: false,
          hint: UNAVAILABLE_HINT,
        });
      return { approved: false, hint: UNAVAILABLE_HINT };
    }

    const id = ulid();
    const now = Date.now();
    const expiresAt = now + config.approval.ttlMs;
    this.db
      .prepare(
        `INSERT INTO approvals(id,turn_id,agent_run_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        context.turn.turnId,
        context.agentRunId ?? null,
        context.turn.chatId,
        context.turn.initiatorUserId,
        toolName,
        JSON.stringify(input),
        risk,
        "pending",
        now,
        expiresAt,
      );

    // 回执那条消息的句柄。裁决落定（Telegram 点的 / 另一条通道抢先 / TTL / 轮次取消）时要把键盘
    // 撤掉并把正文换成结局，而投递可能还在途 —— 所以两头各判一次：`finish` 里判 `settle` 有没有到，
    // 投递回来时判 `outcome` 有没有先置上。存的是 outcome 而不是一个布尔：晚到的那次收尾也得说得出
    // 当时的结局是什么。
    const receipt: {
      settle: ((outcome: ApprovalOutcome) => void) | undefined;
      outcome: ApprovalOutcome | null;
      recorded: boolean;
    } = { settle: undefined, outcome: null, recorded: false };
    // 回执在**插入 pending 行之后**发：先落库再通知，通知失败也不会留下一个没人知道的等待。
    try {
      void Promise.resolve(
        this.notifyInitiator?.({
          id,
          chatId: context.turn.chatId,
          threadId: context.turn.threadId,
          requesterUserId: context.turn.initiatorUserId,
          tool: toolName,
          risk,
          ttlMs: config.approval.ttlMs,
        }),
      )
        .then((value) => {
          const posted = value as ApprovalReceipt | undefined;
          // 投递还在途中就裁决完了：当场收尾，那一列一个字都不必记 —— 它记的是「还在屏幕上」。
          if (receipt.outcome) {
            posted?.settle?.(receipt.outcome);
            return;
          }
          // `tg_message_id` 是启动时收拾残留回执的待办队列（`staleKeyboards`），不写就等于
          // 重启后屏幕上留着一排点不动的按钮。
          if (posted?.tgMessageId) {
            this.db
              .prepare("UPDATE approvals SET tg_message_id=? WHERE id=?")
              .run(posted.tgMessageId, id);
            receipt.recorded = true;
          }
          receipt.settle = posted?.settle;
          // 回执压根没送到人眼前，而它可能是这次审批唯一的通道 —— 见 `#receiptUndeliverable`。
          if (posted?.delivered === false)
            this.#receiptUndeliverable(
              id,
              toolName,
              risk,
              context.turn.chatId,
              context.turn.turnId,
            );
        })
        .catch((error: unknown) =>
          this.log.event({
            level: "warn",
            kind: "approval.receipt_failed",
            summary: "initiator receipt failed",
            traceId: context.turn.turnId,
            data: {
              error: error instanceof Error ? error.message : String(error),
            },
          }),
        );
    } catch {
      /* 同步抛也不能影响审批 */
    }
    return new Promise<ApprovalVerdict>((resolve) => {
      let settled = false;
      const abort = (): void => {
        const changed = this.db
          .prepare(
            "UPDATE approvals SET state='denied',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'",
          )
          .run(Date.now(), id).changes;
        if (changed)
          this.events.emit("approval.decided", {
            id,
            tool: toolName,
            risk,
            chatId: context.turn.chatId,
            approved: false,
            actor: "system",
            channel: "system",
          });
        finish(false, CANCELLED_HINT, { kind: "cancelled" });
      };
      const finish = (
        approved: boolean,
        hint: string | undefined,
        outcome: ApprovalOutcome,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.turn.abortSignal.removeEventListener("abort", abort);
        this.#pending.delete(id);
        receipt.outcome = outcome;
        // 收尾一律 fire-and-forget 且异常吞在投递侧（`PendingPrompts.#dismiss`）：一次改文案
        // 绝不能把审批本身从「等人批」变成「整轮失败」，那是「回执失败不影响审批本身」同一条纪律。
        const landed = receipt.settle?.(outcome);
        // **只在收尾真落地之后**才清那一列。它是「屏幕上还有按钮」的待办、不是历史记录，所以
        // 「编辑没回来」= 「这条还没办完」，得留给下次启动那趟 `staleKeyboards()`。抢在前面清的
        // 表现是消息被删 / 网络抖 / 429 各一次就让那排按钮永久没人收。清得掉的时候必须清 ——
        // 不清的话一个长跑进程攒下的每一条审批都会在下次启动被挨个编辑一遍，跟真实投递抢
        // `perChatPerMinute` 那 20 个槽位（docs/05 §6.1）。
        if (receipt.recorded)
          void Promise.resolve(landed).then((ok) => {
            if (!ok || !receipt.recorded) return;
            receipt.recorded = false;
            // 库可能已经关了（关停 / 用例收尾）：这一句纯粹是收拾待办，为它抛一个
            // unhandledRejection 不值得。
            try {
              this.db
                .prepare("UPDATE approvals SET tg_message_id=NULL WHERE id=?")
                .run(id);
            } catch {
              /* 留给下次启动那趟扫描 */
            }
          });
        if (config.approval.rememberWithinTurn)
          this.#remembered.set(
            rememberedKey,
            approved ? { approved } : { approved, hint: hint ?? DENIED_HINT },
          );
        resolve(
          approved
            ? { approved: true }
            : { approved: false, hint: hint ?? DENIED_HINT },
        );
      };
      const timer = setTimeout(() => {
        const changed = this.db
          .prepare(
            "UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'",
          )
          .run(Date.now(), id).changes;
        if (changed) {
          this.events.emit("approval.decided", {
            id,
            tool: toolName,
            risk,
            chatId: context.turn.chatId,
            approved: false,
            actor: "system",
            channel: "system",
            state: "expired",
          });
          this.log.event({
            level: "warn",
            kind: "approval.expired",
            summary: `${toolName} approval expired`,
            traceId: context.turn.turnId,
            data: { id, risk },
          });
        }
        finish(false, EXPIRED_HINT, { kind: "expired" });
      }, config.approval.ttlMs);
      timer.unref?.();
      this.#pending.set(id, { finish });
      context.turn.abortSignal.addEventListener("abort", abort, { once: true });
      this.events.emit("approval.pending", {
        id,
        turnId: context.turn.turnId,
        agentRunId: context.agentRunId ?? null,
        tool: toolName,
        input,
        risk,
        chatId: context.turn.chatId,
        requesterUserId: context.turn.initiatorUserId,
        requestedAt: now,
        expiresAt,
      });
      this.log.event({
        level: "warn",
        kind: "approval.pending",
        summary: `${toolName} awaits approval`,
        traceId: context.turn.turnId,
        data: { id, risk, expiresAt },
      });
    });
  }

  decide(
    id: string,
    approved: boolean,
    actor: string,
    channel: "telegram" | "webui",
  ): boolean {
    const now = Date.now();
    const row = this.db
      .prepare(
        "SELECT tool_name AS tool,risk,chat_id AS chatId,expires_at AS expiresAt,state FROM approvals WHERE id=?",
      )
      .get(id) as
      | {
          tool: string;
          risk: string;
          chatId: string;
          expiresAt: number;
          state: string;
        }
      | undefined;
    if (!row) return false;
    if (row.state === "pending" && row.expiresAt <= now) {
      const changed = this.db
        .prepare(
          "UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE id=? AND state='pending'",
        )
        .run(now, id).changes;
      if (changed) {
        this.events.emit("approval.decided", {
          id,
          tool: row.tool,
          risk: row.risk,
          chatId: row.chatId,
          approved: false,
          actor: "system",
          channel: "system",
          state: "expired",
        });
        this.log.event({
          level: "warn",
          kind: "approval.expired",
          summary: `${row.tool} approval expired`,
          data: { id, risk: row.risk },
        });
        this.#pending.get(id)?.finish(false, EXPIRED_HINT, { kind: "expired" });
      }
      return false;
    }
    const changed = this.db
      .prepare(
        `UPDATE approvals SET state=?,decided_by=?,decided_at=?,decision_channel=? WHERE id=? AND state='pending' AND expires_at>?`,
      )
      .run(
        approved ? "approved" : "denied",
        actor,
        now,
        channel,
        id,
        now,
      ).changes;
    if (!changed) return false;
    this.events.emit("approval.decided", {
      id,
      tool: row.tool,
      risk: row.risk,
      chatId: row.chatId,
      approved,
      actor,
      channel,
    });
    this.log.event({
      level: approved ? "info" : "warn",
      kind: "approval.decided",
      summary: `${row.tool} ${approved ? "approved" : "denied"}`,
      data: { id, actor, channel, risk: row.risk },
    });
    this.#pending
      .get(id)
      ?.finish(approved, approved ? undefined : DENIED_HINT, {
        kind: approved ? "approved" : "denied",
        channel,
      });
    return true;
  }
}
