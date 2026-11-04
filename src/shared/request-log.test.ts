import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversation,
  createMemoryFileStore,
  createMemoryStore,
  createModel,
  openRequestLog,
  type Logger,
} from '../core/index.js';
import { testPrompts } from '../core/test-prompts.js';
import { parseCommonConfig } from './config.js';
import { openRequestLogging } from './request-log.js';

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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'luolicore-request-logging-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** openai-compatible 的服务端：回一个「好」 */
const server = async () =>
  new Response(
    `data: ${JSON.stringify({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

describe('打开请求记录', () => {
  it('LUOLI_REQUEST_LOG=off：不建数据库，fetch 为 undefined，日志记一条 enabled: false', async () => {
    const dir = await tempDir();
    const parsed = parseCommonConfig(
      {
        LUOLI_BASE_URL: 'http://fake.test/v1',
        LUOLI_DB: join(dir, 'luoli.db'),
        LUOLI_REQUEST_LOG: 'off',
      },
      'm',
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const { logger, entries } = recordingLogger();

    const logging = openRequestLogging({
      config: parsed.config.requestLog,
      fileStore: createMemoryFileStore(),
      logger,
      secrets: [],
    });
    await logging.close();

    expect(logging.fetch).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    expect(entries).toEqual([{ level: 'info', msg: 'requests.open', fields: { enabled: false } }]);
  });

  it('默认打开：数据库建在主库旁边', async () => {
    const dir = await tempDir();
    const parsed = parseCommonConfig(
      { LUOLI_BASE_URL: 'http://fake.test/v1', LUOLI_DB: join(dir, 'luoli.db') },
      'm',
    );
    if (!parsed.ok) throw new Error(parsed.error);

    const logging = openRequestLogging({
      config: parsed.config.requestLog,
      fileStore: createMemoryFileStore(),
      logger: recordingLogger().logger,
      secrets: [],
    });
    await logging.close();

    expect(await readdir(dir)).toContain('requests.db');
  });

  it('打开时：建目录与数据库，记下回复的请求；关闭时写完再关；立即清理一次', async () => {
    const dir = await tempDir();
    const path = join(dir, 'nested', 'requests.db');
    const { logger, entries } = recordingLogger();
    const fileStore = createMemoryFileStore();

    const logging = openRequestLogging({
      config: { path, retentionDays: 30 },
      fileStore,
      logger,
      secrets: ['sk-x'],
      fetch: server,
    });
    const conversation = createConversation({
      model: createModel({ baseURL: 'http://fake.test/v1', modelId: 'm', fetch: logging.fetch }),
      prompts: testPrompts('你是测试助手'),
      store: createMemoryStore(),
      fileStore,
      logger,
      conversationId: 'c1',
    });
    await conversation.append({ author: { name: 'Alice' }, text: '你好' });
    for await (const part of conversation.reply()) void part;
    await conversation.close();
    // 不单独等写入：close 负责
    await logging.close();

    expect(existsSync(path)).toBe(true);
    const reader = openRequestLog({ path, fileStore, readOnly: true });
    const records = await reader.list();
    reader.close();
    expect(
      records.map((record) => [record.conversationId, record.purpose, record.outcome]),
    ).toEqual([['c1', 'reply', 'completed']]);
    expect(entries.find((entry) => entry.msg === 'requests.open')).toEqual({
      level: 'info',
      msg: 'requests.open',
      fields: { enabled: true, retentionDays: 30, path },
    });
    expect(entries.filter((entry) => entry.msg === 'requests.cleanup')).toHaveLength(1);
  });

  it('保留天数为 0 时不清理', async () => {
    const path = join(await tempDir(), 'requests.db');
    const { logger, entries } = recordingLogger();

    const logging = openRequestLogging({
      config: { path, retentionDays: 0 },
      fileStore: createMemoryFileStore(),
      logger,
      secrets: [],
    });
    await logging.close();

    expect(entries.map((entry) => entry.msg)).toEqual(['requests.open']);
  });

  it('打不开时抛错，消息里有路径', async () => {
    const dir = await tempDir();
    // 目录的位置上是一个文件：建不了目录
    await writeFile(join(dir, 'blocked'), '');
    const path = join(dir, 'blocked', 'requests.db');

    expect(() =>
      openRequestLogging({
        config: { path, retentionDays: 30 },
        fileStore: createMemoryFileStore(),
        logger: recordingLogger().logger,
        secrets: [],
      }),
    ).toThrow(`打开请求记录失败（${path}）`);
  });
});
