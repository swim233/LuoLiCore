import type { InferUIMessageChunk, UIMessage } from 'ai';

export type Author = {
  /** 平台提供的不变的用户 id；没有时（如 CLI）只能按名字区分 */
  id?: string;
  /** 发言人当时的显示名 */
  name: string;
};

/**
 * 触发一次回复的一条消息（触发者）：发言人、核心的消息 id，平台上有 id 时还有平台消息 id。
 * 工具据此知道是谁让它做的（ADR-0006、ADR-0010）
 */
export type Trigger = {
  readonly author: Readonly<Author>;
  readonly messageId: string;
  readonly platformMessageId?: string;
};

/**
 * 事件（ADR-0010）：洛璃服务写进会话的一条不是人说的消息，按用户消息存。
 * task：任务到点；task-missed：服务停着时错过了。taskId 是任务的 id（Task.id）
 */
export type ConversationEvent = { type: 'task' | 'task-missed'; taskId: number };

export type MessageMetadata = {
  /** 用户消息的发言人。事件没有 */
  author?: Author;
  /** 事件才有：它的类型与相关的任务。有它的用户消息是事件，送模型时包成 `<event>` */
  event?: ConversationEvent;
  /** ISO 时间。用户消息取平台上的发送时间（平台给出时），事件取服务给的时间 */
  createdAt: string;
  /** 平台里的消息 id（如 Telegram 的 message_id），编辑消息时靠它找到这条 */
  platformMessageId?: string;
  /** 在平台上被编辑过：最后一次编辑的时间（ISO） */
  editedAt?: string;
  /**
   * 模型服务拒收过的图片（`luoli-file:` 地址）：用户消息里的图片，或助手消息里工具结果的图片。
   * 文件与 parts 不变，发给模型时换成「[图片无法读取]」
   */
  unreadableFiles?: string[];
  /** 助手回复被中止，正文是中止前已输出的部分 */
  aborted?: true;
  /** 助手回复因出错中断，正文是出错前已完成的步（失败那一步自己的输出不在其中） */
  failed?: true;
  /** 正常完成的助手回复才有；只算最终成功的那次请求 */
  usage?: Usage;
  /**
   * 每段思考用了多少毫秒（从这段思考开始到结束），按 parts 里 reasoning 段的顺序一一对应；
   * 没有结束的（中止时还在想的那段）为 null。有思考的助手回复才有，以前写入的消息没有
   */
  reasoningMs?: Array<number | null>;
};

/** 一次回复的 token 用量。服务端没报的项为 undefined（报了 0 就是 0） */
export type Usage = {
  input?: number;
  output?: number;
  total?: number;
  /** 输入中命中缓存的部分 */
  cacheRead?: number;
  /** 输出中用于推理的部分。以前写入的消息没有这一项 */
  reasoning?: number;
};

/** 回复流中的数据段。都是 transient 的，不进入消息历史。 */
export type MessageData = {
  /**
   * 即将进行第 attempt 次重试（每类最多 maxRetries 次）。
   * request：请求失败后重发；stream：流中途出错后重新生成，失败那次已输出的内容作废
   */
  retry: { phase: 'request' | 'stream'; attempt: number; maxRetries: number; statusCode?: number };
};

export type Message = UIMessage<MessageMetadata, MessageData>;

/** `reply()` 输出的 UI message stream 中的一段 */
export type MessageChunk = InferUIMessageChunk<Message>;
