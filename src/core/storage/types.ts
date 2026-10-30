import type { Message } from '../message.js';

/** 序号区间：from 起（含）到 before 之前（不含），不给的一端不限 */
export type SeqRange = { from?: number; before?: number };

/** 会话中连续的一段：从 startSeq 起，到下一段的 startSeq 之前（ADR-0004、ADR-0005） */
export type Segment = {
  startSeq: number;
  startReason: 'first' | 'idle' | 'compress';
  /** 段开始时会话标题的快照；一段之内不变 */
  conversationTitle?: string;
  /** 本段开始之前全部内容的滚动摘要；第一段没有 */
  priorSummary?: string;
};

/** 一个会话的消息与段的存取。消息按序号排列；序号由存储分配，可以先预留再写入 */
export type ConversationStore = {
  /** 按序号升序返回区间内的整条消息 */
  list(range?: SeqRange): Promise<Message[]>;
  /** 同 list，附带每条消息的序号 */
  entries(range?: SeqRange): Promise<Array<{ seq: number; message: Message }>>;
  /** 序号最大的那条消息的序号与时间；没有消息时为 undefined */
  last(): Promise<{ seq: number; createdAt: string } | undefined>;
  /** 写入一条消息：不给 seq 时取下一个序号，给了 seq 时用之前预留的序号 */
  add(message: Message, seq?: number): Promise<void>;
  /** 预留一个序号。之后写入的消息排在它后面；预留了没写入时序号空着 */
  reserve(): Promise<number>;
  /**
   * 当前段：startSeq 最大的一段。会话还没有段（第 2 步建的库）时，
   * 视为从序号 1 开始、标题取会话标题、没有摘要的第一段
   */
  currentSegment(): Promise<Segment>;
  /**
   * 开始新的一段；标题取会话此刻的标题。
   * 这个序号已经有一段时（如另一个进程刚切过）不写入，返回 false
   */
  addSegment(segment: {
    startSeq: number;
    startReason: 'idle' | 'compress';
    priorSummary: string;
  }): Promise<boolean>;
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
  /** 新建会话，同时写入它的第一段，返回会话 id */
  createConversation(conversation: NewConversation): Promise<string>;
  /** 打开已有的会话；会话不存在时抛错 */
  openConversation(id: string): Promise<ConversationStore>;
  /** 某平台里最后一条消息最新的会话 id；没有消息的会话不算 */
  findLatestConversation(platform: string): Promise<string | undefined>;
  close(): void;
};
