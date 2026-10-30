import type { InferUIMessageChunk, UIMessage } from 'ai';

export type Author = {
  id: string;
  name: string;
};

export type MessageMetadata = {
  /** 用户消息必有 */
  author?: Author;
  /** ISO 时间 */
  createdAt: string;
  /** 助手回复被中止，正文是中止前已输出的部分 */
  aborted?: true;
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
