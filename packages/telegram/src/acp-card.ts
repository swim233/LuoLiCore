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
 * 一次 ACP 运行的进度卡片（`docs/08 §6.1`）。**一条消息、只重写、不分片、不逐帧归档。**
 *
 * 为什么不给 `TelegramOutput` 开第二种模式：那 377 行整个建立在**文本单调追加**上（`lastRenderedLength`
 * 差值判据、每帧重切全文、装不下就再发一条承接、`（生成中断）`后缀、逐段归档），而卡片是**快照重写**
 * —— 计划项打勾、当前工具换掉、计数器加一，文本会**变短**。喂进 `consume()` 的具体坏法：
 * `[...current].length - lastRenderedLength` 为负 ⇒ 永远不满 `minDeltaChars` ⇒ 一次都不编辑；
 * 偶尔涨过头 ⇒ 多发一条消息且永远收不回。那 377 行里织进了五起事故的修复（`L-TG-02/03/04`、
 * `R-TG-02`、`W-TG-04`）与 50+ 条用例，为一个形状不同的东西改它是拿既有绿灯换代码复用。
 *
 * 所以这里**复用原语与形状，不复用控制流**：`sendWithFallback` / `toPlainText` 那一跳的
 * parse-entities 降级、`deliveryOrder` 的首帧串行、`TelegramDeliveryEvent` + `#emit`
 * （观测不许打断投递）、`deliver` 那层「投递失败 ≠ 生成中断」。不复用：分片、占位、后缀、逐帧归档。
 */

/** `close()` 的入参：ACP 那一趟的收尾事实，由 core 侧在 `finally` 里给。 */
export interface AcpCardFinal {
  /** 全部可选字段都显式带 `| undefined`：`exactOptionalPropertyTypes` 下调用方才能直接写 `stopReason: x`。 */
  stopReason?: string | undefined;
  error?: string | undefined;
  files: number;
  failures: number;
  toolCalls: number;
  costUsd?: number | undefined;
}

export interface AcpProgressCard {
  /**
   * 卡片那条消息的 id。`null` = 一条都没发出去（限流、被拉黑）—— 归档侧靠它决定要不要落
   * `messages` 那一行，而**归档只在终帧做一次**：`ScopedArchiveRepository.append` 是
   * `INSERT OR IGNORE`，首帧就归档等于把「正在启动…」永久钉进 `messages` 与 FTS。
   */
  readonly messageId: number | null;
  /** 收一条 `session/update`；内部按「时间窗 + 状态变化」双闸决定是否真的编辑。**永不 throw**。 */
  push(notification: unknown): void;
  /**
   * 终帧：立刻渲染并落定（不受节流约束），**同一次调用里把取消按钮撤掉**，交回归档用的最终文本
   * （渲染前的正文）。**永不 throw**。
   */
  close(final: AcpCardFinal): Promise<string>;
}

export interface AcpCardTarget {
  chatId: string;
  threadId: number | null;
  /**
   * 取消按钮挂的那个 turn（`docs/08 §6.1`）。**缺席时整个按钮不挂** —— `c:` 那条通道的判据是
   * 「这个 id 还在 `TurnRegistry` 里且点的人是发起人或 owner」，一个空 payload 必然判 false，
   * 而屏幕上出现的是「只有发起人或管理员可以取消」：一句与真实原因毫不相干的话。
   */
  turnId?: string | undefined;
}

export interface AcpCardOptions {
  parseMode: ParseMode;
  maxMessageChars: number;
  intervalMs: number;
  /** 表头那两格。缺省时退化成「外部 agent」并省掉目录 —— 少一格标题不值得让整张卡片发不出来。 */
  agent?: string | undefined;
  dir?: string | undefined;
  /** `agent_thought_chunk` 那一行的开关，默认开（见下面 `#lines` 里那条注释）。 */
  thoughts?: boolean | undefined;
}

export interface AcpCardHooks {
  onDelivery?(event: TelegramDeliveryEvent): void;
  onDeliveryError?(error: unknown): void;
  onParseFallback?(info: ParseFallbackInfo): void;
}

/**
 * 卡片的字符预算：`min(maxMessageChars, 3500)`。上限是 Telegram 的 4096，而**超长不是解析失败**
 * —— `sendWithFallback` 兜不住它，Telegram 直接 `message is too long`。3500 这个数比
 * `maxMessageChars` 的默认 3900 更紧：卡片是**一条消息一趟到底**，它没有「装不下就再发一条」这条
 * 退路，宁可留厚一点余量。
 */
const CARD_MAX_CHARS = 3500;
/**
 * 即时刷新（plan 被替换 / 某个 tool_call 变 failed）之间的地板。
 *
 * 私聊的真实预算是 **~60 次/分钟、串行一秒一拍**（`docs/08 §5.2` 最后那颗：`chat_id < 0` 才走
 * `group` 桶，私聊走只有 `{minTime: 1000}` 的 `out` 桶，**没有 per-minute reservoir**），而卡片按
 * `intervalMs=5000` 只占 ~12/分钟。但即时刷新绕过间隔：一个 200 次工具调用全失败的 agent 会把它
 * 变成 200 次编辑。两个关键事件隔不到 2 秒时，第二次晚 3 秒显示没有任何损失 —— 前一帧已经告诉
 * 用户「有东西变了」。加上这道地板，最坏 30/分钟，仍在私聊预算的一半以内。
 */
const IMMEDIATE_MIN_GAP_MS = 2000;
/** `close()` 等在途那一帧落地的上界。它挂在调用方的 `finally` 上，不能没有底。 */
const CLOSE_WAIT_MS = 5000;
/**
 * 取消按钮走的是 **`bot.ts` 那条既有的 `c:<turnId>` 通道**（`docs/08 §6` 的取消按钮，那里已经判过
 * 「点的人是发起人或 owner」），不是一种新的 callback 种类 —— 所以适配层这边只有「挂不挂这副键盘」
 * 一个决定，`callback_query:data` 的处理器一个字都不用改。
 *
 * 64 字节是 Bot API 给 `callback_data` 的硬上界（同 `docs/05 §6.1` 里 `a:` 那套的算术）。
 * `c:` + ULID(26) = 28，这道闸只在 turnId 不是 ULID 时才够得着；而它一旦超界，Telegram 拒的是整条
 * `sendMessage` —— 屏幕上连卡片都没有。宁可不挂按钮。
 */
const CANCEL_PREFIX = "c:";
const CALLBACK_DATA_MAX = 64;
const CANCEL_LABEL = "⛔ 取消";
const TITLE_MAX = 72;
const PLAN_INLINE_MAX = 24;
const PATH_MAX = 52;
const DIR_MAX = 40;
/** 思考行与正文尾行各自的显示长度，以及它们各自那个**有界滚动窗口**的长度。 */
const THOUGHT_MAX = 120;
const THOUGHT_BUFFER_MAX = 240;
const TAIL_MAX = 120;
const TAIL_BUFFER_MAX = 400;
/**
 * 卡片自己那几张表的上界。喂它的是我们不信任其输出量的子进程（实测 86 秒的任务 263 条 update），
 * 而 `maxUpdatesPerPrompt` 是**每次 prompt** 的上界 —— 一张按 toolCallId 长的表不该跟着它长。
 * 撞上界之后只停止**跟踪明细**，计数照旧准（`#toolCalls` / `#paths`）。
 */
const MAX_TRACKED_TOOLS = 256;
const MAX_TRACKED_FILES = 64;
/** 只参与计数的那张路径表的上界。比明细宽得多（计数只要「有几个」），但仍然有界 ——
 *  路径长度不受我们控制，一份无界的 Set 挂在一次 run 上就是一条内存泄漏。 */
const MAX_COUNTED_FILES = 512;
const MAX_PLAN_ENTRIES = 40;
/**
 * 行级计数的输入上界与编辑距离上界。`diffLines` 是 O(n·d)，而 `push()` 跑在收 `session/update`
 * 的那条路上：一次 200 个工具调用的 run 里，每条 diff 都对一份上万行的文件全量比一遍，等于把
 * 事件循环按在 CPU 上。超界就**只显示路径不显示行数** —— 卡片要回答的是「动了哪些文件」，
 * 行数是附赠品。
 */
const MAX_DIFF_CHARS = 131_072;
const MAX_DIFF_EDIT = 4000;
const PLAN_DONE_LINES = 2;
const PLAN_ACTIVE_LINES = 2;
const PLAN_PENDING_INLINE = 2;
const FILE_LINES = 3;

/** 计数行用的短标签（`读 9 · 改 6 · 跑 5 · 搜 3`），顺序即显示顺序。 */
const KIND_LABEL: Record<ToolKind, string> = {
  read: "读",
  edit: "改",
  execute: "跑",
  search: "搜",
  fetch: "取",
  delete: "删",
  move: "移",
  think: "想",
  switch_mode: "换档",
  other: "其他",
};
const KIND_ORDER = Object.keys(KIND_LABEL) as ToolKind[];
/** `现在` 那一行的图标。标题本来就是一句人读的话，前面配图标比再塞一个中文标签更好读。 */
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
  max_turn_requests: "撞上请求数上限",
  refusal: "上游拒答",
  cancelled: "已取消",
};
/** core 侧的 `AcpErrorCode` 里会走到终帧的那几个。名单外的原样显示 —— 编一个中文说法比露出码更糟。 */
const ERROR_LABEL: Record<string, string> = {
  acp_cancelled: "已取消",
  acp_timeout: "超时中止",
  acp_cost_exceeded: "超预算中止",
  acp_connection_lost: "连接断开",
  acp_prompt_failed: "agent 报错",
};

/**
 * 整段丢弃的优先级（`docs/08 §6.1`）。前四档是定死的那四段，其后几档只有在 `maxMessageChars` 被
 * 调到荒唐的小值时才够得着。**表头、失败行、三个计数行永不进这张表** —— 失败才是这一趟花了十五
 * 分钟的原因，只显示「当前」会把它冲掉。
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

/** `key` 是这一行进「与上帧逐字节相同」判据时的形态，缺省即 `text`。只有表头用它：那一行带着
 *  一个每秒都在变的计时器，把它算进判据等于让「相同就不发」永不成立，而**表头里的模式与目录
 *  仍要参与** —— 一次 `current_mode_update` 是真的变化，不该被计时器连坐着一起排除。 */
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
 * 任何要进卡片的外部文本都先过这里。**换行必须折掉** —— 卡片是「一项一行」的版式，一个带换行的
 * 工具标题会把后面所有行的语义错位；控制字符同理（NUL 在 Telegram 正文里没有任何显示意义）。
 */
function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 单个字段的省略。**这不是「切半行」** —— `docs/02 §9` 红线 11 说的是不透明单元不许截半，而一条
 * 带显式 `…` 的标题是完整的显示单元；真正不许出现的是「一行只渲染了一半就没了」，那由整段丢弃
 * 和最后那道按行的兜底来保证。
 */
function clip(text: string, max: number): string {
  const points = [...oneLine(text)];
  return points.length <= max
    ? points.join("")
    : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/**
 * 路径按**尾部**收：`…/tools/builtins.ts` 认得出是哪个文件，`/home/swim/code/Luo…` 认不出。
 * 一段 4000 字的路径因此照样只占一行 —— 那是外部 agent 递过来的字段，长度不受我们控制。
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
  // 连最后一段自己都超长（单个文件名几千字符）：那一段按尾部硬收，前面补 `…`。
  if (!kept.length) return `…${[...clean].slice(-(max - 1)).join("")}`;
  return `…/${kept.join("/")}`;
}

/** `unref` 过的 sleep：`close()` 那个上界不该成为「进程退不出去」的新理由。 */
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

/** 有界滚动窗口：只留尾部。思考与正文都只显示「最近说到哪了」，留头没有意义。 */
function rollingTail(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(-max).join("");
}

/**
 * 名单里查不到就原样显示（见 `ERROR_LABEL`）。**用 `Object.hasOwn` 而不是直接索引**：`stopReason`
 * 是外部 agent 从 JSON-RPC 递过来的字符串，`STOP_LABEL['toString']` 顺着原型链拿到的是一个函数，
 * 插进模板就是一整段函数源码躺在卡片上。
 */
function label(table: Record<string, string>, key: string): string {
  return Object.hasOwn(table, key) ? table[key]! : clip(key, TITLE_MAX);
}

/** 同一个道理：`'constructor' in KIND_LABEL` 为真，于是 `KIND_LABEL[kind]` 是 `undefined`，
 *  卡片上出现一个字面的 `undefined`。 */
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
 * `Diff{path, oldText, newText}` → `+A −B`。**patch 全文一个字节都不进消息**，两条硬理由：
 * ① Telegram 的 4096 上限，一份真实 diff 一条就顶满；② 终帧那份文本要被归档、下一轮进模型上下文
 * —— 让外部 agent 生成的 diff 原文走这条路，等于给注入开一条不经 `untrusted()` 的门。
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
  /** 工作目录的原样形态（`#dir` 是给表头看的、可能已经省略过的那份）。用途见 `#short`。 */
  readonly #root: string;
  readonly #budget: number;
  readonly #interval: number;
  /** 整趟 run 不变的那副键盘，`undefined` = 这张卡片没有取消按钮（见 `AcpCardTarget.turnId`）。 */
  readonly #cancel: InlineKeyboardMarkup | undefined;
  #mode: string | null = null;
  #plan: Array<{ content: string; status: PlanEntryStatus }> = [];
  #planId: string | null = null;
  readonly #tools = new Map<string, TrackedTool>();
  #toolCalls = 0;
  readonly #kinds = new Map<ToolKind, number>();
  /** 当前在跑的那个工具。用显式的一对而不是每帧扫 `#tools`：撞上 `MAX_TRACKED_TOOLS` 之后
   *  那张表就不再收人了，而「现在在干什么」不该跟着一起消失。 */
  #current: TrackedTool | null = null;
  #currentId: string | null = null;
  #failures = 0;
  #lastFailure: string | null = null;
  readonly #files = new Map<string, TouchedFile>();
  /** 只为**计数**存路径：`#files` 那张表撞上 `MAX_TRACKED_FILES` 之后就不再收人，而
   *  「改动 N 个文件」不该跟着停。用 Set 而不是一个溢出计数器 —— 后者按 `#touch` 的次数加，
   *  同一个文件被改十次就报十个文件（一个 200 次工具调用的 run 能把它虚报成三位数）。 */
  readonly #paths = new Set<string>();
  #tail = "";
  #thought = "";
  #thoughtId: string | null = null;
  #costUsd: number | null = null;
  #dirty = false;
  #lastEditAt = 0;
  #messageId: number | null = null;
  /** 上一帧的正文，**表头里那个计时器除外**（见 `Line.key`）：时钟走了一秒不是新信息，
   *  把它算进判据等于让「逐字节相同就不发」永不成立。 */
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
    // 间隔有下限：私聊那个桶本来就是 `{minTime: 1000}` 一秒一拍，配得比它更小只会让编辑在
    // 节流器里排队 —— 而排在队里的编辑占的正是下一帧要用的槽位（`docs/08 §5.2` 的队尾饿死）。
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
   * 路径进卡片前的收窄。**先去掉工作目录前缀**：目录已经在表头上，每一行再重复一遍
   * `/home/swim/code/LuoLiCore/` 只是把本来就紧的预算花在同一段字上，而「动了哪些文件」要的是
   * `packages/telegram/src/tools.ts` 那一截。目录外的路径（agent 越界读了别处）原样保留 ——
   * 那恰恰是最该看清的一种。
   */
  #short(path: string): string {
    const clean = oneLine(path);
    return shortPath(
      this.#root && clean.startsWith(`${this.#root}/`)
        ? clean.slice(this.#root.length + 1)
        : clean,
    );
  }

  /** 观测不许打断投递（同 `TelegramOutput.#emit`）：`LogSink.event` 保证不抛，但契约上不该赌它。 */
  #emit(event: TelegramDeliveryEvent): void {
    try {
      this.hooks.onDelivery?.(event);
    } catch {
      /* 记不上日志也不能让这张卡片停下来 */
    }
  }

  /** 首帧：卡片必须在 ACP 真的开跑之前就出现在屏幕上，「几分钟看不见任何进度」是这整块的由来。 */
  async start(): Promise<void> {
    this.#dirty = true;
    // 首帧发不出去也要把卡片交出去（`messageId` 为 `null`，下一帧重试发送）：一次投递失败
    // 不该把整趟 ACP 拦在门外。`#flushNow` 自己吞投递错误，这一层兜的是渲染路径上的意外。
    try {
      await this.#flushNow(null);
    } catch {
      /* 首帧没渲染出来，下一帧还有机会 */
    }
    // 只在 dirty 时真的发（判据与 `push` 那条完全一样），所以它不额外占预算；有它才能保证
    // **最后一条 update 一定被渲染出来** —— 一个 3 分钟不吭声的 `execute` 之前那次 flush 可能
    // 才过了半秒，没有心跳的话屏幕上永远停在上一个工具。
    this.#heartbeat = setInterval(() => {
      this.#schedule(false);
    }, this.#interval);
    this.#heartbeat.unref?.();
  }

  push(notification: unknown): void {
    try {
      if (this.#closed) return;
      const immediate = this.#absorb(notification);
      // 「任何 update → dirty」。`agent_message_chunk` 于是也置位，而它**事实上不驱动刷新**：
      // 正文尾只在没有 in_progress 工具时才显示，有工具在跑时这一帧渲染结果与上帧逐字节相同，
      // 被下面那道判据直接吃掉。用「相同就不发」实现规则 6，比给 chunk 开一个特例更少一处分支。
      this.#dirty = true;
      this.#schedule(immediate);
    } catch {
      /* 呈现层的任何异常都不许冒到收 `session/update` 那条路上去 */
    }
  }

  async close(final: AcpCardFinal): Promise<string> {
    if (this.#closed) return this.#plain;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    try {
      // 在途那一帧先落地，否则两次 `editMessageText` 可能倒序到达，终帧被上一帧盖回去。
      // **等待有上界**：在途那一帧可能正压在节流器队列里，而这个 await 挂在调用方的 `finally`
      // 上 —— 拖住它等于拖住整次工具调用的返回。超时就照发终帧，节流器是 FIFO，顺序仍然对。
      if (this.#inFlight)
        await Promise.race([
          this.#inFlight.catch(() => undefined),
          sleep(CLOSE_WAIT_MS),
        ]);
      this.#dirty = true;
      await this.#flushNow(final);
    } catch {
      /* 终帧渲染或投递失败也要把文本交回去：调用方在 `finally` 里等它 */
    }
    if (this.#editCount) {
      // 编辑是**一轮聚合成一条**（`docs/10 §2` 的 `tg.edit`）。`ok` 跟着有没有失败过走：全程
      // 挂掉的编辑否则一个字都不落 —— 逐次记是噪声，但「这张卡片其实一次都没更新上去」不是。
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
   * 时间窗 + 状态变化，两者都要。只用时间窗：plan 变了要等 5 秒才看得见。只用状态变化：
   * 200 次 tool_call = 200 次编辑，把私聊那 ~60/分钟 打光。三个即时例外见 `IMMEDIATE_MIN_GAP_MS`。
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
    // **键盘只挂在过程帧上，所以它进判据。** 终帧通常正文也变了（多一行 `✅ 完成` / `⛔ …`），但那是
    // 常态不是不变量：表头本身就长过预算时，`#frame` 最后那道按码点硬收的兜底会把每一帧都磨成表头
    // 的同一截（计时器与 verdict 都在截断点之后），于是「逐字节相同就不发」把终帧整个吃掉 ——
    // 那排按钮就永远留在一张已经结束的卡片上。「键盘从有到无」是一次真的变化，不许被正文吃掉。
    const markup = final === null ? this.#cancel : undefined;
    const key = `${markup ? CANCEL_PREFIX : ""}${frame.key}`;
    // 逐字节相同就不发，**不靠 Telegram 回 `message is not modified` 兜**：那一跳照样占掉一个
    // 槽位（还是排在真正要发的东西前面）。也不动 `#lastEditAt` —— 这一帧没花掉配额。
    if (this.#lastKey !== null && key === this.#lastKey) {
      this.#dirty = false;
      return;
    }
    this.#dirty = false;
    this.#lastKey = key;
    // 先记时刻再投递：投递失败也算用掉了一次尝试，不然一个持续失败的 chat 会被连着重试打光预算。
    this.#lastEditAt = Date.now();
    if (this.#messageId === null) {
      await this.#send(frame.rendered, final !== null, markup);
      return;
    }
    await this.#edit(this.#messageId, frame.rendered, markup);
  }

  /** 投递失败 ≠ ACP 运行失败（`R-TG-02` 那条的同一道理）：吞掉、记一行、卡片继续。 */
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
    // 首帧这一条按 chat 串行（同另外三条出站路径，`L-TG-02`）：卡片不能挤进别的消息那批分段中间。
    // **编辑一律在锁外** —— 盖上去会让整个 ACP 运行期间这个 chat 的投递变成实质串行。
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
    else this.#lastKey = null; // 没发出去 ⇒ 屏幕上什么都没有，下一帧不该被「与上帧相同」拦掉
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
    // **`reply_markup` 每一帧都要重给**：Bot API 把「不带这个字段的 `editMessageText`」当成撤键盘
    // （同 `TelegramPromptChannel.settle` 那一跳），所以省略它正是终帧要的语义 —— 反过来，过程帧
    // 忘了带就等于按钮在第一次编辑之后自己消失了。撤键盘与改正文因此是同一次调用，不额外占槽位。
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
        // 与 `sendWithFallback` 同一跳、同一条 warn：格式丢掉，卡片还在。降级发的是 `toPlainText`
        // 而不是渲染结果原文 —— 后者在 MarkdownV2 下是满屏 `\-`。
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
          /* 二次失败照旧只记不抛 */
        }
      }
      this.#editError = description;
      this.hooks.onDeliveryError?.(error);
    } finally {
      this.#editMs += Date.now() - at;
    }
  }

  /**
   * 渲染一帧。**超预算按固定优先级整段丢，绝不切半行** —— `docs/02 §9` 红线 11「不透明单元要么
   * 原样保留要么整体换占位」搬到 UI 上。
   *
   * 判据量的是**渲染之后**的长度：转义会让长度接近翻倍，按正文量就会超上限，而超长是 Telegram
   * 硬拒（`sendWithFallback` 只兜得住解析失败）。
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
      // key 用**渲染前**的正文：`#render` 是逐字符的纯函数，比它和比渲染结果是同一个判据。
      const key = kept.map((line) => line.key ?? line.text).join("\n");
      if ([...rendered].length <= this.#budget) return { plain, rendered, key };
      if (step < DROP_LADDER.length) {
        dropped.add(DROP_LADDER[step]!);
        continue;
      }
      // 整张梯子丢完还超（只可能是 `maxMessageChars` 被调到荒唐的小值）：按码点硬收正文。
      // **这一步不会切坏转义** —— 两档转义都是逐字符映射，正文里没有跨字符的构造。
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
   * 卡片正文**整体按纯文本转义**，不走 `safeRender` 那棵 Markdown AST。
   *
   * 理由：卡片里每一个变量都是外部 agent 递过来的字符串（工具标题、路径、思考、正文尾）。
   * 交给 Markdown 解析器的话，一个标题里的 ``` 就能开一段围栏把整张卡片吞进去 —— 输出仍然是
   * 合法的 MarkdownV2（`safeRender` 保证这一点），但卡片会变成一团代码块。逐字符转义换来的是
   * 「一个字符都不会被当成标记」，代价只是卡片里没有粗体，而它本来也不需要。
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
      // 已完成只留最近两条：剩下的由 `3/7` 那个计数代表。已完成的项是「已经不用管了」的那些。
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
        text: `现在 · ${KIND_ICON[this.#current.kind]} ${clip(title, TITLE_MAX)}${path}`,
      });
    } else {
      /**
       * 空闲时才显示这两行。思考行**只在过程帧显示**：终帧那份文本要进归档与下一轮上下文，
       * 而思考链是 agent 的内心戏（`docs/02` 对不透明 part 的同一条口径）—— 显示给人看可以，
       * 钉进历史不行。它也是唯一能让「一个想了 90 秒还没出 plan 的 agent」看起来不是冻住的东西。
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
    // 失败是粘性的：一旦有过就在**每一帧**里留着，且永不进丢弃梯。
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
      lines.push({ text: `工具 ${toolCalls} 次` });
      if (breakdown.length)
        lines.push({ group: "toolKinds", text: `  ${breakdown.join(" · ")}` });
    }
    // 一条 update 都还没来：屏幕上必须有东西，这张卡片的存在本身就是「已经开跑了」这个信息。
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
    // 取消与超时**一定要留终帧**（`docs/00 §「收尾那一条消息还是要发出去」`）：屏幕上停着一张
    // 「现在 · 编辑 …」的卡片而进程已经没了，用户没有任何办法知道它是死了还是还在跑。
    if (final.error)
      return `⛔ ${label(ERROR_LABEL, final.error)} · 已改动 ${files} 个文件${cost}`;
    const stop = final.stopReason ?? "end_turn";
    if (stop === "end_turn") return `✅ 完成${cost}`;
    return `⚠ ${label(STOP_LABEL, stop)}${cost}`;
  }

  /** 交回「这条 update 值不值一次绕过间隔的即时刷新」。**只有 plan 被替换与 tool_call 变 failed。** */
  #absorb(notification: unknown): boolean {
    const update = (notification as SessionNotification | null | undefined)
      ?.update;
    if (!update || typeof update !== "object") return false;
    switch (update.sessionUpdate) {
      case "plan":
        return this.#setPlan(update.entries, null);
      // `plan_update` 在 SDK 里还标着 UNSTABLE，但不接的代价是「agent 用的是新那套 ⇒ 卡片上一个
      // 计划都没有」。只认 `items` 那一档（`file` / `markdown` 是要我们去读文件或渲染 markdown，
      // 两者都不该在卡片这一层做）；多个 planId 时后来的赢 —— 一张卡片只显示一份计划。
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
        // 建表时一律记 `pending`，真实状态交给 `#applyStatus` 去「换」—— 它按 `was !== 'failed'`
        // 判要不要计一次失败，直接把 `failed` 写进初值的话，一条**一上来就是 failed** 的
        // `tool_call`（ACP 允许）会被当成「已经报过了」，那次失败一次都不计。
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
        // 更新只带变化的字段：没跟踪到（撞了上界 / 没见过 `tool_call`）时用它自己带的那些兜。
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
        // 「永不累积」= 不无界增长、不进归档。但 chunk 是按 token 来的，一条常常只有两三个字
        // —— 每条都整段替换的话，屏幕上显示的是一个毫无意义的碎片。所以是**有界滚动窗口**，
        // 并按 `messageId` 换一段思考就清空（ACP 明文：messageId 变了就是新一条消息）。
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
        // `cost.amount` 是**累计值**，所以取见过的最大值而不是求和（同 `AcpUpdateSink`）。
        const amount = update.cost?.amount;
        if (typeof amount === "number")
          this.#costUsd = Math.max(this.#costUsd ?? 0, amount);
        return false;
      }
      case "current_mode_update": {
        // 模式进表头：一次 plan 档的 run 一个文件都不会改，不显示它的话那张「改动 0 个文件」
        // 的卡片看起来像 agent 什么都没干。
        this.#mode =
          typeof update.currentModeId === "string"
            ? clip(update.currentModeId, 16)
            : null;
        return false;
      }
      // `session_info_update`（agent 自己给会话起的标题）与 `available_commands_update`
      // （它支持哪些 slash 命令）对「它现在在干什么」没有信息量，收下但不显示。
      default:
        return false;
    }
  }

  #setPlan(entries: unknown, planId: string | null): boolean {
    if (!Array.isArray(entries)) return false;
    // **plan 整体替换**，不合并：ACP 的语义就是「每次带全量」，合并会在 agent 改主意时留下幽灵条目。
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
    // 「动了哪些文件」不能只靠 diff 块：diff 是可选的。所以 edit / delete / move 收尾时把
    // `locations[0]` 也记上 —— 但只在**收尾**记，不在创建时记：一个失败的 edit 没有改过任何东西。
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
    // 同一个 id 反复报 failed 只算一次；没跟踪到的（撞了上界）按每条算 —— 宁可多记一次失败，
    // 也不要把「它一直在失败」这件事漏掉。
    if (was === "failed") return false;
    this.#failures += 1;
    this.#lastFailure = tool.title || KIND_LABEL[tool.kind];
    return true;
  }

  #absorbContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as ToolCallContent[]) {
      // `content`（文本 / 图片）与 `terminal`（终端输出）一律不进卡片：都是成块的内容，
      // 而卡片的预算是一条消息。工具在干什么由 `title` 说，那是一句人读的话。
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
      // 同一个文件被改多次时**累加每次的行数**，不是「最终 vs 最初」的 git diff：后者要留住每个
      // 文件的原始全文，等于把整个工作副本挂在一条卡片上。
      stat.added += counted.added;
      stat.removed += counted.removed;
      stat.counted = true;
    }
  }

  #touch(path: string, mark: string): TouchedFile | null {
    if (this.#paths.size < MAX_COUNTED_FILES) this.#paths.add(path);
    const existing = this.#files.get(path);
    // `+`（新建）一旦定了就粘住：一个新文件后面被改十次仍然是新文件。别的标记后来的赢
    // —— 先改后删时该显示的是删掉了。
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
 * 开一张卡片。**首帧在这里就发出去**（await 掉）：调用方拿到卡片时屏幕上已经有东西了，而
 * 「起一次外部 agent，几分钟看不见任何进度」正是这一整块要修的事。
 *
 * 首帧发不出去也照样交回卡片（`messageId` 为 `null`）：下一帧会重试发送，而不是把整趟 ACP
 * 卡在一次投递失败上。
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
