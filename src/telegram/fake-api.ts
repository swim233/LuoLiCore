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

/**
 * 只实现前端用到的方法：getMe、deleteWebhook、getUpdates（长轮询）、
 * sendMessage、sendChatAction。其他方法返回 404
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

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
      case 'getUpdates':
        polls.push(body);
        return ok(response, await pending(body, request));
      case 'sendMessage': {
        const failure = sendFailures.shift();
        if (failure) {
          return reply(response, failure, {
            ok: false,
            error_code: failure,
            description: 'Internal Server Error',
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
        return ok(response, sent);
      }
      default:
        return reply(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  }

  /** getUpdates：有新更新立即返回，否则等到有更新或超时，客户端断开时放弃 */
  async function pending(body: Record<string, unknown>, request: IncomingMessage) {
    const offset = Number(body.offset ?? 0);
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
    /** 推送一批更新（同一次 getUpdates 里返回），返回各自的 message_id */
    push(...messages: Array<Omit<TelegramRaw, 'message_id' | 'date'> & { date?: number }>) {
      const ids = messages.map((message) => {
        const message_id = nextMessageId++;
        updates.push({
          update_id: nextUpdateId++,
          message: { date: Math.floor(Date.now() / 1000), ...message, message_id },
        });
        return message_id;
      });
      for (const wake of [...waiting]) wake();
      return ids;
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

function ok(response: ServerResponse, result: unknown): void {
  reply(response, 200, { ok: true, result });
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
