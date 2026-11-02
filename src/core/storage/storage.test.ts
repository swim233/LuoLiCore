import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryStorage,
  DuplicateMessageError,
  openSqliteStorage,
  type Message,
  type MessageMetadata,
  type ModelCall,
  type Storage,
  type ToolCall,
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

/** 一次模型调用，默认是正常完成的回复 */
function call(fields: Partial<ModelCall> = {}): ModelCall {
  return {
    purpose: 'reply',
    replyId: 'r1',
    model: 'test-model',
    startedAt: '2026-10-30T06:02:00.000Z',
    durationMs: 1500,
    firstOutputMs: 400,
    attempts: 1,
    outcome: 'completed',
    finishReason: 'stop',
    inputTokens: 120,
    cacheReadTokens: 100,
    outputTokens: 30,
    reasoningTokens: 12,
    steps: 1,
    toolCalls: 0,
    ...fields,
  };
}

/** 一次工具调用，默认是正常完成的 */
function toolCall(fields: Partial<ToolCall> = {}): ToolCall {
  return {
    replyId: 'r1',
    tool: 'dice',
    step: 1,
    startedAt: '2026-10-30T06:02:01.000Z',
    durationMs: 120,
    outcome: 'completed',
    outputChars: 11,
    ...fields,
  };
}

// ADR-0005 里 model_calls 的列，按顺序
const modelCallColumns = [
  'id',
  'conversation_id',
  'purpose',
  'summary_reason',
  'reply_id',
  'model',
  'started_at',
  'duration_ms',
  'first_output_ms',
  'attempts',
  'outcome',
  'finish_reason',
  'input_tokens',
  'cache_read_tokens',
  'output_tokens',
  'reasoning_tokens',
  'error',
  'steps',
  'tool_calls',
];

// ADR-0005 里 tool_calls 的列，按顺序
const toolCallColumns = [
  'id',
  'conversation_id',
  'reply_id',
  'tool',
  'step',
  'started_at',
  'duration_ms',
  'outcome',
  'error',
  'output_chars',
];

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

  it('按平台消息 id 找消息；update 按 id 换掉整条，序号不变、副本列不变；只在本会话里找', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'telegram' }),
    );
    const other = await storage.openConversation(
      await storage.createConversation({ platform: 'telegram' }),
    );
    const first = message('user', '一', { author: alice, platformMessageId: '100' });
    const second = message('user', '二', { platformMessageId: '101' });
    await store.add(first);
    await store.add(second);
    await other.add(message('user', '别的会话', { platformMessageId: '102' }));

    expect(await store.findByPlatformMessageId('100')).toEqual(first);
    expect(await store.findByPlatformMessageId('102')).toBeUndefined();
    expect(await store.findByPlatformMessageId('999')).toBeUndefined();

    const edited: Message = {
      ...first,
      metadata: { ...first.metadata!, editedAt: '2026-10-30T12:01:00.000Z' },
      parts: [{ type: 'text', text: '一（改）' }],
    };
    await store.update(edited);

    expect(await store.list()).toEqual([edited, second]);
    expect(await store.findByPlatformMessageId('100')).toEqual(edited);
    expect((await store.entries()).map((entry) => entry.seq)).toEqual([1, 2]);
    // 改返回的对象不影响存储里的
    const found = await store.findByPlatformMessageId('101');
    found!.parts = [];
    expect((await store.list())[1]).toEqual(second);
  });

  it('按 id 读一条消息：只在本会话里找，返回副本', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const other = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const saved = message('user', '你好', { author: alice });
    await store.add(saved);
    const elsewhere = message('user', '别的会话');
    await other.add(elsewhere);

    expect(await store.get(saved.id)).toEqual(saved);
    expect(await store.get(elsewhere.id)).toBeUndefined();
    expect(await store.get('missing')).toBeUndefined();
    const found = await store.get(saved.id);
    found!.parts = [];
    expect(await store.get(saved.id)).toEqual(saved);
  });

  it('update 一条不存在的消息时报错', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );

    await expect(store.update(message('user', '不存在'))).rejects.toThrow();
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

  it('按序号区间读消息：from 含、before 不含，entries 附带序号；last 给出序号最大的那条', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    expect(await store.last()).toBeUndefined();
    const first = message('user', '一', { createdAt: '2026-10-30T08:00:00.000Z' });
    await store.add(first);
    const reserved = await store.reserve(); // 空着的序号 2
    const third = message('user', '三', { createdAt: '2026-10-30T08:03:00.000Z' });
    await store.add(third);
    const fourth = message('assistant', '四', { createdAt: '2026-10-30T08:04:00.000Z' });
    await store.add(fourth);

    expect(reserved).toBe(2);
    expect(await store.entries({ from: 2 })).toEqual([
      { seq: 3, message: third },
      { seq: 4, message: fourth },
    ]);
    expect(await store.list({ from: 1, before: 4 })).toEqual([first, third]);
    expect(await store.list({ from: 4, before: 4 })).toEqual([]);
    expect(await store.last()).toEqual({ seq: 4, createdAt: '2026-10-30T08:04:00.000Z' });
  });

  it('新建会话即有第一段：从 1 开始、标题为会话标题、没有摘要', async () => {
    const storage = await open();
    const titled = await storage.openConversation(
      await storage.createConversation({
        platform: 'telegram',
        platformConversationId: '-1',
        title: '读书会',
      }),
    );
    const untitled = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );

    expect(await titled.currentSegment()).toEqual({
      startSeq: 1,
      startReason: 'first',
      conversationTitle: '读书会',
    });
    expect(await untitled.currentSegment()).toEqual({ startSeq: 1, startReason: 'first' });
  });

  it('开始新的一段：当前段是 startSeq 最大的一段，标题取会话标题；同一序号已有一段时不写入、返回 false', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli', title: '群' }),
    );
    await store.addSegment({ startSeq: 9, startReason: 'compress', priorSummary: '后' });
    await store.addSegment({ startSeq: 5, startReason: 'idle', priorSummary: '前' });

    expect(await store.currentSegment()).toEqual({
      startSeq: 9,
      startReason: 'compress',
      conversationTitle: '群',
      priorSummary: '后',
    });
    expect(
      await store.addSegment({ startSeq: 5, startReason: 'compress', priorSummary: '重复' }),
    ).toBe(false);
    expect(
      await store.addSegment({ startSeq: 12, startReason: 'idle', priorSummary: '再后' }),
    ).toBe(true);
    expect(await store.currentSegment()).toMatchObject({ startSeq: 12, priorSummary: '再后' });
  });

  it('按平台与平台会话 id 找会话；列出某平台的会话；改标题只影响之后开始的段', async () => {
    const storage = await open();
    const group = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-100',
      title: '旧名',
    });
    const dm = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '11',
      title: '与 Alice 的私聊',
    });
    await storage.createConversation({ platform: 'cli' });

    expect(await storage.findConversation('telegram', '-100')).toEqual({
      id: group,
      platformConversationId: '-100',
      title: '旧名',
    });
    expect(await storage.findConversation('telegram', '-999')).toBeUndefined();
    expect(await storage.findConversation('cli', '-100')).toBeUndefined();
    expect((await storage.listConversations('telegram')).map((c) => c.id)).toEqual([group, dm]);

    await storage.updateTitle(group, '新名');
    const store = await storage.openConversation(group);
    await store.addSegment({ startSeq: 5, startReason: 'idle', priorSummary: '摘要' });

    expect((await storage.findConversation('telegram', '-100'))?.title).toBe('新名');
    expect((await store.currentSegment()).conversationTitle).toBe('新名');
    await expect(storage.updateTitle('nope', 'x')).rejects.toThrow();
  });

  it('同一会话里平台消息 id 不能重复；不同会话可以', async () => {
    const storage = await open();
    const a = await storage.openConversation(
      await storage.createConversation({ platform: 'telegram', platformConversationId: '1' }),
    );
    const b = await storage.openConversation(
      await storage.createConversation({ platform: 'telegram', platformConversationId: '2' }),
    );
    await a.add(message('user', '一', { platformMessageId: '7' }));
    await b.add(message('user', '一', { platformMessageId: '7' }));

    await expect(a.add(message('user', '二', { platformMessageId: '7' }))).rejects.toThrow(
      DuplicateMessageError,
    );
    expect(await a.list()).toHaveLength(1);
    // 序号冲突是另一种错误，不能当成重复的平台消息
    const seq = await a.reserve();
    await a.add(message('user', '三'), seq);
    await expect(a.add(message('user', '四', { platformMessageId: '8' }), seq)).rejects.not.toThrow(
      DuplicateMessageError,
    );
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

  it('记下的模型调用按写入先后读回，没有的项为空；只读到本会话的', async () => {
    const storage = await open();
    const a = await storage.openConversation(await storage.createConversation({ platform: 'cli' }));
    const b = await storage.openConversation(await storage.createConversation({ platform: 'cli' }));
    const reply = call();
    const failed = call({
      replyId: 'r2',
      firstOutputMs: undefined,
      attempts: 3,
      outcome: 'failed',
      finishReason: undefined,
      inputTokens: undefined,
      cacheReadTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
      error: 'APICallError 429',
    });
    const summary = call({ purpose: 'summary', summaryReason: 'idle', replyId: undefined });

    await a.recordCall(reply);
    await b.recordCall(summary);
    await a.recordCall(failed);

    expect(await a.calls()).toEqual([reply, failed]);
    expect(await b.calls()).toEqual([summary]);
  });

  it('读回的模型调用是副本：改动不影响存储', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const recorded = call();
    await store.recordCall(recorded);
    recorded.attempts = 9;
    (await store.calls())[0]!.outcome = 'failed';

    expect(await store.calls()).toEqual([call()]);
  });

  it('记下的工具调用按写入先后读回，没有的项为空；只读到本会话的；读回的是副本', async () => {
    const storage = await open();
    const a = await storage.openConversation(await storage.createConversation({ platform: 'cli' }));
    const b = await storage.openConversation(await storage.createConversation({ platform: 'cli' }));
    const completed = toolCall();
    const failed = toolCall({
      replyId: 'r2',
      tool: 'nope',
      step: 2,
      durationMs: 0,
      outcome: 'failed',
      error: 'NoSuchToolError',
      outputChars: undefined,
    });
    const timeout = toolCall({ outcome: 'timeout', outputChars: undefined });

    await a.recordToolCall(completed);
    await b.recordToolCall(timeout);
    await a.recordToolCall(failed);
    completed.step = 9;
    (await a.toolCalls())[0]!.tool = '改过';

    expect(await a.toolCalls()).toEqual([toolCall(), failed]);
    expect(await b.toolCalls()).toEqual([timeout]);
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

  it('新库：WAL 模式、user_version 为 3、五张表与索引按 ADR-0005 建好', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    openSqliteStorage(path).close();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
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
        'index:model_calls_conversation',
        'index:model_calls_time',
        'index:segments_order',
        'index:tool_calls_time',
        'index:tool_calls_tool',
        'table:conversations',
        'table:messages',
        'table:model_calls',
        'table:segments',
        'table:tool_calls',
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
      expect(columns('model_calls')).toEqual(modelCallColumns);
      expect(columns('tool_calls')).toEqual(toolCallColumns);
      const indexed = (index: string) =>
        db
          .prepare(`PRAGMA index_info(${index})`)
          .all()
          .map((row) => row.name);
      expect(indexed('model_calls_time')).toEqual(['started_at']);
      expect(indexed('model_calls_conversation')).toEqual(['conversation_id', 'started_at']);
      expect(indexed('tool_calls_time')).toEqual(['started_at']);
      expect(indexed('tool_calls_tool')).toEqual(['tool', 'started_at']);
    } finally {
      db.close();
    }
  });

  it('第 2 步建的会话没有段：当前段视为从 1 开始、标题取会话标题的第一段', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'cli', title: '老群' });
    const db = new DatabaseSync(path);
    db.exec('DELETE FROM segments');
    db.close();

    expect(await (await storage.openConversation(id)).currentSegment()).toEqual({
      startSeq: 1,
      startReason: 'first',
      conversationTitle: '老群',
    });
  });

  it('段的行：标题是插入时会话标题的快照，之后改名不影响已有的段', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-1',
      title: '旧名',
    });
    const store = await storage.openConversation(id);
    const db = new DatabaseSync(path);
    try {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('新名', id);
      await store.addSegment({ startSeq: 3, startReason: 'idle', priorSummary: '摘要' });

      const rows = db
        .prepare(
          `SELECT conversation_id, start_seq, start_reason, conversation_title, prior_summary, created_at
           FROM segments ORDER BY start_seq`,
        )
        .all()
        .map((row) => ({ ...row }));
      expect(rows).toEqual([
        {
          conversation_id: id,
          start_seq: 1,
          start_reason: 'first',
          conversation_title: '旧名',
          prior_summary: null,
          created_at: expect.any(String),
        },
        {
          conversation_id: id,
          start_seq: 3,
          start_reason: 'idle',
          conversation_title: '新名',
          prior_summary: '摘要',
          created_at: expect.any(String),
        },
      ]);
      expect(new Date(String(rows[1]?.created_at)).toISOString()).toBe(rows[1]?.created_at);
    } finally {
      db.close();
    }
  });

  it('user_version 大于 3 时打开报错', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 4');
    db.close();

    expect(() => openSqliteStorage(path)).toThrow('数据库版本比程序新');
  });

  it('消息行的 role、author_id、platform_message_id、created_at 与消息本身一致，没有的为空', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'cli' });
    const store = await storage.openConversation(id);
    const user = message('user', '你好', {
      author: alice,
      createdAt: '2026-10-30T08:00:00.000Z',
      platformMessageId: '42',
    });
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
          platform_message_id: '42',
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

  it('模型调用的行：会话 id 是所在的会话，各列照写入的值；没报的为 NULL，报了 0 的为 0', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'cli' });
    const store = await storage.openConversation(id);
    await store.recordCall(call({ cacheReadTokens: undefined, reasoningTokens: undefined }));
    await store.recordCall(
      call({
        purpose: 'summary',
        summaryReason: 'compress',
        replyId: undefined,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      }),
    );

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT * FROM model_calls ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
      const common = {
        conversation_id: id,
        model: 'test-model',
        started_at: '2026-10-30T06:02:00.000Z',
        duration_ms: 1500,
        first_output_ms: 400,
        attempts: 1,
        outcome: 'completed',
        finish_reason: 'stop',
        input_tokens: 120,
        output_tokens: 30,
        error: null,
        steps: 1,
        tool_calls: 0,
      };
      expect(rows).toEqual([
        {
          id: 1,
          purpose: 'reply',
          summary_reason: null,
          reply_id: 'r1',
          ...common,
          cache_read_tokens: null,
          reasoning_tokens: null,
        },
        {
          id: 2,
          purpose: 'summary',
          summary_reason: 'compress',
          reply_id: null,
          ...common,
          cache_read_tokens: 0,
          reasoning_tokens: 0,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('工具调用的行：会话 id 是所在的会话，各列照写入的值；没有的为 NULL', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'cli' });
    const store = await storage.openConversation(id);
    await store.recordToolCall(toolCall());
    await store.recordToolCall(
      toolCall({
        tool: 'nope',
        step: 2,
        durationMs: 0,
        outcome: 'failed',
        error: 'NoSuchToolError',
        outputChars: undefined,
      }),
    );

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        db
          .prepare('SELECT * FROM tool_calls ORDER BY id')
          .all()
          .map((row) => ({ ...row })),
      ).toEqual([
        {
          id: 1,
          conversation_id: id,
          reply_id: 'r1',
          tool: 'dice',
          step: 1,
          started_at: '2026-10-30T06:02:01.000Z',
          duration_ms: 120,
          outcome: 'completed',
          error: null,
          output_chars: 11,
        },
        {
          id: 2,
          conversation_id: id,
          reply_id: 'r1',
          tool: 'nope',
          step: 2,
          started_at: '2026-10-30T06:02:01.000Z',
          duration_ms: 0,
          outcome: 'failed',
          error: 'NoSuchToolError',
          output_chars: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('版本 2 的库：打开时升到版本 3，旧的模型调用行两列为空，新写入的有值；能写工具调用', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    // 第二阶段第 8 步的程序建的库：四张表，user_version 为 2，已有一行模型调用
    const old = new DatabaseSync(path);
    old.exec('PRAGMA journal_mode = WAL');
    old.exec(version1Schema);
    old.exec(version2Schema);
    old.exec('PRAGMA user_version = 2');
    old.exec(`
      INSERT INTO conversations (id, platform, next_seq, created_at)
        VALUES ('c1', 'cli', 1, '2026-10-29T00:00:00.000Z');
      INSERT INTO model_calls
          (conversation_id, purpose, reply_id, model, started_at, duration_ms, first_output_ms,
           attempts, outcome, finish_reason, input_tokens, cache_read_tokens, output_tokens,
           reasoning_tokens)
        VALUES ('c1', 'reply', 'r0', 'test-model', '2026-10-29T06:00:00.000Z', 900, 300,
                1, 'completed', 'stop', 50, NULL, 5, NULL);
    `);
    const before = old
      .prepare('SELECT * FROM model_calls')
      .all()
      .map((row) => ({ ...row }));
    old.close();

    const storage = openSqliteStorage(path);
    const store = await storage.openConversation('c1');
    await store.recordCall(call({ steps: 2, toolCalls: 3 }));
    await store.recordToolCall(toolCall());
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      const rows = db
        .prepare('SELECT * FROM model_calls ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
      expect(rows[0]).toEqual({ ...before[0], steps: null, tool_calls: null });
      expect(rows[1]).toMatchObject({ steps: 2, tool_calls: 3 });
    } finally {
      db.close();
    }

    const reopened = openSqliteStorage(path);
    cleanups.push(async () => reopened.close());
    const calls = await (await reopened.openConversation('c1')).calls();
    expect(calls[0]).toMatchObject({ replyId: 'r0', steps: undefined, toolCalls: undefined });
    expect(calls[1]).toEqual(call({ steps: 2, toolCalls: 3 }));
    expect(await (await reopened.openConversation('c1')).toolCalls()).toEqual([toolCall()]);
  });

  it('版本 1 的库：打开时升到版本 3，原有的表与数据不变，能写模型调用；重新打开后能读回', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    // 第 7 步的程序建的库：三张表，user_version 为 1
    const old = new DatabaseSync(path);
    old.exec('PRAGMA journal_mode = WAL');
    old.exec(version1Schema);
    old.exec('PRAGMA user_version = 1');
    old.exec(`
      INSERT INTO conversations (id, platform, platform_conversation_id, title, next_seq, created_at)
        VALUES ('c1', 'telegram', '-100', '读书会', 3, '2026-10-29T00:00:00.000Z');
      INSERT INTO segments
          (id, conversation_id, start_seq, start_reason, conversation_title, prior_summary, created_at)
        VALUES ('s1', 'c1', 1, 'first', '读书会', NULL, '2026-10-29T00:00:00.000Z'),
               ('s2', 'c1', 2, 'idle', '读书会', '昨天的摘要', '2026-10-30T00:00:00.000Z');
    `);
    const saved = [
      message('user', '早', { author: alice, platformMessageId: '7' }),
      message('assistant', '早上好'),
    ];
    for (const [index, item] of saved.entries()) {
      old
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, seq, role, author_id, platform_message_id, created_at, ui_message)
           VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          index + 1,
          item.role,
          item.metadata?.author?.id ?? null,
          item.metadata?.platformMessageId ?? null,
          item.metadata!.createdAt,
          JSON.stringify(item),
        );
    }
    const dump = (db: DatabaseSync) =>
      ['conversations', 'messages', 'segments'].map((table) =>
        db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => ({ ...row })),
      );
    const before = dump(old);
    old.close();

    const storage = openSqliteStorage(path);
    const store = await storage.openConversation('c1');
    expect(await store.list()).toEqual(saved);
    expect(await store.currentSegment()).toMatchObject({ startSeq: 2, priorSummary: '昨天的摘要' });
    await store.recordCall(call());
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      expect(dump(db)).toEqual(before);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'model_calls' ORDER BY name")
          .all()
          .map((row) => row.name),
      ).toEqual(['model_calls', 'model_calls_conversation', 'model_calls_time']);
    } finally {
      db.close();
    }

    const reopened = openSqliteStorage(path);
    cleanups.push(async () => reopened.close());
    expect(await (await reopened.openConversation('c1')).calls()).toEqual([call()]);
  });

  it('docs/queries/usage.sql 的查询在库上能跑通：按本地时区分天，缓存命中率只算报了缓存数的调用', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    const group = await storage.openConversation(
      await storage.createConversation({
        platform: 'telegram',
        platformConversationId: '-100',
        title: '读书会',
      }),
    );
    const cli = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const noTokens = {
      inputTokens: undefined,
      cacheReadTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
    };
    // 上海时间：10-30 10:00、10-31 04:00、10-31 05:00、10-31 09:00
    await group.recordCall(
      call({
        model: 'm1',
        startedAt: '2026-10-30T02:00:00.000Z',
        inputTokens: 100,
        cacheReadTokens: 80,
        outputTokens: 10,
        reasoningTokens: undefined,
      }),
    );
    await group.recordCall(
      call({
        model: 'm1',
        startedAt: '2026-10-30T20:00:00.000Z',
        inputTokens: 200,
        cacheReadTokens: undefined,
        outputTokens: 20,
        reasoningTokens: 5,
      }),
    );
    await group.recordCall(
      call({
        model: 'm1',
        startedAt: '2026-10-30T21:00:00.000Z',
        attempts: 3,
        outcome: 'failed',
        finishReason: undefined,
        ...noTokens,
        error: 'APICallError 429',
      }),
    );
    await cli.recordCall(
      call({
        purpose: 'summary',
        summaryReason: 'idle',
        replyId: undefined,
        model: 'm2',
        startedAt: '2026-10-31T01:00:00.000Z',
        inputTokens: 400,
        cacheReadTokens: 100,
        outputTokens: 30,
        reasoningTokens: 0,
      }),
    );
    // 工具调用：dice 三次（一次超时），search 一次失败
    await group.recordToolCall(toolCall({ durationMs: 100, outputChars: 10 }));
    await group.recordToolCall(toolCall({ durationMs: 300, outputChars: 30 }));
    await group.recordToolCall(
      toolCall({
        startedAt: '2026-10-31T02:00:00.000Z',
        step: 2,
        durationMs: 60_000,
        outcome: 'timeout',
        outputChars: undefined,
      }),
    );
    await cli.recordToolCall(
      toolCall({
        tool: 'search',
        startedAt: '2026-10-31T03:00:00.000Z',
        durationMs: 0,
        outcome: 'failed',
        error: 'InvalidToolInputError',
        outputChars: undefined,
      }),
    );
    storage.close();

    // sqlite3 的点命令（表头、对齐）不是 SQL，去掉后按分号分成各条查询
    const source = await readFile(
      new URL('../../../docs/queries/usage.sql', import.meta.url),
      'utf8',
    );
    const queries = source
      .split('\n')
      .filter((line) => !line.startsWith('.'))
      .join('\n')
      .split(';')
      .filter((query) =>
        query.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')),
      );
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const [byDay, byConversation, byModel, failures, byTool, toolFailures] = queries.map(
        (query) =>
          db
            .prepare(query)
            .all()
            .map((row) => ({ ...row })),
      );
      expect(queries).toHaveLength(6);
      expect(byDay).toEqual([
        {
          日期: '2026-10-30',
          调用: 1,
          失败: 0,
          输入: 100,
          缓存命中: 80,
          命中率: 80,
          输出: 10,
          推理: null,
        },
        {
          日期: '2026-10-31',
          调用: 3,
          失败: 1,
          输入: 600,
          缓存命中: 100,
          命中率: 25,
          输出: 50,
          推理: 5,
        },
      ]);
      expect(byConversation).toEqual([
        { 平台: 'cli', 标题: null, 调用: 1, 输入: 400, 命中率: 25, 输出: 30 },
        { 平台: 'telegram', 标题: '读书会', 调用: 3, 输入: 300, 命中率: 80, 输出: 30 },
      ]);
      expect(byModel).toEqual([
        { 模型: 'm2', 调用: 1, 输入: 400, 命中率: 25, 输出: 30 },
        { 模型: 'm1', 调用: 3, 输入: 300, 命中率: 80, 输出: 30 },
      ]);
      expect(failures).toEqual([
        {
          时间: '2026-10-31 05:00:00',
          标题: '读书会',
          用途: 'reply',
          错误: 'APICallError 429',
          请求: 3,
        },
      ]);
      expect(byTool).toEqual([
        { 工具: 'dice', 调用: 3, 失败: 0, 超时: 1, 平均耗时: 20133, 平均长度: 20, 最大长度: 30 },
        {
          工具: 'search',
          调用: 1,
          失败: 1,
          超时: 0,
          平均耗时: 0,
          平均长度: null,
          最大长度: null,
        },
      ]);
      expect(toolFailures).toEqual([
        {
          时间: '2026-10-31 11:00:00',
          标题: null,
          工具: 'search',
          步: 1,
          结果: 'failed',
          错误: 'InvalidToolInputError',
          耗时: 0,
        },
        {
          时间: '2026-10-31 10:00:00',
          标题: '读书会',
          工具: 'dice',
          步: 2,
          结果: 'timeout',
          错误: null,
          耗时: 60_000,
        },
      ]);
    } finally {
      db.close();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

// 第 7 步（表结构版本 1）的建表语句，用来造一个旧库
// 第二阶段第 8 步（表结构版本 2）加的模型调用表，接在 version1Schema 之后，用来造一个版本 2 的库
const version2Schema = `
CREATE TABLE model_calls (
  id                INTEGER PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  purpose           TEXT NOT NULL,
  summary_reason    TEXT,
  reply_id          TEXT,
  model             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  first_output_ms   INTEGER,
  attempts          INTEGER NOT NULL,
  outcome           TEXT NOT NULL,
  finish_reason     TEXT,
  input_tokens      INTEGER,
  cache_read_tokens INTEGER,
  output_tokens     INTEGER,
  reasoning_tokens  INTEGER,
  error             TEXT
);
CREATE INDEX model_calls_time         ON model_calls(started_at);
CREATE INDEX model_calls_conversation ON model_calls(conversation_id, started_at);
`;

const version1Schema = `
CREATE TABLE conversations (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL,
  platform_conversation_id TEXT,
  title                    TEXT,
  next_seq                 INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX conversations_platform
  ON conversations(platform, platform_conversation_id) WHERE platform_conversation_id IS NOT NULL;

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  seq                 INTEGER NOT NULL,
  role                TEXT NOT NULL,
  author_id           TEXT,
  platform_message_id TEXT,
  created_at          TEXT NOT NULL,
  ui_message          TEXT NOT NULL
);
CREATE UNIQUE INDEX messages_order    ON messages(conversation_id, seq);
CREATE UNIQUE INDEX messages_platform ON messages(conversation_id, platform_message_id)
  WHERE platform_message_id IS NOT NULL;

CREATE TABLE segments (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id),
  start_seq          INTEGER NOT NULL,
  start_reason       TEXT NOT NULL,
  conversation_title TEXT,
  prior_summary      TEXT,
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX segments_order ON segments(conversation_id, start_seq);
`;
