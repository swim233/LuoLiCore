import type { InferUIMessageChunk, UIMessage } from 'ai';

export type Author = {
  /** 平台提供的不变的用户 id；没有时（如 CLI）只能按名字区分 */
  id?: string;
  /** 发言人当时的显示名 */
  name: string;
};

export type MessageMetadata = {
  /** 用户消息必有 */
  author?: Author;
  /** ISO 时间 */
  createdAt: string;
  /** 助手回复被中止，正文是中止前已输出的部分 */
  aborted?: true;
  /** 正常完成的助手回复才有；只算最终成功的那次请求 */
  usage?: Usage;
};

/** 一次回复的 token 用量。服务端没报的项为 undefined */
export type Usage = {
  input?: number;
  output?: number;
  total?: number;
  /** 输入中命中缓存的部分 */
  cacheRead?: number;
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
