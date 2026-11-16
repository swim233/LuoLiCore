import { generateId } from 'ai';
import type { Author, Message } from '../message.js';
import { DuplicateMessageError } from './errors.js';
import { isoTime, matchesTask, normalizeChanges, normalizeSchedule, taskSource } from './tasks.js';
import type {
  ConversationOverview,
  ConversationStore,
  MessageGlance,
  ModelCall,
  ModelCallSummary,
  NewSegment,
  Storage,
  StoredMessage,
  StoredSegment,
  Task,
  ToolCall,
} from './types.js';

// createdAt 对应 SQLite 的 created_at 列：消息自带的时间，没带时取写入时间
type Row = { seq: number; message: Message; createdAt: string; addedAt: number };

/** 一个会话在内存里的全部数据 */
type Data = {
  title?: string;
  /** 会话建立的时间 */
  createdAt: string;
  rows: Row[];
  segments: StoredSegment[];
  calls: ModelCall[];
  toolCalls: ToolCall[];
};

// 写入顺序计数，「最后一条消息最新」时间相同时用它分先后（对应 SQLite 的 rowid）
let addCounter = 0;

/** 概览里最后一条消息的文字默认取多少个字符，同 SQLite 存储 */
const defaultTextChars = 200;

/**
 * 内存里的一个新会话（已有第一段），语义与 SQLite 实现一致（含序号预留、重复序号报错）。
 * 存取都复制一份：外部改动拿到的消息不影响存储
 */
export function createMemoryStore({ title }: { title?: string } = {}): ConversationStore {
  return memoryStore(newData(title));
}

function newData(title: string | undefined): Data {
  const createdAt = new Date().toISOString();
  return {
    title,
    createdAt,
    rows: [],
    segments: [{ startSeq: 1, startReason: 'first', conversationTitle: title, createdAt }],
    calls: [],
    toolCalls: [],
  };
}

function storedMessage({ seq, createdAt, message }: Row): StoredMessage {
  return structuredClone({ seq, createdAt, message });
}

function memoryStore(data: Data): ConversationStore {
  const { rows, segments, calls, toolCalls } = data;
  let nextSeq = 1;
  const ordered = () => [...rows].sort((a, b) => a.seq - b.seq);
  const entries: ConversationStore['entries'] = async ({ from, before } = {}) => {
    const inRange = ordered().filter(
      (row) =>
        (from === undefined || row.seq >= from) && (before === undefined || row.seq < before),
    );
    return structuredClone(inRange.map(({ seq, message }) => ({ seq, message })));
  };
  return {
    entries,
    async list(range) {
      return (await entries(range)).map((entry) => entry.message);
    },
    async last() {
      const last = lastRow(rows);
      return last && { seq: last.seq, createdAt: last.createdAt };
    },
    async add(message, seq = nextSeq++) {
      if (rows.some((row) => row.seq === seq)) throw new Error(`序号 ${seq} 已被使用`);
      // 与 SQLite 的唯一索引一致：同一会话里平台消息 id 不重复
      const platformMessageId = message.metadata?.platformMessageId;
      if (
        platformMessageId !== undefined &&
        rows.some((row) => row.message.metadata?.platformMessageId === platformMessageId)
      ) {
        throw new DuplicateMessageError(platformMessageId);
      }
      rows.push({
        seq,
        message: structuredClone(message),
        createdAt: message.metadata?.createdAt ?? new Date().toISOString(),
        addedAt: ++addCounter,
      });
    },
    async reserve() {
      return nextSeq++;
    },
    async get(id) {
      const row = rows.find((r) => r.message.id === id);
      return row && structuredClone(row.message);
    },
    async entry(id) {
      const row = rows.find((r) => r.message.id === id);
      return row && storedMessage(row);
    },
    async page({ before, limit }) {
      const earlier = ordered().filter((row) => before === undefined || row.seq < before);
      const taken = earlier.slice(Math.max(0, earlier.length - limit));
      return { entries: taken.map(storedMessage), hasMore: earlier.length > taken.length };
    },
    async count({ after = 0, role, excludeEvents = false } = {}) {
      return rows.filter(
        (row) =>
          row.seq > after &&
          (role === undefined || row.message.role === role) &&
          !(excludeEvents && row.message.metadata?.event !== undefined),
      ).length;
    },
    async findByPlatformMessageId(platformMessageId) {
      const row = rows.find((r) => r.message.metadata?.platformMessageId === platformMessageId);
      return row && structuredClone(row.message);
    },
    async update(message) {
      const row = rows.find((r) => r.message.id === message.id);
      if (!row) throw new Error(`消息 ${message.id} 不存在`);
      row.message = structuredClone(message);
    },
    async currentSegment() {
      const current = currentOf(segments);
      if (!current) {
        return {
          startSeq: 1,
          startReason: 'first',
          conversationTitle: data.title,
          createdAt: data.createdAt,
        };
      }
      return structuredClone(current);
    },
    async segments() {
      return structuredClone([...segments].sort((a, b) => a.startSeq - b.startSeq));
    },
    async addSegment(segment) {
      const { startSeq } = segment;
      if (segments.some((existing) => existing.startSeq === startSeq)) return false;
      segments.push(
        storedSegment(segment, { title: data.title, createdAt: new Date().toISOString() }),
      );
      return true;
    },
    async clearSegment({ startSeq, startedBy }) {
      // 读与改之间没有 await：与 SQLite 的单条 UPDATE 一样是一次原子的写入
      const current = currentOf(segments);
      if (!current || current.startSeq !== startSeq) return false;
      if (rows.some((row) => row.seq >= startSeq)) return false;
      segments[segments.indexOf(current)] = storedSegment(
        { startSeq, startReason: 'clear', startedBy },
        { title: data.title, createdAt: new Date().toISOString() },
      );
      return true;
    },
    async recordCall(call) {
      calls.push(structuredClone(call));
    },
    async calls() {
      return structuredClone(calls);
    },
    async recordToolCall(call) {
      toolCalls.push(structuredClone(call));
    },
    async toolCalls() {
      return structuredClone(toolCalls);
    },
  };
}

/** startSeq 最大的一段；没有段时为 undefined */
function currentOf(segments: StoredSegment[]): StoredSegment | undefined {
  return segments.reduce<StoredSegment | undefined>(
    (a, b) => (a && a.startSeq > b.startSeq ? a : b),
    undefined,
  );
}

/** 新的一段存成的样子：没有的项不写（与 SQLite 读出的形状一致），执行人复制一份 */
function storedSegment(
  segment: NewSegment,
  { title, createdAt }: { title: string | undefined; createdAt: string },
): StoredSegment {
  return {
    startSeq: segment.startSeq,
    startReason: segment.startReason,
    ...(title === undefined ? {} : { conversationTitle: title }),
    ...('priorSummary' in segment ? { priorSummary: segment.priorSummary } : {}),
    ...('startedBy' in segment ? { startedBy: author(segment.startedBy) } : {}),
    createdAt,
  };
}

/** 执行人：只留显示名与（有时的）id */
function author({ id, name }: Author): Author {
  return id === undefined ? { name } : { id, name };
}

function lastRow(rows: Row[]): Row | undefined {
  return rows.reduce<Row | undefined>((a, b) => (a && a.seq > b.seq ? a : b), undefined);
}

/** 最后一条消息的要点，口径同 SQLite 存储：文字按 Unicode 字符截 */
function glance(row: Row, textChars: number): MessageGlance {
  const { message } = row;
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  const author = message.metadata?.author;
  const event = message.metadata?.event?.type;
  return structuredClone({
    seq: row.seq,
    createdAt: row.createdAt,
    role: message.role,
    ...(author === undefined ? {} : { author }),
    ...(event === undefined ? {} : { event }),
    text: [...text].slice(0, textChars).join(''),
    files: message.parts.filter((part) => part.type === 'file').length,
  });
}

/** 内存里的多个会话，接口与语义同 SQLite 存储，供测试使用 */
export function createMemoryStorage(): Storage {
  const conversations = new Map<
    string,
    { platform: string; platformConversationId?: string; data: Data; store: ConversationStore }
  >();
  // 按 id 升序（即建立先后）；id 从 1 起，不重用
  const tasks: Task[] = [];
  let lastTaskId = 0;
  const findTask = (id: number) => tasks.find((task) => task.id === id);
  /** 进行中、有下次到点的任务 */
  const scheduled = () =>
    tasks.filter(
      (task): task is Task & { nextDueAt: string } =>
        task.status === 'active' && task.nextDueAt !== undefined,
    );

  const overviewOf = (id: string, textChars: number): ConversationOverview | undefined => {
    const conversation = conversations.get(id);
    if (!conversation) return undefined;
    const { platform, platformConversationId, data } = conversation;
    const last = lastRow(data.rows);
    return {
      id,
      platform,
      platformConversationId,
      title: data.title,
      createdAt: data.createdAt,
      messages: data.rows.length,
      segments: Math.max(1, data.segments.length),
      ...(last === undefined ? {} : { last: glance(last, textChars) }),
    };
  };

  return {
    async createConversation({ platform, platformConversationId, title }) {
      const duplicate = [...conversations.values()].some(
        (c) =>
          platformConversationId !== undefined &&
          c.platform === platform &&
          c.platformConversationId === platformConversationId,
      );
      if (duplicate) throw new Error(`平台会话 ${platform}/${platformConversationId} 已存在`);
      const id = generateId();
      const data = newData(title);
      conversations.set(id, { platform, platformConversationId, data, store: memoryStore(data) });
      return id;
    },
    async openConversation(id) {
      const conversation = conversations.get(id);
      if (!conversation) throw new Error(`会话 ${id} 不存在`);
      return conversation.store;
    },
    async findLatestConversation(platform) {
      let latest: { id: string; createdAt: string; addedAt: number } | undefined;
      for (const [id, conversation] of conversations) {
        if (conversation.platform !== platform) continue;
        for (const row of conversation.data.rows) {
          if (
            !latest ||
            row.createdAt > latest.createdAt ||
            (row.createdAt === latest.createdAt && row.addedAt > latest.addedAt)
          ) {
            latest = { id, createdAt: row.createdAt, addedAt: row.addedAt };
          }
        }
      }
      return latest?.id;
    },
    async findConversation(platform, platformConversationId) {
      for (const [id, conversation] of conversations) {
        if (
          conversation.platform === platform &&
          conversation.platformConversationId === platformConversationId
        ) {
          return { id, platformConversationId, title: conversation.data.title };
        }
      }
      return undefined;
    },
    async listConversations(platform) {
      return [...conversations]
        .filter(([, conversation]) => conversation.platform === platform)
        .map(([id, { platformConversationId, data }]) => ({
          id,
          platformConversationId,
          title: data.title,
        }));
    },
    async updateTitle(id, title) {
      const conversation = conversations.get(id);
      if (!conversation) throw new Error(`会话 ${id} 不存在`);
      conversation.data.title = title;
    },
    async overviews({ textChars = defaultTextChars } = {}) {
      return [...conversations.keys()].map((id) => overviewOf(id, textChars)!);
    },
    async overview(id, { textChars = defaultTextChars } = {}) {
      return overviewOf(id, textChars);
    },
    async callSummary(since) {
      const summary: ModelCallSummary = {
        replies: 0,
        failedReplies: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        repliesByConversation: [],
      };
      // Map 按插入顺序遍历，即会话建立先后
      for (const [conversationId, { data }] of conversations) {
        let replies = 0;
        for (const call of data.calls) {
          if (call.startedAt < since) continue;
          if (call.purpose === 'reply' && call.outcome === 'completed') replies++;
          if (call.purpose === 'reply' && call.outcome === 'failed') summary.failedReplies++;
          summary.inputTokens += call.inputTokens ?? 0;
          summary.cacheReadTokens += call.cacheReadTokens ?? 0;
          summary.outputTokens += call.outputTokens ?? 0;
        }
        summary.replies += replies;
        if (replies > 0) {
          summary.repliesByConversation.push({ conversationId, title: data.title, replies });
        }
      }
      // 稳定排序：同样多时保持建立先后
      summary.repliesByConversation.sort((a, b) => b.replies - a.replies);
      return summary;
    },
    async lastReply() {
      let latest: { conversationId: string; call: ModelCall; endedMs: number } | undefined;
      for (const [conversationId, { data }] of conversations) {
        for (const call of data.calls) {
          if (call.purpose !== 'reply' || call.outcome !== 'completed') continue;
          // 按结束时间；同一时刻的取后写入的（会话之间按建立先后，与 SQLite 按行号近似）
          const endedMs = Date.parse(call.startedAt) + call.durationMs;
          if (!latest || endedMs >= latest.endedMs) latest = { conversationId, call, endedMs };
        }
      }
      if (!latest) return undefined;
      const { conversationId, call, endedMs } = latest;
      return { conversationId, replyId: call.replyId, endedAt: new Date(endedMs).toISOString() };
    },
    async createTask({ conversationId, action, schedule, source, nextDueAt, createdAt }) {
      if (!conversations.has(conversationId)) throw new Error(`会话 ${conversationId} 不存在`);
      // 与 SQLite 一样：时间先换成同一种写法，schedule 经过一次 JSON
      const task: Task = {
        id: lastTaskId + 1,
        conversationId,
        action,
        schedule: normalizeSchedule(schedule),
        source: taskSource(source),
        status: 'active',
        ...(nextDueAt === undefined ? {} : { nextDueAt: isoTime(nextDueAt) }),
        dueCount: 0,
        createdAt: isoTime(createdAt ?? new Date().toISOString()),
      };
      lastTaskId = task.id;
      tasks.push(task);
      return structuredClone(task);
    },
    async getTask(id) {
      const task = findTask(id);
      return task && structuredClone(task);
    },
    async listTasks(filter = {}) {
      const { endedSince } = filter;
      const normalized = {
        ...filter,
        ...(endedSince === undefined ? {} : { endedSince: isoTime(endedSince) }),
      };
      return structuredClone(tasks.filter((task) => matchesTask(task, normalized)));
    },
    async updateTask(id, changes) {
      // 先换好写法：时间不合法时抛错，任务不变
      const { action, schedule, status, dueCount, ...times } = normalizeChanges(changes);
      const task = findTask(id);
      if (!task) throw new Error(`任务 ${id} 不存在`);
      if (action !== undefined) task.action = action;
      if (schedule !== undefined) task.schedule = schedule;
      if (status !== undefined) task.status = status;
      if (dueCount !== undefined) task.dueCount = dueCount;
      for (const key of ['nextDueAt', 'lastDueAt', 'endedAt'] as const) {
        const value = times[key];
        if (value === null) delete task[key];
        else if (value !== undefined) task[key] = value;
      }
      return structuredClone(task);
    },
    async dueTasks(at) {
      const time = isoTime(at);
      return structuredClone(
        scheduled()
          .filter((task) => task.nextDueAt <= time)
          // sort 是稳定的：同一时刻保持建立先后
          .sort((a, b) => (a.nextDueAt < b.nextDueAt ? -1 : a.nextDueAt > b.nextDueAt ? 1 : 0)),
      );
    },
    async nextDueAt() {
      return scheduled().reduce<string | undefined>(
        (earliest, task) =>
          earliest === undefined || task.nextDueAt < earliest ? task.nextDueAt : earliest,
        undefined,
      );
    },
    close() {},
  };
}
