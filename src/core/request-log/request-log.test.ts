import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMemoryFileStore,
  openFileStore,
  openRequestLog,
  type FileStore,
  type LoggedRequest,
  type NewFile,
  type NewRequest,
  type RequestLog,
  type RequestLogOptions,
} from '../index.js';

const opened: RequestLog[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const log of opened.splice(0)) log.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'luolicore-requests-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function open(options: RequestLogOptions): RequestLog {
  const log = openRequestLog(options);
  opened.push(log);
  return log;
}

/** 临时目录里新建一个请求记录 */
async function setup({
  fileStore = createMemoryFileStore() as FileStore,
  retentionDays = 30,
} = {}) {
  const dir = await tempDir();
  const path = join(dir, 'requests.db');
  const log = open({ path, fileStore, retentionDays });
  return { dir, path, fileStore, log };
}

/** 直接数测试数据库里某张表的行数 */
function rows(path: string, table: 'requests' | 'contents' | 'request_contents'): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  } finally {
    db.close();
  }
}

// 各类型的「图片」：文件头正确，后面的内容随意
const red: NewFile = {
  data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
  mediaType: 'image/png',
};
const blue: NewFile = {
  data: Uint8Array.from([0xff, 0xd8, 0xff, 4, 5, 6]),
  mediaType: 'image/jpeg',
};
const green: NewFile = {
  data: Uint8Array.from([...[...'GIF89a'].map((char) => char.charCodeAt(0)), 7]),
  mediaType: 'image/gif',
};
const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
const dataUrl = (file: NewFile) => `data:${file.mediaType};base64,${base64(file.data)}`;
const imagePart = (url: string) => ({ type: 'image_url', image_url: { url } });

type ChatMessage = Record<string, unknown>;

const system: ChatMessage = { role: 'system', content: '你是测试助手\n\n## 当前会话\n测试群' };
const tag = (text: string) =>
  `<message from="Alice" uid="u-alice" time="2026-11-01 14:00">\n${text}\n</message>`;
const user = (text: string): ChatMessage => ({ role: 'user', content: tag(text) });
const toolCallMessage: ChatMessage = {
  role: 'assistant',
  content: '我看看',
  tool_calls: [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'fetch', arguments: '{"url":"https://example.com"}' },
    },
  ],
};
const toolText: ChatMessage = {
  role: 'tool',
  tool_call_id: 'call_1',
  content: '抓取失败：HTTP 404',
};
const toolImage = (url: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: 'call_2',
  content: [{ type: 'text', text: '图片如下' }, imagePart(url)],
});
const userImage = (url: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text: tag('看图') }, imagePart(url)],
});

const tools = [
  {
    type: 'function',
    function: {
      name: 'fetch',
      description: '读网页',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

/** provider 发出的那样的请求体：紧凑的 JSON.stringify */
function chatBody(messages: ChatMessage[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'test-model',
    temperature: 0.7,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    ...extra,
  });
}

/** 一次请求，默认是正常完成的回复第一步 */
function request(fields: Partial<NewRequest> = {}): NewRequest {
  return {
    conversationId: 'c1',
    purpose: 'reply',
    replyId: 'r1',
    step: 1,
    attempt: 1,
    startedAt: '2026-11-01T06:00:00.000Z',
    durationMs: 1200,
    outcome: 'completed',
    body: chatBody([system, user('你好')]),
    response: { status: 200, text: '你好呀', finishReason: 'stop' },
    ...fields,
  };
}

type Body = { messages: Array<{ content: unknown }> };

/** 请求体里 messages 的 image_url.url，按出现的顺序 */
function imageUrls(body: LoggedRequest['body']): string[] {
  const urls: string[] = [];
  for (const message of (body as Body).messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ image_url?: { url: string } }>) {
      if (part.image_url) urls.push(part.image_url.url);
    }
  }
  return urls;
}

describe('存取', () => {
  it('拼回的请求体与写入的字符串一字不差；其余字段原样读回', async () => {
    const fileStore = createMemoryFileStore();
    await fileStore.save(red);
    const { log } = await setup({ fileStore });
    const body = chatBody([
      system,
      user('帮我看看 <b>这个</b> 网页 "引号" \\ 反斜杠 \u0001 😀'),
      toolCallMessage,
      toolText,
      toolImage(dataUrl(red)),
    ]);
    const written = request({
      step: 2,
      attempt: 3,
      durationMs: 4567,
      outcome: 'failed',
      body,
      response: {
        status: 500,
        text: '半截',
        reasoning: '想一想',
        toolCalls: [
          { id: 'call_9', name: 'fetch', arguments: '{"url":"https://example.com"' },
          { name: 'dice', arguments: '{}' },
        ],
        finishReason: 'error',
        usage: { input: 1000, cacheRead: 800, output: 20, reasoning: 5 },
        error: '{"error":{"message":"服务端出错"}}',
      },
    });

    await log.record(written);
    const [read] = await log.list({}, { embedImages: true });

    const { body: readBody, id, ...fields } = read!;
    expect(JSON.stringify(readBody)).toBe(body);
    expect({ ...fields, body }).toEqual(written);
    expect(typeof id).toBe('number');
  });

  it('摘要请求没有回复 id 与步，读出时也没有', async () => {
    const { log } = await setup();

    await log.record(request({ purpose: 'summary', replyId: undefined, step: undefined }));
    const [read] = await log.list();

    expect(read!.purpose).toBe('summary');
    expect(read!.replyId).toBeUndefined();
    expect(read!.step).toBeUndefined();
  });

  it('没有 messages、tools，或它们不是数组、带特殊的键：照样拼回一样的字符串', async () => {
    const { log } = await setup();
    const bodies = [
      JSON.stringify({ model: 'm', prompt: 'hi' }),
      JSON.stringify({ model: 'm', messages: [system, user('无工具')] }),
      JSON.stringify({ tools, model: 'm' }),
      JSON.stringify({ model: 'm', messages: 'not an array', tools: 'not an array' }),
      JSON.stringify({ model: 'm', messages: [], tools: [] }),
      JSON.stringify({ messages: [1, 'two', null, [3]], model: 'm' }),
      '{"__proto__":{"messages":[1]},"messages":[{"__proto__":"x","role":"user"}],"z":1,"a":2}',
      JSON.stringify({ 2: 'b', 1: 'a', model: 'm', messages: [{ 10: 'x', 9: 'y', role: 'user' }] }),
    ];

    for (const body of bodies) await log.record(request({ body }));
    const read = await log.list();

    expect(read.map((item) => JSON.stringify(item.body))).toEqual(bodies);
  });

  it('不是 JSON、不是对象或不是紧凑格式的请求体：原样存取字符串', async () => {
    const { log } = await setup();
    const bodies = [
      'not json at all {',
      '',
      JSON.stringify([system]),
      '"just a string"',
      JSON.stringify(JSON.parse(chatBody([system, user('hi')])), null, 2),
      '{"model":"m","temperature":1.0,"messages":[]}',
    ];

    for (const body of bodies) await log.record(request({ body }));
    const read = await log.list({}, { embedImages: true });

    expect(read.map((item) => item.body)).toEqual(bodies);
  });
});

describe('去重', () => {
  it('同一段里后一次请求只多出新消息的内容；tools 只存一份', async () => {
    const { log, path } = await setup();

    await log.record(request({ body: chatBody([system, user('第一句')]) }));
    // system、第一句、tools
    expect(rows(path, 'contents')).toBe(3);
    await log.record(
      request({
        replyId: 'r2',
        body: chatBody([
          system,
          user('第一句'),
          { role: 'assistant', content: '嗯' },
          user('第二句'),
        ]),
      }),
    );

    expect(rows(path, 'requests')).toBe(2);
    expect(rows(path, 'contents')).toBe(5);
  });

  it('完全相同的重试只多一行请求，不多内容', async () => {
    const { log, path } = await setup();
    const body = chatBody([system, user('你好'), toolCallMessage, toolText]);

    await log.record(request({ body, outcome: 'failed' }));
    const before = rows(path, 'contents');
    await log.record(request({ body, attempt: 2 }));

    expect(rows(path, 'requests')).toBe(2);
    expect(rows(path, 'contents')).toBe(before);
    expect((await log.list()).map((item) => JSON.stringify(item.body))).toEqual([body, body]);
  });

  it('两个会话的 system 与 tools 相同时只存一份', async () => {
    const { log, path } = await setup();

    await log.record(request({ conversationId: 'a', body: chatBody([system, user('甲')]) }));
    await log.record(request({ conversationId: 'b', body: chatBody([system, user('乙')]) }));

    // system、tools、甲、乙
    expect(rows(path, 'contents')).toBe(4);
  });

  it('一次请求里两条一样的消息：内容存一份，拼回时两条都在', async () => {
    const { log, path } = await setup();
    const reply = { role: 'assistant', content: '好' };
    const body = chatBody([system, user('a'), reply, user('b'), reply]);

    await log.record(request({ body }));

    expect(rows(path, 'contents')).toBe(5);
    expect(JSON.stringify((await log.list())[0]!.body)).toBe(body);
  });
});

describe('图片', () => {
  it('文件存储里有的图：读出时是 luoli-file 地址；embedImages 时与原字符串相同', async () => {
    const fileStore = createMemoryFileStore();
    const redUrl = await fileStore.save(red);
    const blueUrl = await fileStore.save(blue);
    const { log } = await setup({ fileStore });
    const body = chatBody([
      system,
      userImage(dataUrl(blue)),
      toolCallMessage,
      toolImage(dataUrl(red)),
    ]);

    await log.record(request({ body }));
    const [plain] = await log.list();
    const [embedded] = await log.list({}, { embedImages: true });

    expect(imageUrls(plain!.body)).toEqual([blueUrl, redUrl]);
    expect(plain!.missingImages).toBeUndefined();
    expect(JSON.stringify(embedded!.body)).toBe(body);
    expect(embedded!.missingImages).toBeUndefined();
  });

  it('文件存储里没有的图、写法或类型对不上的：读出时仍是原来的 data URL', async () => {
    const fileStore = createMemoryFileStore();
    await fileStore.save(red);
    await fileStore.save(blue);
    const { log } = await setup({ fileStore });
    const kept = [
      // 文件存储里没有
      dataUrl(green),
      // 类型不支持
      `data:image/bmp;base64,${base64(red.data)}`,
      // 声明的类型与文件头不符
      `data:image/jpeg;base64,${base64(red.data)}`,
      // base64 不是标准写法：去掉补齐、混进空白
      `data:image/png;base64,${base64(red.data).replace(/=+$/, '')}`,
      `data:image/png;base64, ${base64(red.data)}`,
      // 带参数、不是 base64
      `data:image/png;charset=x;base64,${base64(red.data)}`,
      `data:image/png,${base64(red.data)}`,
      'https://example.com/red.png',
    ];
    const body = chatBody([system, { role: 'user', content: kept.map(imagePart) }]);

    await log.record(request({ body }));
    const [read] = await log.list();

    expect(imageUrls(read!.body)).toEqual(kept);
    expect(JSON.stringify(read!.body)).toBe(body);
  });

  it('正文里出现的 data URL、luoli-file 文字不被替换', async () => {
    const fileStore = createMemoryFileStore();
    const redUrl = await fileStore.save(red);
    const { log } = await setup({ fileStore });
    const messages = (url: string) => [
      system,
      user(`看这个：${dataUrl(red)}，存在 ${redUrl}`),
      {
        role: 'user',
        content: [
          { type: 'text', text: dataUrl(red) },
          { type: 'text', text: redUrl, url: dataUrl(red) },
          imagePart(url),
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: dataUrl(red) },
    ];
    const body = chatBody(messages(dataUrl(red)));

    await log.record(request({ body }));
    const [plain] = await log.list();
    const [embedded] = await log.list({}, { embedImages: true });

    expect(JSON.stringify(plain!.body)).toBe(chatBody(messages(redUrl)));
    expect(JSON.stringify(embedded!.body)).toBe(body);
  });

  it('embedImages 时文件已被删掉：照旧是引用，missingImages 列出它', async () => {
    const filesDir = join(await tempDir(), 'files');
    const fileStore = openFileStore(filesDir);
    const redUrl = await fileStore.save(red);
    const blueUrl = await fileStore.save(blue);
    const { log } = await setup({ fileStore });
    await log.record(
      request({
        body: chatBody([system, userImage(dataUrl(red)), userImage(dataUrl(blue))]),
      }),
    );
    await log.record(request({ body: chatBody([system, userImage(dataUrl(blue))]) }));

    await rm(join(filesDir, redUrl.slice('luoli-file:'.length)));
    const [first, second] = await log.list({}, { embedImages: true });

    expect(imageUrls(first!.body)).toEqual([redUrl, dataUrl(blue)]);
    expect(first!.missingImages).toEqual([redUrl]);
    expect(imageUrls(second!.body)).toEqual([dataUrl(blue)]);
    expect(second!.missingImages).toBeUndefined();
    expect(blueUrl).toMatch(/^luoli-file:/);
  });

  it('同一张图出现在两次请求的同一条消息里：内容只存一份', async () => {
    const fileStore = createMemoryFileStore();
    await fileStore.save(red);
    const { log, path } = await setup({ fileStore });
    const withImage = userImage(dataUrl(red));

    await log.record(request({ body: chatBody([system, withImage]) }));
    await log.record(
      request({ body: chatBody([system, withImage, { role: 'assistant', content: '红的' }]) }),
    );

    // system、tools、带图的消息、「红的」
    expect(rows(path, 'contents')).toBe(4);
  });

  it('不存在文件存储里的图不进文件存储：写入不新增文件', async () => {
    const filesDir = join(await tempDir(), 'files');
    const fileStore = openFileStore(filesDir);
    const { log } = await setup({ fileStore });

    await log.record(request({ body: chatBody([system, userImage(dataUrl(red))]) }));

    expect(existsSync(filesDir)).toBe(false);
    const [read] = await log.list();
    expect(imageUrls(read!.body)).toEqual([dataUrl(red)]);
  });
});

describe('筛选与排序', () => {
  async function filled() {
    const { log } = await setup();
    const at = (minute: number) => `2026-11-01T06:${String(minute).padStart(2, '0')}:00.000Z`;
    // 写入顺序与开始时间的顺序不同；r2 两条开始时间相同
    await log.record(request({ conversationId: 'a', replyId: 'r3', startedAt: at(30) }));
    await log.record(request({ conversationId: 'a', replyId: 'r1', startedAt: at(10) }));
    await log.record(
      request({ conversationId: 'b', replyId: 'r2', startedAt: at(20), outcome: 'failed' }),
    );
    await log.record(
      request({ conversationId: 'b', replyId: 'r2', startedAt: at(20), attempt: 2 }),
    );
    await log.record(
      request({
        conversationId: 'c',
        purpose: 'summary',
        replyId: undefined,
        step: undefined,
        startedAt: at(40),
        outcome: 'failed',
      }),
    );
    await log.record(request({ conversationId: 'c', replyId: 'r4', startedAt: at(50) }));
    return { log, at };
  }

  const keys = (items: LoggedRequest[]) =>
    items.map((item) => `${item.conversationId}:${item.replyId ?? '-'}:${item.attempt}`);

  it('不给条件返回全部：按开始时间升序，相同时按写入先后', async () => {
    const { log } = await filled();

    const items = await log.list();

    expect(keys(items)).toEqual(['a:r1:1', 'b:r2:1', 'b:r2:2', 'a:r3:1', 'c:-:1', 'c:r4:1']);
    expect(items.map((item) => item.id)).toEqual([2, 3, 4, 1, 5, 6]);
  });

  it('按会话：一个、多个；空数组什么也不匹配', async () => {
    const { log } = await filled();

    expect(keys(await log.list({ conversationIds: ['a'] }))).toEqual(['a:r1:1', 'a:r3:1']);
    expect(keys(await log.list({ conversationIds: ['c', 'a'] }))).toEqual([
      'a:r1:1',
      'a:r3:1',
      'c:-:1',
      'c:r4:1',
    ]);
    expect(await log.list({ conversationIds: [] })).toEqual([]);
    expect(await log.list({ conversationIds: ['none'] })).toEqual([]);
  });

  it('since 含边界，until 不含；接受 Date 与带时区的字符串', async () => {
    const { log, at } = await filled();

    expect(keys(await log.list({ since: at(20), until: at(40) }))).toEqual([
      'b:r2:1',
      'b:r2:2',
      'a:r3:1',
    ]);
    expect(keys(await log.list({ since: new Date(at(40)) }))).toEqual(['c:-:1', 'c:r4:1']);
    expect(keys(await log.list({ until: '2026-11-01T14:20:00+08:00' }))).toEqual(['a:r1:1']);
    await expect(log.list({ since: 'not a time' })).rejects.toThrow('时间格式不对');
  });

  it('按回复 id；只看失败的；条件可以组合', async () => {
    const { log } = await filled();

    expect(keys(await log.list({ replyId: 'r2' }))).toEqual(['b:r2:1', 'b:r2:2']);
    expect(keys(await log.list({ failedOnly: true }))).toEqual(['b:r2:1', 'c:-:1']);
    expect(keys(await log.list({ failedOnly: true, conversationIds: ['b'] }))).toEqual(['b:r2:1']);
    expect(keys(await log.list({ failedOnly: false, replyId: 'r4' }))).toEqual(['c:r4:1']);
  });

  it('开始时间存成 UTC 的 ISO；写入时间格式不对时报错', async () => {
    const { log } = await setup();

    await log.record(request({ startedAt: '2026-11-01T14:00:00+08:00' }));
    await expect(log.record(request({ startedAt: 'yesterday' }))).rejects.toThrow('时间格式不对');

    expect((await log.list()).map((item) => item.startedAt)).toEqual(['2026-11-01T06:00:00.000Z']);
  });
});

describe('清理', () => {
  const now = new Date('2026-12-01T00:00:00.000Z');
  // 保留 30 天：早于 2026-11-01T00:00:00.000Z 的删掉
  const cutoff = '2026-11-01T00:00:00.000Z';

  it('删掉超过保留天数的请求与只被它们引用的内容；还被引用的内容与文件存储都不动', async () => {
    const filesDir = join(await tempDir(), 'files');
    const fileStore = openFileStore(filesDir);
    await fileStore.save(red);
    const { log, path } = await setup({ fileStore, retentionDays: 30 });
    const oldOnly = user('只在旧请求里');
    const shared = userImage(dataUrl(red));
    // 旧的两条：system、tools、shared、oldOnly、「旧回复」
    await log.record(
      request({ startedAt: '2026-10-01T00:00:00.000Z', body: chatBody([system, shared, oldOnly]) }),
    );
    await log.record(
      request({
        startedAt: '2026-10-31T23:59:59.999Z',
        body: chatBody([system, shared, oldOnly, { role: 'assistant', content: '旧回复' }]),
      }),
    );
    // 恰好在边界上的保留：system、tools、shared，加「新的」
    const keptBody = chatBody([system, shared, user('新的')]);
    await log.record(request({ startedAt: cutoff, body: keptBody }));
    expect(rows(path, 'contents')).toBe(6);
    const files = await readdir(filesDir);

    const result = await log.cleanup(now);

    expect(result).toEqual({ requests: 2, contents: 2 });
    expect(rows(path, 'requests')).toBe(1);
    expect(rows(path, 'contents')).toBe(4);
    expect(rows(path, 'request_contents')).toBe(4);
    const [kept] = await log.list({}, { embedImages: true });
    expect(kept!.startedAt).toBe(cutoff);
    expect(JSON.stringify(kept!.body)).toBe(keptBody);
    expect(await readdir(filesDir)).toEqual(files);

    // 再清理一次什么也不删
    expect(await log.cleanup(now)).toEqual({ requests: 0, contents: 0 });
  });

  it('保留天数为 0 时什么也不删', async () => {
    const { log, path } = await setup({ retentionDays: 0 });
    await log.record(request({ startedAt: '2000-01-01T00:00:00.000Z' }));

    expect(await log.cleanup(now)).toEqual({ requests: 0, contents: 0 });
    expect(rows(path, 'requests')).toBe(1);
  });

  it('不传 now 时按当前时间', async () => {
    const { log } = await setup({ retentionDays: 1 });
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await log.record(request({ startedAt: '2000-01-01T00:00:00.000Z' }));
    await log.record(request({ startedAt: recent }));

    expect(await log.cleanup()).toEqual({ requests: 1, contents: 0 });
    expect((await log.list()).map((item) => item.startedAt)).toEqual([recent]);
  });

  it('保留天数不能是负数或非数', async () => {
    const path = join(await tempDir(), 'requests.db');
    const fileStore = createMemoryFileStore();

    expect(() => openRequestLog({ path, fileStore, retentionDays: -1 })).toThrow('保留天数');
    expect(() => openRequestLog({ path, fileStore, retentionDays: Number.NaN })).toThrow(
      '保留天数',
    );
  });
});

describe('数据库文件', () => {
  it('写入、关闭、重新打开后照样读得出；user_version 为 1', async () => {
    const fileStore = createMemoryFileStore();
    await fileStore.save(red);
    const { log, path } = await setup({ fileStore });
    const body = chatBody([system, userImage(dataUrl(red))]);
    await log.record(request({ body }));
    log.close();

    const reopened = open({ path, fileStore, retentionDays: 30 });
    const [read] = await reopened.list({}, { embedImages: true });

    expect(JSON.stringify(read!.body)).toBe(body);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    db.close();
  });

  it('文件比程序新时打开报错', async () => {
    const path = join(await tempDir(), 'requests.db');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();

    expect(() =>
      openRequestLog({ path, fileStore: createMemoryFileStore(), retentionDays: 30 }),
    ).toThrow('比程序新');
  });

  it(':memory: 也能用', async () => {
    const log = open({ path: ':memory:', fileStore: createMemoryFileStore(), retentionDays: 30 });
    const body = chatBody([system, user('内存里')]);

    await log.record(request({ body }));

    expect(JSON.stringify((await log.list())[0]!.body)).toBe(body);
  });
});

describe('只读', () => {
  it('另一个连接写入后能读到新数据', async () => {
    const fileStore = createMemoryFileStore();
    const { log, path } = await setup({ fileStore });
    await log.record(request({ replyId: 'r1' }));
    const reader = open({ path, fileStore, readOnly: true });
    expect((await reader.list()).map((item) => item.replyId)).toEqual(['r1']);

    const body = chatBody([system, user('后来的')]);
    await log.record(request({ replyId: 'r2', body }));

    const items = await reader.list();
    expect(items.map((item) => item.replyId)).toEqual(['r1', 'r2']);
    expect(JSON.stringify(items[1]!.body)).toBe(body);
  });

  it('写入、清理抛错，不改库', async () => {
    const { log, path } = await setup();
    await log.record(request());
    log.close();
    const reader = open({ path, fileStore: createMemoryFileStore(), readOnly: true });

    await expect(reader.record(request())).rejects.toThrow('只读');
    await expect(reader.cleanup(new Date('2100-01-01T00:00:00.000Z'))).rejects.toThrow('只读');
    expect(rows(path, 'requests')).toBe(1);
  });

  it('文件不存在时报错，且不创建文件', async () => {
    const path = join(await tempDir(), 'missing.db');

    expect(() =>
      openRequestLog({ path, fileStore: createMemoryFileStore(), readOnly: true }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('文件还没建表（版本比程序旧）时报错', async () => {
    const path = join(await tempDir(), 'empty.db');
    await writeFile(path, '');

    expect(() =>
      openRequestLog({ path, fileStore: createMemoryFileStore(), readOnly: true }),
    ).toThrow('比程序旧');
  });
});

describe('两个写连接', () => {
  it('交替写入同一个文件，都成功', async () => {
    const fileStore = createMemoryFileStore();
    const { log: first, path } = await setup({ fileStore });
    const second = open({ path, fileStore, retentionDays: 30 });

    const history: ChatMessage[] = [system];
    for (let i = 0; i < 10; i++) {
      history.push(user(`第 ${i} 句`));
      const writer = i % 2 === 0 ? first : second;
      await writer.record(request({ conversationId: `c${i % 2}`, body: chatBody(history) }));
    }

    const items = await first.list();
    expect(items).toHaveLength(10);
    expect(JSON.stringify(items[9]!.body)).toBe(chatBody(history));
    // system、tools、10 句
    expect(rows(path, 'contents')).toBe(12);
  });

  it('另一个连接正拿着写锁时，等它释放后写入成功', async () => {
    const { log, path } = await setup();
    await log.record(request({ replyId: 'r1' }));

    // 另一个线程开一个写事务，拿着锁 300 毫秒再提交；告诉这边拿到锁的时间
    const holdMs = 300;
    const worker = new Worker(
      `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const db = new DatabaseSync(workerData.path);
db.exec('BEGIN IMMEDIATE');
parentPort.postMessage(Date.now());
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
db.exec('COMMIT');
db.close();
`,
      { eval: true, workerData: { path, holdMs } },
    );
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    const lockedAt = await new Promise<number>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });

    await log.record(request({ replyId: 'r2' }));

    // 写入只能在对方提交之后完成
    expect(Date.now()).toBeGreaterThanOrEqual(lockedAt + holdMs - 5);
    expect((await log.list()).map((item) => item.replyId)).toEqual(['r1', 'r2']);
    await exited;
  });
});
