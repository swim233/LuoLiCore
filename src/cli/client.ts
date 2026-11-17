import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ChatChunk,
  ChatRequest,
  CommandEvent,
  CommandKind,
  CommandRequest,
  ConversationRow,
  ConversationsResponse,
  ErrorResponse,
} from '../server/types.js';
import { readChatStream, readEventStream } from './chat-stream.js';

/** 发 HTTP 请求（测试里换成直接调服务的 app） */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 连不上洛璃服务：没在运行、端口不对，或者回的不是洛璃服务 */
export class ServiceUnreachable extends Error {
  constructor(cause?: unknown) {
    super('无法连接核心服务', { cause });
    this.name = 'ServiceUnreachable';
  }
}

/** 发出去了：回复的流（会话 id 取自响应头），或者服务拒绝的原因 */
export type Sent =
  | { ok: true; conversationId?: string; chunks: AsyncGenerator<ChatChunk, void, undefined> }
  | { ok: false; status: number; error: string };

/** 指令发出去了：事件的流，或者服务拒绝的原因 */
export type CommandSent =
  | { ok: true; events: AsyncGenerator<CommandEvent, void, undefined> }
  | { ok: false; status: number; error: string };

/** 健康检查、读会话列表最多等这么久 */
const requestTimeoutMs = 5000;

/**
 * 发消息后等响应头、读回复时两段数据之间，最多等这么久。服务在回复的流里每 25 秒发一次心跳
 * （排队等别人的回复时也发），超过这个时间没有任何数据，就是服务卡住或连接断了
 */
export const readTimeoutMs = 60_000;

/**
 * 洛璃服务的客户端：只连 127.0.0.1:port，用服务的 HTTP 接口（访问控制要求非 GET 请求都是 JSON）。
 * 默认用 undici 的 fetch：等响应头、两段数据之间最多等 readTimeoutMs（Node 自带的 fetch 默认
 * 300 秒），超时按连接断了处理
 */
export function createClient({ port, fetch }: { port: number; fetch?: Fetch }) {
  const address = `127.0.0.1:${port}`;
  const base = `http://${address}`;
  const agent = fetch
    ? undefined
    : new Agent({ headersTimeout: readTimeoutMs, bodyTimeout: readTimeoutMs });
  const send: Fetch =
    fetch ??
    ((url, init) =>
      undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: agent,
      }) as unknown as Promise<Response>);

  /** 发请求；连不上（不是自己中止的）抛 ServiceUnreachable */
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await send(`${base}${path}`, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ServiceUnreachable(error);
    }
  }

  return {
    /** 显示在提示里的地址，如 127.0.0.1:7310 */
    address,

    /** 服务在运行：GET /api/health 回的是洛璃服务的状态 */
    async healthy(): Promise<boolean> {
      try {
        const response = await request('/api/health', {
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) return false;
        const status = (await response.json()) as Record<string, unknown>;
        return (
          typeof status.startedAt === 'string' &&
          typeof status.uptimeSeconds === 'number' &&
          typeof status.telegram === 'object' &&
          status.telegram !== null
        );
      } catch {
        return false;
      }
    },

    /** 最后消息最新的 CLI 会话（--resume 用）；没有时 undefined。连不上抛 ServiceUnreachable */
    async latestCliConversation(): Promise<ConversationRow | undefined> {
      const response = await request('/api/conversations', {
        signal: AbortSignal.timeout(requestTimeoutMs),
      }).catch((error: unknown) => {
        throw error instanceof ServiceUnreachable ? error : new ServiceUnreachable(error);
      });
      if (!response.ok) throw new ServiceUnreachable(`HTTP ${response.status}`);
      const { conversations } = (await response.json()) as ConversationsResponse;
      return conversations
        .filter((row) => row.platform === 'cli')
        .reduce<ConversationRow | undefined>(
          (latest, row) => (latest === undefined || row.lastAt > latest.lastAt ? row : latest),
          undefined,
        );
    },

    /**
     * 发一条消息：POST /api/chat。signal 中止时断开请求（服务把断开当作中止）。连不上抛
     * ServiceUnreachable；signal 已中止时照样抛出中止的错误
     */
    async chat(body: ChatRequest, signal?: AbortSignal): Promise<Sent> {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok || !response.body) return refused(response);
      return {
        ok: true,
        conversationId: response.headers.get('x-conversation-id') ?? undefined,
        chunks: readChatStream(response.body),
      };
    },

    /**
     * 执行一条指令：POST /api/conversations/:id/compact 或 /clear，执行人是 author。signal 中止时
     * 断开请求（服务把断开当作取消：等着的不执行，进行中的压缩中止）。连不上抛 ServiceUnreachable
     */
    async command(
      conversationId: string,
      kind: CommandKind,
      author: string,
      signal?: AbortSignal,
    ): Promise<CommandSent> {
      const body: CommandRequest = { author };
      const response = await request(
        `/api/conversations/${encodeURIComponent(conversationId)}/${kind}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok || !response.body) return refused(response);
      return { ok: true, events: readEventStream<CommandEvent>(response.body) };
    },

    /** 中止这个会话的回复：POST /api/chat/:id/abort（JSON {}）。出错不抛 */
    async abort(conversationId: string): Promise<void> {
      try {
        const response = await request(`/api/chat/${encodeURIComponent(conversationId)}/abort`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        await response.body?.cancel();
      } catch {
        // 连不上时回复的流也会断，由读流的那边处理
      }
    },

    /** 退出前关掉连接（不然空闲的 keep-alive 连接会让进程多等几秒）；最多等 1 秒，之后直接断掉 */
    async close(): Promise<void> {
      if (!agent) return;
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([
        agent.close().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      clearTimeout(timer);
      if (!closed) await agent.destroy().catch(() => {});
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/** 服务拒绝了请求：状态码与原因（ErrorResponse 的 error；读不出时写状态码） */
async function refused(response: Response): Promise<{ ok: false; status: number; error: string }> {
  const error = await response
    .json()
    .then((json) => (json as ErrorResponse).error)
    .catch(() => `HTTP ${response.status}`);
  return { ok: false, status: response.status, error };
}

/** 连不上时的提示（用户定的原话），地址取实际要连的那个 */
export function unreachableText(address: string): string {
  return `无法连接核心服务（${address}），请先运行 pnpm start 以启动服务`;
}
