import type { Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { diffLines } from "diff";
import type {
  PlanEntry,
  PlanEntryStatus,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import {
  deliveryOrder,
  escapeHtml,
  escapeMarkdownV2,
  sendWithFallback,
  toPlainText,
  type ParseFallbackInfo,
  type ParseMode,
} from "./output.js";
import type { TelegramDeliveryEvent } from "./stream-output.js";

/**
 * 单次 ACP 运行的进度卡片（`docs/08 §6.1`）。单条消息、只重写、不分片、不逐帧归档。
 *
 * 不复用 `TelegramOutput` 的第二种模式，原因：那 377 行完全建立在文本单调追加之上
 * （`lastRenderedLength` 差值判据、每帧重切全文、超长则追发一条承接、`（生成中断）`后缀、逐段归档），
 * 而卡片是快照重写 —— 计划项打勾、当前工具替换、计数器递增，文本会变短。送入 `consume()` 的具体
 * 失效模式：`[...current].length - lastRenderedLength` 为负 ⇒ 永远不满足 `minDeltaChars` ⇒ 一次都不
 * 编辑；偶尔超出 ⇒ 多发一条消息且无法回收。那 377 行中嵌入了五起故障的修复（`L-TG-02/03/04`、
 * `R-TG-02`、`W-TG-04`）与 50+ 条用例，为一个形状不同的需求改动它，是以既有测试的通过状态换代码复用。
 *
 * 因此此处复用原语与形状，不复用控制流：`sendWithFallback` / `toPlainText` 的
 * parse-entities 降级、`deliveryOrder` 的首帧串行、`TelegramDeliveryEvent` + `#emit`
 * （观测不得打断投递）、`deliver` 层的「投递失败 ≠ 生成中断」。不复用：分片、占位、后缀、逐帧归档。
 */

/** `close()` 的入参：ACP 运行的收尾事实，由 core 侧在 `finally` 中提供。 */
export interface AcpCardFinal {
  /** 全部可选字段显式带 `| undefined`：`exactOptionalPropertyTypes` 下调用方才能直接写 `stopReason: x`。 */
  stopReason?: string | undefined;
  error?: string | undefined;
  files: number;
  failures: number;
  toolCalls: number;
  costUsd?: number | undefined;
}

export interface AcpProgressCard {
  /**
   * 卡片消息的 id。`null` 表示一条都未发出（限流、被封禁）—— 归档侧据此决定是否写入
   * `messages` 行，而归档只在终帧执行一次：`ScopedArchiveRepository.append` 是
   * `INSERT OR IGNORE`，首帧即归档会把「正在启动…」永久写入 `messages` 与 FTS。
   */
  readonly messageId: number | null;
  /** 接收一条 `session/update`；内部按时间窗 + 状态变化双重判据决定是否真正编辑。不抛异常。 */
  push(notification: unknown): void;
  /**
   * 终帧：立即渲染并落定（不受节流约束），在同一次调用中撤除取消按钮，返回用于归档的最终文本
   * （渲染前的正文）。不抛异常。
   */
  close(final: AcpCardFinal): Promise<string>;
}

export interface AcpCardTarget {
  chatId: string;
  threadId: number | null;
  /**
   * 取消按钮绑定的 turn（`docs/08 §6.1`）。缺失时不挂载该按钮 —— `c:` 通道的判据是
   * 「该 id 仍在 `TurnRegistry` 中且点击者为发起人或 owner」，空 payload 必然判 false，
   * 屏幕上显示的是「只有发起人或管理员可以取消」：与真实原因无关的提示。
   */
  turnId?: string | undefined;
}

export interface AcpCardOptions {
  parseMode: ParseMode;
  maxMessageChars: number;
  intervalMs: number;
  /** 表头的两个字段。缺省时退化为「外部 agent」并省略目录 —— 缺一格标题不应导致整张卡片发不出。 */
  agent?: string | undefined;
  dir?: string | undefined;
  /** `agent_thought_chunk` 行的开关，默认开启（见下方 `#lines` 中的注释）。 */
  thoughts?: boolean | undefined;
}

export interface AcpCardHooks {
  onDelivery?(event: TelegramDeliveryEvent): void;
  onDeliveryError?(error: unknown): void;
  onParseFallback?(info: ParseFallbackInfo): void;
}

/**
 * 卡片的字符预算：`min(maxMessageChars, 3500)`。上限为 Telegram 的 4096，而超长不属于解析失败
 * —— `sendWithFallback` 无法降级处理，Telegram 直接返回 `message is too long`。3500 比
 * `maxMessageChars` 的默认值 3900 更紧：卡片全程使用单条消息，没有「超长则追发一条」的退路，
 * 因此预留更多余量。
 */
const CARD_MAX_CHARS = 3500;
/**
 * 即时刷新（plan 被替换 / 某个 tool_call 转为 failed）之间的最小间隔。
 *
 * 私聊的真实预算约为 60 次/分钟、串行一秒一拍（`docs/08 §5.2` 末条：`chat_id < 0` 才走
 * `group` 桶，私聊走只有 `{minTime: 1000}` 的 `out` 桶，无 per-minute reservoir），而卡片按
 * `intervalMs=5000` 仅占约 12/分钟。但即时刷新会绕过该间隔：一个 200 次工具调用全部失败的 agent
 * 会将其放大为 200 次编辑。两个关键事件间隔不足 2 秒时，第二次延后 3 秒显示无任何损失 ——
 * 前一帧已经告知用户状态发生变化。加上该下限后，最坏为 30/分钟，仍在私聊预算的一半以内。
 */
const IMMEDIATE_MIN_GAP_MS = 2000;
/** `close()` 等待在途帧落地的上界。它挂在调用方的 `finally` 上，必须有上界。 */
const CLOSE_WAIT_MS = 5000;
/**
 * 取消按钮复用 `bot.ts` 中既有的 `c:<turnId>` 通道（`docs/08 §6` 的取消按钮，该处已判定
 * 「点击者为发起人或 owner」），不是新增的 callback 种类 —— 因此适配层只需决定是否挂载这副键盘，
 * `callback_query:data` 的处理器无需改动。
 *
 * 64 字节是 Bot API 对 `callback_data` 的硬上界（算法同 `docs/05 §6.1` 中 `a:` 那套）。
 * `c:` + ULID(26) = 28，该判据仅在 turnId 非 ULID 时才可能触发；而一旦超界，Telegram 拒绝的是整条
 * `sendMessage` —— 屏幕上不会出现卡片。因此宁可不挂按钮。
 */
const CANCEL_PREFIX = "c:";
const CALLBACK_DATA_MAX = 64;
const CANCEL_LABEL = "⛔ 取消";
const TITLE_MAX = 72;
const PLAN_INLINE_MAX = 24;
const PATH_MAX = 52;
const DIR_MAX = 40;
/** 思考行与正文尾行各自的显示长度，以及各自有界滚动窗口的长度。 */
const THOUGHT_MAX = 120;
const THOUGHT_BUFFER_MAX = 240;
const TAIL_MAX = 120;
const TAIL_BUFFER_MAX = 400;
/**
 * 卡片内部各表的上界。输入方是输出量不受信任的子进程（实测 86 秒的任务产生 263 条 update），
 * 而 `maxUpdatesPerPrompt` 是每次 prompt 的上界 —— 按 toolCallId 增长的表不应随之增长。
 * 达到上界后仅停止跟踪明细，计数仍然准确（`#toolCalls` / `#paths`）。
 */
const MAX_TRACKED_TOOLS = 256;
const MAX_TRACKED_FILES = 64;
/** 仅参与计数的路径表的上界。比明细表宽得多（计数只需数量），但仍然有界 ——
 *  路径长度不受控制，挂在一次 run 上的无界 Set 即为内存泄漏。 */
const MAX_COUNTED_FILES = 512;
const MAX_PLAN_ENTRIES = 40;
/**
 * 行级计数的输入上界与编辑距离上界。`diffLines` 复杂度为 O(n·d)，而 `push()` 运行在接收
 * `session/update` 的路径上：一次 200 个工具调用的 run 中，每条 diff 都对上万行文件做全量比对，
 * 会长时间占用事件循环。超界时只显示路径不显示行数 —— 卡片需要回答的是改动了哪些文件，
 * 行数是附加信息。
 */
const MAX_DIFF_CHARS = 131_072;
const MAX_DIFF_EDIT = 4000;
const PLAN_DONE_LINES = 2;
const PLAN_ACTIVE_LINES = 2;
const PLAN_PENDING_INLINE = 2;
const FILE_LINES = 3;

/** 计数行使用的短标签（`读取 9 · 编辑 6 · 执行 5 · 搜索 3`），定义顺序即显示顺序。 */
const KIND_LABEL: Record<ToolKind, string> = {
  read: "读取",
  edit: "编辑",
  execute: "执行",
  search: "搜索",
  fetch: "获取",
  delete: "删除",
  move: "移动",
  think: "思考",
  switch_mode: "切换模式",
  other: "其他",
};
const KIND_ORDER = Object.keys(KIND_LABEL) as ToolKind[];
/** 「当前」行的图标。标题本身即自然语言描述，前置图标比再加一个中文标签更易读。 */
const KIND_ICON: Record<ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  execute: "⚙️",
  search: "🔍",
  fetch: "🌐",
  delete: "🗑",
  move: "📦",
  think: "💭",
  switch_mode: "🔀",
  other: "🔧",
};
const PLAN_MARK: Record<PlanEntryStatus, string> = {
  completed: "✓",
  in_progress: "▶",
  pending: "○",
};
const STOP_LABEL: Record<string, string> = {
  end_turn: "完成",
  max_tokens: "上游截断（max_tokens）",
  max_turn_requests: "达到请求数上限",
  refusal: "上游拒答",
  cancelled: "已取消",
};
/** core 侧 `AcpErrorCode` 中会到达终帧的若干项。名单外的原样显示 —— 杜撰中文说法比暴露错误码更差。 */
const ERROR_LABEL: Record<string, string> = {
  acp_cancelled: "已取消",
  acp_timeout: "超时中止",
  acp_cost_exceeded: "超预算中止",
  acp_connection_lost: "连接断开",
  acp_prompt_failed: "agent 执行失败",
};

/**
 * 整段丢弃的优先级（`docs/08 §6.1`）。前四档为固定的四段，其后几档只有在 `maxMessageChars` 被
 * 调至极小值时才会触发。表头、失败行、三个计数行永不进入该表 —— 失败正是本次运行耗时十五分钟
 * 的原因，只显示当前状态会将其覆盖。
 */
type Group =
  | "thought"
  | "planDone"
  | "fileLines"
  | "toolKinds"
  | "tail"
  | "planPending"
  | "planActive"
  | "planCount"
  | "now";
const DROP_LADDER: readonly Group[] = [
  "thought",
  "planDone",
  "fileLines",
  "toolKinds",
  "tail",
  "planPending",
  "planActive",
  "planCount",
  "now",
];

/** `key` 是该行参与「与上帧逐字节相同」判据时的形态，缺省即 `text`。只有表头使用它：该行包含
 *  一个每秒变化的计时器，将其计入判据会使「相同则不发」永不成立，而表头中的模式与目录
 *  仍需参与判据 —— 一次 `current_mode_update` 是真实变化，不应被计时器一并排除。 */
interface Line {
  group?: Group;
  text: string;
  key?: string;
}
interface TrackedTool {
  kind: ToolKind;
  title: string;
  path: string | null;
  status: ToolCallStatus;
}
interface TouchedFile {
  mark: string;
  added: number;
  removed: number;
  counted: boolean;
}

/**
 * 所有进入卡片的外部文本先经过此处。换行必须折叠 —— 卡片采用一项一行的版式，带换行的
 * 工具标题会使后续所有行的语义错位；控制字符同理（NUL 在 Telegram 正文中无任何显示意义）。
 */
function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 单个字段的省略。这不属于截断半行 —— `docs/02 §9` 红线 11 约束的是不透明单元不得截半，而带
 * 显式 `…` 的标题是完整的显示单元；真正禁止的是一行只渲染一半即中断，该约束由整段丢弃
 * 和最后一道按行兜底保证。
 */
function clip(text: string, max: number): string {
  const points = [...oneLine(text)];
  return points.length <= max
    ? points.join("")
    : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/**
 * 路径按尾部保留：`…/tools/builtins.ts` 可辨识具体文件，`/home/swim/code/Luo…` 不可。
 * 4000 字的路径因此同样只占一行 —— 该字段由外部 agent 传入，长度不受控制。
 */
function shortPath(path: string, max = PATH_MAX): string {
  const clean = oneLine(path);
  if ([...clean].length <= max) return clean;
  const parts = clean.split("/").filter(Boolean);
  const kept: string[] = [];
  let size = 1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const next = [...parts[index]!].length + 1;
    if (size + next > max) break;
    kept.unshift(parts[index]!);
    size += next;
  }
  // 最后一段自身即超长（单个文件名数千字符）：该段按尾部硬截断，前置 `…`。
  if (!kept.length) return `…${[...clean].slice(-(max - 1)).join("")}`;
  return `…/${kept.join("/")}`;
}

/** 已 `unref` 的 sleep：`close()` 的等待上界不应成为进程无法退出的原因。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function costLabel(amount: number): string {
  return `$${amount < 0.01 ? amount.toFixed(3) : amount.toFixed(2)}`;
}

/** 有界滚动窗口：只保留尾部。思考与正文都只需展示最新进度，保留开头没有意义。 */
function rollingTail(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(-max).join("");
}

/**
 * 名单中不存在时原样显示（见 `ERROR_LABEL`）。使用 `Object.hasOwn` 而非直接索引：`stopReason`
 * 是外部 agent 经 JSON-RPC 传入的字符串，`STOP_LABEL['toString']` 会沿原型链取到一个函数，
 * 插入模板后会在卡片上显示整段函数源码。
 */
function label(table: Record<string, string>, key: string): string {
  return Object.hasOwn(table, key) ? table[key]! : clip(key, TITLE_MAX);
}

/** 同理：`'constructor' in KIND_LABEL` 为真，而 `KIND_LABEL[kind]` 为 `undefined`，
 *  卡片上会显示字面量 `undefined`。 */
function normalizeKind(kind: unknown): ToolKind {
  return typeof kind === "string" && Object.hasOwn(KIND_LABEL, kind)
    ? (kind as ToolKind)
    : "other";
}

function firstPath(locations: unknown): string | null {
  if (!Array.isArray(locations)) return null;
  const first = locations[0] as ToolCallLocation | undefined;
  return first && typeof first.path === "string" && first.path
    ? first.path
    : null;
}

/**
 * `Diff{path, oldText, newText}` → `+A −B`。patch 全文一个字节都不进入消息，两条理由：
 * ① Telegram 的 4096 上限，一份真实 diff 即可占满；② 终帧文本会被归档并进入下一轮模型上下文
 * —— 让外部 agent 生成的 diff 原文走这条路，等于开出一条不经 `untrusted()` 的注入通道。
 */
function countDiff(
  oldText: string,
  newText: string,
): { added: number; removed: number } | null {
  if (oldText.length + newText.length > MAX_DIFF_CHARS) return null;
  const changes = diffLines(oldText, newText, { maxEditLength: MAX_DIFF_EDIT });
  if (!changes) return null;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.added) added += change.count ?? 0;
    else if (change.removed) removed += change.count ?? 0;
  }
  return { added, removed };
}

class AcpCard implements AcpProgressCard {
  readonly #startedAt = Date.now();
  readonly #agent: string;
  readonly #dir: string;
  /** 工作目录的原始形态（`#dir` 是供表头显示、可能已省略过的那份）。用途见 `#short`。 */
  readonly #root: string;
  readonly #budget: number;
  readonly #interval: number;
  /** 整次 run 不变的键盘，`undefined` 表示该卡片没有取消按钮（见 `AcpCardTarget.turnId`）。 */
  readonly #cancel: InlineKeyboardMarkup | undefined;
  #mode: string | null = null;
  #plan: Array<{ content: string; status: PlanEntryStatus }> = [];
  #planId: string | null = null;
  readonly #tools = new Map<string, TrackedTool>();
  #toolCalls = 0;
  readonly #kinds = new Map<ToolKind, number>();
  /** 当前正在执行的工具。使用显式字段而非每帧扫描 `#tools`：达到 `MAX_TRACKED_TOOLS` 后
   *  该表不再接收新项，而当前执行状态不应随之消失。 */
  #current: TrackedTool | null = null;
  #currentId: string | null = null;
  #failures = 0;
  #lastFailure: string | null = null;
  readonly #files = new Map<string, TouchedFile>();
  /** 仅用于计数的路径集合：`#files` 达到 `MAX_TRACKED_FILES` 后不再接收新项，而
   *  「改动 N 个文件」不应随之停止。使用 Set 而非溢出计数器 —— 后者按 `#touch` 调用次数累加，
   *  同一文件被改十次即报十个文件（一次 200 个工具调用的 run 可使其虚增至三位数）。 */
  readonly #paths = new Set<string>();
  #tail = "";
  #thought = "";
  #thoughtId: string | null = null;
  #costUsd: number | null = null;
  #dirty = false;
  #lastEditAt = 0;
  #messageId: number | null = null;
  /** 上一帧的正文，不含表头中的计时器（见 `Line.key`）：时钟走过一秒不构成新信息，
   *  将其计入判据会使「逐字节相同则不发」永不成立。 */
  #lastKey: string | null = null;
  #plain = "";
  #closed = false;
  #inFlight: Promise<void> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #editCount = 0;
  #editMs = 0;
  #editError: string | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly target: AcpCardTarget,
    private readonly options: AcpCardOptions,
    private readonly hooks: AcpCardHooks,
  ) {
    this.#agent = oneLine(options.agent ?? "") || "外部 agent";
    this.#root = oneLine(options.dir ?? "").replace(/\/+$/, "");
    this.#dir = this.#root ? shortPath(this.#root, DIR_MAX) : "";
    this.#budget = Math.max(
      64,
      Math.min(options.maxMessageChars, CARD_MAX_CHARS),
    );
    // 间隔存在下限：私聊桶本身为 `{minTime: 1000}` 一秒一拍，配置更小只会使编辑在节流器中
    // 排队 —— 排队中的编辑占用的正是下一帧所需的槽位（`docs/08 §5.2` 的队尾饥饿）。
    this.#interval = Math.max(1000, options.intervalMs);
    const data = `${CANCEL_PREFIX}${target.turnId ?? ""}`;
    this.#cancel =
      target.turnId && Buffer.byteLength(data) <= CALLBACK_DATA_MAX
        ? { inline_keyboard: [[{ text: CANCEL_LABEL, callback_data: data }]] }
        : undefined;
  }

  get messageId(): number | null {
    return this.#messageId;
  }

  /**
   * 路径进入卡片前的收窄。先去除工作目录前缀：目录已在表头显示，每行重复
   * `/home/swim/code/LuoLiCore/` 只会把本已紧张的预算耗在同一段字符上，而「改动了哪些文件」
   * 需要的是 `packages/telegram/src/tools.ts` 这一段。目录外的路径（agent 越界访问）原样保留 ——
   * 那恰恰是最需要看清的一类。
   */
  #short(path: string): string {
    const clean = oneLine(path);
    return shortPath(
      this.#root && clean.startsWith(`${this.#root}/`)
        ? clean.slice(this.#root.length + 1)
        : clean,
    );
  }

  /** 观测不得打断投递（同 `TelegramOutput.#emit`）：`LogSink.event` 保证不抛，但契约上不应依赖。 */
  #emit(event: TelegramDeliveryEvent): void {
    try {
      this.hooks.onDelivery?.(event);
    } catch {
      /* 日志写入失败不应中止卡片更新 */
    }
  }

  /** 首帧：卡片必须在 ACP 实际开始执行前出现在屏幕上，「数分钟看不到任何进度」是本模块的由来。 */
  async start(): Promise<void> {
    this.#dirty = true;
    // 首帧发送失败也要返回卡片（`messageId` 为 `null`，下一帧重试发送）：一次投递失败
    // 不应阻断整次 ACP。`#flushNow` 自行吞掉投递错误，本层兜底的是渲染路径上的异常。
    try {
      await this.#flushNow(null);
    } catch {
      /* 首帧未渲染成功，下一帧继续 */
    }
    // 仅在 dirty 时真正发送（判据与 `push` 完全一致），因此不额外消耗预算；有它才能保证
    // 最后一条 update 一定被渲染 —— 一个静默 3 分钟的 `execute` 之前那次 flush 可能仅过去半秒，
    // 无心跳时屏幕会永远停留在上一个工具。
    this.#heartbeat = setInterval(() => {
      this.#schedule(false);
    }, this.#interval);
    this.#heartbeat.unref?.();
  }

  push(notification: unknown): void {
    try {
      if (this.#closed) return;
      const immediate = this.#absorb(notification);
      // 任何 update 均置 dirty。`agent_message_chunk` 因此也会置位，但它实际上不驱动刷新：
      // 正文尾仅在无 in_progress 工具时显示，有工具执行时该帧渲染结果与上帧逐字节相同，
      // 被下方判据直接过滤。以「相同则不发」实现规则 6，比为 chunk 增加特例少一处分支。
      this.#dirty = true;
      this.#schedule(immediate);
    } catch {
      /* 呈现层的任何异常都不得传播到接收 `session/update` 的路径上 */
    }
  }

  async close(final: AcpCardFinal): Promise<string> {
    if (this.#closed) return this.#plain;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    try {
      // 先让在途帧落地，否则两次 `editMessageText` 可能乱序到达，终帧被上一帧覆盖。
      // 等待存在上界：在途帧可能正排在节流器队列中，而该 await 挂在调用方的 `finally`
      // 上 —— 阻塞它等于阻塞整次工具调用的返回。超时则照常发送终帧，节流器为 FIFO，顺序仍正确。
      if (this.#inFlight)
        await Promise.race([
          this.#inFlight.catch(() => undefined),
          sleep(CLOSE_WAIT_MS),
        ]);
      this.#dirty = true;
      await this.#flushNow(final);
    } catch {
      /* 终帧渲染或投递失败也要返回文本：调用方在 `finally` 中等待它 */
    }
    if (this.#editCount) {
      // 编辑按轮聚合为一条（`docs/10 §2` 的 `tg.edit`）。`ok` 取决于是否发生过失败：否则全程
      // 失败的编辑不会留下任何记录 —— 逐次记录是噪声，但「该卡片一次都未更新成功」不是。
      this.#emit({
        kind: "edit",
        ok: this.#editError === null,
        ms: this.#editMs,
        count: this.#editCount,
        chars: [...this.#plain].length,
        ...(this.#messageId === null ? {} : { messageId: this.#messageId }),
        ...(this.#editError === null ? {} : { error: this.#editError }),
      });
    }
    return this.#plain;
  }

  /**
   * 时间窗与状态变化两者都需要。仅用时间窗：plan 变化需等 5 秒才可见。仅用状态变化：
   * 200 次 tool_call 即 200 次编辑，耗尽私聊约 60/分钟的预算。三个即时例外见 `IMMEDIATE_MIN_GAP_MS`。
   */
  #schedule(immediate: boolean): void {
    if (this.#closed || !this.#dirty || this.#inFlight) return;
    const gap = immediate
      ? Math.min(IMMEDIATE_MIN_GAP_MS, this.#interval)
      : this.#interval;
    if (Date.now() - this.#lastEditAt < gap) return;
    this.#inFlight = this.#flushNow(null).finally(() => {
      this.#inFlight = null;
    });
    void this.#inFlight;
  }

  async #flushNow(final: AcpCardFinal | null): Promise<void> {
    const frame = this.#frame(final);
    this.#plain = frame.plain;
    // 键盘只挂在过程帧上，因此它参与判据。终帧通常正文也会变化（增加一行 `✅ 完成` / `⛔ …`），
    // 但那是常态而非不变量：表头本身超过预算时，`#frame` 最后一道按码点硬截断的兜底会把每一帧
    // 都截为表头的同一段（计时器与 verdict 均在截断点之后），于是「逐字节相同则不发」会过滤掉整个
    // 终帧 —— 按钮将永久留在一张已结束的卡片上。键盘由有到无是一次真实变化，不得被正文判据吞掉。
    const markup = final === null ? this.#cancel : undefined;
    const key = `${markup ? CANCEL_PREFIX : ""}${frame.key}`;
    // 逐字节相同则不发送，不依赖 Telegram 返回 `message is not modified` 兜底：该请求同样会占用
    // 一个槽位，且排在真正需要发送的内容之前。也不更新 `#lastEditAt` —— 该帧未消耗配额。
    if (this.#lastKey !== null && key === this.#lastKey) {
      this.#dirty = false;
      return;
    }
    this.#dirty = false;
    this.#lastKey = key;
    // 先记录时刻再投递：投递失败同样计为一次尝试，否则持续失败的 chat 会因连续重试耗尽预算。
    this.#lastEditAt = Date.now();
    if (this.#messageId === null) {
      await this.#send(frame.rendered, final !== null, markup);
      return;
    }
    await this.#edit(this.#messageId, frame.rendered, markup);
  }

  /** 投递失败 ≠ ACP 运行失败（同 `R-TG-02` 的判据）：吞掉异常、记录一行、卡片继续。 */
  async #send(
    rendered: string,
    isFinal: boolean,
    markup: InlineKeyboardMarkup | undefined,
  ): Promise<void> {
    const at = Date.now();
    const extra = {
      ...(this.target.threadId === null
        ? {}
        : { message_thread_id: this.target.threadId }),
      ...(markup ? { reply_markup: markup } : {}),
    };
    // 首帧按 chat 串行（同另外三条出站路径，`L-TG-02`）：卡片不能插入其他消息的分段之间。
    // 编辑一律在锁外 —— 纳入锁内会使整个 ACP 运行期间该 chat 的投递退化为实质串行。
    const sent = await deliveryOrder
      .run(this.target.chatId, () =>
        sendWithFallback(
          this.bot.api,
          this.target.chatId,
          rendered,
          extra,
          this.options.parseMode,
          this.hooks.onParseFallback,
        ),
      )
      .catch((error: unknown) => {
        this.hooks.onDeliveryError?.(error);
        return null;
      });
    if (sent) this.#messageId = sent.message_id;
    else this.#lastKey = null; // 未发出 ⇒ 屏幕上无内容，下一帧不应被「与上帧相同」判据拦截
    this.#emit({
      kind: "send",
      ok: sent !== null,
      ms: Date.now() - at,
      ...(sent ? { messageId: sent.message_id } : {}),
      chars: [...rendered].length,
      path: isFinal ? "final" : "stream",
    });
  }

  async #edit(
    messageId: number,
    rendered: string,
    markup: InlineKeyboardMarkup | undefined,
  ): Promise<void> {
    const at = Date.now();
    this.#editCount += 1;
    // `reply_markup` 每一帧都需重新传入：Bot API 将不带该字段的 `editMessageText` 视为撤除键盘
    // （同 `TelegramPromptChannel.settle`），因此省略它正是终帧所需的语义 —— 反之，过程帧遗漏
    // 该字段即等于按钮在首次编辑后自行消失。撤键盘与改正文因此合并为同一次调用，不额外占槽位。
    const extra = markup === undefined ? {} : { reply_markup: markup };
    try {
      if (this.options.parseMode === "none")
        await this.bot.api.editMessageText(
          this.target.chatId,
          messageId,
          rendered,
          extra,
        );
      else
        await this.bot.api.editMessageText(
          this.target.chatId,
          messageId,
          rendered,
          { parse_mode: this.options.parseMode, ...extra },
        );
    } catch (error) {
      const description =
        error instanceof Error ? error.message : String(error);
      if (/message is not modified|429/i.test(description)) return;
      if (/parse entities/i.test(description)) {
        // 与 `sendWithFallback` 属同一跳、同一条 warn：丢弃格式，保留卡片。降级发送的是 `toPlainText`
        // 而非渲染结果原文 —— 后者在 MarkdownV2 下会呈现满屏 `\-`。
        try {
          await this.bot.api.editMessageText(
            this.target.chatId,
            messageId,
            toPlainText(rendered, this.options.parseMode),
            extra,
          );
          this.hooks.onParseFallback?.({
            chars: [...rendered].length,
            error: description,
            phase: "edit",
          });
          return;
        } catch {
          /* 二次失败同样只记录不抛出 */
        }
      }
      this.#editError = description;
      this.hooks.onDeliveryError?.(error);
    } finally {
      this.#editMs += Date.now() - at;
    }
  }

  /**
   * 渲染一帧。超出预算时按固定优先级整段丢弃，不截断半行 —— 即 `docs/02 §9` 红线 11「不透明单元
   * 要么原样保留要么整体替换为占位」在 UI 层的应用。
   *
   * 判据度量的是渲染之后的长度：转义会使长度接近翻倍，按正文长度度量会超出上限，而超长会被
   * Telegram 硬拒（`sendWithFallback` 只能兜底解析失败）。
   */
  #frame(final: AcpCardFinal | null): {
    plain: string;
    rendered: string;
    key: string;
  } {
    const now = Date.now();
    const dropped = new Set<Group>();
    for (let step = 0; ; step += 1) {
      const kept = this.#lines(now, final).filter(
        (line) => !line.group || !dropped.has(line.group),
      );
      const plain = kept.map((line) => line.text).join("\n");
      const rendered = this.#render(plain);
      // key 采用渲染前的正文：`#render` 是逐字符的纯函数，比较它与比较渲染结果等价。
      const key = kept.map((line) => line.key ?? line.text).join("\n");
      if ([...rendered].length <= this.#budget) return { plain, rendered, key };
      if (step < DROP_LADDER.length) {
        dropped.add(DROP_LADDER[step]!);
        continue;
      }
      // 丢弃梯全部用尽仍超限（只可能是 `maxMessageChars` 被配置为极小值）：按码点硬截断正文。
      // 该步骤不会破坏转义 —— 两档转义均为逐字符映射，正文中不存在跨字符的构造。
      let clipped = plain;
      let out = rendered;
      while ([...out].length > this.#budget && clipped.length) {
        const cut = Math.max(
          1,
          Math.floor(([...clipped].length * this.#budget) / [...out].length) -
            1,
        );
        clipped = [...clipped].slice(0, cut).join("");
        out = this.#render(clipped);
      }
      return { plain: clipped, rendered: out, key: clipped };
    }
  }

  /**
   * 卡片正文整体按纯文本转义，不经过 `safeRender` 的 Markdown AST。
   *
   * 理由：卡片中每一个变量都是外部 agent 传入的字符串（工具标题、路径、思考、正文尾）。
   * 若交给 Markdown 解析器，标题中的 ``` 即可开启围栏并吞掉整张卡片 —— 输出仍是合法的
   * MarkdownV2（`safeRender` 保证这一点），但卡片会整体变为代码块。逐字符转义换取的是
   * 任何字符都不会被解释为标记，代价仅是卡片内无粗体，而卡片本就不需要。
   */
  #render(plain: string): string {
    const text = plain.replaceAll("\u0000", "");
    if (this.options.parseMode === "HTML") return escapeHtml(text);
    if (this.options.parseMode === "MarkdownV2") return escapeMarkdownV2(text);
    return text;
  }

  #lines(now: number, final: AcpCardFinal | null): Line[] {
    const lines: Line[] = [];
    const head = [`🔧 ${this.#agent}`];
    if (this.#dir) head.push(this.#dir);
    if (this.#mode) head.push(this.#mode);
    lines.push({
      key: head.join(" · "),
      text: [...head, elapsedLabel(now - this.#startedAt)].join(" · "),
    });
    if (final) lines.push({ text: this.#verdict(final) });
    if (this.#plan.length) {
      const done = this.#plan.filter((entry) => entry.status === "completed");
      const active = this.#plan.filter(
        (entry) => entry.status === "in_progress",
      );
      const pending = this.#plan.filter((entry) => entry.status === "pending");
      lines.push({
        group: "planCount",
        text: `计划 ${done.length}/${this.#plan.length}`,
      });
      // 已完成项只保留最近两条：其余由 `3/7` 计数代表。已完成项属于无需再关注的部分。
      for (const entry of done.slice(-PLAN_DONE_LINES))
        lines.push({
          group: "planDone",
          text: `  ${PLAN_MARK.completed} ${clip(entry.content, TITLE_MAX)}`,
        });
      for (const entry of active.slice(0, PLAN_ACTIVE_LINES))
        lines.push({
          group: "planActive",
          text: `  ${PLAN_MARK.in_progress} ${clip(entry.content, TITLE_MAX)}`,
        });
      if (pending.length) {
        const shown = pending
          .slice(0, PLAN_PENDING_INLINE)
          .map(
            (entry) =>
              `${PLAN_MARK.pending} ${clip(entry.content, PLAN_INLINE_MAX)}`,
          )
          .join(" · ");
        const rest =
          pending.length - Math.min(pending.length, PLAN_PENDING_INLINE);
        lines.push({
          group: "planPending",
          text: `  ${shown}${rest ? `  … 还有 ${rest} 项` : ""}`,
        });
      }
    }
    if (!final && this.#current) {
      const path =
        this.#current.path && !this.#current.title.includes(this.#current.path)
          ? ` · ${this.#short(this.#current.path)}`
          : "";
      const title = this.#current.title || KIND_LABEL[this.#current.kind];
      lines.push({
        group: "now",
        text: `当前 · ${KIND_ICON[this.#current.kind]} ${clip(title, TITLE_MAX)}${path}`,
      });
    } else {
      /**
       * 仅在空闲时显示这两行。思考行只在过程帧显示：终帧文本会进入归档与下一轮上下文，
       * 而思考链属于 agent 的内部状态（同 `docs/02` 对不透明 part 的口径）—— 可以展示给人看，
       * 但不应写入历史。它也是唯一能表明「思考 90 秒仍未产出 plan 的 agent」未卡死的信号。
       */
      if (!final && this.#thought && this.options.thoughts !== false)
        lines.push({
          group: "thought",
          text: `💭 ${clip(rollingTail(this.#thought, THOUGHT_MAX), THOUGHT_MAX)}`,
        });
      if (this.#tail)
        lines.push({
          group: "tail",
          text: `💬 ${clip(rollingTail(this.#tail, TAIL_MAX), TAIL_MAX)}`,
        });
    }
    const files = Math.max(final?.files ?? 0, this.#paths.size);
    if (files) {
      lines.push({ text: `改动 ${files} 个文件` });
      const shown = [...this.#files.entries()].slice(0, FILE_LINES);
      for (const [path, stat] of shown) {
        const counts = stat.counted
          ? ` ${[stat.added ? `+${stat.added}` : "", stat.removed ? `−${stat.removed}` : ""].filter(Boolean).join(" ")}`.trimEnd()
          : "";
        lines.push({
          group: "fileLines",
          text: `  ${stat.mark} ${this.#short(path)}${counts}`,
        });
      }
      const rest = files - shown.length;
      if (rest > 0)
        lines.push({ group: "fileLines", text: `  … 还有 ${rest} 个` });
    }
    // 失败状态是粘性的：一旦出现即在每一帧中保留，且永不进入丢弃梯。
    const failures = Math.max(final?.failures ?? 0, this.#failures);
    if (failures)
      lines.push({
        text: `⚠ 失败 ${failures} 次${this.#lastFailure ? ` · 最近：${clip(this.#lastFailure, TITLE_MAX)}` : ""}`,
      });
    const toolCalls = Math.max(final?.toolCalls ?? 0, this.#toolCalls);
    if (toolCalls) {
      const breakdown = KIND_ORDER.filter((kind) => this.#kinds.get(kind)).map(
        (kind) => `${KIND_LABEL[kind]} ${this.#kinds.get(kind)}`,
      );
      lines.push({ text: `工具调用 ${toolCalls} 次` });
      if (breakdown.length)
        lines.push({ group: "toolKinds", text: `  ${breakdown.join(" · ")}` });
    }
    // 尚未收到任何 update：屏幕上必须有内容，卡片的存在本身即表示运行已启动。
    if (lines.length === 1) lines.push({ text: "⏳ 正在启动…" });
    return lines;
  }

  #verdict(final: AcpCardFinal): string {
    const cost =
      typeof final.costUsd === "number" && final.costUsd > 0
        ? ` · ${costLabel(final.costUsd)}`
        : this.#costUsd
          ? ` · ${costLabel(this.#costUsd)}`
          : "";
    const files = Math.max(final.files, this.#paths.size);
    // 取消与超时必须保留终帧（`docs/00 §「收尾那一条消息还是要发出去」`）：若屏幕上停留一张
    // 「现在 · 编辑 …」的卡片而进程已终止，用户无法判断它是已结束还是仍在运行。
    if (final.error)
      return `⛔ ${label(ERROR_LABEL, final.error)} · 已改动 ${files} 个文件${cost}`;
    const stop = final.stopReason ?? "end_turn";
    if (stop === "end_turn") return `✅ 完成${cost}`;
    return `⚠ ${label(STOP_LABEL, stop)}${cost}`;
  }

  /** 返回该 update 是否值得触发一次绕过间隔的即时刷新。仅限 plan 被替换与 tool_call 转为 failed。 */
  #absorb(notification: unknown): boolean {
    const update = (notification as SessionNotification | null | undefined)
      ?.update;
    if (!update || typeof update !== "object") return false;
    switch (update.sessionUpdate) {
      case "plan":
        return this.#setPlan(update.entries, null);
      // `plan_update` 在 SDK 中仍标记为 UNSTABLE，但不接收的代价是「agent 使用新协议 ⇒ 卡片上
      // 没有任何计划」。只接受 `items` 一档（`file` / `markdown` 要求读取文件或渲染 markdown，
      // 二者都不应在卡片层完成）；存在多个 planId 时以后到者为准 —— 一张卡片只显示一份计划。
      case "plan_update":
        return update.plan?.type === "items"
          ? this.#setPlan(update.plan.entries, update.plan.planId)
          : false;
      case "plan_removed": {
        if (this.#planId !== null && update.planId === this.#planId) {
          this.#plan = [];
          this.#planId = null;
          return true;
        }
        return false;
      }
      case "tool_call": {
        const id =
          typeof update.toolCallId === "string" ? update.toolCallId : "";
        const kind = normalizeKind(update.kind);
        this.#toolCalls += 1;
        this.#kinds.set(kind, (this.#kinds.get(kind) ?? 0) + 1);
        // 建表时统一记为 `pending`，真实状态交由 `#applyStatus` 迁移 —— 它按 `was !== 'failed'`
        // 判定是否计入一次失败；若直接把 `failed` 写入初值，一条初始状态即为 failed 的
        // `tool_call`（ACP 允许）会被视为已上报，该次失败将完全不被计入。
        const tool: TrackedTool = {
          kind,
          title: clip(update.title ?? "", TITLE_MAX),
          path: firstPath(update.locations),
          status: "pending",
        };
        if (id && this.#tools.size < MAX_TRACKED_TOOLS)
          this.#tools.set(id, tool);
        this.#absorbContent(update.content);
        return this.#applyStatus(id, tool, update.status ?? "pending");
      }
      case "tool_call_update": {
        const id =
          typeof update.toolCallId === "string" ? update.toolCallId : "";
        // 更新只携带变化的字段：未被跟踪时（达到上界 / 未收到过 `tool_call`）以其自带字段兜底。
        const tool = this.#tools.get(id) ?? {
          kind: normalizeKind(update.kind),
          title: "",
          path: null,
          status: "pending",
        };
        if (update.kind) tool.kind = normalizeKind(update.kind);
        if (update.title) tool.title = clip(update.title, TITLE_MAX);
        const path = firstPath(update.locations);
        if (path) tool.path = path;
        this.#absorbContent(update.content);
        return this.#applyStatus(id, tool, update.status ?? tool.status);
      }
      case "agent_message_chunk": {
        if (update.content.type === "text")
          this.#tail = rollingTail(
            this.#tail + update.content.text,
            TAIL_BUFFER_MAX,
          );
        return false;
      }
      case "agent_thought_chunk": {
        // 「永不累积」指不无界增长、不进入归档。但 chunk 按 token 切分，单条常只有两三个字
        // —— 若每条整体替换，屏幕上显示的将是无意义的片段。因此采用有界滚动窗口，
        // 并在 `messageId` 变化时清空（ACP 明确规定：messageId 变化即为新一条消息）。
        if (update.content.type !== "text") return false;
        const messageId =
          typeof update.messageId === "string" ? update.messageId : null;
        if (messageId !== this.#thoughtId) {
          this.#thought = "";
          this.#thoughtId = messageId;
        }
        this.#thought = rollingTail(
          this.#thought + update.content.text,
          THOUGHT_BUFFER_MAX,
        );
        return false;
      }
      case "usage_update": {
        // `cost.amount` 是累计值，因此取已见过的最大值而非求和（同 `AcpUpdateSink`）。
        const amount = update.cost?.amount;
        if (typeof amount === "number")
          this.#costUsd = Math.max(this.#costUsd ?? 0, amount);
        return false;
      }
      case "current_mode_update": {
        // 模式显示在表头：plan 档的 run 不会修改任何文件，不显示模式时那张「改动 0 个文件」
        // 的卡片看起来像 agent 未执行任何操作。
        this.#mode =
          typeof update.currentModeId === "string"
            ? clip(update.currentModeId, 16)
            : null;
        return false;
      }
      // `session_info_update`（agent 为会话生成的标题）与 `available_commands_update`
      // （其支持的 slash 命令）对当前执行状态没有信息量，接收但不显示。
      default:
        return false;
    }
  }

  #setPlan(entries: unknown, planId: string | null): boolean {
    if (!Array.isArray(entries)) return false;
    // plan 整体替换，不做合并：ACP 的语义即每次携带全量，合并会在 agent 变更计划时残留过期条目。
    this.#plan = (entries as PlanEntry[])
      .slice(0, MAX_PLAN_ENTRIES)
      .map((entry) => ({
        content: clip(String(entry?.content ?? ""), TITLE_MAX),
        status:
          entry?.status === "completed" || entry?.status === "in_progress"
            ? entry.status
            : ("pending" as PlanEntryStatus),
      }));
    this.#planId = planId;
    return true;
  }

  #applyStatus(id: string, tool: TrackedTool, status: ToolCallStatus): boolean {
    const was = tool.status;
    tool.status = status;
    if (id && this.#tools.has(id)) this.#tools.set(id, tool);
    if (status === "in_progress") {
      this.#current = tool;
      this.#currentId = id;
      return false;
    }
    if (status !== "completed" && status !== "failed") return false;
    if (id === this.#currentId) {
      this.#current = null;
      this.#currentId = null;
    }
    // 「改动了哪些文件」不能仅依赖 diff 块：diff 是可选的。因此 edit / delete / move 收尾时同时
    // 记录 `locations[0]` —— 但只在收尾记录、不在创建时记录：失败的 edit 未修改任何内容。
    if (
      status === "completed" &&
      tool.path &&
      (tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move")
    ) {
      this.#touch(
        tool.path,
        tool.kind === "delete" ? "✕" : tool.kind === "move" ? "→" : "±",
      );
    }
    if (status !== "failed") return false;
    // 同一 id 重复上报 failed 只计一次；未被跟踪的（已达上界）按条计 —— 宁可多计一次失败，
    // 也不能遗漏持续失败这一事实。
    if (was === "failed") return false;
    this.#failures += 1;
    this.#lastFailure = tool.title || KIND_LABEL[tool.kind];
    return true;
  }

  #absorbContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as ToolCallContent[]) {
      // `content`（文本 / 图片）与 `terminal`（终端输出）一律不进入卡片：二者均为成块内容，
      // 而卡片的预算仅为一条消息。工具的当前行为由 `title` 表达，那是一句自然语言描述。
      if (
        !block ||
        block.type !== "diff" ||
        typeof block.path !== "string" ||
        !block.path
      )
        continue;
      const oldText = typeof block.oldText === "string" ? block.oldText : "";
      const newText = typeof block.newText === "string" ? block.newText : "";
      const stat = this.#touch(block.path, oldText ? "±" : "+");
      if (!stat) continue;
      const counted = countDiff(oldText, newText);
      if (!counted) continue;
      // 同一文件被多次修改时累加每次的行数，而非计算「最终 vs 最初」的 git diff：后者需保留每个
      // 文件的原始全文，相当于把整个工作副本挂在一条卡片上。
      stat.added += counted.added;
      stat.removed += counted.removed;
      stat.counted = true;
    }
  }

  #touch(path: string, mark: string): TouchedFile | null {
    if (this.#paths.size < MAX_COUNTED_FILES) this.#paths.add(path);
    const existing = this.#files.get(path);
    // `+`（新建）一经确定即固定：新文件后续被修改十次仍是新文件。其他标记以后到者为准
    // —— 先修改后删除时应显示为已删除。
    if (existing) {
      if (existing.mark !== "+") existing.mark = mark;
      return existing;
    }
    if (this.#files.size >= MAX_TRACKED_FILES) return null;
    const created: TouchedFile = { mark, added: 0, removed: 0, counted: false };
    this.#files.set(path, created);
    return created;
  }
}

/**
 * 创建一张卡片。首帧在此处发出（await 完成）：调用方拿到卡片时屏幕上已有内容，而
 * 「启动一次外部 agent 后数分钟看不到任何进度」正是本模块要解决的问题。
 *
 * 首帧发送失败同样返回卡片（`messageId` 为 `null`）：下一帧会重试发送，而不是让整次 ACP
 * 阻塞在一次投递失败上。
 */
export async function openAcpProgressCard(
  bot: Bot,
  target: AcpCardTarget,
  options: AcpCardOptions,
  hooks: AcpCardHooks = {},
): Promise<AcpProgressCard> {
  const card = new AcpCard(bot, target, options, hooks);
  await card.start();
  return card;
}
