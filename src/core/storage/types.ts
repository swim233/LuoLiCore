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

/**
 * 一次模型调用（一次回复或一次摘要，期间的重试都合在一起）的结果，对应 model_calls 的一行
 * （ADR-0005）。服务端没报、或这次调用没有的项为 undefined（存为 NULL），不是 0
 */
export type ModelCall = {
  purpose: 'reply' | 'summary';
  /** 摘要才有 */
  summaryReason?: 'idle' | 'compress';
  /** 回复才有：与写入历史的助手消息 id、日志里的 replyId 相同 */
  replyId?: string;
  /** 模型 id */
  model: string;
  /** 第一次请求发出的时间，ISO */
  startedAt: string;
  durationMs: number;
  /** 从开始到第一段非空的文字、推理或工具调用输出；没有输出时为 undefined */
  firstOutputMs?: number;
  /** HTTP 请求次数，含重试与拒收图片后的恢复 */
  attempts: number;
  outcome: 'completed' | 'empty' | 'aborted' | 'cancelled' | 'failed';
  /** 正常结束时才有 */
  finishReason?: string;
  /** 以下 4 项：正常结束时的总用量 */
  inputTokens?: number;
  cacheReadTokens?: number;
  /** 含推理 */
  outputTokens?: number;
  reasoningTokens?: number;
  /** 失败时的错误类型与状态码，如 `APICallError 429`；不含错误信息与正文 */
  error?: string;
  /** 发出过请求的步数；摘要为 1。表结构版本 3 之前的行为空 */
  steps?: number;
  /** 工具调用次数，含参数不合结构、调了不存在的工具的；摘要为 0。表结构版本 3 之前的行为空 */
  toolCalls?: number;
};

/**
 * 一次工具调用的结果，对应 tool_calls 的一行（ADR-0005），与 tool.end 日志同一份数据。
 * 不存参数、结果与错误消息
 */
export type ToolCall = {
  /** 所在回复的 id，与 ModelCall 的 replyId 相同 */
  replyId: string;
  /** 工具名；模型调了不存在的工具时，是模型给的名字 */
  tool: string;
  /** 第几步，从 1 开始 */
  step: number;
  /** 开始时间，ISO */
  startedAt: string;
  /** 超时时算到超时为止；参数不合结构、调了不存在的工具（没有执行）为 0 */
  durationMs: number;
  outcome: 'completed' | 'failed' | 'timeout' | 'aborted';
  /** 失败时的错误类型，如 `InvalidToolInputError`；不含错误信息 */
  error?: string;
  /** 结果交给模型的文字的长度（tool.end 日志的 resultLength）；没有结果时为 undefined */
  outputChars?: number;
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
  /** 按 id 读一条消息；没有时为 undefined */
  get(id: string): Promise<Message | undefined>;
  /** 按平台消息 id 找消息；没有时为 undefined */
  findByPlatformMessageId(platformMessageId: string): Promise<Message | undefined>;
  /** 按 id 换掉已写入的消息（如编辑后的正文）。序号与查询用的副本列不变；没有这条时抛错 */
  update(message: Message): Promise<void>;
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
  /** 记一次模型调用，只追加 */
  recordCall(call: ModelCall): Promise<void>;
  /** 本会话记下的模型调用，按写入先后 */
  calls(): Promise<ModelCall[]>;
  /** 记一次工具调用，只追加 */
  recordToolCall(call: ToolCall): Promise<void>;
  /** 本会话记下的工具调用，按写入先后 */
  toolCalls(): Promise<ToolCall[]>;
};

export type NewConversation = {
  /** 'cli' | 'telegram' */
  platform: string;
  /** 平台里的会话 id（如 Telegram 的 chat id）；CLI 不给 */
  platformConversationId?: string;
  /** 群名；私聊为对方名字 */
  title?: string;
};

export type ConversationInfo = {
  id: string;
  platformConversationId?: string;
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
  /** 按平台与平台会话 id 找会话；没有时为 undefined */
  findConversation(
    platform: string,
    platformConversationId: string,
  ): Promise<ConversationInfo | undefined>;
  /** 某平台的全部会话，按创建先后 */
  listConversations(platform: string): Promise<ConversationInfo[]>;
  /** 改会话标题；已有的段保留各自开始时的快照，新段用新标题 */
  updateTitle(id: string, title: string | undefined): Promise<void>;
  close(): void;
};
