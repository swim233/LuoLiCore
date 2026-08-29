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
  "该操作需要人工批准，但管理员已拒绝，因此未执行。请说明操作未获批准，并给出不需要该操作的替代方案。";
const EXPIRED_HINT =
  "该操作需要人工批准，但审批窗口已过期，因此未执行。请说明审批已超时，并提示用户在仍需执行时重新发起。";
const CANCELLED_HINT = "该操作等待审批时所属轮次已取消，因此未执行。";
const UNAVAILABLE_HINT =
  "该操作需要 owner 批准，但当前没有可用的审批通道，因此未执行。请说明审批通道不可用，并给出不需要该操作的替代方案。";

interface PendingApproval {
  finish(
    approved: boolean,
    hint: string | undefined,
    outcome: ApprovalOutcome,
  ): void;
}

/**
 * 一条审批的收场方式。`channel` 只在确有人裁决时才存在 —— 过期与轮次取消均由系统写入
 * （`decided_by='system'`），不涉及通道。
 *
 * 回执正文展示的是 `channel` 而非 `decided_by`。后者有三种格式：Telegram 路径写 `user:<tgId>`、
 * WebUI 写字面量 `owner`、系统写 `system`（`docs/03` 的 `approvals` 段）。将第一种展示在群消息中
 * 既无法表达清楚（一串数字对群内其他人没有意义），又会泄露 owner 的 Telegram id。裁决权本就
 * 只授予 owner（`allowInitiator` 已永久移除），因此裁决者是常量，值得说明的只有裁决通道。
 */
export interface ApprovalOutcome {
  /** `stale` 表示进程重启后由启动扫描处理的那一批：无人裁决，该请求随进程一并作废。 */
  kind: "approved" | "denied" | "expired" | "cancelled" | "stale";
  channel?: "telegram" | "webui";
}

/** 启动时需处理的一条残留回执。携带 `state` / `tool` 是为了将正文替换为当时的真实结局。 */
export interface StaleReceipt {
  chatId: string;
  messageId: number;
  state: string;
  tool: string;
}

/**
 * 一条并非工具调用、但需走同一条审批链的请求（`requestExternal` / `recordDecided`）。
 *
 * @property toolName 写入 `approvals.tool_name`，也是 `approval.rules` 匹配使用的名字。
 * @property exemptOwnerSkip 反向豁免 `approval.skipForOwner`。
 *   该开关的前提是 owner 自己要求 bot 执行的操作无需再次询问 owner —— 发起人与裁决人是同一主体。
 *   ACP 的 `session/request_permission` 不符合该形态：操作发起人是一台外部 agent，owner 只是
 *   将其引入的人，两者不是同一主体。而 `skipForOwner` 默认为真、ACP 又仅限 owner，
 *   因此不在此处反向豁免的话，整条逐条审批完全不会生效（每次都直接 `approved: true`）。
 *   ⚠️ 该逻辑看似缺陷，实则不是 —— 改回去等于静默移除逐条审批，而界面与文档中仍声明它存在。
 */
export interface ExternalApprovalRequest {
  toolName: string;
  input: unknown;
  context: ToolExecutionContext;
  risk: ApprovalRisk;
  exemptOwnerSkip?: boolean;
}

/**
 * 回执回调的返回值。各项均为可选 —— 没有 Telegram 入口（或回执仅为纯文本）时全部为空。
 *
 * @property tgChatId 该回执实际所在的会话，写入 `approvals.tg_chat_id`。按钮发往 owner 私聊，
 *   而 `approvals.chat_id` 记的是发起人会话 —— 两者不再相等，用后者去 `editMessageText` 只会
 *   拿群 id 配私聊的 message_id（见 `staleKeyboards`）。
 * @property tgMessageId 写入 `approvals.tg_message_id`。该列是启动时处理残留回执的待办队列
 *   （`docs/05 §6.1`）：不写入的话，重启后界面上会残留一排无法点击的按钮。
 * @property settle 裁决落定（在 Telegram 点击、WebUI 抢先裁决、TTL 到期、轮次取消）时收尾该回执：
 *   撤除键盘并将正文替换为结局。不撤除的话另一条通道上的两个按钮仍在，而此时它们已无法点击；
 *   不修改正文的话该消息仍停留在超时将自动拒绝的表述上，而该表述已不成立（`docs/21 §12`）。
 *   返回值表示该次编辑是否真正生效 —— `tg_message_id` 只在为真时清除（见 `staleKeyboards`）。
 * @property delivered 显式的 `false` 表示该回执无法发送（Telegram 拒收）。界面上没有任何内容，
 *   因此它不属于回执失败但审批照常这一档 —— 当 WebUI 也没有裁决通道时，此刻在语义上即为
 *   没有可用的审批通道，详见 `request()` 中的相应段落。默认值（`undefined`）表示未尝试投递，
 *   例如没有 Telegram 入口，或回执只是一条不带按钮的纯文本。
 */
export interface ApprovalReceipt {
  tgChatId?: string;
  tgMessageId?: number;
  settle?: (outcome: ApprovalOutcome) => Promise<boolean> | boolean;
  delivered?: boolean;
}

export class DatabaseApprovalBroker implements ApprovalBroker {
  readonly #config: () => Readonly<Config>;
  /** 连同 hint 一并记录：只记录布尔值时，同轮重试一次已过期或已取消的调用会得到管理员已拒绝，
   *  模型据此告知用户请求被拒，而实际情况是无人来得及处理。 */
  readonly #remembered = new Map<
    string,
    { approved: boolean; hint?: string }
  >();
  readonly #pending = new Map<string, PendingApproval>();

  /**
   * 传入 getter 时每次读取都取最新值：approval.enabled / ttlMs 热更新后下一次请求立即生效。
   *
   * @param notifyInitiator 回执的投递侧（`docs/22 · D-APPR-01`）。存在裁决通道时本轮会
   *   静默等待满 `ttlMs`（默认 180 秒），而 Telegram 侧没有任何提示 —— 用户看到的是 bot 收到
   *   消息后沉默三分钟。回执发送失败不影响审批本身，因此此处吞掉其异常。入参携带 `id`：
   *   回执上需挂载 inline keyboard，而按钮的 `callback_data` 必须能指回该行。
   *
   *   带按钮的那条发往 owner 私聊（群内有效角色封顶 `trusted`，群里的按钮无人可点），因此
   *   `chatTitle` / `input` 一并交出：owner 在私聊里收到的这条已脱离原会话上下文，只给一个
   *   工具名不足以裁决 —— 他需要知道是哪个群、谁发起的、这次调用的入参长什么样。
   * @param prompts Telegram 侧的阻塞式人机通道（`docs/05 §6.1`）。此处仅用于判定可用性，且按会话
   *   判定 —— 判的是 owner 私聊那一侧，因为按钮发在那里；发起人会话可不可裁决与此无关。
   *   提示正文与选项由装配方（`main.ts`）经 `notifyInitiator` 提供，裁决仍回到 `decide()`。
   */
  constructor(
    private readonly db: Sqlite,
    config: Readonly<Config> | (() => Readonly<Config>),
    private readonly events: EventBus,
    private readonly log: LogSink,
    private readonly notifyInitiator?: (input: {
      id: string;
      chatId: string;
      chatTitle?: string;
      threadId: number | null;
      requesterUserId: string;
      tool: string;
      input: unknown;
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
   * 启动时需处理的残留回执（`docs/05 §6.1`）：读取一次并同时清空该列 —— 它是界面上仍有一排
   * 无法点击按钮的待办队列，不是历史记录，不清空则每次重启都会重复编辑同一批历史消息。
   *
   * 判据比 `state<>'pending'` 更宽是刻意的：新进程中任何 pending 行都不可能还有等待者
   * （Promise 无法跨进程），而上一条语句只将 `expires_at` 已过的标为 `expired` —— 重启足够快时，
   * 一条 TTL 未到的 pending 行会带着永远无法唤醒任何等待者的键盘留在界面上。
   *
   * 清空该列的前提是收尾已生效。该列是待办队列而非历史记录，因此 `editMessageText` 未返回即等于
   * 该条尚未处理完 —— 裁决落定的路径（`finish`）因此只在收尾确实发出后才清除它。
   * 提前清除的表现是：消息被删、网络抖动、429 各发生一次，那排按钮即永久无人回收（关停竞态只是
   * 其中一条来源，而非唯一来源）。本函数自身是读取后立即清除：本次调用本就要重排整列待办，
   * 收尾失败的条目下次启动同样扫不到 —— 但它们的等待者早已消失，最坏情况是界面上留下一排点击后
   * 会如实回复已过期（进程重启过）的按钮，而不是一个具有误导性的可用按钮。
   *
   * 同时读取 `state` / `tool_name`：正文需替换为当时的真实结局（构造函数刚标记为 `expired` 的
   * 说明窗口已到期，TTL 未到的说明随进程作废），而不是一律替换为同一句。分类判据在
   * `staleApprovalOutcome()`（`packages/telegram/src/prompts.ts`，文案与其同处一处）。
   *
   * 会话取 `COALESCE(tg_chat_id, chat_id)`：那条带按钮的消息发往 owner 私聊，而 `chat_id` 记的是
   * 发起人会话，用后者去 `editMessageText` 是拿群 id 配私聊的 message_id，全部 400。回落守的是
   * 迁移 `0016` 之前写下的行 —— 它们没有 `tg_chat_id`，而当初的投递目标正是 `chat_id`。
   */
  staleKeyboards(): StaleReceipt[] {
    const rows = this.db
      .prepare(
        "SELECT COALESCE(tg_chat_id,chat_id) AS chatId,tg_message_id AS messageId,state,tool_name AS tool FROM approvals WHERE tg_message_id IS NOT NULL",
      )
      .all() as StaleReceipt[];
    if (rows.length)
      this.db
        .prepare(
          "UPDATE approvals SET tg_message_id=NULL,tg_chat_id=NULL WHERE tg_message_id IS NOT NULL",
        )
        .run();
    return rows;
  }

  /**
   * 回执无法发送（Telegram 拒收），而 Telegram 是本次审批唯一的裁决通道。
   *
   * 此刻在语义上与 `request()` 开头两条通道都不存在的闸门完全相同，因此采用同一口径：立即落定
   * 并返回 `UNAVAILABLE_HINT`，而不是让本轮占用 `concurrency` 槽位、配额预留与 `turnTimeoutMs`
   * 预算空等满 `ttlMs`（默认 180 秒）—— 那正是 [reviews/20 §0.0] 裁定要消除的形态，只是来源不同：
   * 闸门放行时通道仍存在，是投递环节才失效的。
   *
   * 两侧都要检查（与 `request()` 处的判据形态一致）：WebUI 仍保持 SSE 连接时，投递失败只是失去
   * 附加通知，审批仍等待其裁决 —— 那才符合回执失败不影响审批本身。
   *
   * 写入 `expired` 而非 `denied`：`denied + decided_by='system'` 在该表中已表示轮次被取消，
   * 而本情形根本未送达用户。`state` 受 CHECK 约束（`pending|approved|denied|expired`），
   * 能表达窗口结束且无人裁决的只有 `expired`；真正说明原因的是那条 `approval.unavailable`
   * warn —— 它本就是没有裁决通道这一事件的日志 kind，由 `data.reason` 区分两种来源。
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
    // 界面上没有任何内容（这正是执行到此处的原因），因此该档只与写入库的 `state` 对齐，
    // 不会改写任何正文。
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
   * 并非工具调用但需走同一条审批链的请求（`docs/05 §3.5.3`）。第一个使用方是 ACP 的
   * `session/request_permission`：操作发起人是一台外部 agent，而它询问的每一步都需写入
   * `approvals` 表、走同一套 `approval.rules` / TTL / 双通道裁决 —— 该表与该规则集只有一份，
   * 让 ACP 另建一套等于使审批一词在本项目中有两种含义。
   *
   * `tool_name` 由调用方提供（ACP 恒为 `acp_permission`）。它不必是已注册的工具 ——
   * `ApprovalRules.evaluate` 只接受名字与 `JSON.stringify(input)`，而该路径的 input 中已含
   * `"kind":"execute"` 这类足够精确的判据；为每种 kind 构造一个虚假工具名只会污染工具页与
   * `tools.overrides` 的键空间（该表只识别已注册的工具，多余的键运维修改后也不生效）。
   */
  async requestExternal(
    request: ExternalApprovalRequest,
  ): Promise<ApprovalVerdict> {
    return this.#request(request);
  }

  /**
   * 一条已有结论的审批：不询问用户，只留存凭据。
   *
   * ACP 的 `allow_always` / `reject_always` 命中会话内记忆时走此路径 —— 不写入该行的话，
   * 一次批准之后 agent 继续修改 40 个文件的过程在审计中只剩最初那一条，而这正是 always 档最需要
   * 被统计的地方。`decided_by` 由调用方提供（`acp:always`），以便它与真人裁决（`user:<tgId>` /
   * `owner`）和系统裁决（`system`）在同一列中可区分（`docs/03` 的 `approvals` 段）。
   *
   * `decision_channel` 不是 `decided_by` 的副本：前者的取值域是通道（`telegram` / `webui` /
   * `system` / `acp`），后者是主体。将裁决者原样写入通道列，审批卡上该字段会重复显示同一字符串
   * （它渲染的正是 `decided_by · decision_channel`，`docs/21 §18`），且按通道分桶的查询会多出一个
   * 取值域之外的桶。
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
    // 统计的是裁决通道而非订阅者：main.ts 的 config.changed 订阅者常驻，用 subscriberCount
    // 判定会使这段永远无法执行，非 owner 仍会静默等待满 ttlMs（docs/24 · R-APPR-01）。
    //
    // 两条通道都不存在时才立即拒绝（docs/05 §6）：除 WebUI 的 SSE 外还有 Telegram 回执上的 inline
    // keyboard。遗漏后者的话，新通道在无人打开浏览器的部署中永远不会生效 —— 而那恰是它唯一
    // 有价值的场景。Telegram 一侧判定的不是是否有人正在查看（无法检测，且 owner 的手机推送也不
    // 要求其盯着屏幕），而是 bot 是否已启动且**按钮落地的那个会话**中可点击。
    //
    // 探的是 owner 私聊而非 `context.turn.chatId`：群内的有效角色封顶 `trusted`，
    // `decidableBy:'owner'` 在任何群里都无人可满足，按钮因此一律发往 owner 私聊。仍按发起人
    // 会话探的话，判定的是一个不会收到按钮的会话 —— 挂上一条无人可点击的 pending 行再空等满
    // ttlMs。取不到 `bootstrapOwnerId` 时回落发起人会话：那是没有 owner 可通知的部署，
    // 投递侧同样退回原会话，两处必须同一口径。
    //
    // 该闸门判定的是放行时刻通道是否存在。投递环节才失效的情形由 `#receiptUndeliverable`
    // 处理，口径与此处完全一致 —— 两处必须一并考虑：只拦截此处的话，`post` 被 Telegram 拒收
    // 后仍会回到空等满 ttlMs 而界面无任何提示的状态（reviews/20 §0.0 的另一种来源）。
    if (
      this.events.channelCount === 0 &&
      this.prompts?.available(
        config.access.bootstrapOwnerId || context.turn.chatId,
      ) !== true
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

    // 回执消息的句柄。裁决落定（在 Telegram 点击 / 另一通道抢先 / TTL 到期 / 轮次取消）时需撤除
    // 键盘并将正文替换为结局，而投递可能仍在途中 —— 因此两侧各判定一次：`finish` 中判定 `settle`
    // 是否已到达，投递返回时判定 `outcome` 是否已先置位。存储的是 outcome 而非布尔值：延迟到达的
    // 收尾同样需要能表达当时的结局。
    const receipt: {
      settle: ((outcome: ApprovalOutcome) => void) | undefined;
      outcome: ApprovalOutcome | null;
      recorded: boolean;
    } = { settle: undefined, outcome: null, recorded: false };
    // 回执在插入 pending 行之后发送：先写库再通知，通知失败也不会留下无人知晓的等待。
    try {
      void Promise.resolve(
        this.notifyInitiator?.({
          id,
          chatId: context.turn.chatId,
          threadId: context.turn.threadId,
          requesterUserId: context.turn.initiatorUserId,
          tool: toolName,
          input,
          risk,
          ttlMs: config.approval.ttlMs,
          ...(context.turn.chatTitle
            ? { chatTitle: context.turn.chatTitle }
            : {}),
        }),
      )
        .then((value) => {
          const posted = value as ApprovalReceipt | undefined;
          // 投递仍在途中即已完成裁决：立即收尾，该列无需写入 —— 它记录的是仍显示在界面上的回执。
          if (receipt.outcome) {
            posted?.settle?.(receipt.outcome);
            return;
          }
          // `tg_message_id` 是启动时处理残留回执的待办队列（`staleKeyboards`），不写入等于
          // 重启后界面上残留一排无法点击的按钮。`tg_chat_id` 与它同写同清：回执落在 owner 私聊，
          // 而 `chat_id` 是发起人会话，缺了这一列那趟扫描会拿群 id 去撤私聊里的键盘。
          if (posted?.tgMessageId) {
            this.db
              .prepare(
                "UPDATE approvals SET tg_message_id=?,tg_chat_id=? WHERE id=?",
              )
              .run(posted.tgMessageId, posted.tgChatId ?? null, id);
            receipt.recorded = true;
          }
          receipt.settle = posted?.settle;
          // 回执根本未送达用户，而它可能是本次审批的唯一通道 —— 见 `#receiptUndeliverable`。
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
      /* 同步抛出同样不得影响审批 */
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
        // 收尾一律采用 fire-and-forget，异常在投递侧吞掉（`PendingPrompts.#dismiss`）：一次文案
        // 更新绝不能把审批本身从等待批准变为整轮失败，这与回执失败不影响审批本身是同一条纪律。
        const landed = receipt.settle?.(outcome);
        // 只在收尾确实生效之后才清除该列。它是界面上仍有按钮的待办队列而非历史记录，因此
        // 编辑未返回即表示该条尚未处理完，需留给下次启动的 `staleKeyboards()`。提前清除的
        // 表现是消息被删、网络抖动、429 各发生一次即使那排按钮永久无人回收。可以清除时必须清除 ——
        // 否则长期运行的进程累积的每一条审批都会在下次启动时被逐个编辑，与真实投递争抢
        // `perChatPerMinute` 的 20 个槽位（docs/05 §6.1）。
        if (receipt.recorded)
          void Promise.resolve(landed).then((ok) => {
            if (!ok || !receipt.recorded) return;
            receipt.recorded = false;
            // 数据库可能已关闭（进程关停或用例收尾）：该语句只是清理待办，不值得为它产生一次
            // unhandledRejection。
            try {
              this.db
                .prepare(
                  "UPDATE approvals SET tg_message_id=NULL,tg_chat_id=NULL WHERE id=?",
                )
                .run(id);
            } catch {
              /* 留给下次启动时的扫描处理 */
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
