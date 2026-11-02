import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryStore,
  createPromptFiles,
  defineTool,
  installTools,
  PromptFileError,
  type Conversation,
  type ConversationStore,
  type Logger,
  type MessageChunk,
  type PromptSource,
  type SegmentOptions,
} from './index.js';
import { fixturePrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const alice = { id: 'u-alice', name: 'Alice' };
const repoPrompts = fileURLToPath(new URL('../../prompts/', import.meta.url));

// 固定时区与时钟（只假冒 Date，计时器照常走）；空闲切段用 vi.setSystemTime 拨 Date
const start = '2026-10-30T06:02:00.000Z';
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
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(start) });
});
const opened: Conversation[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

/** 临时目录：一份测试用固定提示的副本（含默认人设 system.md），以及一个人设文件 persona.md */
async function promptDir(persona = '你是测试助手') {
  const dir = await mkdtemp(join(tmpdir(), 'luolicore-prompts-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await cp(fixturePrompts, dir, { recursive: true });
  const personaPath = join(dir, 'persona.md');
  await writeFile(personaPath, persona);
  /** 改写目录里的一个文件（或人设） */
  const edit = async (file: string, change: (text: string) => string) => {
    const path = join(dir, file);
    await writeFile(path, change(await readFile(path, 'utf8')));
  };
  return { dir, personaPath, edit };
}

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) =>
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

const logsOf = (entries: LogEntry[], msg: string) => entries.filter((e) => e.msg === msg);

function finish(reason: 'stop' | 'tool-calls' = 'stop'): StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  };
}

function answer(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    finish(),
  ];
}

/** 每次调用先执行 before（第几次调用），然后回复「好」；before 返回 Error 时这次请求以它失败 */
function model(before?: (call: number) => Promise<Error | StreamPart[] | void>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const result = await before?.(call++);
      if (result instanceof Error) throw result;
      return { stream: simulateReadableStream({ chunks: result ?? answer('好') }) };
    },
  });
}

function httpError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: { 'retry-after-ms': '0' },
    responseBody: `{"error":"status ${statusCode}"}`,
  });
}

/** 模型第 call 次请求的 system 与其余消息（拼成文本） */
function requestOf(mock: MockLanguageModelV4, call: number) {
  const prompt = mock.doStreamCalls[call]?.prompt ?? [];
  const text = (content: (typeof prompt)[number]['content']) =>
    typeof content === 'string'
      ? content
      : content.map((part) => (part.type === 'text' ? part.text : `<${part.type}>`)).join('');
  return {
    system: prompt[0]?.role === 'system' ? prompt[0].content : undefined,
    messages: prompt.slice(1).map((message) => text(message.content)),
  };
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function setup({
  prompts,
  mock = model(),
  store = createMemoryStore(),
  segments,
  logger = recordingLogger().logger,
}: {
  prompts: PromptSource;
  mock?: MockLanguageModelV4;
  store?: ConversationStore;
  segments?: SegmentOptions;
  logger?: Logger;
}) {
  const conversation = createConversation({
    model: mock,
    prompts,
    store,
    logger,
    conversationId: 'c1',
    segments,
  });
  opened.push(conversation);
  const round = async (text: string) => {
    await conversation.append({ author: alice, text });
    return readAll(conversation.reply());
  };
  return { conversation, store, mock, round };
}

/** 用真实时间轮询，直到 check 成立 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function loadError(source: PromptSource): Promise<PromptFileError> {
  const error = await source.load().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(PromptFileError);
  return error as PromptFileError;
}

describe('读取与检查', () => {
  it('仓库 prompts/ 里的文件都能读、变量都对（只查能否读入，不核对措辞）', async () => {
    await expect(createPromptFiles().load()).resolves.toBeDefined();
  });

  it('人设去掉首尾空白后原样使用，里面的 {{…}} 不检查、不替换', async () => {
    const { dir, personaPath } = await promptDir(
      '\n\n  你是{{x}}助手。{{ title }}\n\n第二段\n  \n',
    );

    const texts = await createPromptFiles({ personaPath, dir }).load();

    expect(texts.persona).toBe('你是{{x}}助手。{{ title }}\n\n第二段');
  });

  it('人设里的 {{x}} 原样出现在发给模型的 system 里', async () => {
    const { dir, personaPath } = await promptDir('你是{{x}}助手');
    const { mock, round } = setup({ prompts: createPromptFiles({ personaPath, dir }) });

    await round('你好');

    expect(requestOf(mock, 0).system?.startsWith('你是{{x}}助手\n\n## 消息格式\n\n')).toBe(true);
  });

  it('不给人设路径时用内置目录里的 system.md，出错时写成 prompts/system.md', async () => {
    const { dir, edit } = await promptDir();
    await edit('system.md', () => '\n默认人设\n');
    const source = createPromptFiles({ dir });

    expect((await source.load()).persona).toBe('默认人设');

    await rm(join(dir, 'system.md'));
    expect((await loadError(source)).message).toBe(
      '提示词文件有误：prompts/system.md（文件不存在）',
    );
  });

  it('默认的内置目录与人设按代码所在位置找，不受启动目录影响', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'luolicore-cwd-'));
    const cwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const texts = await createPromptFiles().load();
      expect(texts.persona).toBe((await readFile(join(repoPrompts, 'system.md'), 'utf8')).trim());
    } finally {
      process.chdir(cwd);
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('缺文件：内置文件写仓库相对路径，人设写配置的路径；几个问题一起列出', async () => {
    const { dir, personaPath } = await promptDir();
    await rm(join(dir, 'summary.md'));
    await rm(personaPath);

    const error = await loadError(createPromptFiles({ personaPath, dir }));

    expect(error.message).toBe(
      `提示词文件有误：${personaPath}（文件不存在）；prompts/summary.md（文件不存在）`,
    );
  });

  it('不认识的变量：写错的名字、带空格的写法都算；信息里有文件名与变量名，不含文件内容', async () => {
    const { dir, personaPath, edit } = await promptDir();
    await edit('summary.md', (text) => text.replace('{{maxChars}}', '{{maxChar}}'));
    await edit('conversation.md', (text) => text.replace('{{title}}', '{{ title }}'));
    await edit('message-format.md', (text) => `${text}\n{{Title}}`);

    const error = await loadError(createPromptFiles({ personaPath, dir }));

    expect(error.problems).toEqual([
      { file: 'prompts/message-format.md', problems: ['不认识的变量 {{Title}}'] },
      {
        file: 'prompts/conversation.md',
        problems: ['不认识的变量 {{ title }}', '缺少变量 {{title}}'],
      },
      { file: 'prompts/summary.md', problems: ['不认识的变量 {{maxChar}}'] },
    ]);
    expect(error.message).toBe(
      '提示词文件有误：prompts/message-format.md（不认识的变量 {{Title}}）；' +
        'prompts/conversation.md（不认识的变量 {{ title }}，缺少变量 {{title}}）；' +
        'prompts/summary.md（不认识的变量 {{maxChar}}）',
    );
  });

  it.each([
    ['conversation.md', 'title'],
    ['prior-summary.md', 'summary'],
    ['summary.md', 'scope'],
    ['summary-scope-before.md', 'time'],
    ['summary-scope-recent.md', 'keep'],
  ])('漏了必需的变量：%s 没有 {{%s}}', async (file, name) => {
    const { dir, personaPath, edit } = await promptDir();
    await edit(file, (text) => text.replaceAll(`{{${name}}}`, ''));

    const error = await loadError(createPromptFiles({ personaPath, dir }));

    expect(error.message).toBe(`提示词文件有误：prompts/${file}（缺少变量 {{${name}}}）`);
  });

  it('收尾提示 tool-limit.md：缺文件、写了变量（它没有变量）都报错', async () => {
    const missing = await promptDir();
    await rm(join(missing.dir, 'tool-limit.md'));
    expect(
      (await loadError(createPromptFiles({ personaPath: missing.personaPath, dir: missing.dir })))
        .message,
    ).toBe('提示词文件有误：prompts/tool-limit.md（文件不存在）');

    const variable = await promptDir();
    await variable.edit('tool-limit.md', (text) => `${text}{{step}}`);
    expect(
      (await loadError(createPromptFiles({ personaPath: variable.personaPath, dir: variable.dir })))
        .message,
    ).toBe('提示词文件有误：prompts/tool-limit.md（不认识的变量 {{step}}）');
  });

  it('summary.md 不用 {{maxChars}} 也可以：摘要指令里就没有字数', async () => {
    const { dir, personaPath, edit } = await promptDir();
    await edit('summary.md', (text) => text.replace('{{maxChars}}', '若干'));
    const { mock, store, round } = setup({
      prompts: createPromptFiles({ personaPath, dir }),
      segments: { idleMs: 30, summaryMaxChars: 987 },
    });

    await round('早上好');
    vi.setSystemTime(Date.now() + 60_000);
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    const instruction = requestOf(mock, 1).messages.at(-1);
    expect(instruction).toContain('总长度不超过 若干 字。');
    expect(instruction).not.toContain('987');
  });
});

describe('每次回复、每次摘要开始时重读', () => {
  it('两次回复之间改了消息格式说明与人设：第二次请求的 system 是新内容', async () => {
    const { dir, personaPath, edit } = await promptDir('旧人设');
    const { mock, round } = setup({ prompts: createPromptFiles({ personaPath, dir }) });

    await round('一');
    await edit('message-format.md', (text) => `${text}\n新加的一句。`);
    await edit('persona.md', () => '新人设');
    await round('二');

    const [first, second] = [requestOf(mock, 0).system, requestOf(mock, 1).system];
    expect(first?.startsWith('旧人设\n\n## 消息格式\n\n')).toBe(true);
    expect(first).not.toContain('新加的一句。');
    expect(second?.startsWith('新人设\n\n## 消息格式\n\n')).toBe(true);
    expect(second?.endsWith('\n新加的一句。')).toBe(true);
  });

  it('摘要同理：system 与摘要指令都用开始摘要时读到的文字', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const { mock, store, round } = setup({
      prompts: createPromptFiles({ personaPath, dir }),
      segments: { idleMs: 30 },
    });

    await round('早上好');
    await edit('message-format.md', (text) => `${text}\n新加的一句。`);
    await edit('summary-scope-idle.md', () => '新的范围说明。');
    vi.setSystemTime(Date.now() + 60_000);
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    const summary = requestOf(mock, 1);
    expect(requestOf(mock, 0).system).not.toContain('新加的一句。');
    expect(summary.system?.endsWith('\n新加的一句。')).toBe(true);
    expect(summary.messages.at(-1)).toContain('\n- 新的范围说明。\n');
  });
});

describe('一次调用内用同一份', () => {
  /** 第一次请求前改掉消息格式说明，再按 first 失败；之后的请求照常回复 */
  async function changedBeforeFirst(first: (call: number) => Error | StreamPart[]) {
    const { dir, personaPath, edit } = await promptDir();
    const mock = model(async (call) => {
      if (call !== 0) return;
      await edit('message-format.md', (text) => `${text}\n新加的一句。`);
      return first(call);
    });
    return { prompts: createPromptFiles({ personaPath, dir }), mock };
  }

  it('请求失败（429）后重试前改了文件：重试的请求仍是旧内容，下一次回复才用新的', async () => {
    const { prompts, mock } = await changedBeforeFirst(() => httpError(429));
    const { round } = setup({ prompts, mock });

    await round('一');
    expect(mock.doStreamCalls).toHaveLength(2);
    expect(requestOf(mock, 1).system).toBe(requestOf(mock, 0).system);
    expect(requestOf(mock, 1).system).not.toContain('新加的一句。');

    await round('二');
    expect(requestOf(mock, 2).system?.endsWith('\n新加的一句。')).toBe(true);
  });

  it('流中出错后重新生成：仍是旧内容', async () => {
    const { prompts, mock } = await changedBeforeFirst(() => [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: '半' },
      { type: 'error', error: { message: '服务端过载' } },
    ]);
    const { round } = setup({ prompts, mock });

    await round('一');

    expect(mock.doStreamCalls).toHaveLength(2);
    expect(requestOf(mock, 1).system).toBe(requestOf(mock, 0).system);
    expect(requestOf(mock, 1).system).not.toContain('新加的一句。');
  });

  it('收尾提示：回复中途改了 tool-limit.md，这次的收尾步仍是旧内容，下一次回复才用新的', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const original = (await readFile(join(dir, 'tool-limit.md'), 'utf8')).trim();
    // 工具执行时改文件；每次回复第 1 步调它，第 2 步是收尾步
    const touch = defineTool({
      name: 'touch',
      description: '改文件',
      input: z.object({}),
      execute: async () => {
        await edit('tool-limit.md', () => '新的收尾提示。');
        return 'ok';
      },
    });
    const toolCall: StreamPart[] = [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'touch', input: '{}' },
      finish('tool-calls'),
    ];
    const mock = model(async (call) => (call % 2 === 0 ? toolCall : undefined));
    const conversation = createConversation({
      model: mock,
      prompts: createPromptFiles({ personaPath, dir }),
      tools: installTools([touch], {}).tools,
      maxSteps: 2,
    });
    opened.push(conversation);

    await conversation.append({ author: alice, text: '一' });
    await readAll(conversation.reply());
    await conversation.append({ author: alice, text: '二' });
    await readAll(conversation.reply());

    expect(mock.doStreamCalls).toHaveLength(4);
    expect(requestOf(mock, 1).messages.at(-1)).toBe(original);
    expect(requestOf(mock, 3).messages.at(-1)).toBe('新的收尾提示。');
  });

  it('拒收图片后换成占位重试：仍是旧内容', async () => {
    const { prompts, mock } = await changedBeforeFirst(() => httpError(400));
    const { conversation } = setup({ prompts, mock });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

    await conversation.append({ author: alice, files: [{ data: png, mediaType: 'image/png' }] });
    await readAll(conversation.reply());

    expect(mock.doStreamCalls).toHaveLength(2);
    expect(requestOf(mock, 1).messages[0]).toContain('[图片无法读取]');
    expect(requestOf(mock, 1).system).toBe(requestOf(mock, 0).system);
    expect(requestOf(mock, 1).system).not.toContain('新加的一句。');
  });
});

describe('运行中改坏', () => {
  it('回复：按失败处理，不发请求、不记模型调用；改好后下一次回复正常', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const { logger, entries } = recordingLogger();
    const { conversation, store, mock, round } = setup({
      prompts: createPromptFiles({ personaPath, dir }),
      logger,
    });
    await edit('summary-scope-recent.md', (text) => text.replace('{{keep}}', '{{kept}}'));

    const chunks = await round('你好');

    const errorText =
      '提示词文件有误：prompts/summary-scope-recent.md（不认识的变量 {{kept}}，缺少变量 {{keep}}）';
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
      { type: 'error', errorText },
    ]);
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
    expect(mock.doStreamCalls).toHaveLength(0);
    expect(await store.calls()).toEqual([]);
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({
      error: { type: 'PromptFileError', message: errorText },
    });

    await edit('summary-scope-recent.md', (text) => text.replace('{{kept}}', '{{keep}}'));
    await round('再来');

    expect((await conversation.messages()).map((m) => m.role)).toEqual([
      'user',
      'user',
      'assistant',
    ]);
    expect(await store.calls()).toMatchObject([{ purpose: 'reply', outcome: 'completed' }]);
  });

  it('摘要：summary.failed，不切段、不记模型调用；改好后下一次检查正常切段', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const { logger, entries } = recordingLogger();
    const { conversation, store, mock, round } = setup({
      prompts: createPromptFiles({ personaPath, dir }),
      segments: { idleMs: 30 },
      logger,
    });

    await round('早上好');
    const original = await readFile(join(dir, 'summary.md'), 'utf8');
    await edit('summary.md', (text) => text.replace('{{scope}}', ''));
    vi.setSystemTime(Date.now() + 60_000);
    await until(() => logsOf(entries, 'summary.failed').length > 0);

    expect(logsOf(entries, 'summary.failed')[0]?.fields).toMatchObject({
      reason: 'idle',
      error: { message: '提示词文件有误：prompts/summary.md（缺少变量 {{scope}}）' },
    });
    expect((await store.currentSegment()).startReason).toBe('first');
    expect(mock.doStreamCalls).toHaveLength(1);
    expect((await store.calls()).map((call) => call.purpose)).toEqual(['reply']);

    await writeFile(join(dir, 'summary.md'), original);
    // 写入前的检查发现已经空闲太久，补做切段
    await conversation.append({ author: alice, text: '又来了' });
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    expect((await store.calls()).map((call) => call.purpose)).toEqual(['reply', 'summary']);
  });
});

describe('日志', () => {
  it('内容变了记一条 prompts.changed，列出文件、不含内容；第一次读与没变时不记', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const { logger, entries } = recordingLogger();
    const source = createPromptFiles({ personaPath, dir, logger });

    await source.load();
    await source.load();
    expect(logsOf(entries, 'prompts.changed')).toEqual([]);

    await edit('message-format.md', (text) => `${text}\n新加的一句。`);
    await edit('persona.md', () => '新人设');
    await source.load();
    await source.load();

    expect(logsOf(entries, 'prompts.changed')).toEqual([
      {
        level: 'info',
        msg: 'prompts.changed',
        fields: { files: [personaPath, 'prompts/message-format.md'] },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('新');
  });

  it('改坏与改好都算变化；读不了的文件不算', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const { logger, entries } = recordingLogger();
    const source = createPromptFiles({ personaPath, dir, logger });
    await source.load();

    await edit('conversation.md', (text) => text.replace('{{title}}', '{{titel}}'));
    await expect(source.load()).rejects.toThrow(PromptFileError);
    await edit('conversation.md', (text) => text.replace('{{titel}}', '{{title}}'));
    await source.load();
    const original = await readFile(join(dir, 'summary.md'), 'utf8');
    await rm(join(dir, 'summary.md'));
    await expect(source.load()).rejects.toThrow(PromptFileError);
    await writeFile(join(dir, 'summary.md'), original);
    await source.load();

    expect(logsOf(entries, 'prompts.changed').map((e) => e.fields.files)).toEqual([
      ['prompts/conversation.md'],
      ['prompts/conversation.md'],
    ]);
  });

  it('几个会话共用一个来源：同时回复也只记一条', async () => {
    const { dir, personaPath, edit } = await promptDir();
    const { logger, entries } = recordingLogger();
    const prompts = createPromptFiles({ personaPath, dir, logger });
    // 相当于启动时的检查
    await prompts.load();
    const a = setup({ prompts });
    const b = setup({ prompts });

    await edit('message-format.md', (text) => `${text}\n新加的一句。`);
    await Promise.all([a.round('甲'), b.round('乙')]);
    await Promise.all([a.round('甲'), b.round('乙')]);

    expect(logsOf(entries, 'prompts.changed')).toHaveLength(1);
    expect(requestOf(a.mock, 0).system?.endsWith('\n新加的一句。')).toBe(true);
    expect(requestOf(b.mock, 0).system?.endsWith('\n新加的一句。')).toBe(true);
  });
});

it('填进去的会话名称与摘要里有 {{…}} 时原样出现，不再替换', async () => {
  const { dir, personaPath } = await promptDir('人设');
  const store = createMemoryStore({ title: '{{title}} $& 群' });
  const { conversation, mock, round } = setup({
    prompts: createPromptFiles({ personaPath, dir }),
    store,
  });
  await conversation.append({ author: alice, text: '上一段' });
  await store.addSegment({
    startSeq: 2,
    startReason: 'idle',
    priorSummary: '提到了 {{summary}} 与 {{title}}',
  });

  await round('你好');

  expect(
    requestOf(mock, 0).system?.endsWith(
      '\n\n## 当前会话\n\n名称：{{title}} $& 群' +
        '\n\n## 之前的对话摘要\n\n以下是本会话更早内容的摘要，原文已不在上下文中。' +
        '\n\n提到了 {{summary}} 与 {{title}}',
    ),
  ).toBe(true);
});
