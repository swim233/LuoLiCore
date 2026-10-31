import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createMemoryState } from '@chat-adapter/state-memory';
import type { StateAdapter } from 'chat';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import {
  createMemoryFileStore,
  createMemoryStorage,
  type Logger,
  type Storage,
} from '../core/index.js';
import { startTelegram } from './app.js';
import { fakeBot, imageBytes, startFakeTelegram, type FakeTelegram } from './fake-api.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const token = '123456:TEST-token_abc';
const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
const otherGroup: TelegramChat = { id: -1002, type: 'supergroup', title: '别的群' };
const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice', last_name: 'Liddell' };
const bob: TelegramUser = { id: 22, is_bot: false, first_name: 'Bob' };
const stranger: TelegramUser = { id: 33, is_bot: false, first_name: '陌生人' };
const privateWith = (user: TelegramUser): TelegramChat => ({
  id: user.id,
  type: 'private',
  first_name: user.first_name,
  last_name: user.last_name,
});

/** 依次回复这些文字；Error 表示请求失败；带 gate 的等它放行才输出 */
function replying(
  ...turns: Array<string | Error | { text: string; gate: Promise<void> }>
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const turn = turns[call++] ?? '（没有更多脚本）';
      if (turn instanceof Error) throw turn;
      const { text, gate } = typeof turn === 'string' ? { text: turn, gate: undefined } : turn;
      await gate;
      const parts: StreamPart[] = [
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
      return { stream: simulateReadableStream({ chunks: parts }) };
    },
  });
}

function unauthorized(): APICallError {
  return new APICallError({
    message: 'Unauthorized',
    url: 'https://example.invalid/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 401,
    isRetryable: false,
  });
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

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of running.splice(0).reverse()) await stop();
});

async function start(
  model: MockLanguageModelV4,
  {
    storage = createMemoryStorage(),
    state,
    backlog,
    wait = { idleMs: 50, maxMs: 500 },
  }: {
    storage?: Storage;
    state?: StateAdapter;
    /** 等待合并的时长；默认调小 */
    wait?: { idleMs: number; maxMs: number };
    /** 启动前就在假接口里的更新，相当于停机期间积压的 */
    backlog?: (api: FakeTelegram) => void;
  } = {},
) {
  const api = await startFakeTelegram();
  running.push(() => api.close());
  backlog?.(api);
  const { logger, entries } = recordingLogger();
  const app = await startTelegram({
    config: {
      token,
      apiUrl: api.url,
      chats: new Set([String(group.id)]),
      users: new Set([String(alice.id)]),
      wakeWords: ['nori'],
      errorText: '（出了点问题）',
      staleMs: 60 * 60_000,
      timeouts: {},
      segments: {},
      maxRetries: 0,
    },
    model,
    instructions: '你是测试助手',
    storage,
    fileStore: createMemoryFileStore(),
    logger,
    pollTimeoutSeconds: 1,
    state,
    wait,
  });
  running.push(() => app.stop());
  return { api, app, storage, entries };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sends = (api: FakeTelegram) => api.calls.filter((call) => call.method === 'sendMessage');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 第 index 次模型请求里所有消息的内容（含名字标签） */
function promptText(model: MockLanguageModelV4, index: number): string {
  return JSON.stringify(model.doStreamCalls[index]?.prompt ?? []);
}

/** 第 index 次模型请求里的图片，按出现顺序列出媒体类型 */
function promptFiles(model: MockLanguageModelV4, index: number): string[] {
  return (model.doStreamCalls[index]?.prompt ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === 'file' ? [part.mediaType] : []))
      : [],
  );
}

/** 每条消息的附件数 */
async function filesOf(storage: Storage, chatId: number) {
  const info = await storage.findConversation('telegram', String(chatId));
  if (!info) return [];
  const store = await storage.openConversation(info.id);
  return (await store.list()).map(
    (message) => message.parts.filter((part) => part.type === 'file').length,
  );
}

async function historyOf(storage: Storage, chatId: number) {
  const info = await storage.findConversation('telegram', String(chatId));
  if (!info) return [];
  const store = await storage.openConversation(info.id);
  return (await store.list()).map((message) => ({
    role: message.role,
    text: message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
  }));
}

describe('Telegram 前端（本地假 Bot API）', () => {
  it('群里含唤醒词：记录并回复，纯文本、引用触发消息，期间发「正在输入」', async () => {
    const { api, app, storage } = await start(replying('你好呀'));

    const [id] = api.push({ chat: group, from: alice, text: 'Nori 在吗' });
    await api.waitFor((calls) => calls.some((call) => call.method === 'sendMessage'));
    await app.bot.idle();

    expect(sends(api)).toEqual([
      {
        method: 'sendMessage',
        token,
        body: {
          chat_id: String(group.id),
          text: '你好呀',
          reply_parameters: { message_id: id, allow_sending_without_reply: true },
        },
      },
    ]);
    expect(api.calls.some((call) => call.method === 'sendChatAction')).toBe(true);
    expect(await historyOf(storage, group.id)).toEqual([
      { role: 'user', text: 'Nori 在吗' },
      { role: 'assistant', text: '你好呀' },
    ]);
  });

  it('群里普通消息只记录：不回复，也不发「正在输入」；发言人、时间、消息 id 写入', async () => {
    const { api, storage } = await start(replying());
    const date = Math.floor(Date.parse('2026-10-30T06:02:00.000Z') / 1000);

    const [id] = api.push({ chat: group, from: alice, text: '今天天气不错', date });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(api.calls.filter((call) => call.method.startsWith('send'))).toEqual([]);
    const info = await storage.findConversation('telegram', String(group.id));
    expect(info?.title).toBe('读书会');
    const [message] = await (await storage.openConversation(info!.id)).list();
    expect(message?.metadata).toEqual({
      author: { id: '11', name: 'Alice Liddell' },
      createdAt: '2026-10-30T06:02:00.000Z',
      platformMessageId: String(id),
    });
  });

  it.each([
    ['@bot', { chat: group, from: alice, text: '@nori_test_bot 你好' }],
    ['@bot（不分大小写）', { chat: group, from: bob, text: '问问 @Nori_Test_Bot' }],
    ['私聊', { chat: privateWith(alice), from: alice, text: '在吗' }],
    [
      '私聊里的 /start',
      {
        chat: privateWith(alice),
        from: alice,
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    ],
  ])('%s 触发回复，引用触发消息', async (_name, message) => {
    const { api, app, storage } = await start(replying('收到'));

    const [id] = api.push(message);
    await api.waitFor((calls) => calls.some((call) => call.method === 'sendMessage'));
    await app.bot.idle();

    expect(sends(api).map((call) => call.body)).toEqual([
      {
        chat_id: String(message.chat.id),
        text: '收到',
        reply_parameters: { message_id: id, allow_sending_without_reply: true },
      },
    ]);
    expect((await historyOf(storage, message.chat.id)).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('长回复经适配器发出：每条不超过 4096、没有被截断，拼回去与原文相同', async () => {
    const long = `${'A'.repeat(4096)}\n${'B'.repeat(3000)}\n${'C'.repeat(100)}`;
    const { api, app } = await start(replying(long));

    const [id] = api.push({ chat: group, from: alice, text: 'nori 讲长一点' });
    await api.waitFor(() => sends(api).length >= 2);
    await app.bot.idle();

    const texts = sends(api).map((call) => String(call.body.text));
    expect(texts.every((text) => text.length <= 4096)).toBe(true);
    expect(texts.join('')).toBe(long);
    expect(sends(api).map((call) => call.body.reply_parameters)).toEqual([
      { message_id: id, allow_sending_without_reply: true },
      undefined,
    ]);
  });

  it('离线积压：2 小时前的触发只记录，不回复也不发「正在输入」，记 telegram.stale；30 分钟前的照常回复', async () => {
    const { api, app, storage, entries } = await start(replying('回复较新的那条'));
    const minutesAgo = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;

    const [old, recent] = api.push(
      { chat: group, from: alice, text: 'nori 两小时前问的', date: minutesAgo(120) },
      { chat: group, from: bob, text: 'nori 半小时前问的', date: minutesAgo(30) },
    );
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    expect(sends(api).map((call) => call.body.reply_parameters)).toEqual([
      { message_id: recent, allow_sending_without_reply: true },
    ]);
    expect(api.calls.filter((call) => call.method === 'sendChatAction')).toHaveLength(1);
    expect(entries.filter((e) => e.msg === 'telegram.stale').map((e) => e.fields)).toEqual([
      {
        conversationId: expect.any(String),
        chatId: String(group.id),
        messageId: String(old),
        ageMinutes: 120,
      },
    ]);
    expect((await historyOf(storage, group.id)).map((m) => m.text)).toEqual([
      'nori 两小时前问的',
      'nori 半小时前问的',
      '回复较新的那条',
    ]);
  });

  it('回复 bot 的消息触发回复', async () => {
    const { api, app } = await start(replying('第一句', '第二句'));
    api.push({ chat: group, from: alice, text: 'nori 早' });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();
    const botMessage = {
      message_id: 5001,
      chat: group,
      from: fakeBot,
      date: Math.floor(Date.now() / 1000),
      text: '第一句',
    };

    const [id] = api.push({ chat: group, from: bob, text: '为什么', reply_to_message: botMessage });
    await api.waitFor(() => sends(api).length === 2);

    expect(sends(api)[1]?.body).toMatchObject({
      text: '第二句',
      reply_parameters: { message_id: id },
    });
  });

  it('白名单外的群与私聊：不记录、不回复，日志只有聊天类型、chat id 与发送者 id', async () => {
    const { api, storage, entries } = await start(replying('不该出现'));

    api.push(
      { chat: otherGroup, from: alice, text: 'nori 在吗' },
      { chat: privateWith(stranger), from: stranger, text: '你好' },
    );
    await waitUntil(() => entries.filter((e) => e.msg === 'telegram.ignored').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(entries.filter((e) => e.msg === 'telegram.ignored').map((e) => e.fields)).toEqual([
      { chatType: 'supergroup', chatId: String(otherGroup.id), userId: String(alice.id) },
      { chatType: 'private', chatId: String(stranger.id), userId: String(stranger.id) },
    ]);
    expect(api.calls.filter((call) => call.method.startsWith('send'))).toEqual([]);
    expect(await storage.listConversations('telegram')).toEqual([]);
  });

  it('回复中再被触发：当前回复发出后立即再回一次，引用期间最后一条触发，请求里有期间所有消息', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = replying({ text: '慢慢说', gate }, '再说');
    const { api, app, storage, entries } = await start(model);

    const [first] = api.push({ chat: group, from: alice, text: 'nori 讲个故事' });
    await waitUntil(() => model.doStreamCalls.length === 1);
    api.push({ chat: group, from: bob, text: 'nori 我也要听' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 2);
    api.push({ chat: group, from: bob, text: '期间的闲聊' });
    const [last] = api.push({ chat: group, from: alice, text: 'nori 讲长一点' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 4);
    release();
    await api.waitFor(() => sends(api).length === 2);
    await app.bot.idle();

    expect(sends(api).map((call) => call.body)).toMatchObject([
      { text: '慢慢说', reply_parameters: { message_id: first } },
      { text: '再说', reply_parameters: { message_id: last } },
    ]);
    for (const text of ['nori 我也要听', '期间的闲聊', 'nori 讲长一点', '慢慢说']) {
      expect(promptText(model, 1)).toContain(text);
    }
    // 没有去调用核心的 reply 两次（那会抛「上一个回复还没结束」）
    expect(entries.filter((e) => e.level !== 'info').map((e) => e.msg)).toEqual([]);
  });

  it('模型调用失败：引用触发消息发固定提示；不写入助手消息', async () => {
    const { api, app, storage } = await start(replying(unauthorized()));

    const [id] = api.push({ chat: group, from: alice, text: 'nori 在吗' });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    expect(sends(api)[0]?.body).toEqual({
      chat_id: String(group.id),
      text: '（出了点问题）',
      reply_parameters: { message_id: id, allow_sending_without_reply: true },
    });
    expect((await historyOf(storage, group.id)).map((m) => m.role)).toEqual(['user']);
  });

  it('发送失败：记 telegram.send_failed，不重试，之后的消息照常', async () => {
    const { api, app, entries } = await start(replying('第一句', '第二句'));
    api.failSends(500);

    api.push({ chat: group, from: alice, text: 'nori 一' });
    await waitUntil(() => entries.some((e) => e.msg === 'telegram.send_failed'));
    await app.bot.idle();
    api.push({ chat: group, from: alice, text: 'nori 二' });
    await api.waitFor(() => sends(api).length === 2);

    expect(sends(api).map((call) => call.body.text)).toEqual(['第一句', '第二句']);
    expect(entries.find((e) => e.msg === 'telegram.send_failed')?.fields).toMatchObject({
      method: 'sendMessage',
    });
  });

  it('改群名：会话标题更新，下一段用新标题', async () => {
    const { api, storage } = await start(replying());
    api.push({ chat: group, from: alice, text: '改个名' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 1);

    api.push({ chat: { ...group, title: '新读书会' }, from: alice, new_chat_title: '新读书会' });
    await waitUntil(
      async () =>
        (await storage.findConversation('telegram', String(group.id)))?.title === '新读书会',
    );

    // 服务消息不记录
    expect(await historyOf(storage, group.id)).toHaveLength(1);
  });

  it('私聊会话的标题为「与 显示名 的私聊」', async () => {
    const { api, app, storage } = await start(replying('好'));

    api.push({ chat: privateWith(alice), from: alice, text: '在吗' });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    expect((await storage.findConversation('telegram', String(alice.id)))?.title).toBe(
      '与 Alice Liddell 的私聊',
    );
  });

  it('同一批里 /命令 与普通消息（两条派发路径）也按顺序记录', async () => {
    const { api, storage } = await start(replying());
    const command = { type: 'bot_command', offset: 0, length: 5 };

    api.push(
      { chat: group, from: alice, text: '/help', entities: [command] },
      { chat: group, from: bob, text: '普通的一句' },
      { chat: group, from: alice, text: '/list', entities: [command] },
      { chat: group, from: bob, text: '又一句' },
    );
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 4);

    expect((await historyOf(storage, group.id)).map((m) => m.text)).toEqual([
      '/help',
      '普通的一句',
      '/list',
      '又一句',
    ]);
  });

  it('同一批里的多条消息按顺序记录', async () => {
    const { api, app, storage } = await start(replying('好'));

    api.push(
      { chat: group, from: alice, text: '一' },
      { chat: group, from: bob, text: '@nori_test_bot 二' },
      { chat: group, from: alice, text: '三' },
      { chat: group, from: bob, text: '四' },
    );
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    // 回复排在它开始生成时看到的最后一条之后，与后两条的先后取决于时机，这里只看用户消息
    const history = await historyOf(storage, group.id);
    expect(history.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      '一',
      '@nori_test_bot 二',
      '三',
      '四',
    ]);
  });

  it('不让 SDK 另存线程历史，也不缓存收发的消息（SDK 升级使覆盖失效时这里会失败）', async () => {
    const state = createMemoryState();
    const listKeys: string[] = [];
    const appendToList = state.appendToList.bind(state);
    state.appendToList = async (key, ...rest) => {
      listKeys.push(key);
      return appendToList(key, ...rest);
    };
    const { api, app } = await start(replying('好'), { state });

    api.push(
      { chat: group, from: alice, text: '先说一句' },
      { chat: group, from: bob, text: 'nori 在吗' },
    );
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    // 线程历史经 state.appendToList 写入；消息缓存是适配器里的私有 Map
    expect(listKeys).toEqual([]);
    const { messageCache } = app.adapter as unknown as { messageCache: Map<string, unknown> };
    expect(messageCache.size).toBe(0);
  });

  it('连发三条、第二条带 nori：等待合并，只回复一次，引用第二条，请求里有第三条', async () => {
    const model = replying('一起回答', '不该出现');
    const { api, app, storage } = await start(model, { wait: { idleMs: 400, maxMs: 3000 } });

    api.push({ chat: group, from: alice, text: '我先说一句' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 1);
    const [second] = api.push({ chat: group, from: bob, text: 'nori 你怎么看' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 2);
    api.push({ chat: group, from: alice, text: '我也想知道' });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();
    await sleep(100);

    expect(sends(api).map((call) => call.body.reply_parameters)).toEqual([
      { message_id: second, allow_sending_without_reply: true },
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(promptText(model, 0)).toContain('我也想知道');
    // 等待期间就在发「正在输入」
    expect(api.calls.findIndex((call) => call.method === 'sendChatAction')).toBeLessThan(
      api.calls.findIndex((call) => call.method === 'sendMessage'),
    );
  });

  it('照片与静态贴纸下载后以图片交给模型；语音、动画贴纸、PDF 记成占位', async () => {
    const model = replying('看到了');
    const { api, app, storage } = await start(model);
    for (const id of ['photo-s', 'photo-m', 'photo-l'])
      api.addFile(id, imageBytes('image/jpeg', id));
    api.addFile('sticker', imageBytes('image/webp', 'sticker'));
    api.addFile('pdf', new TextEncoder().encode('%PDF-1.7'));

    api.push(
      {
        chat: group,
        from: alice,
        caption: 'nori 看看这张',
        photo: [
          { file_id: 'photo-s', width: 90, height: 68 },
          { file_id: 'photo-l', width: 2560, height: 1920 },
          { file_id: 'photo-m', width: 1280, height: 960 },
        ],
      },
      { chat: group, from: bob, sticker: { file_id: 'sticker', emoji: '👍' } },
      { chat: group, from: bob, voice: { file_id: 'voice', duration: 5 } },
      { chat: group, from: alice, sticker: { file_id: 'anim', emoji: '😀', is_animated: true } },
      {
        chat: group,
        from: alice,
        document: { file_id: 'pdf', file_name: '报告.pdf', mime_type: 'application/pdf' },
      },
    );
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    expect(promptFiles(model, 0)).toEqual(['image/jpeg', 'image/webp']);
    expect(api.downloads).toEqual(['files/photo-m', 'files/sticker']);
    expect(await historyOf(storage, group.id)).toEqual([
      { role: 'user', text: 'nori 看看这张' },
      { role: 'user', text: '' },
      { role: 'user', text: '[语音 0:05]' },
      { role: 'user', text: '[贴纸 😀]' },
      { role: 'user', text: '[文件 报告.pdf]' },
      { role: 'assistant', text: '看到了' },
    ]);
    expect(await filesOf(storage, group.id)).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it('相册：适配器攒齐后合成一条消息、多张图，按原顺序；回复引用第一条；编辑第一条的说明文字改正文、图片不变', async () => {
    const model = replying('两张都看到了');
    const { api, app, storage, entries } = await start(model);
    api.addFile('a1', imageBytes('image/jpeg', 'a1'));
    api.addFile('a2', imageBytes('image/jpeg', 'a2'));
    const firstItem = {
      chat: group,
      from: alice,
      media_group_id: 'album-1',
      photo: [{ file_id: 'a1', width: 8, height: 8 }],
    };

    const secondItem = {
      chat: group,
      from: alice,
      media_group_id: 'album-1',
      photo: [{ file_id: 'a2', width: 8, height: 8 }],
    };

    const [first, second] = api.push({ ...firstItem, caption: 'nori 看看这组' }, secondItem);
    await api.waitFor(() => sends(api).length === 1, 8000);
    await app.bot.idle();

    expect(await historyOf(storage, group.id)).toEqual([
      { role: 'user', text: 'nori 看看这组' },
      { role: 'assistant', text: '两张都看到了' },
    ]);
    expect(await filesOf(storage, group.id)).toEqual([2, 0]);
    expect(api.downloads).toEqual(['files/a1', 'files/a2']);
    expect(promptFiles(model, 0)).toEqual(['image/jpeg', 'image/jpeg']);
    expect(sends(api)[0]?.body.reply_parameters).toEqual({
      message_id: first,
      allow_sending_without_reply: true,
    });

    // 同一批里改了两条的说明：各条分别处理，不被当成一组攒起来只剩最后一条
    api.pushEdit({ ...firstItem, message_id: first!, caption: '改过的说明' });
    api.pushEdit({ ...secondItem, message_id: second!, caption: '第二条加的说明' });
    await waitUntil(
      () =>
        entries.some((e) => e.msg === 'telegram.edited') &&
        entries.some((e) => e.msg === 'telegram.edit_missing'),
      5000,
    );
    expect((await historyOf(storage, group.id))[0]?.text).toBe('改过的说明');
    expect(await filesOf(storage, group.id)).toEqual([2, 0]);
    expect(api.downloads).toHaveLength(2);
  }, 15_000);

  it('相册还没攒齐时改了其中一条：编辑单独处理（此时找不到），相册照样记录', async () => {
    const { api, storage, entries } = await start(replying());
    const item = (fileId: string) => ({
      chat: group,
      from: alice,
      media_group_id: 'album-2',
      photo: [{ file_id: fileId, width: 8, height: 8 }],
    });
    api.addFile('b1', imageBytes('image/jpeg', 'b1'));
    api.addFile('b2', imageBytes('image/jpeg', 'b2'));

    const [, second] = api.push({ ...item('b1'), caption: '原来的说明' }, item('b2'));
    api.pushEdit({ ...item('b2'), message_id: second!, caption: '马上改了' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 1, 8000);

    expect(await historyOf(storage, group.id)).toEqual([{ role: 'user', text: '原来的说明' }]);
    expect(await filesOf(storage, group.id)).toEqual([2]);
    expect(entries.map((e) => e.msg)).toContain('telegram.edit_missing');
  }, 10_000);

  it('编辑：改历史里的正文，不触发；下一次请求里是新正文', async () => {
    const model = replying('他改口了', '不该出现');
    const { api, app, storage, entries } = await start(model);

    const [id] = api.push({ chat: group, from: alice, text: '原来的说法' });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 1);
    api.pushEdit({ message_id: id!, chat: group, from: alice, text: 'nori 改过的说法' });
    await waitUntil(() => entries.some((e) => e.msg === 'telegram.edited'));
    await sleep(100);
    expect(sends(api)).toEqual([]);

    api.push({ chat: group, from: bob, text: 'nori 她说了什么' });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();

    expect(promptText(model, 0)).toContain('改过的说法');
    expect(promptText(model, 0)).not.toContain('原来的说法');
  });

  it('文件头是 PNG、后面是乱码的图片被模型拒收：换成「[图片无法读取]」重试，正常回复；下一次请求里那里是占位', async () => {
    let reply = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const hasImage = prompt.some(
          (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'file'),
        );
        if (hasImage) {
          throw new APICallError({
            message: 'Bad Request',
            url: 'https://example.invalid/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 400,
          });
        }
        return replying(['这张图打不开', '记得'][reply++] ?? '好').doStream({ prompt } as never);
      },
    });
    const { api, app, storage, entries } = await start(model);
    api.addFile('garbled', Uint8Array.from([...imageBytes('image/png', ''), 0xde, 0xad, 0xbe]));

    const [id] = api.push({
      chat: group,
      from: alice,
      document: { file_id: 'garbled', file_name: 'scan.png', mime_type: 'image/png' },
      caption: 'nori 看看这张',
    });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();
    api.push({ chat: group, from: bob, text: 'nori 刚才那张呢' });
    await api.waitFor(() => sends(api).length === 2);
    await app.bot.idle();

    expect(sends(api).map((call) => call.body)).toMatchObject([
      { text: '这张图打不开', reply_parameters: { message_id: id } },
      { text: '记得' },
    ]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(promptFiles(model, 0)).toEqual(['image/png']);
    expect(promptFiles(model, 2)).toEqual([]);
    // 那条消息在原来图片的位置是占位
    const [first] = model.doStreamCalls[2]!.prompt.filter((m) => m.role === 'user');
    expect(first?.content).toMatchObject([
      { type: 'text', text: expect.stringContaining('nori 看看这张') },
      { type: 'text', text: '[图片无法读取]' },
      { type: 'text', text: '</message>' },
    ]);
    expect(await filesOf(storage, group.id)).toEqual([1, 0, 0, 0]);
    expect(entries.filter((e) => e.msg === 'reply.image_fallback')).toHaveLength(1);
    expect(entries.filter((e) => e.level === 'error')).toEqual([]);
  });

  it('伪造的 .png（内容是文字）：记成「[文件 fake.png]」，不作为图片；这次和之后的请求都正常', async () => {
    const model = replying('看起来是个文件', '好的');
    const { api, app, storage, entries } = await start(model);
    api.addFile('fake', new TextEncoder().encode('这是一段文字，不是图片'));

    api.push({
      chat: group,
      from: alice,
      document: { file_id: 'fake', file_name: 'fake.png', mime_type: 'image/png', file_size: 33 },
      caption: 'nori 这个文件里是什么？',
    });
    await api.waitFor(() => sends(api).length === 1);
    await app.bot.idle();
    api.push({ chat: group, from: bob, text: 'nori 还在吗' });
    await api.waitFor(() => sends(api).length === 2);
    await app.bot.idle();

    expect(api.downloads).toEqual(['files/fake']);
    expect(promptFiles(model, 0)).toEqual([]);
    expect(promptFiles(model, 1)).toEqual([]);
    expect(promptText(model, 1)).toContain('[文件 fake.png]');
    expect(sends(api).map((call) => call.body.text)).toEqual(['看起来是个文件', '好的']);
    expect(await filesOf(storage, group.id)).toEqual([0, 0, 0, 0]);
    expect(entries.filter((e) => e.msg === 'telegram.image_rejected').map((e) => e.fields)).toEqual(
      [{ conversationId: expect.any(String), kind: 'document', size: 33 }],
    );
  });

  it('下载失败：记「[图片下载失败]」，warn 日志只有文件种类与大小，没有文件地址与 token', async () => {
    const { api, storage, entries } = await start(replying());
    api.addFile('broken', new Uint8Array([1]), { failing: true });

    api.push({
      chat: group,
      from: alice,
      photo: [{ file_id: 'broken', width: 8, height: 8, file_size: 1234 }],
    });
    await waitUntil(async () => (await historyOf(storage, group.id)).length === 1);

    expect(await historyOf(storage, group.id)).toEqual([{ role: 'user', text: '[图片下载失败]' }]);
    expect(entries.filter((e) => e.msg === 'telegram.download_failed')).toEqual([
      {
        level: 'warn',
        msg: 'telegram.download_failed',
        fields: { conversationId: expect.any(String), kind: 'photo', size: 1234 },
      },
    ]);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('/file/');
  });

  describe('停机后重启的空闲补做', () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

    /** 库里已有这个群的会话，最后一条消息在 5 小时前（超过默认的 240 分钟空闲时长） */
    async function storageWithOldMessage(): Promise<Storage> {
      const storage = createMemoryStorage();
      const id = await storage.createConversation({
        platform: 'telegram',
        platformConversationId: String(group.id),
        title: group.title,
      });
      await (
        await storage.openConversation(id)
      ).add({
        id: 'before-stop',
        role: 'user',
        metadata: {
          author: { id: String(alice.id), name: 'Alice Liddell' },
          createdAt: hoursAgo(5).toISOString(),
          platformMessageId: '1',
        },
        parts: [{ type: 'text', text: '停机前最后一句' }],
      });
      return storage;
    }

    async function segmentOf(storage: Storage) {
      const info = await storage.findConversation('telegram', String(group.id));
      return (await storage.openConversation(info!.id)).currentSegment();
    }

    it('有积压：积压第一条与停机前最后一条只隔 10 分钟，不切段、不发摘要', async () => {
      const storage = await storageWithOldMessage();
      const model = replying('不该有摘要');
      const { app, entries } = await start(model, {
        storage,
        backlog: (api) => {
          api.push({
            chat: group,
            from: bob,
            text: '停机期间说的',
            date: Math.floor(hoursAgo(5 - 10 / 60).getTime() / 1000),
          });
        },
      });

      await app.caughtUp;
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(model.doStreamCalls).toHaveLength(0);
      expect(await segmentOf(storage)).toMatchObject({ startSeq: 1, startReason: 'first' });
      expect((await historyOf(storage, group.id)).map((m) => m.text)).toEqual([
        '停机前最后一句',
        '停机期间说的',
      ]);
      // 积压里出现过的会话已经打开，补做时不再打开
      expect(entries.find((e) => e.msg === 'telegram.caught_up')?.fields).toEqual({ opened: 0 });
    });

    it('积压里只有相册：等相册攒齐、记录之后才补做，不按现在的时间多切一段（观察 G）', async () => {
      const storage = await storageWithOldMessage();
      const model = replying('不该有摘要');
      const date = Math.floor(hoursAgo(5 - 10 / 60).getTime() / 1000);
      const { app, entries } = await start(model, {
        storage,
        backlog: (api) => {
          api.addFile('g1', imageBytes('image/jpeg', 'g1'));
          api.addFile('g2', imageBytes('image/jpeg', 'g2'));
          api.push(
            {
              chat: group,
              from: bob,
              media_group_id: 'backlog-album',
              photo: [{ file_id: 'g1', width: 8, height: 8 }],
              caption: '停机期间的相册',
              date,
            },
            {
              chat: group,
              from: bob,
              media_group_id: 'backlog-album',
              photo: [{ file_id: 'g2', width: 8, height: 8 }],
              date,
            },
          );
          // 别的相册里某一条的编辑：不打开会话，补做不用等它
          api.pushEdit({
            message_id: 4000,
            chat: group,
            from: bob,
            media_group_id: 'older-album',
            photo: [{ file_id: 'g0', width: 8, height: 8 }],
            caption: '改过的旧说明',
          });
        },
      });

      await app.caughtUp;
      // 补做时相册已经记录
      expect((await historyOf(storage, group.id)).map((m) => m.text)).toEqual([
        '停机前最后一句',
        '停机期间的相册',
      ]);
      await sleep(100);

      expect(model.doStreamCalls).toHaveLength(0);
      expect(await segmentOf(storage)).toMatchObject({ startSeq: 1, startReason: 'first' });
      expect(entries.find((e) => e.msg === 'telegram.caught_up')?.fields).toEqual({ opened: 0 });
      expect(entries.map((e) => e.msg)).toContain('telegram.edit_missing');
    }, 10_000);

    it('没有积压：启动后照常按现在的时间补做空闲切段', async () => {
      const storage = await storageWithOldMessage();
      const model = replying('停机前的摘要');

      const { api, app, entries } = await start(model, { storage });
      await app.caughtUp;
      // 第一次拉取不长轮询，立即返回；之后照常长轮询
      await waitUntil(() => api.polls.length >= 2);
      expect(api.polls.slice(0, 2).map((poll) => poll.timeout)).toEqual([0, 1]);
      await waitUntil(async () => (await segmentOf(storage)).startReason === 'idle');

      expect(await segmentOf(storage)).toMatchObject({
        startSeq: 2,
        priorSummary: '停机前的摘要',
      });
      expect(entries.find((e) => e.msg === 'telegram.caught_up')?.fields).toEqual({ opened: 1 });
    });
  });
});
