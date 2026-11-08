// 洛璃服务对外的数据类型：接口的返回、请求体、SSE 的事件。网页面板 import type 这个文件。
// 这里只引用纯类型的模块（core 的消息类型，它只引用 ai 的类型），网页的 tsconfig 也能检查：
// 不要在这里引用带 Node 类型或服务端代码的模块

import type { Message } from '../core/message.js';

/** 洛璃服务此刻的状态：SSE 的 hello 与 GET /api/health 都用它 */
export type ServiceStatus = {
  /** 服务启动的时间，ISO */
  startedAt: string;
  /** 服务启动了多少秒 */
  uptimeSeconds: number;
  telegram: {
    /** 设了 token、启动了 Telegram 前端 */
    enabled: boolean;
    /** 连得上 Telegram（最近一次拉取更新成功）；没启动时为 false */
    connected: boolean;
  };
};

// ─── 会话 ───────────────────────────────────────────────────────────────

/**
 * 会话的种类，由服务按平台推出来：Telegram 的群（平台会话 id 是负数）、Telegram 的私聊、
 * CLI、网页。other：不认识的平台（现在没有）
 */
export type ConversationKind = 'group' | 'private' | 'cli' | 'web' | 'other';

/**
 * 会话列表里的一行。GET /api/conversations 返回全部，SSE 的 conversation 事件推一行。
 * 列表按 lastAt 倒序
 */
export type ConversationRow = {
  id: string;
  /** 'telegram' | 'cli' | 'web' */
  platform: string;
  kind: ConversationKind;
  /** 群名；私聊为「与 某人 的私聊」；CLI 会话没有标题 */
  title?: string;
  /** 平台里的会话 id（Telegram 的 chat id）；CLI、网页没有 */
  platformConversationId?: string;
  /** 会话建立的时间，ISO */
  createdAt: string;
  /** 最后一条消息的时间；没有消息时为 createdAt。列表按它倒序排 */
  lastAt: string;
  /** 最后一条消息（按序号）的预览；没有消息时没有 */
  last?: MessagePreview;
  /** 消息条数（全屏头部「N 条消息」） */
  messages: number;
  /** 段数（「M 段」）。变了说明切了新段，要显示段的分隔线就重新取 GET /api/conversations/:id */
  segments: number;
  /**
   * 未读数：已读位置之后、用户发的消息条数，只算 Telegram 的群和私聊（别人发的）；
   * 洛璃的回复、CLI、网页会话都是 0
   */
  unread: number;
  /**
   * 已读位置：看到了第几条（序号）；没看过时为 0。第一条未读是序号大于它的第一条用户消息。
   * 打开会话时要取到第一条未读：取 limit = 最后一条的序号 − readSeq + 1 条（至少 200，至多 1000）
   * 一定包含它
   */
  readSeq: number;
};

/** 一条消息的预览 */
export type MessagePreview = {
  seq: number;
  /** 消息的时间，ISO */
  createdAt: string;
  role: 'user' | 'assistant';
  /** 用户消息的发言人显示名；助手的消息没有（显示「洛璃」） */
  author?: string;
  /** 正文开头的一截（空白合成一个空格，最多 80 个字符）；只有图片时为「[图片]」；都没有时为空 */
  text: string;
};

/** 会话里的一段 */
export type ApiSegment = {
  /** 本段从这个序号的消息开始：分隔线画在这条消息前面 */
  startSeq: number;
  /** first：会话开始；idle：空闲太久后开始新的一段；compress：上下文太长，压缩后开始新的一段 */
  startReason: 'first' | 'idle' | 'compress';
  /** 本段开始时的会话标题 */
  conversationTitle?: string;
  /** 本段开始之前全部内容的滚动摘要；第一段没有 */
  priorSummary?: string;
  /** 这一段开始的时间，ISO */
  createdAt: string;
};

/** GET /api/conversations 的返回 */
export type ConversationsResponse = { conversations: ConversationRow[] };

/** GET /api/conversations/:id 的返回：列表里的那一行，加上全部段（按 startSeq 升序） */
export type ConversationResponse = { conversation: ConversationRow; segments: ApiSegment[] };

// ─── 消息 ───────────────────────────────────────────────────────────────

/**
 * 接口里的一条消息：整条 UI 消息（与存在核心里的相同），只有工具结果的文字太长时截短。
 * GET /api/conversations/:id/messages 返回一批，SSE 的 message 事件推一条
 */
export type ApiMessage = {
  /** 会话内的顺序 */
  seq: number;
  id: string;
  role: 'user' | 'assistant';
  /** 消息的时间，ISO：用户消息是平台上的发送时间 */
  createdAt: string;
  /**
   * 整条 UI 消息（parts 与 metadata，与 ai 的 UIMessage 同一种结构）。parts 里可能有：
   * - text；reasoning（思考）；file（图片，url 是 luoli-file: 地址，宽高见 images）；
   * - 工具调用：type 是 `tool-<工具名>`，有 toolCallId、state、input，
   *   output-available 时有 output，output-error 时有 errorText；
   * - step-start 等其他段，不认识的不显示即可。
   * 工具的 output：字符串；或能转成 JSON 的值；或带图片的结果
   * `{ type: 'luoli-content', parts: [{ type: 'text', text }, { type: 'image', url, mediaType, width?, height?, bytes }] }`。
   * 结果的文字超过 2000 个字符时截成开头 2000 个字符（不是字符串的值截成 JSON 文字的开头，
   * 变成字符串；带图片的结果只截文字，图片照留），errorText 同样。截没截、原来多长见 tools
   */
  message: Message;
  /** 每个有结果的工具调用：toolCallId → 结果的长度 */
  tools: Record<string, ToolResultInfo>;
  /**
   * 消息里的图片（file 段，以及工具结果里的图片）：luoli-file: 地址 → 图片信息；
   * 文件已经不在了为 null（显示「图片已丢失」）
   */
  images: Record<string, ImageInfo | null>;
};

export type ToolResultInfo = {
  /**
   * 结果文字原来的总长度（字符串原样，其他值转成 JSON；带图片的只算文字）；
   * 出错时是错误说明的长度
   */
  chars: number;
  /** 接口里截短了 */
  truncated: boolean;
};

export type ImageInfo = {
  /** 取图片的地址：/api/files/<文件名> */
  src: string;
  /** 宽高（像素），读不出时没有 */
  width?: number;
  height?: number;
};

/**
 * GET /api/conversations/:id/messages 的返回。查询参数：
 * - before：只取序号小于它的（往前翻时传当前最早一条的序号）；不传时从最新的取；
 * - limit：最多几条，默认 200，最多 1000。
 */
export type MessagesResponse = {
  /** 按序号升序 */
  messages: ApiMessage[];
  /** 这批之前还有更早的消息；false 时到了会话开头 */
  hasMore: boolean;
};

/**
 * POST /api/conversations/:id/read 的请求体：已经看到了第几条（序号），一般是最后一条的序号。
 * 已读位置只往前走：比现在的小时不变；比最后一条大时按最后一条算。
 * 返回更新后的那一行（ConversationRow），同时推给所有连着的面板
 */
export type MarkReadRequest = { seq: number };

// ─── 今日概况 ───────────────────────────────────────────────────────────

/**
 * 今日概况：服务器所在时区今天 0 点以来开始的模型调用。GET /api/today 返回，
 * 有模型调用写入时 SSE 的 today 事件推新的一份
 */
export type TodaySummary = {
  /** 「今天」是哪一天（服务器时区），YYYY-MM-DD。日期变了（过了 0 点）要重新取 */
  date: string;
  /** 服务器的时区，如 Asia/Singapore */
  timeZone: string;
  /** 今天 0 点，ISO（UTC） */
  since: string;
  /** 回复数：用途为回复、正常完成的 */
  replies: number;
  /** 失败的回复数 */
  failedReplies: number;
  /** 以下三项：全部模型调用（回复与摘要，不论结果）之和 */
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** 各会话今天的回复数（口径同 replies），多的在前；没有回复的会话不列 */
  conversations: Array<{ id: string; title?: string; replies: number }>;
};

// ─── SSE ────────────────────────────────────────────────────────────────

/** SSE 的 message 事件 */
export type MessageEvent = {
  conversationId: string;
  message: ApiMessage;
  /** true：已有的消息被编辑（就地更新）；false：新写入的消息（按序号插入） */
  edited: boolean;
};

/**
 * 经 SSE（GET /api/events）推给面板的事件：事件名 → data 的类型。
 * 每个事件是一条 `event: 名字` 加一行 `data: JSON`；面板不认识的事件名直接忽略，
 * 以后加事件只在这里加一项，旧的不改。
 */
export type ServerEvents = {
  /**
   * 连上时的第一个事件：服务此刻的状态。之后的事件都是增量；连上（含重连）后自己取一次
   * 会话列表与今日概况
   */
  hello: ServiceStatus;
  /** 会话列表里的一行变了：新建、改名、切段、来了新消息、消息被编辑、未读数变了。整行替换 */
  conversation: ConversationRow;
  /** 一条消息写入或被编辑；之后紧跟着这个会话的 conversation 事件 */
  message: MessageEvent;
  /** 有模型调用写入（回复或摘要结束）：新的今日概况 */
  today: TodaySummary;
};

/** 接口出错时的返回（400、403、404、415、500） */
export type ErrorResponse = { error: string };
