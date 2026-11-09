import type { ConversationStore, Storage } from '../core/index.js';

/** 存储里发生的一次写入（只说是什么、在哪，不带内容） */
export type StorageChange =
  /** 会话新建、改了标题、切了新段 */
  | { type: 'conversation'; conversationId: string }
  /** 写入了一条消息（edited 为 false），或改了一条已有的消息（true） */
  | { type: 'message'; conversationId: string; messageId: string; edited: boolean }
  /** 记了一次模型调用 */
  | { type: 'call'; conversationId: string }
  /** 新建或改了一个任务（到点、完成、取消） */
  | { type: 'task'; conversationId: string; taskId: number };

/**
 * 给核心的存储包一层：写入成功之后调用 onChange，说明写了什么。读取与写入本身原样转给里面的
 * 存储，行为不变（写入出错照样抛出，不通知）；onChange 抛错只会被吞掉，不影响写入。
 * 洛璃服务里，Telegram 前端和会话管理都用包过的这份，核心和 Telegram 不用为通知改代码。
 * 每个方法都显式转发：核心以后加了写入的方法，这里不改就编译不过，不会漏掉通知
 */
export function observeStorage(
  storage: Storage,
  onChange: (change: StorageChange) => void,
): Storage {
  const notify = (change: StorageChange) => {
    try {
      onChange(change);
    } catch {
      // 通知出错不影响写入
    }
  };

  const observe = (conversationId: string, store: ConversationStore): ConversationStore => ({
    list: (range) => store.list(range),
    entries: (range) => store.entries(range),
    last: () => store.last(),
    get: (id) => store.get(id),
    entry: (id) => store.entry(id),
    page: (options) => store.page(options),
    count: (options) => store.count(options),
    findByPlatformMessageId: (platformMessageId) =>
      store.findByPlatformMessageId(platformMessageId),
    reserve: () => store.reserve(),
    currentSegment: () => store.currentSegment(),
    segments: () => store.segments(),
    calls: () => store.calls(),
    recordToolCall: (call) => store.recordToolCall(call),
    toolCalls: () => store.toolCalls(),
    async add(message, seq) {
      await store.add(message, seq);
      notify({ type: 'message', conversationId, messageId: message.id, edited: false });
    },
    async update(message) {
      await store.update(message);
      notify({ type: 'message', conversationId, messageId: message.id, edited: true });
    },
    async addSegment(segment) {
      const added = await store.addSegment(segment);
      if (added) notify({ type: 'conversation', conversationId });
      return added;
    },
    async recordCall(call) {
      await store.recordCall(call);
      notify({ type: 'call', conversationId });
    },
  });

  return {
    openConversation: async (id) => observe(id, await storage.openConversation(id)),
    findLatestConversation: (platform) => storage.findLatestConversation(platform),
    findConversation: (platform, platformConversationId) =>
      storage.findConversation(platform, platformConversationId),
    listConversations: (platform) => storage.listConversations(platform),
    overviews: (options) => storage.overviews(options),
    overview: (id, options) => storage.overview(id, options),
    callSummary: (since) => storage.callSummary(since),
    lastReply: () => storage.lastReply(),
    getTask: (id) => storage.getTask(id),
    listTasks: (filter) => storage.listTasks(filter),
    dueTasks: (at) => storage.dueTasks(at),
    nextDueAt: () => storage.nextDueAt(),
    async createTask(input) {
      const task = await storage.createTask(input);
      notify({ type: 'task', conversationId: task.conversationId, taskId: task.id });
      return task;
    },
    async updateTask(id, changes) {
      const task = await storage.updateTask(id, changes);
      notify({ type: 'task', conversationId: task.conversationId, taskId: task.id });
      return task;
    },
    close: () => storage.close(),
    async createConversation(conversation) {
      const id = await storage.createConversation(conversation);
      notify({ type: 'conversation', conversationId: id });
      return id;
    },
    async updateTitle(id, title) {
      await storage.updateTitle(id, title);
      notify({ type: 'conversation', conversationId: id });
    },
  };
}
