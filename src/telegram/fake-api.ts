import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TelegramMessage, TelegramUpdate, TelegramUser } from '@chat-adapter/telegram';
import type { TelegramRaw } from './message.js';

/** 测试用的本地 Bot API：收到的请求都记下来，更新由测试推送 */
export type FakeTelegram = Awaited<ReturnType<typeof startFakeTelegram>>;

export type ApiCall = { method: string; token: string; body: Record<string, unknown> };

export const fakeBot: TelegramUser = {
  id: 999,
  is_bot: true,
  first_name: 'Nori',
  username: 'nori_test_bot',
};

/** 群里看得到的一条 bot 发的消息：在哪个聊天、文字、引用了哪条（没引用时没有） */
export type Delivered = { chatId: string; messageId: number; text: string; replyTo?: number };

/**
 * 只实现前端用到的方法：getMe、deleteWebhook、getUpdates（长轮询）、
 * sendMessage、sendChatAction、getFile、setMyCommands，以及文件下载（/file/bot<token>/<路径>）。
 * 其他返回 404。
 * sendMessage 的引用照真的 Bot API：被引用的消息不在这个聊天里（没发过、被删了）时，
 * 带 allow_sending_without_reply 就不带引用发出，否则 400
 */
export async function startFakeTelegram() {
  const updates: TelegramUpdate[] = [];
  const calls: ApiCall[] = [];
  // getUpdates 的请求体（不进 calls，免得长轮询淹没其他请求）
  const polls: Array<Record<string, unknown>> = [];
  const waiting = new Set<() => void>();
  let nextUpdateId = 1;
  let nextMessageId = 5000;
  // sendMessage 依次按这里的状态码失败；空了就成功
  const sendFailures: number[] = [];
  // 为 true 时 getUpdates 一律返回 502（模拟连不上 Telegram）
  let pollsFailing = false;
  // setMyCommands 以这个状态码失败；没有时成功
  let setCommandsFailure: number | undefined;
  // 有时 setMyCommands 等它放行才回应
  let setCommandsHold: Promise<void> | undefined;
  // 可下载的文件：file_id → 内容；在 failingFiles 里的下载时返回 500
  const files = new Map<string, Uint8Array>();
  const failingFiles = new Set<string>();
  // 下载请求的文件路径（地址里的 token 不记）
  const downloads: string[] = [];
  // 每个聊天里现有的消息（推送的、bot 发的；删掉的去掉），按 chat id
  const existing = new Map<string, Set<number>>();
  const exists = (chatId: string, messageId: number) =>
    existing.get(chatId)?.has(messageId) ?? false;
  const remember = (chatId: string, messageId: number) => {
    existing.set(chatId, (existing.get(chatId) ?? new Set()).add(messageId));
  };
  // bot 发出、群里看得到的消息
  const delivered: Delivered[] = [];

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(request.url ?? '');
    if (file) return download(decodeURIComponent(file[1]!), response);
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!match)
      return reply(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = match as unknown as [string, string, string];
    if (method !== 'getUpdates') calls.push({ method, token, body });
    switch (method) {
      case 'getMe':
        return ok(response, fakeBot);
      case 'deleteWebhook':
      case 'sendChatAction':
        return ok(response, true);
      case 'setMyCommands':
        await setCommandsHold;
        if (setCommandsFailure) {
          return reply(response, setCommandsFailure, {
            ok: false,
            error_code: setCommandsFailure,
            description: setCommandsFailure === 401 ? 'Unauthorized' : 'Internal Server Error',
          });
        }
        return ok(response, true);
      case 'getUpdates':
        polls.push(body);
        if (pollsFailing) {
          return reply(response, 502, { ok: false, error_code: 502, description: 'Bad Gateway' });
        }
        return ok(response, await pending(body, request));
      case 'getFile': {
        const fileId = String(body.file_id);
        if (!files.has(fileId)) {
          return reply(response, 400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: invalid file_id',
          });
        }
        return ok(response, { file_id: fileId, file_path: `files/${fileId}` });
      }
      case 'sendMessage': {
        const failure = sendFailures.shift();
        if (failure) {
          return reply(response, failure, {
            ok: false,
            error_code: failure,
            description: 'Internal Server Error',
          });
        }
        const chatId = String(body.chat_id);
        const quoted = body.reply_parameters as
          { message_id: number; allow_sending_without_reply?: boolean } | undefined;
        const replyTo = quoted && exists(chatId, quoted.message_id) ? quoted.message_id : undefined;
        if (quoted && replyTo === undefined && !quoted.allow_sending_without_reply) {
          return reply(response, 400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: message to be replied not found',
          });
        }
        const sent: TelegramMessage = {
          message_id: nextMessageId++,
          chat: {
            id: Number(body.chat_id),
            type: Number(body.chat_id) < 0 ? 'supergroup' : 'private',
          },
          date: Math.floor(Date.now() / 1000),
          from: fakeBot,
          text: String(body.text),
        };
        remember(chatId, sent.message_id);
        delivered.push({
          chatId,
          messageId: sent.message_id,
          text: sent.text!,
          ...(replyTo === undefined ? {} : { replyTo }),
        });
        return ok(response, sent);
      }
      default:
        return reply(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  }

  function download(fileId: string, response: ServerResponse): void {
    downloads.push(`files/${fileId}`);
    const data = files.get(fileId);
    if (!data || failingFiles.has(fileId)) {
      response.writeHead(data ? 500 : 404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(data);
  }

  /** getUpdates：有新更新立即返回，否则等到有更新或超时，客户端断开时放弃 */
  async function pending(body: Record<string, unknown>, request: IncomingMessage) {
    const offset = Number(body.offset ?? 0);
    // 与真的 Bot API 一样：带上 offset 就算确认了它之前的更新，之后不再返回（重启后也不会）
    updates.splice(0, updates.filter((update) => update.update_id < offset).length);
    const available = () => updates.filter((update) => update.update_id >= offset);
    if (available().length === 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          waiting.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, Number(body.timeout ?? 0) * 1000);
        waiting.add(done);
        request.on('close', done);
      });
    }
    return available();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    polls,
    downloads,
    /** bot 发出、群里看得到的消息，按发出先后 */
    delivered,
    /** 之后的 setMyCommands 以这个状态码失败（如 401）；undefined 时恢复。收到的内容记在 calls 里 */
    failSetCommands(status: number | undefined) {
      setCommandsFailure = status;
    },
    /** 之后的 setMyCommands 先不回应，等调用返回的函数才回应 */
    holdSetCommands(): () => void {
      let release!: () => void;
      setCommandsHold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        setCommandsHold = undefined;
        release();
      };
    },
    /** 推送一批更新（同一次 getUpdates 里返回），返回各自的 message_id */
    push(...messages: Array<Omit<TelegramRaw, 'message_id' | 'date'> & { date?: number }>) {
      const ids = messages.map((message) => {
        const message_id = nextMessageId++;
        remember(String(message.chat.id), message_id);
        updates.push({
          update_id: nextUpdateId++,
          message: { date: Math.floor(Date.now() / 1000), ...message, message_id },
        });
        return message_id;
      });
      for (const wake of [...waiting]) wake();
      return ids;
    },
    /** 推送一条编辑（edited_message），带 edit_date */
    pushEdit(message: Omit<TelegramRaw, 'date'> & { date?: number }) {
      const now = Math.floor(Date.now() / 1000);
      updates.push({
        update_id: nextUpdateId++,
        edited_message: { date: now, edit_date: now, ...message },
      });
      for (const wake of [...waiting]) wake();
    },
    /** 群里删掉一条消息（Bot 收不到删除的通知）：之后引用它就引用不上 */
    deleteMessage(chatId: number, messageId: number) {
      existing.get(String(chatId))?.delete(messageId);
    },
    /** 登记一个可下载的文件；failing 时 getFile 成功、下载返回 500 */
    addFile(fileId: string, data: Uint8Array, { failing = false } = {}) {
      files.set(fileId, data);
      if (failing) failingFiles.add(fileId);
    },
    /**
     * 之后的 getUpdates 一律失败（502），模拟连不上 Telegram；false 时恢复。
     * 打开时正在等的长轮询立即返回（空的），下一次拉取就会失败
     */
    failPolls(failing: boolean) {
      pollsFailing = failing;
      if (failing) for (const wake of [...waiting]) wake();
    },
    /** 之后的 sendMessage 依次以这些状态码失败 */
    failSends(...statuses: number[]) {
      sendFailures.push(...statuses);
    },
    /** 等到满足条件的请求出现 */
    async waitFor(predicate: (calls: ApiCall[]) => boolean, timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(calls)) {
        if (Date.now() > deadline) throw new Error('等待 Telegram 请求超时');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close(): Promise<void> {
      for (const wake of [...waiting]) wake();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const headers: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
};

/** 测试用的「图片」：该类型的文件头，后面跟着「|tag」，用 tagOf 取回 tag */
export function imageBytes(mediaType: string, tag: string): Uint8Array {
  return Uint8Array.from([...headers[mediaType]!, ...new TextEncoder().encode(`|${tag}`)]);
}

/** imageBytes 里的 tag */
export function tagOf(data: Uint8Array): string {
  return new TextDecoder().decode(data).split('|').at(-1)!;
}

function ok(response: ServerResponse, result: unknown): void {
  reply(response, 200, { ok: true, result });
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
