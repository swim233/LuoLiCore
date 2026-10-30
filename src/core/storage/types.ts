import type { Message } from '../message.js';

/** 一个会话的消息存取。消息按序号排列；序号由存储分配，可以先预留再写入 */
export type ConversationStore = {
  /** 按序号升序返回整条消息；给了 before 时只返回序号小于它的 */
  list(options?: { before?: number }): Promise<Message[]>;
  /** 写入一条消息：不给 seq 时取下一个序号，给了 seq 时用之前预留的序号 */
  add(message: Message, seq?: number): Promise<void>;
  /** 预留一个序号。之后写入的消息排在它后面；预留了没写入时序号空着 */
  reserve(): Promise<number>;
};

export type NewConversation = {
  /** 'cli' | 'telegram' */
  platform: string;
  /** 平台里的会话 id（如 Telegram 的 chat id）；CLI 不给 */
  platformConversationId?: string;
  /** 群名；私聊为对方名字 */
  title?: string;
};

/** 一个数据库：多个会话 */
export type Storage = {
  /** 新建会话，返回会话 id */
  createConversation(conversation: NewConversation): Promise<string>;
  /** 打开已有的会话；会话不存在时抛错 */
  openConversation(id: string): Promise<ConversationStore>;
  /** 某平台里最后一条消息最新的会话 id；没有消息的会话不算 */
  findLatestConversation(platform: string): Promise<string | undefined>;
  close(): void;
};
