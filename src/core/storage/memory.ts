import { generateId } from 'ai';
import type { Message } from '../message.js';
import { DuplicateMessageError } from './errors.js';
import type { ConversationStore, Segment, Storage } from './types.js';

// createdAt 对应 SQLite 的 created_at 列：消息自带的时间，没带时取写入时间
type Row = { seq: number; message: Message; createdAt: string; addedAt: number };

/** 一个会话在内存里的全部数据 */
type Data = { title?: string; rows: Row[]; segments: Segment[] };

// 写入顺序计数，「最后一条消息最新」时间相同时用它分先后（对应 SQLite 的 rowid）
let addCounter = 0;

/**
 * 内存里的一个新会话（已有第一段），语义与 SQLite 实现一致（含序号预留、重复序号报错）。
 * 存取都复制一份：外部改动拿到的消息不影响存储
 */
export function createMemoryStore({ title }: { title?: string } = {}): ConversationStore {
  return memoryStore(newData(title));
}

function newData(title: string | undefined): Data {
  return {
    title,
    rows: [],
    segments: [{ startSeq: 1, startReason: 'first', conversationTitle: title }],
  };
}

function memoryStore(data: Data): ConversationStore {
  const { rows, segments } = data;
  let nextSeq = 1;
  const entries: ConversationStore['entries'] = async ({ from, before } = {}) => {
    const ordered = rows
      .filter(
        (row) =>
          (from === undefined || row.seq >= from) && (before === undefined || row.seq < before),
      )
      .sort((a, b) => a.seq - b.seq);
    return structuredClone(ordered.map(({ seq, message }) => ({ seq, message })));
  };
  return {
    entries,
    async list(range) {
      return (await entries(range)).map((entry) => entry.message);
    },
    async last() {
      const last = rows.reduce<Row | undefined>((a, b) => (a && a.seq > b.seq ? a : b), undefined);
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
      const current = segments.reduce<Segment | undefined>(
        (a, b) => (a && a.startSeq > b.startSeq ? a : b),
        undefined,
      );
      return structuredClone(
        current ?? { startSeq: 1, startReason: 'first', conversationTitle: data.title },
      );
    },
    async addSegment({ startSeq, startReason, priorSummary }) {
      if (segments.some((segment) => segment.startSeq === startSeq)) return false;
      segments.push({ startSeq, startReason, conversationTitle: data.title, priorSummary });
      return true;
    },
  };
}

/** 内存里的多个会话，接口与语义同 SQLite 存储，供测试使用 */
export function createMemoryStorage(): Storage {
  const conversations = new Map<
    string,
    { platform: string; platformConversationId?: string; data: Data; store: ConversationStore }
  >();
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
    close() {},
  };
}
