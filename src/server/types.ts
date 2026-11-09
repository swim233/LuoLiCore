// 洛璃服务对外的数据类型：接口的返回、请求体、SSE 的事件。网页面板 import type 这个文件。
// 这里只引用纯类型的模块（core 的消息类型，它只引用 ai 的类型），网页的 tsconfig 也能检查：
// 不要在这里引用带 Node 类型或服务端代码的模块

import type { InferUIMessageChunk, UIMessage } from 'ai';
import type { Message, MessageData, MessageMetadata, Usage } from '../core/message.js';

/**
 * 洛璃服务此刻的状态：GET /api/health 返回它，SSE 的 hello 带着它（另加现场），
 * Telegram 连上、断开或拿到 bot 的用户名时推 status 事件
 */
export type ServiceStatus = {
  /** 服务启动的时间，ISO */
  startedAt: string;
  /** 服务启动了多少秒 */
  uptimeSeconds: number;
  telegram: {
    /** 设了 token、启动了 Telegram 前端。false 时面板显示「空闲」，弹出框写「Telegram 服务未启动」 */
    enabled: boolean;
    /** 连得上 Telegram（最近一次拉取更新成功）；没启动时为 false。启动了但为 false 时显示「离线」 */
    connected: boolean;
    /**
     * 最近一次确认连得上 Telegram 的时间（最近一次拉取更新成功），ISO：离线时显示「上次在线 HH:MM」。
     * 这次启动后还没连上过时没有。连着的时候它不随时更新，只在连接状态变了时准确
     */
    lastOnlineAt?: string;
  };
  /** 助手：面板上显示的名字，以及消息里提到她时要高亮的几样 */
  assistant: {
    /** 显示名：LUOLI_NAME，默认「洛璃」。只用于面板显示，与人设、发给模型的内容无关 */
    name: string;
    /** 唤醒词（LUOLI_WAKE_WORDS，不分大小写）；没启动 Telegram 时为空数组 */
    wakeWords: string[];
    /** bot 在 Telegram 里的用户名，不带 @；没启动 Telegram、还没拿到（没连上过）时没有 */
    username?: string;
  };
  /**
   * 网页会话：面板的「对话」里自己发的消息显示的名字（还没写进历史的那条用它；写进历史的消息各自存着发言人，
   * 显示那个）。LUOLI_WEB_NAME（去掉首尾空白，空的按没设），默认系统用户名；和发给模型的发言人名字是同一个
   */
  web: {
    author: string;
  };
  /** 上次回复：最近一次正常完成的回复（口径同今日概况的回复数）；还没有过时没有 */
  lastReply?: LastReply;
};

/** 最近一次正常完成的回复 */
export type LastReply = {
  conversationId: string;
  /** 回复结束的时间，ISO */
  at: string;
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
  /**
   * 群名；私聊为「与 某人 的私聊」；网页会话为发出第一句时取的标题（存在 web.db，只给面板显示，
   * 不进 prompt）；CLI 会话没有标题
   */
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
   * 变成字符串；带图片的结果只截文字，图片照留），errorText 同样。截没截、原来多长见 tools。
   * 助手消息的 metadata 里：reasoningMs 是每段思考用了多少毫秒（按 reasoning 段的顺序一一对应，
   * 中止时还在想的那段为 null；以前的消息没有，就不显示秒数）；aborted、failed、usage 等见 core
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
  /**
   * 给界面看的一句话（工具定义里的摘要，如 fetch 为「网址 · 页面标题」）；工具没写摘要、摘要出错时
   * 没有，界面显示工具名加参数的前一截
   */
  summary?: string;
  /** 用了多少毫秒，取自工具调用表；对不上时没有。参数不对、调了不存在的工具（没有执行）为 0 */
  durationMs?: number;
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

// ─── 此刻：进行中的回复 ─────────────────────────────────────────────────

/**
 * 一个进行中的回复此刻在做什么。等待合并（Telegram 被触发后先等一会儿，把接连发来的消息合在一起）；
 * 思考中（回复开始后、模型在想、工具结束后等下一步）；回复中（在输出文字）；调用工具；重试中
 */
export type LiveState = 'waiting' | 'thinking' | 'replying' | 'tool' | 'retry';

/**
 * 现场里的一个进行中的回复（含还在等待合并的）。每个会话同一时间最多一个，按 conversationId 认。
 * 回复结束（完成、出错、中止）或等待被放弃后从现场里去掉
 */
export type LiveReply = {
  conversationId: string;
  /**
   * 回复 id：核心 start 段的 messageId，回复写入历史后就是那条助手消息的 id。还在等待合并时没有；
   * 一开始就失败、没有 start 段的回复（如提示词文件有误）也没有
   */
  replyId?: string;
  state: LiveState;
  /** state 为 tool 时：最近开始、还没结束的那个工具的名字 */
  toolName?: string;
  /**
   * Telegram：被触发、进入等待合并的时间，ISO。网页、CLI 的回复没有；state 为 waiting 却没有它的，
   * 是上一次回复刚结束、Telegram 还在发最后几条时又被触发，等着「再回复一次」开始
   */
  waitingSince?: string;
  /** 回复开始的时间，ISO；还在等待合并时没有 */
  startedAt?: string;
  /** Telegram：回复中又被触发，这次发出后再回复一次。网页会话：生成中又发了消息（排队），同上 */
  again: boolean;
  /**
   * 网页会话：排队的消息从这个序号起（这次回复开始之后写入、还没被回复看到的），对话里显示
   * 「排队中」。补的那次回复开始（start）、排队被取消（dequeue）或这次回复结束（end，之后紧接着
   * 开始补的那次）时就不再排队。Telegram 没有
   */
  queuedFrom?: number;
  /** 已经推出去的内容，按出现的顺序；事件里的 part 就是这里的下标 */
  parts: LivePart[];
  /** 最近一次重试 */
  retry?: LiveRetry;
};

/** 回复里的一段：思考、文字、工具调用。step 是第几步（从 1 起，一步是向模型发一次请求） */
export type LivePart = LiveReasoning | LiveText | LiveTool;

export type LiveReasoning = {
  type: 'reasoning';
  step: number;
  /** 思考的内容（全量） */
  text: string;
  /** 开始、结束的时间（服务端），ISO：「思考了 N 秒」= endedAt − startedAt；还在想时没有 endedAt */
  startedAt: string;
  endedAt?: string;
};

export type LiveText = {
  type: 'text';
  step: number;
  /** 已经输出的文字（全量） */
  text: string;
};

export type LiveTool = {
  type: 'tool';
  step: number;
  /** 调用 id（toolCallId） */
  callId: string;
  /** 工具名 */
  name: string;
  /** 参数的前一截：JSON，最多 200 个字符，截了以「…」结尾 */
  input: string;
  /** 开始、结束的时间（服务端），ISO：耗时 = endedAt − startedAt；还在跑时没有 endedAt */
  startedAt: string;
  endedAt?: string;
  /** 结束后才有：true 成功；false 出错（含超时、被中止、参数不对、没有完成） */
  ok?: boolean;
  /** 出错时：错误的一句话（模型看到的错误说明的第一行，最多 200 个字符） */
  error?: string;
  /** 结果里的图片（取图片的地址与宽高）；没有图片时没有 */
  images?: ImageInfo[];
  /**
   * 给界面看的一句话（见 ToolResultInfo.summary）：开始时按参数给（还没有结果），结束时按参数
   * 和结果重新给；没写摘要的工具没有
   */
  summary?: string;
};

/** 一次重试（核心的 data-retry 段） */
export type LiveRetry = {
  /** request：请求失败后重发；stream：流中途出错后重新生成（之后紧跟一个 reset 事件） */
  phase: 'request' | 'stream';
  /** 第几次重试，共几次 */
  attempt: number;
  maxRetries: number;
  /** HTTP 状态码；网络错误、流中途出错时没有 */
  statusCode?: number;
  /** 什么时候，ISO */
  at: string;
};

/**
 * 现场：全部进行中的回复，以及它包含到了第几个 live 事件。hello 里带着，面板据此重建「此刻」，
 * 之后收到的 live 事件都是在它之后发生的（seq 从 seq + 1 起，一个不缺、不重）
 */
export type LiveSnapshot = {
  /** 现场已经包含的最后一个 live 事件的序号；还没有过时为 0 */
  seq: number;
  replies: LiveReply[];
};

/** 每个 live 事件都有的字段 */
type LiveBase = {
  /**
   * 序号：服务每推一个 live 事件加一（所有会话共用）。面板收到的序号总是接着 hello 里 live.seq 往下，
   * 比它小或相等的可以丢掉（不会出现）
   */
  seq: number;
  conversationId: string;
  /** 回复 id，知道时才有（见 LiveReply.replyId） */
  replyId?: string;
  /** 这件事发生的时间（服务端），ISO */
  at: string;
};

/** 回复还在进行的事件带上这次回复此刻的状态（这个事件之后的），与现场里的 state、toolName 相同 */
type LiveProgress = LiveBase & { state: LiveState; toolName?: string };

/**
 * 「此刻」的实时事件（SSE 的 live 事件），按 type 区分。同一个回复的事件按流里的顺序推；
 * 逐字的文字与思考攒约 50 毫秒合成一个事件，其余的马上推。part 是现场里 parts 的下标
 */
export type LiveEvent =
  /** Telegram 被触发，进入等待合并 */
  | (LiveProgress & { type: 'wait' })
  /**
   * Telegram 回复中又被触发，或网页会话生成中又发了消息（排队）：这次发出后再回复一次。
   * 回复刚结束、下一次还没开始时被触发，现场里新建一条等待中的。网页会话带 queuedFrom
   */
  | (LiveProgress & { type: 'again'; queuedFrom?: number })
  /** 网页会话排队的补回复被取消（发那条消息的请求断开了）：现场里那条的 again、queuedFrom 去掉 */
  | (LiveProgress & { type: 'dequeue' })
  /** 等待合并被放弃，不回复了（如服务退出），现场里去掉这个会话 */
  | (LiveBase & { type: 'cancel' })
  /**
   * 回复开始（at 即开始的时间）。之前在等待合并的，接着用同一条现场（waitingSince 照旧）。
   * again、queuedFrom 是这次回复开始时的「又被触发」与排队（开始之前就又被触发、排了队的接着算；
   * 上一次回复刚结束时又被触发的，这次就是「再回复一次」，不算），面板照它设。服务总会带上
   * again；没有时当作 false
   */
  | (LiveProgress & { type: 'start'; again?: boolean; queuedFrom?: number })
  /** 开始一段思考，在 parts 末尾新加一段（下标 part） */
  | (LiveProgress & { type: 'reasoning-start'; part: number; step: number })
  /** 思考的内容接上 text */
  | (LiveProgress & { type: 'reasoning-delta'; part: number; text: string })
  /** 这段思考结束（at 即结束的时间） */
  | (LiveProgress & { type: 'reasoning-end'; part: number; startedAt: string })
  /** 文字接上 text；part 等于 parts 的长度时在末尾新加一段文字 */
  | (LiveProgress & { type: 'text-delta'; part: number; step: number; text: string })
  /** 开始调用工具，在 parts 末尾新加一段（at 即开始的时间） */
  | (LiveProgress & {
      type: 'tool-start';
      part: number;
      step: number;
      callId: string;
      name: string;
      input: string;
      /** 给界面看的一句话（按参数，还没有结果）；没写摘要的工具没有 */
      summary?: string;
    })
  /** 工具调用结束（at 即结束的时间）。出错、超时、被中止都是 ok: false */
  | (LiveProgress & {
      type: 'tool-end';
      part: number;
      callId: string;
      startedAt: string;
      ok: boolean;
      error?: string;
      images?: ImageInfo[];
      /** 给界面看的一句话（按参数和结果）；没写摘要的工具没有 */
      summary?: string;
    })
  /** 要重试了 */
  | (LiveProgress & { type: 'retry'; retry: LiveRetry })
  /**
   * 流中途出错、重新生成：这一步已经推出的内容作废，parts 只留前 keep 段（即这一步之前的）。
   * 紧跟在 phase 为 stream 的 retry 之后
   */
  | (LiveProgress & { type: 'reset'; step: number; keep: number })
  /**
   * 回复结束（at 即结束的时间），现场里去掉这个会话。之前还开着的思考、工具调用，先各推一个
   * reasoning-end、tool-end（工具的 error 为「工具调用未完成」）
   */
  | (LiveBase & {
      type: 'end';
      /** completed：正常完成；failed：出错；aborted：被中止（含前端不读了、取消） */
      outcome: 'completed' | 'failed' | 'aborted';
      /** 回复开始的时间：用时 = at − startedAt */
      startedAt: string;
      /** 正常完成时：各步之和；服务端没报的项没有 */
      usage?: Usage;
      /**
       * 出错时：错误的一句话。能从错误里认出 HTTP 状态码时为「请求失败（429）」；认不出（超时、
       * 网络错误、服务端自己写的说明等）时为错误说明的第一行，最多 200 个字符，抹掉了 key
       */
      error?: string;
      /** 出错且认出了 HTTP 状态码（400～599）时才有 */
      statusCode?: number;
      /** 这次结束之后的「上次回复」：正常完成时就是这一次 */
      lastReply?: LastReply;
    });

// ─── 对话（网页会话）────────────────────────────────────────────────────

/**
 * POST /api/chat 的请求体：在网页会话里发一条消息，或重试。返回回复的 UI message stream
 * （`createUIMessageStreamResponse`，网页用 `useChat` 接），段的类型是 ChatChunk。
 * - 发消息：conversationId（新会话不带，服务新建并记下标题）、text、files（先用 POST /api/files
 *   上传得到的 luoli-file: 地址，最多 10 个）；text 与 files 至少有一样。消息马上写进历史，
 *   发言人是 LUOLI_WEB_NAME。
 *   - 这个会话空闲：开始回复，回复的流就在这个响应里。
 *   - 正在回复（或已有排队的）：消息排队。响应里先有 data-queued，然后等着；当前回复结束后补一次
 *     回复，看到期间所有新消息，补回复的流交给排队的最后一个请求。前面几个排队的请求不带回复，
 *     有下一条排进来时就正常结束。当前回复出错也照样补。
 * - 重试：{ conversationId, retry: true }，不带消息。会话正在回复或有排队时 409。只有上一次回复
 *   出错时才能重试：最后一条是出错的助手回复（metadata.failed），或者出错时一步都没写进历史、最后
 *   一条还是那条用户消息（服务这次运行期间记着；重启后、之后又有新消息时不算）。中止的回复、中止时
 *   取消了补回复留下的用户消息都 409。
 * - 请求断开（关页面、useChat 的 stop）：中止它的那次回复（半截写进历史，标记 aborted）；
 *   排队的请求断开时取消它的补回复。要同时中止当前回复并取消补回复，用 POST /api/chat/:id/abort。
 * 每个响应的第一段是 data-conversation（会话 id、这条消息的序号、新会话的标题）；响应头
 * X-Conversation-Id 也是会话 id。出错：400 参数不对或图片不在、404 会话不存在、409 见上、
 * 503 服务正在退出，都是 ErrorResponse
 */
export type ChatRequest =
  | { conversationId?: string; text?: string; files?: string[]; retry?: undefined }
  | { conversationId: string; retry: true };

/** 对话的流里服务自己加的数据段（都是 transient，不进消息）：核心的 retry，加上这两种 */
export type ChatData = MessageData & {
  /** 每个响应的第一段 */
  conversation: {
    conversationId: string;
    /** 发出的这条消息的序号；重试时没有 */
    seq?: number;
    /** 新建的会话：标题（前 16 个字，超出加「…」；只有图片时为「图片」） */
    title?: string;
  };
  /** 这条消息在排队：当前回复结束后补一次回复（补回复的流也会接在这个响应里，除非又有新的排进来） */
  queued: { fromSeq: number };
};

/** 对话的流里的消息与段（网页的 useChat 用这个类型） */
export type ChatMessage = UIMessage<MessageMetadata, ChatData>;
export type ChatChunk = InferUIMessageChunk<ChatMessage>;

/**
 * POST /api/chat/:id/abort：中止这个会话进行中的回复，同时取消排队的补回复（排队的消息留在历史里）。
 * 网页按 Esc、点中止都用它，另一个标签页也能中止。请求体用不到，但和别的 POST 一样要带
 * Content-Type: application/json（访问控制的要求，不带的 415），请求体写 {}
 */
export type AbortResponse = {
  /** 有进行中的回复或排队被取消了 */
  aborted: boolean;
};

/**
 * POST /api/files：上传一张图片。请求体就是图片的原始字节，Content-Type 是图片的类型
 * （image/png、image/jpeg、image/webp、image/gif，不收动图），这是「只收 JSON 请求体」的例外。
 * 每张不超过 20 MB（超过 413，不读完）；内容与声明的类型不符 400；类型不收 415。
 * 按内容存，同样的图片只存一份；上传了没发出去的不清理
 */
export type UploadResponse = {
  /** 文件存储里的地址，发消息时放进 files */
  url: string;
  mediaType: string;
  /** 取图片的地址：/api/files/<文件名> */
  src: string;
  bytes: number;
  /** 宽高（像素），读不出时没有 */
  width?: number;
  height?: number;
};

/** SSE 的 hello：服务此刻的状态，加上现场 */
export type Hello = ServiceStatus & { live: LiveSnapshot };

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
 * 读得太慢的连接（待发的事件攒到上限）会被服务断开，面板重连后从 hello 重新开始
 */
export type ServerEvents = {
  /**
   * 连上时的第一个事件：服务此刻的状态与现场。之后的事件都是增量；连上（含重连）后自己取一次
   * 会话列表与今日概况
   */
  hello: Hello;
  /** 会话列表里的一行变了：新建、改名、切段、来了新消息、消息被编辑、未读数变了。整行替换 */
  conversation: ConversationRow;
  /** 一条消息写入或被编辑；之后紧跟着这个会话的 conversation 事件 */
  message: MessageEvent;
  /** 有模型调用写入（回复或摘要结束）：新的今日概况 */
  today: TodaySummary;
  /** 服务的状态变了：Telegram 连上、断开，拿到了 bot 的用户名。整份替换 */
  status: ServiceStatus;
  /** 「此刻」：进行中的回复的一步进展，见 LiveEvent */
  live: LiveEvent;
};

/** 接口出错时的返回（400、403、404、415、500） */
export type ErrorResponse = { error: string };
