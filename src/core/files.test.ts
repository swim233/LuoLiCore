import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConversation,
  createMemoryFileStore,
  createMemoryStore,
  openFileStore,
  openSqliteStorage,
  type Conversation,
  type ConversationStore,
  type FileStore,
  type Logger,
  type Message,
  type MessageChunk,
} from './index.js';
import { inlineFiles, isSupportedImage } from './files.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const alice = { id: 'u-alice', name: 'Alice' };
const instructions = '你是测试助手';

// 固定时区与时钟：标签里的 time 是 2026-10-30 14:02
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-30T06:02:00.000Z') });
});
const opened: Conversation[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

const open = '<message from="Alice" uid="u-alice" time="2026-10-30 14:02">';

// 各类型的「图片」：文件头正确，后面的内容随意，模型不解码
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const headers = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')],
  'image/gif': ascii('GIF89a'),
};
const image = (mediaType: keyof typeof headers, ...rest: number[]) => ({
  data: Uint8Array.from([...headers[mediaType], ...rest]),
  mediaType,
});
const red = image('image/png', 1, 2, 3);
const blue = image('image/jpeg', 4, 5, 6);
const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'luolicore-files-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function textParts(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    },
  ];
}

/** 依次给出这些回复（回复与摘要都算一次调用） */
function replying(...texts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: texts.map((text) => ({
      stream: simulateReadableStream({ chunks: textParts(text) }),
    })),
  });
}

/** 模型第 call 次调用收到的消息（不含 system），内容原样 */
function messagesOf(model: MockLanguageModelV4, call: number) {
  return (model.doStreamCalls[call]?.prompt ?? []).filter((m) => m.role !== 'system');
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

function setup({
  model,
  fileStore = createMemoryFileStore(),
  store = createMemoryStore(),
  segments,
}: {
  model: MockLanguageModelV4;
  fileStore?: FileStore;
  store?: ConversationStore;
  segments?: Parameters<typeof createConversation>[0]['segments'];
}) {
  const { logger, entries } = recordingLogger();
  const conversation = createConversation({
    model,
    instructions,
    store,
    fileStore,
    logger,
    segments,
  });
  opened.push(conversation);
  return { conversation, store, fileStore, entries };
}

describe.each([
  ['目录', async () => openFileStore(join(await tempDir(), 'files'))],
  ['内存', async () => createMemoryFileStore()],
])('文件存储（%s）', (_name, openStore) => {
  it('同一份内容保存两次得到同一个地址；读回的字节相同', async () => {
    const store = await openStore();

    const first = await store.save(red);
    const second = await store.save({ data: Uint8Array.from(red.data), mediaType: red.mediaType });

    expect(first).toMatch(/^luoli-file:[0-9a-f]{64}\.png$/);
    expect(second).toBe(first);
    expect(await store.read(first)).toEqual(red.data);
  });

  it('扩展名按媒体类型；不支持的类型报错', async () => {
    const store = await openStore();

    const urls = await Promise.all(
      (['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const).map((mediaType) =>
        store.save(image(mediaType, 1)),
      ),
    );

    expect(urls.map((url) => url.split('.').at(-1))).toEqual(['jpg', 'png', 'webp', 'gif']);
    await expect(
      store.save({ data: Uint8Array.from([1]), mediaType: 'application/pdf' }),
    ).rejects.toThrow('application/pdf');
  });

  it('文件头与媒体类型不符（伪造或损坏的图片）：报错，不保存', async () => {
    const store = await openStore();
    const text = new TextEncoder().encode('这其实是一段文字，扩展名改成了 .png');
    const fakes = [
      // 改了扩展名的文字文件
      { data: text, mediaType: 'image/png' },
      // 别的类型的图片
      { data: blue.data, mediaType: 'image/png' },
      { data: red.data, mediaType: 'image/jpeg' },
      // 只有一半文件头
      { data: Uint8Array.from(headers['image/png'].slice(0, 4)), mediaType: 'image/png' },
      { data: Uint8Array.from([0xff, 0xd8]), mediaType: 'image/jpeg' },
      // RIFF 但不是 WEBP（如 WAV）
      {
        data: Uint8Array.from([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')]),
        mediaType: 'image/webp',
      },
      { data: Uint8Array.from(ascii('GIF88a')), mediaType: 'image/gif' },
      { data: new Uint8Array(), mediaType: 'image/jpeg' },
    ];

    for (const fake of fakes) {
      await expect(store.save(fake), fake.mediaType).rejects.toThrow('文件内容与媒体类型不符');
      expect(isSupportedImage(fake)).toBe(false);
    }
    // GIF 两个版本都算
    const gif87 = { data: Uint8Array.from(ascii('GIF87a')), mediaType: 'image/gif' };
    expect(isSupportedImage(gif87)).toBe(true);
    expect(await store.save(gif87)).toMatch(/\.gif$/);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    '对象原型上的键 %s 不算支持的类型',
    async (mediaType) => {
      const store = await openStore();

      await expect(store.save({ data: Uint8Array.from([1]), mediaType })).rejects.toThrow(
        '不支持的文件类型',
      );
    },
  );

  it('文件不存在、地址格式不对时读到 undefined，不抛错', async () => {
    const store = await openStore();

    expect(await store.read(`luoli-file:${'0'.repeat(64)}.png`)).toBeUndefined();
    expect(await store.read('luoli-file:../../etc/passwd')).toBeUndefined();
    expect(await store.read('https://example.com/a.png')).toBeUndefined();
  });
});

describe('目录里的文件', () => {
  it('<哈希>.<扩展名>：同一张图只存一份，不留临时文件；目录在第一次保存时才创建', async () => {
    const dir = join(await tempDir(), 'files');
    const store = openFileStore(dir);
    await expect(readdir(dir)).rejects.toThrow();

    // 被拒绝的不建目录、不留文件
    await expect(store.save({ data: red.data, mediaType: 'image/jpeg' })).rejects.toThrow();
    await expect(readdir(dir)).rejects.toThrow();
    const url = await store.save(red);
    await store.save(red);
    await store.save(blue);
    await expect(store.save({ data: blue.data, mediaType: 'image/gif' })).rejects.toThrow();

    const names = (await readdir(dir)).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain(url.slice('luoli-file:'.length));
    expect(names.every((name) => /^[0-9a-f]{64}\.(png|jpg)$/.test(name))).toBe(true);
  });

  it('地址拼不出目录外的路径：目录外有同名文件也读不到', async () => {
    const root = await tempDir();
    const name = `${'a'.repeat(64)}.png`;
    await writeFile(join(root, name), red.data);
    const store = openFileStore(join(root, 'files'));

    expect(await store.read(`luoli-file:../${name}`)).toBeUndefined();
  });
});

describe('inlineFiles', () => {
  it('luoli-file 地址换成按各自媒体类型的 data URL；其他 part 与其他地址不变', async () => {
    const store = createMemoryFileStore();
    const png = await store.save(red);
    const jpeg = await store.save(blue);
    const message: Message = {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'file', mediaType: 'image/png', url: png },
        { type: 'file', mediaType: 'image/jpeg', url: jpeg },
        { type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' },
      ],
    };

    const inlined = await inlineFiles(message, store, () => {});

    expect(inlined.parts).toEqual([
      { type: 'text', text: '看图' },
      { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${base64(red.data)}` },
      { type: 'file', mediaType: 'image/jpeg', url: `data:image/jpeg;base64,${base64(blue.data)}` },
      { type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' },
    ]);
    // 原消息不变
    expect(message.parts[1]).toEqual({ type: 'file', mediaType: 'image/png', url: png });
  });
});

describe('带图片的消息', () => {
  it('append：先存文件，消息里只有地址；parts 为文字在前、图片在后', async () => {
    const { conversation, store, fileStore } = setup({ model: replying() });

    const message = await conversation.append({ author: alice, text: '看图', files: [red, blue] });

    const [saved] = await store.list();
    expect(saved).toEqual(message);
    expect(saved?.parts).toEqual([
      { type: 'text', text: '看图' },
      { type: 'file', mediaType: 'image/png', url: await fileStore.save(red) },
      { type: 'file', mediaType: 'image/jpeg', url: await fileStore.save(blue) },
    ]);
    const json = JSON.stringify(saved);
    expect(json).not.toContain(base64(red.data));
    expect(json).not.toContain(base64(blue.data));
  });

  it('只有图片、没有文字：parts 只有图片', async () => {
    const { conversation } = setup({ model: replying() });

    const message = await conversation.append({ author: alice, files: [red] });

    expect(message.parts.map((part) => part.type)).toEqual(['file']);
  });

  it.each([
    ['不支持的媒体类型', { data: red.data, mediaType: 'application/pdf' }],
    [
      '文件头与媒体类型不符',
      { data: new TextEncoder().encode('伪造的 png'), mediaType: 'image/png' },
    ],
  ])('%s：append 报错，消息不写入', async (_name, file) => {
    const { conversation, store } = setup({ model: replying() });

    await expect(
      conversation.append({ author: alice, text: '文件', files: [file] }),
    ).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('发给模型：标签拆成两段包住图片，图片是对应媒体类型的数据', async () => {
    const model = replying('看到了');
    const { conversation } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [red, blue] });

    await readAll(conversation.reply());

    expect(messagesOf(model, 0)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: `${open}\n看图` },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: base64(red.data) } },
          {
            type: 'file',
            mediaType: 'image/jpeg',
            data: { type: 'data', data: base64(blue.data) },
          },
          { type: 'text', text: '</message>' },
        ],
      },
    ]);
  });

  it('只有图片：开标签之后直接是图片', async () => {
    const model = replying('看到了');
    const { conversation } = setup({ model });
    await conversation.append({ author: alice, files: [red] });

    await readAll(conversation.reply());

    expect(messagesOf(model, 0)[0]?.content).toEqual([
      { type: 'text', text: open },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: base64(red.data) } },
      { type: 'text', text: '</message>' },
    ]);
  });

  it('没有图片的消息与之前完全一样：一个 text part', async () => {
    const model = replying('好');
    const { conversation } = setup({ model });
    await conversation.append({ author: alice, text: '你好' });

    await readAll(conversation.reply());

    expect(messagesOf(model, 0)).toEqual([
      { role: 'user', content: [{ type: 'text', text: `${open}\n你好\n</message>` }] },
    ]);
  });

  it('文件丢失：这张图换成「[图片已丢失]」，记 warn（只有地址），回复照常', async () => {
    const model = replying('好');
    const fileStore = createMemoryFileStore();
    const { conversation, store, entries } = setup({ model });
    // 消息由另一个文件存储写入：引用的文件在这次的存储里不存在
    const other = setup({ model: replying(), store, fileStore });
    await other.conversation.append({ author: alice, text: '看图', files: [red] });

    const chunks = await readAll(conversation.reply());

    expect(chunks.at(-1)?.type).toBe('finish');
    expect(messagesOf(model, 0)[0]?.content).toEqual([
      { type: 'text', text: `${open}\n看图` },
      { type: 'text', text: '[图片已丢失]' },
      { type: 'text', text: '</message>' },
    ]);
    const missing = entries.filter((e) => e.msg === 'file.missing');
    expect(missing).toEqual([
      {
        level: 'warn',
        msg: 'file.missing',
        fields: expect.objectContaining({ url: await fileStore.save(red) }),
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(base64(red.data));
    expect((await store.list()).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('摘要请求沿用同一份前缀，图片一起发出', async () => {
    const model = replying('看到了', '摘要');
    const { conversation, store } = setup({ model, segments: { idleMs: 30 } });
    await conversation.append({ author: alice, text: '看图', files: [red] });
    await readAll(conversation.reply());

    vi.setSystemTime(Date.now() + 60_000);
    const deadline = performance.now() + 2000;
    while ((await store.currentSegment()).startReason !== 'idle') {
      if (performance.now() > deadline) throw new Error('等待超时');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const reply = messagesOf(model, 0);
    const summary = messagesOf(model, 1);
    expect(summary.slice(0, reply.length)).toEqual(reply);
    expect(summary.slice(reply.length).map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('SQLite 存储与目录文件存储：写入带图片的消息，重新打开后回复，发给模型的图片数据正确', async () => {
    const dir = await tempDir();
    const dbPath = join(dir, 'luoli.db');
    const filesDir = join(dir, 'files');
    const first = openSqliteStorage(dbPath);
    const id = await first.createConversation({ platform: 'cli' });
    const writer = setup({
      model: replying(),
      store: await first.openConversation(id),
      fileStore: openFileStore(filesDir),
    });
    await writer.conversation.append({ author: alice, text: '看图', files: [red] });
    await writer.conversation.close();
    first.close();

    const second = openSqliteStorage(dbPath);
    cleanups.push(async () => second.close());
    const model = replying('看到了');
    const { conversation } = setup({
      model,
      store: await second.openConversation(id),
      fileStore: openFileStore(filesDir),
    });
    await readAll(conversation.reply());

    expect(messagesOf(model, 0)[0]?.content).toEqual([
      { type: 'text', text: `${open}\n看图` },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: base64(red.data) } },
      { type: 'text', text: '</message>' },
    ]);
  });
});
