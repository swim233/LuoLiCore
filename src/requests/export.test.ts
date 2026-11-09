import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  openFileStore,
  openRequestLog,
  openSqliteStorage,
  type NewFile,
  type NewRequest,
} from '../core/index.js';
import { runExport, writeAndClose, writeJsonArray } from './export.js';

// 固定本机时区：输出的 time 按东八区
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'luolicore-export-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const now = new Date('2026-11-04T10:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const red: NewFile = {
  data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
  mediaType: 'image/png',
};
const dataUrl = (file: NewFile) =>
  `data:${file.mediaType};base64,${Buffer.from(file.data).toString('base64')}`;

const system = { role: 'system', content: '你是测试助手' };
const user = (text: string) => ({ role: 'user', content: text });
const body = (...messages: object[]) =>
  JSON.stringify({ model: 'm', messages: [system, ...messages], stream: true });

function request(fields: Partial<NewRequest>): NewRequest {
  return {
    conversationId: 'missing',
    purpose: 'reply',
    replyId: 'r1',
    step: 1,
    attempt: 1,
    startedAt: hoursAgo(1),
    durationMs: 1200,
    outcome: 'completed',
    body: body(user('你好')),
    response: { status: 200, text: '好', finishReason: 'stop' },
    ...fields,
  };
}

/** 临时目录里的主库、请求记录与文件存储；requests 是要写进请求记录的请求 */
async function fixture(
  build: (ids: { group: string; other: string; cli: string }) => NewRequest[],
) {
  const dir = await tempDir();
  const dbPath = join(dir, 'luoli.db');
  const filesDir = join(dir, 'files');
  const storage = openSqliteStorage(dbPath);
  const group = await storage.createConversation({
    platform: 'telegram',
    platformConversationId: '-1001',
    title: '读书会 Book Club',
  });
  const other = await storage.createConversation({
    platform: 'telegram',
    platformConversationId: '-1002',
    title: '读书会二群',
  });
  const cli = await storage.createConversation({ platform: 'cli' });
  // 标题里写着另一个群的 id：按 id 认出时不该把它也算上
  await storage.createConversation({
    platform: 'telegram',
    platformConversationId: '-1003',
    title: '旧群 -1001 的备份',
  });
  storage.close();
  const fileStore = openFileStore(filesDir);
  const imageUrl = await fileStore.save(red);
  const requestsPath = join(dir, 'requests.db');
  const log = openRequestLog({ path: requestsPath, fileStore, retentionDays: 0 });
  const requests = build({ group, other, cli });
  for (const item of requests) await log.record(item);
  log.close();
  return { dir, dbPath, filesDir, requestsPath, imageUrl, ids: { group, other, cli }, requests };
}

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** 跑一次导出：LUOLI_DB 指向 dir 里的主库 */
async function run(dir: string, ...argv: string[]) {
  const stdout = sink();
  const stderr = sink();
  const code = await runExport({
    argv,
    env: { LUOLI_DB: join(dir, 'luoli.db') },
    now,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** 导出的各项 */
async function exported(dir: string, ...argv: string[]) {
  const result = await run(dir, ...argv);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
}

describe('默认范围', () => {
  it('不给时间与回复：只导出最近 24 小时的', async () => {
    const f = await fixture(({ group }) => [
      request({ conversationId: group, replyId: 'old', startedAt: hoursAgo(25) }),
      request({ conversationId: group, replyId: 'edge', startedAt: hoursAgo(24) }),
      request({ conversationId: group, replyId: 'new', startedAt: hoursAgo(1) }),
    ]);

    const result = await run(f.dir);
    const items = JSON.parse(result.stdout) as Array<{ replyId: string }>;

    expect(items.map((item) => item.replyId)).toEqual(['edge', 'new']);
    expect(result.stderr).toBe(
      '导出 2 条请求（最近 24 小时，开始时间 2026-11-03 18:00:00 至 不限），写到标准输出\n',
    );
  });

  it('给了 --reply 时不受 24 小时限制', async () => {
    const f = await fixture(({ group }) => [
      request({ conversationId: group, replyId: 'old', startedAt: hoursAgo(100) }),
      request({ conversationId: group, replyId: 'old', attempt: 2, startedAt: hoursAgo(99) }),
      request({ conversationId: group, replyId: 'new' }),
    ]);

    const items = await exported(f.dir, '--reply', 'old');

    expect(items.map((item) => [item.replyId, item.attempt])).toEqual([
      ['old', 1],
      ['old', 2],
    ]);
  });

  it('--since、--until 照给的；--failed 只看失败的', async () => {
    const f = await fixture(({ group }) => [
      request({ conversationId: group, replyId: 'a', startedAt: hoursAgo(50) }),
      request({ conversationId: group, replyId: 'b', startedAt: hoursAgo(40), outcome: 'failed' }),
      request({ conversationId: group, replyId: 'c', startedAt: hoursAgo(30) }),
    ]);

    expect((await exported(f.dir, '--since', '2d')).map((item) => item.replyId)).toEqual([
      'b',
      'c',
    ]);
    expect(
      (await exported(f.dir, '--since', '3d', '--until', '35h')).map((item) => item.replyId),
    ).toEqual(['a', 'b']);
    expect(
      (await exported(f.dir, '--since', '3d', '--failed')).map((item) => item.replyId),
    ).toEqual(['b']);
  });
});

describe('会话', () => {
  async function three() {
    return fixture(({ group, other, cli }) => [
      request({ conversationId: group, replyId: 'g' }),
      request({ conversationId: other, replyId: 'o' }),
      request({ conversationId: cli, replyId: 'c' }),
    ]);
  }
  const replies = (items: Array<Record<string, unknown>>) => items.map((item) => item.replyId);

  it('按会话 id、Telegram 群 id（负数）、标题片段（不分大小写）', async () => {
    const f = await three();

    expect(replies(await exported(f.dir, '--conversation', f.ids.cli))).toEqual(['c']);
    expect(replies(await exported(f.dir, '--conversation', '-1002'))).toEqual(['o']);
    expect(replies(await exported(f.dir, '--conversation', 'book CLUB'))).toEqual(['g']);
  });

  it('一段文字匹配到多个会话时全部算上，stderr 列出；多个 --conversation 合起来', async () => {
    const f = await three();

    const result = await run(f.dir, '--conversation', '读书会');
    expect(replies(JSON.parse(result.stdout))).toEqual(['g', 'o']);
    expect(result.stderr.split('\n').slice(0, 2)).toEqual([
      `会话：读书会 Book Club（telegram，${f.ids.group}）`,
      `会话：读书会二群（telegram，${f.ids.other}）`,
    ]);
    expect(
      replies(await exported(f.dir, '--conversation', '-1001', '--conversation', f.ids.cli)),
    ).toEqual(['g', 'c']);
  });

  it('依次按 id、群 id、标题认，先认出的为准：群 id 相同时不再看标题', async () => {
    const f = await three();

    const result = await run(f.dir, '--conversation', '-1001');

    expect(replies(JSON.parse(result.stdout))).toEqual(['g']);
    expect(result.stderr).not.toContain('旧群');
  });

  it('匹配不到时报错退出，不导出', async () => {
    const f = await three();

    const result = await run(f.dir, '--conversation', '不存在的群');

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('找不到会话「不存在的群」');
  });
});

describe('输出的每一项', () => {
  it('字段与顺序、本机时区的 time、请求体完整拼回', async () => {
    const f = await fixture(({ group }) => [
      request({
        conversationId: group,
        replyId: 'r1',
        step: 2,
        attempt: 3,
        startedAt: '2026-11-04T09:42:52.123Z',
        durationMs: 1240,
        body: body(user('第一句'), { role: 'assistant', content: '嗯' }, user('第二句')),
        response: {
          status: 200,
          text: '好',
          reasoning: '想',
          toolCalls: [{ id: 't1', name: 'fetch', arguments: '{}' }],
          finishReason: 'stop',
          usage: { input: 10, cacheRead: 8, output: 2 },
        },
      }),
    ]);

    const [item] = await exported(f.dir);

    expect(Object.keys(item!)).toEqual([
      'time',
      'conversation',
      'purpose',
      'replyId',
      'step',
      'attempt',
      'durationMs',
      'outcome',
      'request',
      'response',
    ]);
    expect(item).toEqual({
      time: '2026-11-04 17:42:52',
      conversation: { id: f.ids.group, platform: 'telegram', title: '读书会 Book Club' },
      purpose: 'reply',
      replyId: 'r1',
      step: 2,
      attempt: 3,
      durationMs: 1240,
      outcome: 'completed',
      request: JSON.parse(f.requests[0]!.body),
      response: f.requests[0]!.response,
    });
    expect(Object.keys(item!.conversation as object)).toEqual(['id', 'platform', 'title']);
    expect(JSON.stringify(item!.request)).toBe(f.requests[0]!.body);
  });

  it('摘要没有 replyId、step；CLI 会话没有 title；主库里找不到的会话只有 id；原样存的请求体是字符串', async () => {
    const f = await fixture(({ cli }) => [
      request({ conversationId: cli, purpose: 'summary', replyId: undefined, step: undefined }),
      request({ conversationId: 'gone', body: 'not json {' }),
    ]);

    const [summary, orphan] = await exported(f.dir);

    expect(Object.keys(summary!)).toEqual([
      'time',
      'conversation',
      'purpose',
      'attempt',
      'durationMs',
      'outcome',
      'request',
      'response',
    ]);
    expect(summary!.conversation).toEqual({ id: f.ids.cli, platform: 'cli' });
    expect(orphan!.conversation).toEqual({ id: 'gone' });
    expect(orphan!.request).toBe('not json {');
  });
});

describe('图片', () => {
  it('默认是引用；--embed-images 时与写入的请求体相同；文件缺了时有 missingImages', async () => {
    const withImage = body({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: dataUrl(red) } },
      ],
    });
    const f = await fixture(({ group }) => [request({ conversationId: group, body: withImage })]);

    const [plain] = await exported(f.dir);
    const [embedded] = await exported(f.dir, '--embed-images');
    expect(JSON.stringify(plain!.request)).toContain(f.imageUrl);
    expect(JSON.stringify(plain!.request)).not.toContain(';base64,');
    expect(JSON.stringify(embedded!.request)).toBe(withImage);
    expect(embedded).not.toHaveProperty('missingImages');

    await rm(join(f.filesDir, f.imageUrl.slice('luoli-file:'.length)));
    const [missing] = await exported(f.dir, '--embed-images');
    expect(missing!.missingImages).toEqual([f.imageUrl]);
    expect(Object.keys(missing!).at(-1)).toBe('missingImages');
  });
});

describe('只读', () => {
  it('导出前后两个库文件的内容与修改时间不变', async () => {
    const f = await fixture(({ group }) => [request({ conversationId: group })]);
    const snapshot = async () =>
      Promise.all(
        [f.dbPath, f.requestsPath].map(async (path) => ({
          bytes: await readFile(path),
          mtime: (await stat(path)).mtimeMs,
        })),
      );
    const before = await snapshot();

    await exported(f.dir, '--embed-images');
    await exported(f.dir, '--conversation', '读书会');

    expect(await snapshot()).toEqual(before);
  });

  it('另一个连接正拿着请求记录的写锁时导出照常，看不到没提交的', async () => {
    const f = await fixture(({ group }) => [request({ conversationId: group, replyId: 'done' })]);
    const writer = openRequestLog({
      path: f.requestsPath,
      fileStore: openFileStore(f.filesDir),
      retentionDays: 0,
    });
    await writer.record(request({ replyId: 'second' }));
    const raw = new DatabaseSync(f.requestsPath);
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('DELETE FROM request_contents');
    try {
      expect((await exported(f.dir)).map((item) => item.replyId)).toEqual(['done', 'second']);
    } finally {
      raw.exec('ROLLBACK');
      raw.close();
      writer.close();
    }
  });

  it('请求记录不存在时报错退出，说明路径与可能的原因，不建文件', async () => {
    const dir = await tempDir();
    openSqliteStorage(join(dir, 'luoli.db')).close();

    const result = await run(dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`请求记录不存在：${join(dir, 'requests.db')}`);
    expect(result.stderr).toContain('LUOLI_REQUEST_LOG=off');
    expect((await readdir(dir)).filter((name) => name.startsWith('requests'))).toEqual([]);
  });

  it('主库不存在时报错退出，不建文件', async () => {
    const f = await fixture(() => []);
    await rm(f.dbPath);

    const result = await run(f.dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`主库不存在：${f.dbPath}`);
    expect(existsSync(f.dbPath)).toBe(false);
  });

  it('主库的表结构版本与程序不一致时报错，提示先启动一次', async () => {
    const f = await fixture(() => []);
    const setVersion = (version: number) => {
      const db = new DatabaseSync(f.dbPath);
      db.exec(`PRAGMA user_version = ${version}`);
      db.close();
    };

    setVersion(1);
    const older = await run(f.dir);
    setVersion(99);
    const newer = await run(f.dir);

    expect(older.code).toBe(1);
    expect(older.stderr).toContain('先启动一次洛璃服务');
    expect(newer.stderr).toContain('比程序新');
  });
});

describe('写出', () => {
  it('写文件与写标准输出的内容相同，是两空格缩进的 JSON 数组', async () => {
    const f = await fixture(({ group, cli }) => [
      request({ conversationId: group, replyId: 'a', startedAt: hoursAgo(2) }),
      request({ conversationId: cli, replyId: 'b' }),
    ]);
    const path = join(f.dir, 'out.json');

    const toStdout = await run(f.dir);
    const toFile = await run(f.dir, '-o', path);

    expect(toFile.code).toBe(0);
    expect(toFile.stdout).toBe('');
    expect(toFile.stderr).toContain(`写到${path}`);
    const written = await readFile(path, 'utf8');
    expect(written).toBe(toStdout.stdout);
    expect(written).toBe(`${JSON.stringify(JSON.parse(written), null, 2)}\n`);
  });

  it('0 条时输出 []，stderr 说明', async () => {
    const f = await fixture(() => []);

    const result = await run(f.dir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('[]\n');
    expect(result.stderr).toContain('没有符合条件的请求');
  });

  it('输出文件所在的目录不存在时报错，不建目录', async () => {
    const f = await fixture(() => []);
    const path = join(f.dir, 'missing', 'out.json');

    const result = await run(f.dir, '-o', path);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('输出文件所在的目录不存在');
    expect(existsSync(join(f.dir, 'missing'))).toBe(false);
  });

  it('逐项写出：写得慢时等它（背压），结果与 JSON.stringify 相同；流出错时抛出', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      i,
      text: 'x'.repeat(100),
      nested: { a: [i] },
    }));
    const chunks: string[] = [];
    let writes = 0;
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes++;
        chunks.push(String(chunk));
        setTimeout(callback, 1);
      },
    });

    await writeJsonArray(items, slow);

    expect(chunks.join('')).toBe(`${JSON.stringify(items, null, 2)}\n`);
    expect(writes).toBe(items.length + 1);

    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('磁盘满了'));
      },
    });
    await expect(writeJsonArray(items, broken)).rejects.toThrow('磁盘满了');
  });
});

describe('写出出错', () => {
  /** 写入先收下（write 返回 true），过一会儿才报错：像磁盘满时的文件 */
  function failingLater() {
    return new Writable({
      highWaterMark: 1 << 20,
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(new Error('ENOSPC: no space left on device')), 5);
      },
    });
  }

  it('最后几段进了缓冲区之后才写失败：关闭时抛出这个错误', async () => {
    await expect(writeAndClose([{ a: 1 }], failingLater())).rejects.toThrow('ENOSPC');
  });

  it('写成功时内容完整，流已关闭', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        setTimeout(callback, 1);
      },
    });

    await writeAndClose([{ a: 1 }, { b: [2] }], stream);

    expect(chunks.join('')).toBe(`${JSON.stringify([{ a: 1 }, { b: [2] }], null, 2)}\n`);
    expect(stream.writableFinished).toBe(true);
  });

  it('-o 写文件出错：退出码 1，说明原因，不报成功', async () => {
    const f = await fixture(({ group }) => [request({ conversationId: group })]);
    const stdout = sink();
    const stderr = sink();

    const code = await runExport({
      argv: ['-o', join(f.dir, 'out.json')],
      env: { LUOLI_DB: f.dbPath },
      now,
      stdout: stdout.stream,
      stderr: stderr.stream,
      openFile: async () => failingLater(),
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain(`写出失败（${join(f.dir, 'out.json')}）：ENOSPC`);
    expect(stderr.text()).not.toContain('导出');
    expect(stdout.text()).toBe('');
  });
});

describe('参数', () => {
  it('不认识的参数：报错退出并提示 --help', async () => {
    const f = await fixture(() => []);

    const result = await run(f.dir, '--bogus');

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^参数错误：.*\n用 --help 查看用法\n$/s);
  });

  it('--help：用法写到标准输出，不打开库', async () => {
    const dir = await tempDir();

    const result = await run(dir, '--help');

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^用法：pnpm requests/);
    expect(await readdir(dir)).toEqual([]);
  });
});
