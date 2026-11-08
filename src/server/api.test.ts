import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryFileStore,
  createMemoryStorage,
  openSqliteStorage,
  type Message,
  type ModelCall,
  type Storage,
  type StoredToolContent,
} from '../core/index.js';
import { testService } from './test-kit.js';
import type {
  ApiMessage,
  ConversationResponse,
  ConversationRow,
  ConversationsResponse,
  ErrorResponse,
  MessagesResponse,
  TodaySummary,
} from './types.js';

type Part = Message['parts'][number];

let nextId = 0;
function message(
  role: 'user' | 'assistant',
  parts: Part[] | string,
  metadata: Partial<NonNullable<Message['metadata']>> = {},
): Message {
  return {
    id: `m${++nextId}`,
    role,
    metadata: { createdAt: '2026-11-01T10:00:00.000Z', ...metadata },
    parts: typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts,
  };
}

const alice = { id: '11', name: 'Alice Liddell' };
const bob = { id: '22', name: 'Bob' };

/** 最小的 PNG：文件头加 IHDR（宽高），后面带一个 tag 让内容各不相同 */
function png(width: number, height: number, tag: string): Uint8Array {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
  bytes.push(...[...'IHDR'].map((c) => c.charCodeAt(0)));
  for (const value of [width, height]) {
    bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  }
  bytes.push(8, 6, 0, 0, 0, ...new TextEncoder().encode(tag));
  return Uint8Array.from(bytes);
}

/** 依次写入消息，返回会话 id */
async function conversation(
  storage: Storage,
  info: { platform: string; platformConversationId?: string; title?: string },
  messages: Message[] = [],
): Promise<string> {
  const id = await storage.createConversation(info);
  const store = await storage.openConversation(id);
  for (const m of messages) await store.add(m);
  return id;
}

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json() as Promise<T>;
}

const sse: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const reader of sse.splice(0)) await reader.cancel().catch(() => {});
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('会话列表', () => {
  it('按最后一条消息的时间倒序；没有消息的按建立时间；种类、预览、条数、段数', async () => {
    const storage = createMemoryStorage();
    const group = await conversation(
      storage,
      { platform: 'telegram', platformConversationId: '-1001', title: '读书会' },
      [
        message('assistant', '更早'),
        message('user', '  下周\n读什么\t好呀？  ', {
          author: alice,
          createdAt: '2026-11-01T12:00:00.000Z',
        }),
      ],
    );
    const dm = await conversation(
      storage,
      { platform: 'telegram', platformConversationId: '11', title: '与 Alice Liddell 的私聊' },
      [
        message('user', [{ type: 'file', mediaType: 'image/png', url: 'luoli-file:x.png' }], {
          author: alice,
          createdAt: '2026-11-01T13:00:00.000Z',
        }),
      ],
    );
    const cli = await conversation(storage, { platform: 'cli' }, [
      message('assistant', 'x'.repeat(200), { createdAt: '2026-11-01T11:00:00.000Z' }),
    ]);
    const { request } = await testService({ storage });
    const web = await storage.createConversation({ platform: 'web', title: '新对话' });

    const { conversations } = await json<ConversationsResponse>(request('/api/conversations'));

    expect(conversations.map((c) => c.id)).toEqual([web, dm, group, cli]);
    const byId = Object.fromEntries(conversations.map((c) => [c.id, c]));
    expect(byId[group]).toEqual({
      id: group,
      platform: 'telegram',
      kind: 'group',
      title: '读书会',
      platformConversationId: '-1001',
      createdAt: expect.any(String),
      lastAt: '2026-11-01T12:00:00.000Z',
      last: {
        seq: 2,
        createdAt: '2026-11-01T12:00:00.000Z',
        role: 'user',
        author: 'Alice Liddell',
        text: '下周 读什么 好呀？',
      },
      messages: 2,
      segments: 1,
      unread: 0,
      readSeq: 2,
    });
    expect(byId[dm]).toMatchObject({ kind: 'private', last: { text: '[图片]' } });
    expect(byId[cli]).toMatchObject({ kind: 'cli', readSeq: 1 });
    expect(byId[cli]!.title).toBeUndefined();
    // 助手的消息没有作者；预览最多 80 个字符
    expect(byId[cli]!.last).toEqual({
      seq: 1,
      createdAt: '2026-11-01T11:00:00.000Z',
      role: 'assistant',
      text: 'x'.repeat(80),
    });
    expect(byId[web]).toMatchObject({ kind: 'web', messages: 0, segments: 1, unread: 0 });
    expect(byId[web]!.last).toBeUndefined();
    expect(byId[web]!.lastAt).toBe(byId[web]!.createdAt);
  });

  it('一个会话：那一行加全部段；不认识的 id 返回 404 与 JSON', async () => {
    const storage = createMemoryStorage();
    const id = await conversation(storage, { platform: 'telegram', title: '读书会' }, [
      message('user', '一', { author: alice }),
      message('user', '二', { author: alice }),
    ]);
    await (
      await storage.openConversation(id)
    ).addSegment({ startSeq: 2, startReason: 'idle', priorSummary: '聊了第一件事' });
    const { request } = await testService({ storage });

    const detail = await json<ConversationResponse>(request(`/api/conversations/${id}`));
    expect(detail.conversation).toMatchObject({ id, segments: 2, messages: 2 });
    expect(detail.segments).toEqual([
      {
        startSeq: 1,
        startReason: 'first',
        conversationTitle: '读书会',
        createdAt: expect.any(String),
      },
      {
        startSeq: 2,
        startReason: 'idle',
        conversationTitle: '读书会',
        priorSummary: '聊了第一件事',
        createdAt: expect.any(String),
      },
    ]);

    for (const path of ['/api/conversations/nope', '/api/conversations/nope/messages']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: '没有这个会话' });
    }
  });
});

describe('未读', () => {
  it('第一次打开 web.db 时现有会话都算看过；之后来的、之后新建的会话从头算', async () => {
    const storage = createMemoryStorage();
    const old = await conversation(
      storage,
      { platform: 'telegram', platformConversationId: '-1001' },
      [message('user', '以前的', { author: alice })],
    );
    const { request } = await testService({ storage });
    await (await storage.openConversation(old)).add(message('user', '新来的', { author: bob }));
    const fresh = await conversation(
      storage,
      { platform: 'telegram', platformConversationId: '-1002' },
      [message('user', '一', { author: alice }), message('user', '二', { author: bob })],
    );

    const { conversations } = await json<ConversationsResponse>(request('/api/conversations'));
    const byId = Object.fromEntries(conversations.map((c) => [c.id, c]));
    expect(byId[old]).toMatchObject({ unread: 1, readSeq: 1 });
    expect(byId[fresh]).toMatchObject({ unread: 2, readSeq: 0 });
  });

  it('只算 Telegram 里用户发的：洛璃的回复不算，CLI、网页会话不算', async () => {
    const storage = createMemoryStorage();
    const { request } = await testService({ storage });
    const group = await conversation(
      storage,
      { platform: 'telegram', platformConversationId: '-1001' },
      [
        message('user', '一', { author: alice }),
        message('assistant', '回复'),
        message('user', '二', { author: bob }),
        message('assistant', '回复'),
      ],
    );
    const dm = await conversation(storage, { platform: 'telegram', platformConversationId: '11' }, [
      message('user', '私聊', { author: alice }),
    ]);
    const cli = await conversation(storage, { platform: 'cli' }, [
      message('user', 'CLI', { author: { name: 'swim' } }),
    ]);
    const web = await conversation(storage, { platform: 'web' }, [
      message('user', '网页', { author: { name: 'swim' } }),
    ]);

    const { conversations } = await json<ConversationsResponse>(request('/api/conversations'));
    const unread = Object.fromEntries(conversations.map((c) => [c.id, c.unread]));
    expect(unread).toEqual({ [group]: 2, [dm]: 1, [cli]: 0, [web]: 0 });
  });

  it('标记已读：只往前走，超过最后一条按最后一条；返回那一行并推给面板', async () => {
    const storage = createMemoryStorage();
    const { request } = await testService({ storage });
    const id = await conversation(storage, { platform: 'telegram', platformConversationId: '-1' }, [
      message('user', '一', { author: alice }),
      message('user', '二', { author: alice }),
      message('user', '三', { author: alice }),
    ]);
    const events = await request('/api/events');
    const reader = events.body!.getReader();
    sse.push(reader);
    const read = (seq: unknown) =>
      request(`/api/conversations/${id}/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq }),
      });

    expect(await json<ConversationRow>(read(2))).toMatchObject({ readSeq: 2, unread: 1 });
    expect(await json<ConversationRow>(read(1))).toMatchObject({ readSeq: 2, unread: 1 });
    expect(await json<ConversationRow>(read(999))).toMatchObject({ readSeq: 3, unread: 0 });

    // 连着的面板收到这个会话的新一行
    const decoder = new TextDecoder();
    let text = '';
    while ((text.match(/event: conversation/g) ?? []).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const rows = text
      .split('\n\n')
      .filter((block) => block.startsWith('event: conversation'))
      .map((block) => JSON.parse(block.split('\n')[1]!.slice('data: '.length)) as ConversationRow);
    expect(rows.map((row) => [row.id, row.readSeq, row.unread])).toEqual([
      [id, 2, 1],
      [id, 2, 1],
      [id, 3, 0],
    ]);

    // 参数不对：400；会话不存在：404；不是 JSON：415
    for (const seq of [-1, 1.5, 'x', null]) expect((await read(seq)).status).toBe(400);
    const missing = await request('/api/conversations/nope/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"seq":1}',
    });
    expect(missing.status).toBe(404);
    const form = await request(`/api/conversations/${id}/read`, {
      method: 'POST',
      body: 'seq=1',
    });
    expect(form.status).toBe(415);
    const broken = await request(`/api/conversations/${id}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: '请求参数不对：请求体不是合法的 JSON' });
  });
});

describe('消息', () => {
  async function withMessages(count: number) {
    const storage = createMemoryStorage();
    const written: Message[] = [];
    for (let i = 1; i <= count; i++) {
      written.push(
        message(i % 2 ? 'user' : 'assistant', `第 ${i} 条`, i % 2 ? { author: alice } : {}),
      );
    }
    const id = await conversation(storage, { platform: 'cli' }, written);
    const service = await testService({ storage });
    const page = (query = '') =>
      json<MessagesResponse>(service.request(`/api/conversations/${id}/messages${query}`));
    return { ...service, id, written, page };
  }

  const seqs = (response: MessagesResponse) => response.messages.map((m) => m.seq);

  it('分批取：从最新往前，按序号升序；before、limit；前面还有没有', async () => {
    const { page, written } = await withMessages(7);

    const latest = await page('?limit=3');
    expect(seqs(latest)).toEqual([5, 6, 7]);
    expect(latest.hasMore).toBe(true);
    expect(latest.messages[0]).toEqual({
      seq: 5,
      id: written[4]!.id,
      role: 'user',
      createdAt: '2026-11-01T10:00:00.000Z',
      message: written[4],
      tools: {},
      images: {},
    });
    expect(seqs(await page('?before=5&limit=3'))).toEqual([2, 3, 4]);
    const first = await page('?before=2&limit=3');
    expect(seqs(first)).toEqual([1]);
    expect(first.hasMore).toBe(false);
    expect(await page('?before=1')).toEqual({ messages: [], hasMore: false });
    const all = await page();
    expect(seqs(all)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all.hasMore).toBe(false);
  });

  it('默认 200 条，最多 1000 条', async () => {
    const { page } = await withMessages(1003);

    const latest = await page();
    expect(latest.messages).toHaveLength(200);
    expect(seqs(latest)[0]).toBe(804);
    expect(latest.hasMore).toBe(true);
    const most = await page('?limit=1000');
    expect(most.messages).toHaveLength(1000);
    expect(most.hasMore).toBe(true);
    expect(seqs(await page('?before=4&limit=1000'))).toEqual([1, 2, 3]);
  });

  it('参数不对返回 400 与 JSON', async () => {
    const { request, id } = await withMessages(1);

    for (const query of [
      '?limit=0',
      '?limit=1001',
      '?limit=abc',
      '?limit=1.5',
      '?before=0',
      '?before=x',
    ]) {
      const response = await request(`/api/conversations/${id}/messages${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorResponse).error).toMatch(/^请求参数不对：/);
    }
  });

  it('工具结果的文字超过 2000 个字符时截短，给出原来的长度；图片照留', async () => {
    const storage = createMemoryStorage();
    const fileStore = createMemoryFileStore();
    const image = await fileStore.save({ data: png(800, 600, 'tool'), mediaType: 'image/png' });
    const long = '字'.repeat(5000);
    const withImage: StoredToolContent = {
      type: 'luoli-content',
      parts: [
        { type: 'text', text: '图'.repeat(3000) },
        { type: 'image', url: image, mediaType: 'image/png', width: 800, height: 600, bytes: 52 },
      ],
    };
    const tools = [
      {
        type: 'tool-fetch',
        toolCallId: 'long',
        state: 'output-available',
        input: { url: 'a' },
        output: long,
      },
      {
        type: 'tool-fetch',
        toolCallId: 'short',
        state: 'output-available',
        input: { url: 'b' },
        output: { ok: true },
      },
      {
        type: 'tool-fetch',
        toolCallId: 'json',
        state: 'output-available',
        input: {},
        output: { text: 'j'.repeat(3000) },
      },
      {
        type: 'tool-fetch',
        toolCallId: 'image',
        state: 'output-available',
        input: {},
        output: withImage,
      },
      {
        type: 'tool-fetch',
        toolCallId: 'error',
        state: 'output-error',
        input: {},
        errorText: 'e'.repeat(2500),
      },
    ] as unknown as Part[];
    const stored = message('assistant', [...tools, { type: 'text', text: '读完了' }]);
    const id = await conversation(storage, { platform: 'cli' }, [stored]);
    const { request } = await testService({ storage, fileStore });

    const { messages } = await json<MessagesResponse>(request(`/api/conversations/${id}/messages`));
    const [got] = messages as [ApiMessage];
    const parts = got.message.parts as Array<Record<string, unknown>>;

    expect(got.tools).toEqual({
      long: { chars: 5000, truncated: true },
      short: { chars: 11, truncated: false },
      json: { chars: JSON.stringify({ text: 'j'.repeat(3000) }).length, truncated: true },
      image: { chars: 3000, truncated: true },
      error: { chars: 2500, truncated: true },
    });
    expect(parts[0]!.output).toBe('字'.repeat(2000));
    expect(parts[1]!.output).toEqual({ ok: true });
    expect(parts[2]!.output).toBe(JSON.stringify({ text: 'j'.repeat(3000) }).slice(0, 2000));
    expect(parts[3]!.output).toEqual({
      type: 'luoli-content',
      parts: [{ type: 'text', text: '图'.repeat(2000) }, withImage.parts[1]],
    });
    expect(parts[4]!.errorText).toBe('e'.repeat(2000));
    expect(parts[5]).toEqual({ type: 'text', text: '读完了' });
    // 工具结果里的图片也在 images 里
    expect(got.images).toEqual({
      [image]: { src: `/api/files/${image.slice('luoli-file:'.length)}`, width: 800, height: 600 },
    });
  });

  it('存下来的消息形状不对：不让整批失败，缺的按空算，坏的段原样放过', async () => {
    // 核心写不出这样的消息：直接改 SQLite 里存的 JSON
    const dir = await mkdtemp(join(tmpdir(), 'luoli-odd-'));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => {
      storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    const fileStore = createMemoryFileStore();
    const good = await fileStore.save({ data: png(40, 30, 'good'), mediaType: 'image/png' });
    const id = await storage.createConversation({ platform: 'telegram' });
    const store = await storage.openConversation(id);
    for (const messageId of ['no-error-text', 'odd-parts', 'no-parts', 'not-object']) {
      await store.add(message('assistant', '占位', {}));
      const raw = new DatabaseSync(path);
      raw
        .prepare(
          'UPDATE messages SET id = ? WHERE id = (SELECT id FROM messages ORDER BY seq DESC LIMIT 1)',
        )
        .run(messageId);
      raw.close();
    }
    const createdAt = '2026-11-01T10:00:00.000Z';
    const stored: Record<string, unknown> = {
      // 工具出错但没有错误说明
      'no-error-text': {
        id: 'no-error-text',
        role: 'assistant',
        metadata: { createdAt },
        parts: [{ type: 'tool-fetch', toolCallId: 'e1', state: 'output-error', input: {} }],
      },
      // 段不是对象、图片没有地址、带图片的结果里有坏段、宽高不是数字
      'odd-parts': {
        id: 'odd-parts',
        role: 'assistant',
        metadata: { createdAt },
        parts: [
          null,
          3,
          { type: 'file', mediaType: 'image/png' },
          {
            type: 'tool-fetch',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: {
              type: 'luoli-content',
              parts: [
                null,
                { type: 'text' },
                { type: 'text', text: '结果' },
                { type: 'image', mediaType: 'image/png' },
                { type: 'image', url: good, mediaType: 'image/png', width: '40', bytes: 1 },
              ],
            },
          },
          { type: 'text', text: '还在' },
        ],
      },
      // parts 不是数组；整条消息不是对象
      'no-parts': { id: 'no-parts', role: 'user', metadata: { createdAt }, parts: 'oops' },
      'not-object': null,
    };
    const raw = new DatabaseSync(path);
    for (const [messageId, value] of Object.entries(stored)) {
      raw
        .prepare('UPDATE messages SET ui_message = ? WHERE id = ?')
        .run(JSON.stringify(value), messageId);
    }
    raw.close();
    const { request } = await testService({ storage, fileStore });

    const response = await request(`/api/conversations/${id}/messages`);
    expect(response.status).toBe(200);
    const { messages } = (await response.json()) as MessagesResponse;
    const [noErrorText, oddParts, noParts, notObject] = messages as [
      ApiMessage,
      ApiMessage,
      ApiMessage,
      ApiMessage,
    ];

    expect(noErrorText.tools).toEqual({ e1: { chars: 0, truncated: false } });
    expect(noErrorText.message.parts).toEqual([
      { type: 'tool-fetch', toolCallId: 'e1', state: 'output-error', input: {} },
    ]);
    expect(oddParts.tools).toEqual({ c1: { chars: 2, truncated: false } });
    expect(oddParts.message.parts.slice(0, 3)).toEqual([
      null,
      3,
      { type: 'file', mediaType: 'image/png' },
    ]);
    expect(oddParts.message.parts.at(-1)).toEqual({ type: 'text', text: '还在' });
    // 只有地址对的图片进 images；宽高不是数字时不给宽高
    expect(oddParts.images).toEqual({
      [good]: { src: `/api/files/${good.slice('luoli-file:'.length)}` },
    });
    expect(noParts).toMatchObject({ id: 'no-parts', role: 'user', tools: {}, images: {} });
    expect(noParts.message.parts).toEqual([]);
    expect(notObject).toMatchObject({ seq: 4, id: '', role: 'user', tools: {}, images: {} });
    expect(notObject.message.parts).toEqual([]);
    // 会话列表与会话概况照常
    expect((await request('/api/conversations')).status).toBe(200);
    expect((await request(`/api/conversations/${id}`)).status).toBe(200);
  });

  it('图片：地址 → 取图的路径与宽高；文件不在了为 null', async () => {
    const storage = createMemoryStorage();
    const fileStore = createMemoryFileStore();
    const photo = await fileStore.save({ data: png(1280, 720, 'photo'), mediaType: 'image/png' });
    const lost = `luoli-file:${'0'.repeat(64)}.jpg`;
    const id = await conversation(storage, { platform: 'telegram' }, [
      message(
        'user',
        [
          { type: 'text', text: '看图' },
          { type: 'file', mediaType: 'image/png', url: photo },
          { type: 'file', mediaType: 'image/jpeg', url: lost },
        ],
        { author: alice },
      ),
    ]);
    const { request } = await testService({ storage, fileStore });

    const { messages } = await json<MessagesResponse>(request(`/api/conversations/${id}/messages`));
    expect(messages[0]!.images).toEqual({
      [photo]: { src: `/api/files/${photo.slice('luoli-file:'.length)}`, width: 1280, height: 720 },
      [lost]: null,
    });
  });
});

describe('今日概况', () => {
  /** 一次模型调用，默认是今天正常完成的回复 */
  function call(fields: Partial<ModelCall> = {}): ModelCall {
    return {
      purpose: 'reply',
      replyId: 'r',
      model: 'm',
      startedAt: '2026-11-08T02:00:00.000Z',
      durationMs: 1000,
      attempts: 1,
      outcome: 'completed',
      inputTokens: 100,
      cacheReadTokens: 60,
      outputTokens: 20,
      ...fields,
    };
  }

  it('服务器时区的今天 0 点起；回复数只算回复，token 算上摘要；各会话的回复数', async () => {
    const storage = createMemoryStorage();
    const group = await conversation(storage, { platform: 'telegram', title: '读书会' });
    const cli = await conversation(storage, { platform: 'cli' });
    const storeGroup = await storage.openConversation(group);
    const storeCli = await storage.openConversation(cli);
    // 新加坡（UTC+8）2026-11-08 的 0 点是 2026-11-07T16:00Z
    await storeGroup.recordCall(call({ startedAt: '2026-11-07T15:59:59.999Z' }));
    await storeGroup.recordCall(call({ startedAt: '2026-11-07T16:00:00.000Z' }));
    await storeGroup.recordCall(call());
    await storeCli.recordCall(call());
    await storeCli.recordCall(
      call({
        outcome: 'failed',
        inputTokens: 5,
        cacheReadTokens: undefined,
        outputTokens: undefined,
      }),
    );
    await storeGroup.recordCall(
      call({
        purpose: 'summary',
        replyId: undefined,
        inputTokens: 1000,
        cacheReadTokens: 0,
        outputTokens: 300,
      }),
    );
    const { request } = await testService({
      storage,
      timeZone: 'Asia/Singapore',
      now: () => new Date('2026-11-08T15:59:00.000Z'),
    });

    expect(await json<TodaySummary>(request('/api/today'))).toEqual({
      date: '2026-11-08',
      timeZone: 'Asia/Singapore',
      since: '2026-11-07T16:00:00.000Z',
      replies: 3,
      failedReplies: 1,
      inputTokens: 100 * 3 + 5 + 1000,
      cacheReadTokens: 60 * 3,
      outputTokens: 20 * 3 + 300,
      conversations: [
        { id: group, title: '读书会', replies: 2 },
        { id: cli, replies: 1 },
      ],
    });
  });

  it('过了服务器时区的 0 点，昨天的不再算', async () => {
    const storage = createMemoryStorage();
    const id = await conversation(storage, { platform: 'cli' });
    await (
      await storage.openConversation(id)
    ).recordCall(call({ startedAt: '2026-11-08T15:00:00.000Z' }));
    let now = new Date('2026-11-08T15:59:59.000Z');
    const { request } = await testService({ storage, timeZone: 'Asia/Singapore', now: () => now });

    expect(await json<TodaySummary>(request('/api/today'))).toMatchObject({
      date: '2026-11-08',
      replies: 1,
    });
    now = new Date('2026-11-08T16:00:00.000Z');
    expect(await json<TodaySummary>(request('/api/today'))).toMatchObject({
      date: '2026-11-09',
      since: '2026-11-08T16:00:00.000Z',
      replies: 0,
      conversations: [],
    });
  });
});

describe('文件', () => {
  it('按名字取文件存储里的图片：类型照文件，长缓存', async () => {
    const fileStore = createMemoryFileStore();
    const data = png(10, 20, 'file');
    const url = await fileStore.save({ data, mediaType: 'image/png' });
    const { request } = await testService({ fileStore });

    const response = await request(`/api/files/${url.slice('luoli-file:'.length)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
  });

  it('不在的文件 404；名字不对 400；路径穿越读不到东西', async () => {
    const { request } = await testService();

    const missing = await request(`/api/files/${'a'.repeat(64)}.png`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: '没有这个文件' });
    for (const name of [
      'abc.png',
      `${'a'.repeat(64)}.txt`,
      `${'A'.repeat(64)}.png`,
      '..%2F..%2Fpackage.json',
      '%2e%2e%2fpackage.json',
      `..%2f${'a'.repeat(64)}.png`,
    ]) {
      const response = await request(`/api/files/${name}`);
      expect(response.status).toBe(400);
    }
    for (const path of ['/api/files/', '/api/files']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    // 没编码的 ../ 在路由之前就被 URL 规范掉了，到不了文件接口，也读不到仓库里的文件
    const dotted = await request('/api/files/../../package.json');
    expect(await dotted.text()).not.toContain('luolicore');
  });
});
