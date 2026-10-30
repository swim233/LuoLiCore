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
};

export type Message = UIMessage<MessageMetadata>;

/** `reply()` 输出的 UI message stream 中的一段 */
export type MessageChunk = InferUIMessageChunk<Message>;
