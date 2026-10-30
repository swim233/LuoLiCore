import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryStorage,
  openSqliteStorage,
  type Message,
  type MessageMetadata,
  type Storage,
} from '../index.js';

let nextId = 0;

function message(
  role: 'user' | 'assistant',
  text: string,
  metadata: Partial<MessageMetadata> = {},
): Message {
  return {
    id: `m${++nextId}`,
    role,
    metadata: { createdAt: '2026-10-30T12:00:00.000Z', ...metadata },
    parts: [{ type: 'text', text }],
  };
}

const alice = { id: 'u-alice', name: 'Alice' };

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'luolicore-db-'));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openMemory(): Promise<Storage> {
  return createMemoryStorage();
}

async function openSqlite(): Promise<Storage> {
  const dir = await tempDir();
  const storage = openSqliteStorage(join(dir, 'luoli.db'));
  cleanups.push(async () => {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  return storage;
}

describe.each([
  ['内存', openMemory],
  ['SQLite', openSqlite],
])('%s存储', (_name, open) => {
  it('写入后 list 原样取回整条消息（含 author、usage、aborted），按序号排列', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const messages = [
      message('user', '你好', { author: alice }),
      message('assistant', '你好呀', { usage: { input: 10, output: 3, total: 13, cacheRead: 4 } }),
      message('assistant', '说到一半', { aborted: true }),
    ];
    for (const m of messages) await store.add(m);

    expect(await store.list()).toEqual(messages);
  });

  it('没有 id 的发言人原样往返', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const saved = message('user', '你好', { author: { name: '无名' } });
    await store.add(saved);

    expect(await store.list()).toEqual([saved]);
  });

  it('预留序号后先写入后来的消息、再用预留号写入：预留的那条排在前面', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const first = message('user', '一');
    await store.add(first);
    const reserved = await store.reserve();
    const later = message('user', '三');
    await store.add(later);
    const reply = message('assistant', '二');
    await store.add(reply, reserved);

    expect((await store.list()).map((m) => m.id)).toEqual([first.id, reply.id, later.id]);
    expect((await store.list({ before: reserved })).map((m) => m.id)).toEqual([first.id]);
  });

  it('同一序号不能写两次', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const seq = await store.reserve();
    await store.add(message('user', '一'), seq);

    await expect(store.add(message('user', '二'), seq)).rejects.toThrow();
  });

  it('两个会话互不影响，各自从序号 1 开始', async () => {
    const storage = await open();
    const a = await storage.openConversation(await storage.createConversation({ platform: 'cli' }));
    const b = await storage.openConversation(await storage.createConversation({ platform: 'cli' }));
    await a.add(message('user', 'A1'));
    await b.add(message('user', 'B1'));
    await a.add(message('user', 'A2'));

    expect((await a.list()).map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'A1' }],
      [{ type: 'text', text: 'A2' }],
    ]);
    expect((await b.list()).map((m) => m.parts)).toEqual([[{ type: 'text', text: 'B1' }]]);
    expect(await a.reserve()).toBe(3);
    expect(await b.reserve()).toBe(2);
  });

  it('打开不存在的会话报错；同一平台会话 id 不能建两次', async () => {
    const storage = await open();
    await expect(storage.openConversation('nope')).rejects.toThrow();
    await storage.createConversation({ platform: 'telegram', platformConversationId: '-100' });
    await expect(
      storage.createConversation({ platform: 'telegram', platformConversationId: '-100' }),
    ).rejects.toThrow();
    // CLI 会话没有平台会话 id，可以建任意多个
    await storage.createConversation({ platform: 'cli' });
    await storage.createConversation({ platform: 'cli' });
  });

  it('找最后一条消息最新的会话：只看指定平台，跳过没有消息的会话', async () => {
    const storage = await open();
    const create = async (platform: string, platformConversationId?: string) => {
      const id = await storage.createConversation({ platform, platformConversationId });
      return { id, store: await storage.openConversation(id) };
    };
    expect(await storage.findLatestConversation('cli')).toBeUndefined();

    // 创建顺序与消息时间相反：按会话创建时间找会得出错误的结果
    const newer = await create('cli');
    const older = await create('cli');
    await create('cli'); // 最后创建但没有消息
    const telegram = await create('telegram', '-100');
    await newer.store.add(message('user', '早', { createdAt: '2026-10-30T09:00:00.000Z' }));
    await older.store.add(message('user', '旧', { createdAt: '2026-10-29T09:00:00.000Z' }));
    await newer.store.add(message('assistant', '晚', { createdAt: '2026-10-30T10:00:00.000Z' }));
    await telegram.store.add(message('user', '最新', { createdAt: '2026-10-31T09:00:00.000Z' }));

    expect(await storage.findLatestConversation('cli')).toBe(newer.id);
    expect(await storage.findLatestConversation('telegram')).toBe(telegram.id);
    expect(await storage.findLatestConversation('none')).toBeUndefined();
  });
});

describe('SQLite 存储', () => {
  it('关闭后重新打开同一文件，数据还在，序号接着往下', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');

    const first = openSqliteStorage(path);
    const id = await first.createConversation({ platform: 'cli', title: '测试' });
    const saved = message('user', '你好', { author: alice });
    await (await first.openConversation(id)).add(saved);
    first.close();

    const second = openSqliteStorage(path);
    cleanups.push(async () => second.close());
    const store = await second.openConversation(id);
    expect(await store.list()).toEqual([saved]);
    expect(await second.findLatestConversation('cli')).toBe(id);
    expect(await store.reserve()).toBe(2);
  });

  it('新库：WAL 模式、user_version 为 1、三张表与索引按 ADR-0005 建好', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    openSqliteStorage(path).close();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      const objects = db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all()
        .map((row) => `${row.type}:${row.name}`);
      expect(objects).toEqual([
        'index:conversations_platform',
        'index:messages_order',
        'index:messages_platform',
        'index:segments_order',
        'table:conversations',
        'table:messages',
        'table:segments',
      ]);
      const columns = (table: string) =>
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name);
      expect(columns('conversations')).toEqual([
        'id',
        'platform',
        'platform_conversation_id',
        'title',
        'next_seq',
        'created_at',
      ]);
      expect(columns('messages')).toEqual([
        'id',
        'conversation_id',
        'seq',
        'role',
        'author_id',
        'platform_message_id',
        'created_at',
        'ui_message',
      ]);
      expect(columns('segments')).toEqual([
        'id',
        'conversation_id',
        'start_seq',
        'start_reason',
        'conversation_title',
        'prior_summary',
        'created_at',
      ]);
    } finally {
      db.close();
    }
  });

  it('user_version 大于 1 时打开报错', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 2');
    db.close();

    expect(() => openSqliteStorage(path)).toThrow('数据库版本比程序新');
  });

  it('消息行的 role、author_id、created_at 与消息本身一致，没有 id 的发言人 author_id 为空', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'cli' });
    const store = await storage.openConversation(id);
    const user = message('user', '你好', { author: alice, createdAt: '2026-10-30T08:00:00.000Z' });
    const anonymous = message('user', '我没有 id', {
      author: { name: '无名' },
      createdAt: '2026-10-30T08:00:02.000Z',
    });
    const reply = message('assistant', '你好呀', { createdAt: '2026-10-30T08:00:01.000Z' });
    await store.add(user);
    await store.add(reply);
    await store.add(anonymous);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db
        .prepare(
          'SELECT id, seq, role, author_id, platform_message_id, created_at FROM messages ORDER BY seq',
        )
        .all();
      expect(rows.map((row) => ({ ...row }))).toEqual([
        {
          id: user.id,
          seq: 1,
          role: 'user',
          author_id: 'u-alice',
          platform_message_id: null,
          created_at: '2026-10-30T08:00:00.000Z',
        },
        {
          id: reply.id,
          seq: 2,
          role: 'assistant',
          author_id: null,
          platform_message_id: null,
          created_at: '2026-10-30T08:00:01.000Z',
        },
        {
          id: anonymous.id,
          seq: 3,
          role: 'user',
          author_id: null,
          platform_message_id: null,
          created_at: '2026-10-30T08:00:02.000Z',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('两个连接（相当于两个进程）交替预留与写入同一会话，序号不重复', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const a = openSqliteStorage(path);
    const b = openSqliteStorage(path);
    cleanups.push(async () => {
      a.close();
      b.close();
    });
    const id = await a.createConversation({ platform: 'cli' });
    const [storeA, storeB] = [await a.openConversation(id), await b.openConversation(id)];

    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) {
      seqs.push(await storeA.reserve(), await storeB.reserve());
      await storeA.add(message('user', `a${i}`));
      await storeB.add(message('user', `b${i}`));
    }

    expect(new Set(seqs).size).toBe(seqs.length);
    expect(await storeA.list()).toHaveLength(40);
  });
});
