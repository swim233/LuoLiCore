import { generateId } from 'ai';
import type { Message } from '../message.js';
import type { ConversationStore, Storage } from './types.js';

type Row = { seq: number; message: Message; addedAt: number };

// 写入顺序计数，「最后一条消息最新」时间相同时用它分先后（对应 SQLite 的 rowid）
let addCounter = 0;

/**
 * 内存里的一个会话，语义与 SQLite 实现一致（含序号预留、重复序号报错）。
 * 存取都复制一份：外部改动拿到的消息不影响存储
 */
export function createMemoryStore(): ConversationStore {
  return memoryStore([]);
}

function memoryStore(rows: Row[]): ConversationStore {
  let nextSeq = 1;
  return {
    async list({ before } = {}) {
      const ordered = rows
        .filter((row) => before === undefined || row.seq < before)
        .sort((a, b) => a.seq - b.seq);
      return structuredClone(ordered.map((row) => row.message));
    },
    async add(message, seq = nextSeq++) {
      if (rows.some((row) => row.seq === seq)) throw new Error(`序号 ${seq} 已被使用`);
      rows.push({ seq, message: structuredClone(message), addedAt: ++addCounter });
    },
    async reserve() {
      return nextSeq++;
    },
  };
}

/** 内存里的多个会话，接口与语义同 SQLite 存储，供测试使用 */
export function createMemoryStorage(): Storage {
  const conversations = new Map<
    string,
    { platform: string; platformConversationId?: string; rows: Row[]; store: ConversationStore }
  >();
  return {
    async createConversation({ platform, platformConversationId }) {
      const duplicate = [...conversations.values()].some(
        (c) =>
          platformConversationId !== undefined &&
          c.platform === platform &&
          c.platformConversationId === platformConversationId,
      );
      if (duplicate) throw new Error(`平台会话 ${platform}/${platformConversationId} 已存在`);
      const id = generateId();
      const rows: Row[] = [];
      conversations.set(id, { platform, platformConversationId, rows, store: memoryStore(rows) });
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
        for (const row of conversation.rows) {
          const createdAt = row.message.metadata?.createdAt ?? '';
          if (
            !latest ||
            createdAt > latest.createdAt ||
            (createdAt === latest.createdAt && row.addedAt > latest.addedAt)
          ) {
            latest = { id, createdAt, addedAt: row.addedAt };
          }
        }
      }
      return latest?.id;
    },
    close() {},
  };
}
