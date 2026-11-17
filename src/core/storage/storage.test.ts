import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryStorage,
  DuplicateMessageError,
  openSqliteStorage,
  readConversations,
  type Message,
  type MessageMetadata,
  type ModelCall,
  type NewTask,
  type Storage,
  type Task,
  type TaskSchedule,
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
const bob = { id: 'u-bob', name: 'Bob' };

/** 一个新任务，默认是明早 9 点（上海）提醒交周报的一次性任务，Alice 在 42 号消息里让建的 */
function newTask(conversationId: string, fields: Partial<NewTask> = {}): NewTask {
  return {
    conversationId,
    action: '提醒 Alice 交周报',
    schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
    source: { author: alice, messageId: 'm-src', platformMessageId: '42' },
    nextDueAt: '2026-11-10T01:00:00.000Z',
    createdAt: '2026-11-09T13:30:00.000Z',
    ...fields,
  };
}

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
  'tool_call_id',
];

// ADR-0005 里 tasks 的列，按顺序
const taskColumns = [
  'id',
  'conversation_id',
  'action',
  'schedule',
  'source_author_id',
  'source_author_name',
  'source_message_id',
  'source_platform_message_id',
  'status',
  'next_due_at',
  'last_due_at',
  'due_count',
  'created_at',
  'ended_at',
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
      createdAt: expect.any(String),
    });
    expect(await untitled.currentSegment()).toEqual({
      startSeq: 1,
      startReason: 'first',
      createdAt: expect.any(String),
    });
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
      createdAt: expect.any(String),
    });
    expect(
      await store.addSegment({ startSeq: 5, startReason: 'compress', priorSummary: '重复' }),
    ).toBe(false);
    expect(
      await store.addSegment({ startSeq: 12, startReason: 'idle', priorSummary: '再后' }),
    ).toBe(true);
    expect(await store.currentSegment()).toMatchObject({ startSeq: 12, priorSummary: '再后' });
  });

  it('手动压缩与清空的段：原因与执行人能写能读，currentSegment 与 segments() 都带执行人与时间；没有 id 的执行人只有名字', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({
        platform: 'telegram',
        platformConversationId: '-1',
        title: '群',
      }),
    );
    const startedBy = { ...bob };

    expect(
      await store.addSegment({
        startSeq: 3,
        startReason: 'manual',
        priorSummary: '手动',
        startedBy,
      }),
    ).toBe(true);
    // 存进去的是一份副本
    startedBy.name = '改了';
    expect(
      await store.addSegment({
        startSeq: 6,
        startReason: 'clear',
        startedBy: { name: 'cli-user' },
      }),
    ).toBe(true);

    const segments = await store.segments();
    expect(segments).toEqual([
      { startSeq: 1, startReason: 'first', conversationTitle: '群', createdAt: expect.any(String) },
      {
        startSeq: 3,
        startReason: 'manual',
        conversationTitle: '群',
        priorSummary: '手动',
        startedBy: bob,
        createdAt: expect.any(String),
      },
      {
        startSeq: 6,
        startReason: 'clear',
        conversationTitle: '群',
        startedBy: { name: 'cli-user' },
        createdAt: expect.any(String),
      },
    ]);
    expect(segments[0]).not.toHaveProperty('startedBy');
    expect(segments[2]).not.toHaveProperty('priorSummary');
    expect(segments[2]!.startedBy).not.toHaveProperty('id');
    for (const segment of segments) {
      expect(new Date(segment.createdAt).toISOString()).toBe(segment.createdAt);
    }
    expect(await store.currentSegment()).toEqual(segments[2]);
    expect(
      await store.addSegment({
        startSeq: 6,
        startReason: 'manual',
        priorSummary: '重复',
        startedBy: bob,
      }),
    ).toBe(false);
    expect(await store.segments()).toEqual(segments);
  });

  it('把还没有消息的当前段改成清空的段：段数不变，原因 clear，去掉摘要，记下执行人，时间与标题取改写的时候', async () => {
    const storage = await open();
    const id = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-1',
      title: '旧名',
    });
    const store = await storage.openConversation(id);
    await store.add(message('user', '一', { author: alice }));
    await store.add(message('assistant', '二'));
    await store.addSegment({ startSeq: 3, startReason: 'idle', priorSummary: '摘要' });
    const idle = (await store.segments())[1]!;
    await storage.updateTitle(id, '新名');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = new Date().toISOString();

    expect(await store.clearSegment({ startSeq: 3, startedBy: bob })).toBe(true);

    const segments = await store.segments();
    expect(segments).toHaveLength(2);
    expect(segments[1]).toEqual({
      startSeq: 3,
      startReason: 'clear',
      conversationTitle: '新名',
      startedBy: bob,
      createdAt: expect.any(String),
    });
    expect(segments[1]).not.toHaveProperty('priorSummary');
    expect(segments[1]!.createdAt >= before).toBe(true);
    expect(segments[1]!.createdAt > idle.createdAt).toBe(true);
    expect(await store.currentSegment()).toEqual(segments[1]);
    // 消息不动
    expect((await store.list()).map((m) => m.parts)).toEqual([
      [{ type: 'text', text: '一' }],
      [{ type: 'text', text: '二' }],
    ]);
  });

  it('改写只在当前段没有消息时允许：当前段有消息、给的不是当前段的起点时不写入，返回 false，段原样', async () => {
    const storage = await open();
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    await store.add(message('user', '一'));
    // 第一段有消息
    expect(await store.clearSegment({ startSeq: 1, startedBy: bob })).toBe(false);
    await store.addSegment({ startSeq: 2, startReason: 'idle', priorSummary: '摘要' });
    const before = await store.segments();

    // 不是当前段的起点：之前的一段、没有的一段
    expect(await store.clearSegment({ startSeq: 1, startedBy: bob })).toBe(false);
    expect(await store.clearSegment({ startSeq: 5, startedBy: bob })).toBe(false);
    // 当前段写进了一条消息
    await store.add(message('user', '二'));
    expect(await store.clearSegment({ startSeq: 2, startedBy: bob })).toBe(false);

    expect(await store.segments()).toEqual(before);
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
      toolCallId: 'call_9',
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

  describe('读取', () => {
    /** 一个会话，依次写入 count 条消息（用户、助手交替），返回存储与会话 */
    async function withMessages(count: number) {
      const storage = await open();
      const id = await storage.createConversation({ platform: 'cli' });
      const store = await storage.openConversation(id);
      const written: Message[] = [];
      for (let i = 1; i <= count; i++) {
        const m = message(i % 2 === 1 ? 'user' : 'assistant', `第 ${i} 条`, {
          createdAt: `2026-10-30T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
          ...(i % 2 === 1 ? { author: alice } : {}),
        });
        written.push(m);
        await store.add(m);
      }
      return { storage, id, store, written };
    }

    it('entry：按 id 取一条，带序号与时间；别的会话的、不存在的为 undefined', async () => {
      const { storage, store, written } = await withMessages(3);
      const other = await storage.openConversation(
        await storage.createConversation({ platform: 'cli' }),
      );

      expect(await store.entry(written[1]!.id)).toEqual({
        seq: 2,
        createdAt: '2026-10-30T12:02:00.000Z',
        message: written[1],
      });
      expect(await other.entry(written[1]!.id)).toBeUndefined();
      expect(await store.entry('nope')).toBeUndefined();
    });

    it('entry：消息没带时间时，时间是写入时间', async () => {
      const storage = await open();
      const store = await storage.openConversation(
        await storage.createConversation({ platform: 'cli' }),
      );
      const m: Message = { id: 'no-time', role: 'user', parts: [{ type: 'text', text: '无' }] };
      const before = new Date().toISOString();
      await store.add(m);

      const entry = await store.entry('no-time');
      expect(entry!.createdAt >= before).toBe(true);
      expect(entry!.createdAt <= new Date().toISOString()).toBe(true);
    });

    it('page：从最新往前一批批取，按序号升序；hasMore 说明前面还有没有', async () => {
      const { store, written } = await withMessages(7);
      const seqs = (page: { entries: Array<{ seq: number }> }) => page.entries.map((e) => e.seq);

      const latest = await store.page({ limit: 3 });
      expect(seqs(latest)).toEqual([5, 6, 7]);
      expect(latest.hasMore).toBe(true);
      expect(latest.entries[0]).toEqual({
        seq: 5,
        createdAt: '2026-10-30T12:05:00.000Z',
        message: written[4],
      });

      const earlier = await store.page({ before: 5, limit: 3 });
      expect(seqs(earlier)).toEqual([2, 3, 4]);
      expect(earlier.hasMore).toBe(true);

      // 正好取到头：前面没有了
      const first = await store.page({ before: 2, limit: 1 });
      expect(seqs(first)).toEqual([1]);
      expect(first.hasMore).toBe(false);
      // 不够一批
      expect(await store.page({ before: 3, limit: 10 })).toMatchObject({ hasMore: false });
      expect(seqs(await store.page({ before: 3, limit: 10 }))).toEqual([1, 2]);
      // 最前面之前什么也没有
      expect(await store.page({ before: 1, limit: 10 })).toEqual({ entries: [], hasMore: false });
      // 全部正好一批
      const all = await store.page({ limit: 7 });
      expect(seqs(all)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(all.hasMore).toBe(false);
    });

    it('page：序号有空洞（预留了没写入）时照样按序号取', async () => {
      const storage = await open();
      const store = await storage.openConversation(
        await storage.createConversation({ platform: 'cli' }),
      );
      await store.add(message('user', '一'));
      await store.reserve();
      await store.add(message('user', '三'));

      const page = await store.page({ limit: 1 });
      expect(page.entries.map((e) => e.seq)).toEqual([3]);
      expect(page.hasMore).toBe(true);
      expect((await store.page({ before: 3, limit: 5 })).entries.map((e) => e.seq)).toEqual([1]);
    });

    it('page：取到的消息是副本，改了不影响存储', async () => {
      const { store } = await withMessages(2);
      const page = await store.page({ limit: 2 });
      (page.entries[0]!.message.parts[0] as { text: string }).text = '改过';

      expect(((await store.list())[0]!.parts[0] as { text: string }).text).toBe('第 1 条');
    });

    it('count：某序号之后的条数，可以只数一种角色', async () => {
      const { store } = await withMessages(5);

      expect(await store.count()).toBe(5);
      expect(await store.count({ after: 2 })).toBe(3);
      expect(await store.count({ role: 'user' })).toBe(3);
      expect(await store.count({ after: 2, role: 'user' })).toBe(2);
      expect(await store.count({ after: 2, role: 'assistant' })).toBe(1);
      expect(await store.count({ after: 5 })).toBe(0);
    });

    it('count：excludeEvents 时不数事件（metadata 有 event 的用户消息），没有发言人的普通用户消息照数', async () => {
      const storage = await open();
      const store = await storage.openConversation(
        await storage.createConversation({ platform: 'web' }),
      );
      await store.add(message('user', '早', { author: alice }));
      await store.add(message('user', '任务到点', { event: { type: 'task', taskId: 1 } }));
      await store.add(message('assistant', '好的'));
      await store.add(message('user', '错过了', { event: { type: 'task-missed', taskId: 2 } }));
      // 没有发言人、也不是事件（如很早以前写的）
      await store.add(message('user', '无名'));

      expect(await store.count({ role: 'user' })).toBe(4);
      expect(await store.count({ role: 'user', excludeEvents: true })).toBe(2);
      expect(await store.count({ after: 1, role: 'user', excludeEvents: true })).toBe(1);
      expect(await store.count({ excludeEvents: true })).toBe(3);
      expect(await store.count({ excludeEvents: false })).toBe(5);
    });

    it('概览：最后一条是事件时，要点里有事件的类型，没有发言人', async () => {
      const storage = await open();
      const id = await storage.createConversation({ platform: 'web' });
      const store = await storage.openConversation(id);
      await store.add(message('user', '早', { author: alice }));
      await store.add(
        message('user', '错过了：交周报', { event: { type: 'task-missed', taskId: 3 } }),
      );

      const last = (await storage.overview(id))?.last;
      expect(last).toStrictEqual({
        seq: 2,
        createdAt: '2026-10-30T12:00:00.000Z',
        role: 'user',
        event: 'task-missed',
        text: '错过了：交周报',
        files: 0,
      });
      expect((await storage.overviews())[0]?.last?.event).toBe('task-missed');
      await store.add(message('user', '收到', { author: alice }));
      expect((await storage.overview(id))?.last).not.toHaveProperty('event');
    });

    it('segments：全部段按开始的序号升序，带标题快照、摘要与时间', async () => {
      const storage = await open();
      const id = await storage.createConversation({ platform: 'telegram', title: '读书会' });
      const store = await storage.openConversation(id);
      const before = new Date().toISOString();
      await store.addSegment({ startSeq: 10, startReason: 'compress', priorSummary: '后来' });
      await storage.updateTitle(id, '新群名');
      await store.addSegment({ startSeq: 5, startReason: 'idle', priorSummary: '之前' });

      const segments = await store.segments();
      expect(segments).toEqual([
        {
          startSeq: 1,
          startReason: 'first',
          conversationTitle: '读书会',
          createdAt: expect.any(String),
        },
        {
          startSeq: 5,
          startReason: 'idle',
          conversationTitle: '新群名',
          priorSummary: '之前',
          createdAt: expect.any(String),
        },
        {
          startSeq: 10,
          startReason: 'compress',
          conversationTitle: '读书会',
          priorSummary: '后来',
          createdAt: expect.any(String),
        },
      ]);
      for (const segment of segments) {
        expect(segment.createdAt.slice(0, 4)).toBe(before.slice(0, 4));
      }
      // currentSegment 与 segments() 的最后一段相同，也带时间（清空的段的提示要用）
      expect(await store.currentSegment()).toEqual(segments[2]);
    });

    it('overviews：全部会话，不分平台，按建立先后；最后一条消息的要点、条数、段数', async () => {
      const storage = await open();
      const group = await storage.createConversation({
        platform: 'telegram',
        platformConversationId: '-1001',
        title: '读书会',
      });
      const cli = await storage.createConversation({ platform: 'cli' });
      const empty = await storage.createConversation({ platform: 'web', title: '新对话' });
      const groupStore = await storage.openConversation(group);
      await groupStore.add(message('assistant', '较早的回复'));
      await groupStore.add({
        id: 'last',
        role: 'user',
        metadata: { author: alice, createdAt: '2026-10-30T13:00:00.000Z' },
        parts: [
          { type: 'text', text: '第一段' },
          { type: 'file', mediaType: 'image/png', url: 'luoli-file:a.png' },
          { type: 'text', text: '第二段' },
        ],
      });
      await groupStore.addSegment({ startSeq: 2, startReason: 'idle', priorSummary: '摘要' });
      await (await storage.openConversation(cli)).add(message('assistant', '只有助手'));

      const overviews = await storage.overviews();
      expect(overviews.map((o) => o.id)).toEqual([group, cli, empty]);
      const [groupOverview, cliOverview, emptyOverview] = overviews;
      expect(groupOverview).toEqual({
        id: group,
        platform: 'telegram',
        platformConversationId: '-1001',
        title: '读书会',
        createdAt: expect.any(String),
        messages: 2,
        segments: 2,
        last: {
          seq: 2,
          createdAt: '2026-10-30T13:00:00.000Z',
          role: 'user',
          author: alice,
          text: '第一段\n第二段',
          files: 1,
        },
      });
      expect(cliOverview).toMatchObject({
        platform: 'cli',
        messages: 1,
        segments: 1,
        last: { seq: 1, role: 'assistant', text: '只有助手', files: 0 },
      });
      expect(cliOverview!.platformConversationId).toBeUndefined();
      expect(cliOverview!.last!.author).toBeUndefined();
      expect(emptyOverview).toEqual({
        id: empty,
        platform: 'web',
        platformConversationId: undefined,
        title: '新对话',
        createdAt: expect.any(String),
        messages: 0,
        segments: 1,
      });
      // overview(id) 与列表里的那一项相同；不存在时 undefined
      expect(await storage.overview(group)).toEqual(groupOverview);
      expect(await storage.overview('nope')).toBeUndefined();
    });

    it('overviews：文字按 Unicode 字符截到 textChars；只有图片时文字为空', async () => {
      const storage = await open();
      const id = await storage.createConversation({ platform: 'cli' });
      const store = await storage.openConversation(id);
      await store.add(message('user', '😀😀😀abc'));

      expect((await storage.overview(id, { textChars: 4 }))!.last!.text).toBe('😀😀😀a');
      expect((await storage.overviews({ textChars: 2 }))[0]!.last!.text).toBe('😀😀');

      await store.add({
        id: 'img',
        role: 'user',
        metadata: { createdAt: '2026-10-30T12:00:00.000Z' },
        parts: [
          { type: 'file', mediaType: 'image/png', url: 'luoli-file:a.png' },
          { type: 'file', mediaType: 'image/png', url: 'luoli-file:b.png' },
        ],
      });
      expect((await storage.overview(id))!.last).toMatchObject({ seq: 2, text: '', files: 2 });
    });

    it('overviews：最后一条按序号，不按时间', async () => {
      const storage = await open();
      const id = await storage.createConversation({ platform: 'cli' });
      const store = await storage.openConversation(id);
      await store.add(message('user', '新', { createdAt: '2026-10-30T13:00:00.000Z' }));
      await store.add(message('user', '旧', { createdAt: '2026-10-30T11:00:00.000Z' }));

      expect((await storage.overview(id))!.last).toMatchObject({ seq: 2, text: '旧' });
    });

    it('callSummary：某时刻以来；回复数与失败数只算回复，token 算全部用途与结果', async () => {
      const storage = await open();
      const a = await storage.createConversation({ platform: 'telegram', title: '甲' });
      const b = await storage.createConversation({ platform: 'cli' });
      const c = await storage.createConversation({ platform: 'telegram', title: '丙' });
      const storeA = await storage.openConversation(a);
      const storeB = await storage.openConversation(b);
      const storeC = await storage.openConversation(c);
      const today = '2026-10-30T16:00:00.000Z';
      const at = (time: string) => ({ startedAt: time });

      // 昨天的不算
      await storeA.recordCall(call(at('2026-10-30T15:59:59.999Z')));
      // 今天：甲 1 次回复，乙 2 次回复，丙只有失败与摘要
      await storeA.recordCall(call(at('2026-10-30T16:00:00.000Z')));
      await storeB.recordCall(call(at('2026-10-30T17:00:00.000Z')));
      await storeB.recordCall(call(at('2026-10-30T18:00:00.000Z')));
      await storeC.recordCall(
        call({
          ...at('2026-10-30T19:00:00.000Z'),
          outcome: 'failed',
          inputTokens: 50,
          cacheReadTokens: undefined,
          outputTokens: undefined,
        }),
      );
      await storeC.recordCall(
        call({
          ...at('2026-10-30T19:30:00.000Z'),
          purpose: 'summary',
          summaryReason: 'idle',
          replyId: undefined,
          inputTokens: 1000,
          cacheReadTokens: 800,
          outputTokens: 200,
        }),
      );
      // 中止的回复：不算回复也不算失败，token 照算
      await storeA.recordCall(
        call({ ...at('2026-10-30T20:00:00.000Z'), outcome: 'aborted', inputTokens: 7 }),
      );
      // 摘要失败：不算失败的回复
      await storeA.recordCall(
        call({
          ...at('2026-10-30T20:30:00.000Z'),
          purpose: 'summary',
          outcome: 'failed',
          inputTokens: undefined,
          cacheReadTokens: undefined,
          outputTokens: undefined,
        }),
      );

      expect(await storage.callSummary(today)).toEqual({
        replies: 3,
        failedReplies: 1,
        inputTokens: 120 * 3 + 50 + 1000 + 7,
        cacheReadTokens: 100 * 3 + 800 + 100,
        outputTokens: 30 * 3 + 200 + 30,
        repliesByConversation: [
          { conversationId: b, title: undefined, replies: 2 },
          { conversationId: a, title: '甲', replies: 1 },
        ],
      });
    });

    it('callSummary：没有调用时全是 0；同样多的回复按会话建立先后', async () => {
      const storage = await open();
      expect(await storage.callSummary('2026-10-30T00:00:00.000Z')).toEqual({
        replies: 0,
        failedReplies: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        repliesByConversation: [],
      });

      const first = await storage.createConversation({ platform: 'cli', title: '先' });
      const second = await storage.createConversation({ platform: 'cli', title: '后' });
      await (await storage.openConversation(second)).recordCall(call());
      await (await storage.openConversation(first)).recordCall(call());

      expect((await storage.callSummary('2026-10-30T00:00:00.000Z')).repliesByConversation).toEqual(
        [
          { conversationId: first, title: '先', replies: 1 },
          { conversationId: second, title: '后', replies: 1 },
        ],
      );
    });

    it('lastReply：结束得最晚的、正常完成的回复，结束时间是开始加耗时；没有时为 undefined', async () => {
      const storage = await open();
      expect(await storage.lastReply()).toBeUndefined();

      const a = await storage.createConversation({ platform: 'telegram', title: '甲' });
      const b = await storage.createConversation({ platform: 'cli' });
      const storeA = await storage.openConversation(a);
      const storeB = await storage.openConversation(b);
      await storeB.recordCall(
        call({ startedAt: '2026-10-30T10:00:00.000Z', durationMs: 1500, replyId: 'r-b' }),
      );
      await storeA.recordCall(
        call({ startedAt: '2026-10-30T09:00:00.000Z', durationMs: 1000, replyId: 'r-a' }),
      );
      // 更晚开始的失败、中止、摘要都不算
      await storeA.recordCall(call({ startedAt: '2026-10-30T11:00:00.000Z', outcome: 'failed' }));
      await storeA.recordCall(call({ startedAt: '2026-10-30T11:01:00.000Z', outcome: 'aborted' }));
      await storeA.recordCall(
        call({ startedAt: '2026-10-30T11:02:00.000Z', purpose: 'summary', replyId: undefined }),
      );

      expect(await storage.lastReply()).toEqual({
        conversationId: b,
        replyId: 'r-b',
        endedAt: '2026-10-30T10:00:01.500Z',
      });

      // 开始得早、结束得晚的那次算最近：与运行中按结束时间更新的口径相同
      await storeA.recordCall(
        call({ startedAt: '2026-10-30T09:59:00.000Z', durationMs: 65_000, replyId: 'r-long' }),
      );
      expect(await storage.lastReply()).toEqual({
        conversationId: a,
        replyId: 'r-long',
        endedAt: '2026-10-30T10:00:05.000Z',
      });
    });
  });

  describe('任务', () => {
    it('新建：返回带 id 的任务，进行中、到点 0 次，没有上次到点与结束时间；id 从 1 起递增', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });

      const first = await storage.createTask(newTask(c));
      const second = await storage.createTask(
        newTask(c, {
          action: '说说今天的天气',
          schedule: { kind: 'daily', time: '08:00' },
          nextDueAt: '2026-11-10T00:00:00.000Z',
        }),
      );

      expect(first).toStrictEqual({
        id: 1,
        conversationId: c,
        action: '提醒 Alice 交周报',
        schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
        source: { author: alice, messageId: 'm-src', platformMessageId: '42' },
        status: 'active',
        nextDueAt: '2026-11-10T01:00:00.000Z',
        dueCount: 0,
        createdAt: '2026-11-09T13:30:00.000Z',
      });
      expect(second).toMatchObject({ id: 2, action: '说说今天的天气', status: 'active' });
    });

    it('新建：不给建立时间时取写入时间；不给下次到点时没有；来源没有平台消息 id、发言人没有 id 时也没有这两项', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const before = new Date().toISOString();

      const task = await storage.createTask({
        conversationId: c,
        action: '提醒喝水',
        schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
        source: { author: { name: '网页用户' }, messageId: 'm-web' },
      });

      expect(task.createdAt >= before && task.createdAt <= new Date().toISOString()).toBe(true);
      expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
      expect(task.source).toStrictEqual({ author: { name: '网页用户' }, messageId: 'm-web' });
      expect(task).not.toHaveProperty('nextDueAt');
      expect(await storage.getTask(task.id)).toStrictEqual(task);
    });

    it('新建：每种时间原样往返（截止时刻、星期几、几号都在）', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const schedules: TaskSchedule[] = [
        { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
        { kind: 'daily', time: '08:00' },
        { kind: 'weekdays', time: '09:30', until: '2026-12-31T15:59:59.999Z' },
        { kind: 'weekly', weekday: 7, time: '20:00' },
        { kind: 'monthly', day: 31, time: '10:00', until: '2027-06-30T15:59:59.999Z' },
      ];

      for (const schedule of schedules) {
        const created = await storage.createTask(newTask(c, { schedule }));
        expect((await storage.getTask(created.id))?.schedule).toStrictEqual(schedule);
      }
    });

    it('新建：时间里的 at、until 也换成 toISOString 的写法，time 等其余项原样；不合法时报错，不建任务', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const create = async (schedule: TaskSchedule) =>
        (await storage.getTask((await storage.createTask(newTask(c, { schedule }))).id))?.schedule;

      expect(await create({ kind: 'once', at: '2026-11-10T09:00:00+08:00' })).toStrictEqual({
        kind: 'once',
        at: '2026-11-10T01:00:00.000Z',
      });
      expect(
        await create({ kind: 'weekdays', time: '9:30', until: '2026-12-31T23:59:59.999+08:00' }),
      ).toStrictEqual({ kind: 'weekdays', time: '9:30', until: '2026-12-31T15:59:59.999Z' });
      expect(
        await create({ kind: 'monthly', day: 1, time: '10:00', until: '2027-01-01T00:00Z' }),
      ).toStrictEqual({
        kind: 'monthly',
        day: 1,
        time: '10:00',
        until: '2027-01-01T00:00:00.000Z',
      });
      // 不给的截止不会多出一项
      expect(await create({ kind: 'daily', time: '08:00', until: undefined })).toStrictEqual({
        kind: 'daily',
        time: '08:00',
      });

      await expect(
        storage.createTask(newTask(c, { schedule: { kind: 'once', at: '明早九点' } })),
      ).rejects.toThrow('不是合法的时间');
      await expect(
        storage.createTask(
          newTask(c, { schedule: { kind: 'weekly', weekday: 1, time: '09:00', until: 'x' } }),
        ),
      ).rejects.toThrow('不是合法的时间');
      expect(await storage.listTasks()).toHaveLength(4);
    });

    it('新建：会话不存在时报错，不建任务', async () => {
      const storage = await open();

      await expect(storage.createTask(newTask('nope'))).rejects.toThrow('会话 nope 不存在');
      expect(await storage.listTasks()).toEqual([]);
    });

    it('时间换成 toISOString 的写法再存：带时区偏移、没有毫秒的都能比较；不合法的时间报错', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });

      const task = await storage.createTask(
        newTask(c, { nextDueAt: '2026-11-10T09:00:00+08:00', createdAt: '2026-11-09T13:30:00Z' }),
      );
      expect(task).toMatchObject({
        nextDueAt: '2026-11-10T01:00:00.000Z',
        createdAt: '2026-11-09T13:30:00.000Z',
      });
      expect(await storage.updateTask(task.id, { lastDueAt: '2026-11-10T01:00Z' })).toMatchObject({
        lastDueAt: '2026-11-10T01:00:00.000Z',
      });
      expect(await storage.dueTasks('2026-11-10T09:00:00+08:00')).toHaveLength(1);
      expect(await storage.dueTasks('2026-11-10T08:59:59+08:00')).toEqual([]);

      await expect(storage.createTask(newTask(c, { nextDueAt: '明天' }))).rejects.toThrow(
        '不是合法的时间',
      );
      await expect(storage.updateTask(task.id, { endedAt: 'x' })).rejects.toThrow('不是合法的时间');
      expect(await storage.listTasks()).toHaveLength(1);
    });

    it('按 id 取：没有时为 undefined；取回的是副本，改动不影响存储', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const created = await storage.createTask(newTask(c));

      const got = await storage.getTask(created.id);
      expect(got).toStrictEqual(created);
      got!.status = 'done';
      (got!.source.author as { name: string }).name = '改过';
      created.action = '改过';

      expect(await storage.getTask(created.id)).toStrictEqual({
        ...created,
        action: '提醒 Alice 交周报',
      });
      expect(await storage.getTask(99)).toBeUndefined();
    });

    it('列出：按建立先后；可以按会话、按状态筛选，两个条件一起用', async () => {
      const storage = await open();
      const a = await storage.createConversation({ platform: 'web' });
      const b = await storage.createConversation({ platform: 'web' });
      const t1 = await storage.createTask(newTask(a));
      const t2 = await storage.createTask(newTask(b));
      const t3 = await storage.updateTask((await storage.createTask(newTask(a))).id, {
        status: 'cancelled',
        nextDueAt: null,
        endedAt: '2026-11-09T14:00:00.000Z',
      });
      const t4 = await storage.updateTask((await storage.createTask(newTask(a))).id, {
        status: 'done',
        nextDueAt: null,
        endedAt: '2026-11-10T01:00:00.000Z',
      });

      expect(await storage.listTasks()).toStrictEqual([t1, t2, t3, t4]);
      expect(await storage.listTasks({ conversationId: a })).toStrictEqual([t1, t3, t4]);
      expect(await storage.listTasks({ status: 'active' })).toStrictEqual([t1, t2]);
      expect(await storage.listTasks({ conversationId: a, status: 'active' })).toStrictEqual([t1]);
      expect(await storage.listTasks({ conversationId: b, status: 'done' })).toEqual([]);
      expect(await storage.listTasks({ conversationId: 'nope' })).toEqual([]);
    });

    it('结束时间的筛选：已结束的只要这个时刻（含）以后结束的，进行中的不受影响', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const active = await storage.createTask(newTask(c));
      const end = async (status: 'done' | 'cancelled', endedAt: string) =>
        storage.updateTask((await storage.createTask(newTask(c))).id, {
          status,
          nextDueAt: null,
          endedAt,
        });
      await end('cancelled', '2026-09-30T23:59:59.999Z');
      const recent = await end('done', '2026-10-10T00:00:00.000Z');
      const latest = await end('cancelled', '2026-11-09T00:00:00.000Z');

      expect(await storage.listTasks({ endedSince: '2026-10-10T00:00:00.000Z' })).toStrictEqual([
        active,
        recent,
        latest,
      ]);
      // 同一时刻的别种写法
      expect(await storage.listTasks({ endedSince: '2026-10-10T08:00:00+08:00' })).toHaveLength(3);
      expect(
        await storage.listTasks({ endedSince: '2026-10-10T00:00:00.001Z', status: 'done' }),
      ).toEqual([]);
      expect(
        await storage.listTasks({ endedSince: '2027-01-01T00:00:00.000Z', conversationId: c }),
      ).toStrictEqual([active]);
    });

    it('修改：只改给出的项，null 清掉；返回改过的任务，再取也一样；什么都不给时原样返回', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const daily = await storage.createTask(
        newTask(c, {
          schedule: { kind: 'daily', time: '09:00' },
          source: { author: bob, messageId: 'm-bob' },
        }),
      );
      const other = await storage.createTask(newTask(c));

      const fired = await storage.updateTask(daily.id, {
        lastDueAt: '2026-11-10T01:00:00.000Z',
        nextDueAt: '2026-11-11T01:00:00.000Z',
        dueCount: 1,
      });
      expect(fired).toStrictEqual({
        ...daily,
        lastDueAt: '2026-11-10T01:00:00.000Z',
        nextDueAt: '2026-11-11T01:00:00.000Z',
        dueCount: 1,
      });
      expect(await storage.getTask(daily.id)).toStrictEqual(fired);

      const withoutNext: Task = { ...fired };
      delete withoutNext.nextDueAt;
      const ended = await storage.updateTask(daily.id, {
        status: 'done',
        nextDueAt: null,
        endedAt: '2026-11-11T01:00:00.000Z',
      });
      expect(ended).toStrictEqual({
        ...withoutNext,
        status: 'done',
        endedAt: '2026-11-11T01:00:00.000Z',
      });
      expect(await storage.updateTask(daily.id, {})).toStrictEqual(ended);
      // 没给的项（含显式的 undefined）不动
      expect(await storage.updateTask(daily.id, { status: undefined })).toStrictEqual(ended);
      expect(await storage.getTask(other.id)).toStrictEqual(other);
    });

    it('修改：换「做什么」和整个时间，时间照新建时的写法存；一次性和周期的能互换，别的项不动；再取、列出、到点的也是新的', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const created = await storage.createTask(newTask(c));
      const other = await storage.createTask(newTask(c));
      const fired = await storage.updateTask(created.id, { dueCount: 2 });

      const daily = await storage.updateTask(created.id, {
        action: '提醒 Alice 喝水',
        schedule: { kind: 'daily', time: '08:00', until: '2026-12-31T23:59:59.999+08:00' },
        nextDueAt: '2026-11-11T08:00:00+08:00',
      });
      expect(daily).toStrictEqual({
        ...fired,
        action: '提醒 Alice 喝水',
        schedule: { kind: 'daily', time: '08:00', until: '2026-12-31T15:59:59.999Z' },
        nextDueAt: '2026-11-11T00:00:00.000Z',
      });
      expect(await storage.getTask(created.id)).toStrictEqual(daily);

      // 只换时间：做什么、到点次数、来源都不动
      const once = await storage.updateTask(created.id, {
        schedule: { kind: 'once', at: '2026-11-09T21:00:00-04:00' },
        nextDueAt: '2026-11-10T01:00:00.000Z',
      });
      expect(once).toStrictEqual({
        ...daily,
        schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
        nextDueAt: '2026-11-10T01:00:00.000Z',
      });
      // 只换做什么
      const renamed = await storage.updateTask(created.id, { action: '提醒 Bob 交周报' });
      expect(renamed).toStrictEqual({ ...once, action: '提醒 Bob 交周报' });

      expect(await storage.listTasks({ conversationId: c })).toStrictEqual([renamed, other]);
      expect(await storage.dueTasks('2026-11-10T01:00:00.000Z')).toStrictEqual([renamed, other]);
      // 时刻不合法：报错，什么都不改
      await expect(
        storage.updateTask(created.id, {
          action: '不该改',
          schedule: { kind: 'once', at: '明天' },
        }),
      ).rejects.toThrow('不是合法的时间');
      expect(await storage.getTask(created.id)).toStrictEqual(renamed);
      expect(await storage.getTask(other.id)).toStrictEqual(other);
    });

    it('监视任务：描述跟着 schedule 原样存取，核心不解读；没有下次到点，不算进到点的和最早的下次到点；能改描述、记到点', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      const monitor = {
        service: 'qweather',
        endpoint: 'weather_alert',
        params: { latitude: 31.23, localTime: true },
        where: { all: [{ field: 'color.code', op: 'in', value: ['red'] }] },
        anything: { nested: [1, '2'] },
      };
      const timed = await storage.createTask(newTask(c));
      const watching = await storage.createTask(
        newTask(c, { schedule: { kind: 'monitor', monitor }, nextDueAt: undefined }),
      );

      expect(watching).toMatchObject({ schedule: { kind: 'monitor', monitor }, status: 'active' });
      expect(watching).not.toHaveProperty('nextDueAt');
      expect(await storage.getTask(watching.id)).toStrictEqual(watching);
      expect(await storage.listTasks({ status: 'active' })).toStrictEqual([timed, watching]);
      expect(await storage.dueTasks('2030-01-01T00:00:00.000Z')).toStrictEqual([timed]);
      expect(await storage.nextDueAt()).toBe(timed.nextDueAt);

      const changed = await storage.updateTask(watching.id, {
        schedule: { kind: 'monitor', monitor: { ...monitor, interval_minutes: 10 } },
        lastDueAt: '2026-11-10T02:00:00.000Z',
        dueCount: 1,
      });
      expect(changed).toStrictEqual({
        ...watching,
        schedule: { kind: 'monitor', monitor: { ...monitor, interval_minutes: 10 } },
        lastDueAt: '2026-11-10T02:00:00.000Z',
        dueCount: 1,
      });
      expect(await storage.getTask(watching.id)).toStrictEqual(changed);
    });

    it('修改：没有这个任务时报错', async () => {
      const storage = await open();

      await expect(storage.updateTask(7, { status: 'cancelled' })).rejects.toThrow('任务 7 不存在');
      await expect(storage.updateTask(7, {})).rejects.toThrow('任务 7 不存在');
    });

    it('取要到点的：进行中、下次到点不晚于给定时刻（含）的，按下次到点先后，同一时刻按建立先后', async () => {
      const storage = await open();
      const a = await storage.createConversation({ platform: 'web' });
      const b = await storage.createConversation({ platform: 'web' });
      const nine = await storage.createTask(newTask(a, { nextDueAt: '2026-11-10T01:00:00.000Z' }));
      const eight = await storage.createTask(newTask(b, { nextDueAt: '2026-11-10T00:00:00.000Z' }));
      const alsoNine = await storage.createTask(
        newTask(b, { nextDueAt: '2026-11-10T01:00:00.000Z' }),
      );
      await storage.createTask(newTask(a, { nextDueAt: '2026-11-10T02:00:00.000Z' }));
      // 已结束却留着下次到点的、没有下次到点的：都不算
      await storage.updateTask(
        (await storage.createTask(newTask(a, { nextDueAt: '2026-11-09T23:00:00.000Z' }))).id,
        { status: 'cancelled', endedAt: '2026-11-09T22:00:00.000Z' },
      );
      await storage.createTask(newTask(a, { nextDueAt: undefined }));

      expect(await storage.dueTasks('2026-11-10T01:00:00.000Z')).toStrictEqual([
        eight,
        nine,
        alsoNine,
      ]);
      expect(await storage.dueTasks('2026-11-10T00:59:59.999Z')).toStrictEqual([eight]);
      expect(await storage.dueTasks('2026-11-09T00:00:00.000Z')).toEqual([]);
    });

    it('最近的到点：进行中任务里最早的下次到点；没有时为 undefined；结束了的不算', async () => {
      const storage = await open();
      const c = await storage.createConversation({ platform: 'web' });
      expect(await storage.nextDueAt()).toBeUndefined();

      await storage.createTask(newTask(c, { nextDueAt: undefined }));
      expect(await storage.nextDueAt()).toBeUndefined();

      const nine = await storage.createTask(newTask(c, { nextDueAt: '2026-11-10T01:00:00.000Z' }));
      const eight = await storage.createTask(newTask(c, { nextDueAt: '2026-11-10T00:00:00.000Z' }));
      expect(await storage.nextDueAt()).toBe('2026-11-10T00:00:00.000Z');

      // 取消时留着下次到点也不算
      await storage.updateTask(eight.id, { status: 'cancelled' });
      expect(await storage.nextDueAt()).toBe('2026-11-10T01:00:00.000Z');
      await storage.updateTask(nine.id, { nextDueAt: '2026-11-10T00:30:00.000Z' });
      expect(await storage.nextDueAt()).toBe('2026-11-10T00:30:00.000Z');
    });
  });
});

describe('SQLite 存储', () => {
  it('没有段的旧会话（第 2 步建的库）：segments 视为一段，时间取会话的建立时间；概览算一段', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'cli', title: '旧会话' });
    const raw = new DatabaseSync(path);
    raw.prepare('DELETE FROM segments WHERE conversation_id = ?').run(id);
    const createdAt = String(
      raw.prepare('SELECT created_at FROM conversations WHERE id = ?').get(id)?.created_at,
    );
    raw.close();

    expect(await (await storage.openConversation(id)).segments()).toEqual([
      { startSeq: 1, startReason: 'first', conversationTitle: '旧会话', createdAt },
    ]);
    expect((await storage.overview(id))!.segments).toBe(1);
  });

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

  it('新库：WAL 模式、user_version 为 6、六张表与索引按 ADR-0005 建好', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    openSqliteStorage(path).close();

    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
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
        'index:tasks_conversation',
        'index:tasks_due',
        'index:tool_calls_time',
        'index:tool_calls_tool',
        'table:conversations',
        'table:messages',
        'table:model_calls',
        'table:segments',
        'table:tasks',
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
        'started_by',
        'started_by_id',
      ]);
      expect(columns('model_calls')).toEqual(modelCallColumns);
      expect(columns('tool_calls')).toEqual(toolCallColumns);
      expect(columns('tasks')).toEqual(taskColumns);
      const indexed = (index: string) =>
        db
          .prepare(`PRAGMA index_info(${index})`)
          .all()
          .map((row) => row.name);
      expect(indexed('model_calls_time')).toEqual(['started_at']);
      expect(indexed('model_calls_conversation')).toEqual(['conversation_id', 'started_at']);
      expect(indexed('tool_calls_time')).toEqual(['started_at']);
      expect(indexed('tool_calls_tool')).toEqual(['tool', 'started_at']);
      expect(indexed('tasks_due')).toEqual(['status', 'next_due_at']);
      expect(indexed('tasks_conversation')).toEqual(['conversation_id', 'status']);
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
      createdAt: (await storage.overview(id))!.createdAt,
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

  it('段的行：执行人记在 started_by、started_by_id 两列，没有 id 时为 NULL；另一个连接往当前段写了消息之后，改写不成', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    const other = openSqliteStorage(path);
    cleanups.push(async () => {
      storage.close();
      other.close();
    });
    const id = await storage.createConversation({ platform: 'cli' });
    const store = await storage.openConversation(id);
    await store.add(message('user', '一'));
    await store.addSegment({
      startSeq: 2,
      startReason: 'manual',
      priorSummary: '摘要',
      startedBy: bob,
    });

    await (await other.openConversation(id)).add(message('user', '另一个连接写的'));
    expect(await store.clearSegment({ startSeq: 2, startedBy: { name: 'cli-user' } })).toBe(false);
    await store.addSegment({ startSeq: 3, startReason: 'clear', startedBy: { name: 'cli-user' } });

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        db
          .prepare(
            `SELECT start_seq, start_reason, prior_summary, started_by, started_by_id
             FROM segments ORDER BY start_seq`,
          )
          .all()
          .map((row) => ({ ...row })),
      ).toEqual([
        {
          start_seq: 1,
          start_reason: 'first',
          prior_summary: null,
          started_by: null,
          started_by_id: null,
        },
        {
          start_seq: 2,
          start_reason: 'manual',
          prior_summary: '摘要',
          started_by: 'Bob',
          started_by_id: 'u-bob',
        },
        {
          start_seq: 3,
          start_reason: 'clear',
          prior_summary: null,
          started_by: 'cli-user',
          started_by_id: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('模型调用的摘要原因 manual 照写照读', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const storage = openSqliteStorage(join(dir, 'luoli.db'));
    cleanups.push(async () => storage.close());
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    const summary = call({ purpose: 'summary', summaryReason: 'manual', replyId: undefined });

    await store.recordCall(summary);

    expect(await store.calls()).toEqual([summary]);
  });

  it('user_version 大于 6 时打开报错', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 7');
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
    await store.recordToolCall(toolCall({ toolCallId: 'call_1' }));
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
          tool_call_id: 'call_1',
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
          tool_call_id: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('任务的行：时间是一段 JSON，来源拆成四列，各列照写入的值；没有的为 NULL', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-1',
    });
    await storage.createTask(
      newTask(id, {
        schedule: { kind: 'weekly', weekday: 1, time: '09:00', until: '2026-12-31T15:59:59.999Z' },
      }),
    );
    const web = await storage.createTask(
      newTask(id, {
        source: { author: { name: '网页用户' }, messageId: 'm-web' },
        nextDueAt: undefined,
      }),
    );
    await storage.updateTask(web.id, {
      status: 'cancelled',
      lastDueAt: '2026-11-10T01:00:00.000Z',
      dueCount: 3,
      endedAt: '2026-11-10T02:00:00.000Z',
    });

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT * FROM tasks ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
      expect(rows).toEqual([
        {
          id: 1,
          conversation_id: id,
          action: '提醒 Alice 交周报',
          schedule: expect.any(String),
          source_author_id: 'u-alice',
          source_author_name: 'Alice',
          source_message_id: 'm-src',
          source_platform_message_id: '42',
          status: 'active',
          next_due_at: '2026-11-10T01:00:00.000Z',
          last_due_at: null,
          due_count: 0,
          created_at: '2026-11-09T13:30:00.000Z',
          ended_at: null,
        },
        {
          id: 2,
          conversation_id: id,
          action: '提醒 Alice 交周报',
          schedule: expect.any(String),
          source_author_id: null,
          source_author_name: '网页用户',
          source_message_id: 'm-web',
          source_platform_message_id: null,
          status: 'cancelled',
          next_due_at: null,
          last_due_at: '2026-11-10T01:00:00.000Z',
          due_count: 3,
          created_at: '2026-11-09T13:30:00.000Z',
          ended_at: '2026-11-10T02:00:00.000Z',
        },
      ]);
      expect(JSON.parse(String(rows[0]!.schedule))).toEqual({
        kind: 'weekly',
        weekday: 1,
        time: '09:00',
        until: '2026-12-31T15:59:59.999Z',
      });
      // 按 JSON 里的种类也能直接查
      expect(db.prepare("SELECT id FROM tasks WHERE schedule ->> '$.kind' = 'once'").all()).toEqual(
        [{ id: 2 }],
      );
    } finally {
      db.close();
    }
  });

  it('任务的 id 不重用：最大的那行被删掉后，新建的任务也不会拿到它的 id', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => storage.close());
    const id = await storage.createConversation({ platform: 'web' });
    await storage.createTask(newTask(id));
    await storage.createTask(newTask(id));
    const raw = new DatabaseSync(path);
    raw.prepare('DELETE FROM tasks WHERE id = 2').run();
    raw.close();

    expect((await storage.createTask(newTask(id))).id).toBe(3);
  });

  it('版本 5 的库：打开时升到版本 6，段多了执行人两列，原有的段不变、执行人为空，其余数据不变；之后能写手动压缩、清空的段', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    // 第七阶段到组件库第 4 步的程序建的库：六张表，user_version 为 5
    const old = new DatabaseSync(path);
    old.exec('PRAGMA journal_mode = WAL');
    old.exec(version1Schema);
    old.exec(version2Schema);
    old.exec(version3Schema);
    old.exec(version4Schema);
    old.exec(version5Schema);
    old.exec('PRAGMA user_version = 5');
    old.exec(`
      INSERT INTO conversations (id, platform, platform_conversation_id, title, next_seq, created_at)
        VALUES ('c1', 'telegram', '-100', '读书会', 3, '2026-10-29T00:00:00.000Z');
      INSERT INTO segments
          (id, conversation_id, start_seq, start_reason, conversation_title, prior_summary, created_at)
        VALUES ('s1', 'c1', 1, 'first', '读书会', NULL, '2026-10-29T00:00:00.000Z'),
               ('s2', 'c1', 2, 'idle', '读书会', '昨天的摘要', '2026-10-30T00:00:00.000Z');
      INSERT INTO model_calls
          (conversation_id, purpose, summary_reason, model, started_at, duration_ms, attempts,
           outcome, steps, tool_calls)
        VALUES ('c1', 'summary', 'idle', 'test-model', '2026-10-30T00:00:00.000Z', 900, 1,
                'completed', 1, 0);
      INSERT INTO tasks
          (conversation_id, action, schedule, source_author_name, source_message_id, status,
           next_due_at, created_at)
        VALUES ('c1', '提醒交周报', '{"kind":"once","at":"2026-11-10T01:00:00.000Z"}', 'Alice',
                'm-src', 'active', '2026-11-10T01:00:00.000Z', '2026-10-29T00:00:00.000Z');
    `);
    const saved = message('user', '早', { author: alice, platformMessageId: '7' });
    old
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, seq, role, author_id, platform_message_id, created_at, ui_message)
         VALUES (?, 'c1', 1, 'user', 'u-alice', '7', ?, ?)`,
      )
      .run(saved.id, saved.metadata!.createdAt, JSON.stringify(saved));
    const tables = ['conversations', 'messages', 'segments', 'model_calls', 'tool_calls', 'tasks'];
    const dump = (db: DatabaseSync) =>
      tables.map((table) =>
        db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => ({ ...row })),
      );
    const before = dump(old);
    old.close();

    const storage = openSqliteStorage(path);
    const store = await storage.openConversation('c1');
    expect(await store.segments()).toEqual([
      {
        startSeq: 1,
        startReason: 'first',
        conversationTitle: '读书会',
        createdAt: '2026-10-29T00:00:00.000Z',
      },
      {
        startSeq: 2,
        startReason: 'idle',
        conversationTitle: '读书会',
        priorSummary: '昨天的摘要',
        createdAt: '2026-10-30T00:00:00.000Z',
      },
    ]);
    expect((await store.segments()).some((segment) => 'startedBy' in segment)).toBe(false);
    expect(await store.list()).toEqual([saved]);
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
      expect(dump(db)).toEqual(withSegmentAuthors(before, tables.indexOf('segments')));
    } finally {
      db.close();
    }
    // 只读打开（导出脚本用）认得版本 6 的库
    expect(readConversations(path)).toEqual([
      { id: 'c1', platform: 'telegram', platformConversationId: '-100', title: '读书会' },
    ]);

    const reopened = openSqliteStorage(path);
    cleanups.push(async () => reopened.close());
    const again = await reopened.openConversation('c1');
    await again.addSegment({
      startSeq: 3,
      startReason: 'manual',
      priorSummary: '手动',
      startedBy: bob,
    });
    expect(await again.clearSegment({ startSeq: 3, startedBy: { name: 'cli-user' } })).toBe(true);
    expect(await again.currentSegment()).toMatchObject({
      startSeq: 3,
      startReason: 'clear',
      startedBy: { name: 'cli-user' },
    });
  });

  it('版本 4 的库：打开时升到版本 6，加任务表与段的执行人两列，已有的数据不变；任务表能用，重新打开后能读回', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    // 第六阶段第 7 步到第七阶段第 1 步的程序建的库：五张表，user_version 为 4，各表都有数据
    const old = new DatabaseSync(path);
    old.exec('PRAGMA journal_mode = WAL');
    old.exec(version1Schema);
    old.exec(version2Schema);
    old.exec(version3Schema);
    old.exec(version4Schema);
    old.exec('PRAGMA user_version = 4');
    const saved = message('user', '明早九点提醒我交周报', {
      author: alice,
      platformMessageId: '42',
    });
    old.exec(`
      INSERT INTO conversations (id, platform, platform_conversation_id, title, next_seq, created_at)
        VALUES ('c1', 'telegram', '-100', '读书会', 2, '2026-10-29T00:00:00.000Z');
      INSERT INTO segments
          (id, conversation_id, start_seq, start_reason, conversation_title, prior_summary, created_at)
        VALUES ('s1', 'c1', 1, 'first', '读书会', NULL, '2026-10-29T00:00:00.000Z');
      INSERT INTO model_calls
          (conversation_id, purpose, reply_id, model, started_at, duration_ms, attempts, outcome,
           steps, tool_calls)
        VALUES ('c1', 'reply', 'r0', 'test-model', '2026-10-29T06:00:00.000Z', 900, 1, 'completed',
                1, 0);
      INSERT INTO tool_calls
          (conversation_id, reply_id, tool, step, started_at, duration_ms, outcome, tool_call_id)
        VALUES ('c1', 'r0', 'fetch', 1, '2026-10-29T06:00:00.100Z', 300, 'completed', 'call_1');
    `);
    old
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, seq, role, author_id, platform_message_id, created_at, ui_message)
         VALUES (?, 'c1', 1, 'user', 'u-alice', '42', ?, ?)`,
      )
      .run(saved.id, saved.metadata!.createdAt, JSON.stringify(saved));
    const tables = ['conversations', 'messages', 'segments', 'model_calls', 'tool_calls'];
    const dump = (db: DatabaseSync) =>
      tables.map((table) =>
        db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => ({ ...row })),
      );
    const before = dump(old);
    old.close();

    const storage = openSqliteStorage(path);
    expect(await (await storage.openConversation('c1')).list()).toEqual([saved]);
    const created = await storage.createTask(
      newTask('c1', { source: { author: alice, messageId: saved.id, platformMessageId: '42' } }),
    );
    expect(created.id).toBe(1);
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
      expect(dump(db)).toEqual(withSegmentAuthors(before, tables.indexOf('segments')));
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'tasks' ORDER BY name")
          .all()
          .map((row) => row.name),
      ).toEqual(['tasks', 'tasks_conversation', 'tasks_due']);
    } finally {
      db.close();
    }
    // 只读打开（导出脚本用）认得版本 6 的库
    expect(readConversations(path)).toEqual([
      { id: 'c1', platform: 'telegram', platformConversationId: '-100', title: '读书会' },
    ]);

    const reopened = openSqliteStorage(path);
    cleanups.push(async () => reopened.close());
    expect(await reopened.getTask(1)).toStrictEqual(created);
    expect(await reopened.dueTasks('2026-11-10T01:00:00.000Z')).toStrictEqual([created]);
  });

  it('改过「做什么」和时间的任务：关掉再打开，读出来一样', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    const c = await storage.createConversation({ platform: 'web' });
    const created = await storage.createTask(newTask(c));
    const updated = await storage.updateTask(created.id, {
      action: '提醒 Bob 交周报',
      schedule: { kind: 'weekly', weekday: 3, time: '20:00', until: '2027-01-31T15:59:59.999Z' },
      nextDueAt: '2026-11-11T12:00:00.000Z',
    });
    storage.close();

    const reopened = openSqliteStorage(path);
    cleanups.push(async () => reopened.close());
    expect(await reopened.getTask(created.id)).toStrictEqual(updated);
    expect(updated).toMatchObject({
      action: '提醒 Bob 交周报',
      schedule: { kind: 'weekly', weekday: 3, time: '20:00', until: '2027-01-31T15:59:59.999Z' },
    });
  });

  it('版本 3 的库：打开时升到版本 6，旧的工具调用行没有调用 id，新写入的有；都能读回', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    // 第三阶段到第六阶段第 6 步的程序建的库：五张表，user_version 为 3，已有一行工具调用
    const old = new DatabaseSync(path);
    old.exec('PRAGMA journal_mode = WAL');
    old.exec(version1Schema);
    old.exec(version2Schema);
    old.exec(version3Schema);
    old.exec('PRAGMA user_version = 3');
    old.exec(`
      INSERT INTO conversations (id, platform, next_seq, created_at)
        VALUES ('c1', 'web', 1, '2026-10-29T00:00:00.000Z');
      INSERT INTO tool_calls
          (conversation_id, reply_id, tool, step, started_at, duration_ms, outcome, error,
           output_chars)
        VALUES ('c1', 'r1', 'dice', 1, '2026-10-30T06:02:01.000Z', 120, 'completed', NULL, 11);
    `);
    old.close();

    const storage = openSqliteStorage(path);
    const store = await storage.openConversation('c1');
    await store.recordToolCall(toolCall({ toolCallId: 'call_2', durationMs: 40 }));
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
      expect(
        db
          .prepare('SELECT tool_call_id FROM tool_calls ORDER BY id')
          .all()
          .map((row) => row.tool_call_id),
      ).toEqual([null, 'call_2']);
    } finally {
      db.close();
    }

    const reopened = openSqliteStorage(path);
    cleanups.push(async () => reopened.close());
    const rows = await (await reopened.openConversation('c1')).toolCalls();
    expect(rows).toEqual([toolCall(), toolCall({ toolCallId: 'call_2', durationMs: 40 })]);
    expect(rows[0]!.toolCallId).toBeUndefined();
  });

  it('版本 2 的库：打开时升到版本 6，旧的模型调用行两列为空，新写入的有值；能写工具调用', async () => {
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
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
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

  it('版本 1 的库：打开时升到版本 6，原有的表与数据不变（段多了执行人两列，都为空），能写模型调用；重新打开后能读回', async () => {
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
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
      expect(dump(db)).toEqual(withSegmentAuthors(before, 2));
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

/**
 * 升到版本 6 之后，dump 出来的各表里，段那张表（第 index 张）的每一行多了执行人两列，都为空；
 * 其余照旧
 */
function withSegmentAuthors(
  tables: Array<Array<Record<string, unknown>>>,
  index: number,
): Array<Array<Record<string, unknown>>> {
  return tables.map((rows, i) =>
    i === index ? rows.map((row) => ({ ...row, started_by: null, started_by_id: null })) : rows,
  );
}

// 第七阶段（表结构版本 5）加的任务表，接在 version4Schema 之后
const version5Schema = `
CREATE TABLE tasks (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id            TEXT NOT NULL REFERENCES conversations(id),
  action                     TEXT NOT NULL,
  schedule                   TEXT NOT NULL,
  source_author_id           TEXT,
  source_author_name         TEXT NOT NULL,
  source_message_id          TEXT NOT NULL,
  source_platform_message_id TEXT,
  status                     TEXT NOT NULL,
  next_due_at                TEXT,
  last_due_at                TEXT,
  due_count                  INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  ended_at                   TEXT
);
CREATE INDEX tasks_due          ON tasks(status, next_due_at);
CREATE INDEX tasks_conversation ON tasks(conversation_id, status);
`;

// 第六阶段第 7 步（表结构版本 4）加的工具调用 id，接在 version3Schema 之后
const version4Schema = `
ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT;
`;

// 第三阶段（表结构版本 3）加的工具调用表与模型调用表的两列，接在 version2Schema 之后
const version3Schema = `
ALTER TABLE model_calls ADD COLUMN steps      INTEGER;
ALTER TABLE model_calls ADD COLUMN tool_calls INTEGER;

CREATE TABLE tool_calls (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  reply_id        TEXT NOT NULL,
  tool            TEXT NOT NULL,
  step            INTEGER NOT NULL,
  started_at      TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  outcome         TEXT NOT NULL,
  error           TEXT,
  output_chars    INTEGER
);
CREATE INDEX tool_calls_time ON tool_calls(started_at);
CREATE INDEX tool_calls_tool ON tool_calls(tool, started_at);
`;

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

describe('只读读出会话（readConversations）', () => {
  it('按建立先后读出全部会话与平台；库文件的内容与修改时间不变', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    const group = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-1001',
      title: '读书会',
    });
    const cli = await storage.createConversation({ platform: 'cli' });
    storage.close();
    const before = { bytes: await readFile(path), mtime: (await stat(path)).mtimeMs };

    const conversations = readConversations(path);

    expect(conversations).toEqual([
      { id: group, platform: 'telegram', platformConversationId: '-1001', title: '读书会' },
      { id: cli, platform: 'cli', platformConversationId: undefined, title: undefined },
    ]);
    expect({ bytes: await readFile(path), mtime: (await stat(path)).mtimeMs }).toEqual(before);
  });

  it('文件不存在时报错，不建文件；版本不一致时报错', async () => {
    const dir = await tempDir();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const missing = join(dir, 'missing.db');

    expect(() => readConversations(missing)).toThrow();
    expect(await readdir(dir)).toEqual([]);

    const old = join(dir, 'old.db');
    const db = new DatabaseSync(old);
    db.exec(version1Schema);
    db.exec('PRAGMA user_version = 1');
    db.close();
    expect(() => readConversations(old)).toThrow('请先启动一次核心服务');
  });
});
