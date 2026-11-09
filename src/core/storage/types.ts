import type { Author, Message, Trigger } from '../message.js';

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
  /**
   * 这次调用的 id（模型给的，与消息里工具段的 toolCallId 相同），用来对上消息里的调用。
   * 表结构版本 4 之前写的行没有
   */
  toolCallId?: string;
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

/** 一条消息连同它的序号与时间 */
export type StoredMessage = {
  seq: number;
  /** 消息自带的时间（metadata.createdAt），没带时为写入时间 */
  createdAt: string;
  message: Message;
};

/** 按序号取的一批消息 */
export type MessagePage = {
  /** 按序号升序 */
  entries: StoredMessage[];
  /** 这批之前还有更早的消息 */
  hasMore: boolean;
};

/** 段连同它开始的时间 */
export type StoredSegment = Segment & {
  /** 这一段写入的时间（ISO）。没有段的旧会话视为一段，时间取会话的建立时间 */
  createdAt: string;
};

/** 一条消息的要点，不含整条消息 */
export type MessageGlance = {
  seq: number;
  /** 同 StoredMessage.createdAt */
  createdAt: string;
  role: Message['role'];
  /** 用户消息的发言人；事件没有 */
  author?: Author;
  /** 文字部分按顺序用换行连起来，最多取开头若干个字符（按 Unicode 字符计） */
  text: string;
  /** 文件（图片）部分的个数；工具结果里的图片不算 */
  files: number;
};

/** 一个会话的概览 */
export type ConversationOverview = StoredConversation & {
  /** 会话建立的时间（ISO） */
  createdAt: string;
  /** 消息条数 */
  messages: number;
  /** 段数；没有段的旧会话算一段 */
  segments: number;
  /** 序号最大的那条消息；没有消息时没有 */
  last?: MessageGlance;
};

/** 某时刻以来开始的模型调用的汇总 */
export type ModelCallSummary = {
  /** 用途为回复、结果为 completed 的次数 */
  replies: number;
  /** 用途为回复、结果为 failed 的次数 */
  failedReplies: number;
  /** 以下三项：全部用途（回复与摘要）、全部结果之和；服务端没报的按 0 计 */
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** 每个会话的回复数（口径同 replies），多的在前，同样多时按会话建立先后；没有回复的会话不列 */
  repliesByConversation: Array<{ conversationId: string; title?: string; replies: number }>;
};

/** 最近一次正常完成的回复 */
export type RecentReply = {
  conversationId: string;
  replyId?: string;
  /** 结束的时间（开始时间加耗时），ISO */
  endedAt: string;
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
  /** 同 get，附带序号与时间 */
  entry(id: string): Promise<StoredMessage | undefined>;
  /**
   * 序号在 before 之前（不给时不限）的最后 limit 条消息，按序号升序；hasMore 说明这批之前还有没有。
   * 用来从新到旧一批批往前取
   */
  page(options: { before?: number; limit: number }): Promise<MessagePage>;
  /** 序号大于 after（不给时不限）的消息条数；给了 role 时只数这种角色的 */
  count(options?: { after?: number; role?: Message['role'] }): Promise<number>;
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
  /** 全部段，按开始的序号升序。会话还没有段时同 currentSegment，视为一段 */
  segments(): Promise<StoredSegment[]>;
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

/** 会话连同所在的平台（readConversations 的结果） */
export type StoredConversation = ConversationInfo & { platform: string };

/**
 * 任务什么时候到点（ADR-0010），整条存成 JSON（ADR-0005）。核心不解读，下次到点由洛璃服务算。
 * 一次性的是一个时刻（ISO，UTC）；周期的是种类加时刻 time（`HH:mm`，按服务器所在时区），
 * 每周的加星期几 weekday（1 是周一，7 是周日），每月的加几号 day（1–31）；
 * until 是截止的时刻（ISO，UTC），下一次到点晚于它就算完成，不给时不截止。
 * 新建时 at、until 换成 toISOString 的写法，其余原样。
 * 以后的触发方式（第八阶段的监视）在这里加一种 kind
 */
export type TaskSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string; until?: string }
  | { kind: 'weekdays'; time: string; until?: string }
  | { kind: 'weekly'; weekday: number; time: string; until?: string }
  | { kind: 'monthly'; day: number; time: string; until?: string };

/** active：进行中；done：已完成（一次性的到点了，周期的过了截止）；cancelled：已取消（不删） */
export type TaskStatus = 'active' | 'done' | 'cancelled';

/**
 * 一个任务，对应 tasks 的一行（ADR-0005、ADR-0010）。
 * 时间都是 ISO 的 UTC（toISOString 的写法；写入时换成这种写法）
 */
export type Task = {
  /** 整数，从 1 起，不重用。给模型看的是 t 加它（taskRef） */
  id: number;
  conversationId: string;
  /** 做什么：洛璃建任务时写的一句话 */
  action: string;
  schedule: TaskSchedule;
  /** 谁让建的：触发建任务那次回复的那条消息，连同发言人 */
  source: Trigger;
  status: TaskStatus;
  /** 下次到点；进行中的任务才有（结束时由调用方清掉，查询只看进行中的） */
  nextDueAt?: string;
  /** 上次到点；还没到过点时没有 */
  lastDueAt?: string;
  /** 到点了几次 */
  dueCount: number;
  createdAt: string;
  /** 完成或取消的时间；进行中的没有 */
  endedAt?: string;
};

/** 新建任务：状态为进行中，到点次数为 0 */
export type NewTask = {
  conversationId: string;
  action: string;
  schedule: TaskSchedule;
  source: Trigger;
  nextDueAt?: string;
  /** 默认为写入时间 */
  createdAt?: string;
};

/** 修改任务：只改给出的项；给 null 是清掉（如结束时清掉下次到点） */
export type TaskChanges = {
  status?: TaskStatus;
  nextDueAt?: string | null;
  lastDueAt?: string | null;
  dueCount?: number;
  endedAt?: string | null;
};

/** 列出任务的条件，都不给时列出全部 */
export type TaskFilter = {
  conversationId?: string;
  status?: TaskStatus;
  /** 已结束的任务只要这个时刻（含）以后结束的；进行中的不受影响 */
  endedSince?: string;
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
  /**
   * 全部会话（不分平台）的概览，按建立先后。textChars：最后一条消息的文字取开头多少个字符，默认 200
   */
  overviews(options?: { textChars?: number }): Promise<ConversationOverview[]>;
  /** 一个会话的概览；会话不存在时为 undefined */
  overview(id: string, options?: { textChars?: number }): Promise<ConversationOverview | undefined>;
  /** since（ISO 时间）及以后开始的模型调用的汇总 */
  callSummary(since: string): Promise<ModelCallSummary>;
  /**
   * 最近一次正常完成的回复（模型调用里用途为回复、结果为 completed、结束得最晚的一次，
   * 结束时间是开始时间加耗时）；还没有时为 undefined
   */
  lastReply(): Promise<RecentReply | undefined>;
  // 以下是任务的存取（ADR-0010）。核心只存取，不调度、不检查限额与平台、不计算下次到点。
  // 读出的都是副本
  /** 新建任务，返回带 id 的任务；会话不存在时抛错 */
  createTask(task: NewTask): Promise<Task>;
  /** 按 id 取；没有时为 undefined */
  getTask(id: number): Promise<Task | undefined>;
  /** 按条件列出，按建立先后 */
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  /** 修改任务，返回改过的；没有这个任务时抛错 */
  updateTask(id: number, changes: TaskChanges): Promise<Task>;
  /** 下次到点不晚于 at 的进行中任务，按下次到点先后（同一时刻按建立先后） */
  dueTasks(at: string): Promise<Task[]>;
  /** 进行中任务里最早的下次到点；没有时为 undefined */
  nextDueAt(): Promise<string | undefined>;
  close(): void;
};
