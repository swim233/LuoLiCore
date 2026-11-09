import { DefaultChatTransport } from 'ai';
import type { ChatTransport } from 'ai';
import { request } from './api';
import type {
  AbortResponse,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ErrorResponse,
  UploadResponse,
} from '../../server/types';

/* 网页对话要用的服务接口：发消息（useChat 的 transport）、中止、上传图片。
   正式构建里是洛璃服务的 HTTP 接口（POST /api/chat、POST /api/chat/:id/abort、POST /api/files，见 src/server/types.ts）；
   开发模式里由 dev/mock-chat.ts 在浏览器里模拟同样的接口。 */
export interface ChatApi {
  /**
   * 给一个 Chat 用的 transport。每次发消息（或重试）新建一个 Chat、一个 transport：
   * onChunk 能看到这次响应里的每一段（data-conversation、data-queued、start、abort、error……），
   * Chat 自己只认文字、思考、工具，不报这些
   */
  transport(onChunk: (chunk: ChatChunk) => void): ChatTransport<ChatMessage>;
  /** 中止这个会话进行中的回复，同时取消排队的补回复（排队的消息留在历史里） */
  abort(convId: string): Promise<AbortResponse>;
  /** 上传一张图片，返回文件存储里的引用 */
  upload(file: File, signal?: AbortSignal): Promise<UploadResponse>;
}

/** 一次发送的元信息：useChat 的 sendMessage、regenerate 的 metadata 里带着，prepare 时取出来 */
export interface SendMeta {
  /** 新会话没有 */
  conversationId?: string;
}

/** 这个标签页的客户端 id：模块加载时随机生成一次，只在内存里。服务排队时按它分辨是不是同一个标签页发的 */
const clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');

/** 发给 POST /api/chat 的请求体：只发新消息（会话的正本在服务端）；重试（regenerate）不带消息 */
export function chatRequestBody(opts: {
  trigger: 'submit-message' | 'regenerate-message';
  messages: ChatMessage[];
  metadata: unknown;
}): ChatRequest {
  const conversationId = (opts.metadata as SendMeta | undefined)?.conversationId;
  if (opts.trigger === 'regenerate-message')
    return { conversationId: conversationId!, retry: true };
  const last = opts.messages.at(-1);
  const parts = last?.role === 'user' ? last.parts : [];
  const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  // 文件段的地址是先上传得到的 luoli-file: 引用
  const files = parts.flatMap((p) => (p.type === 'file' ? [p.url] : []));
  return {
    clientId,
    ...(conversationId ? { conversationId } : {}),
    ...(text ? { text } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** 把每一段交给 onChunk 看一眼，再原样往下传 */
export class ObservedTransport implements ChatTransport<ChatMessage> {
  constructor(
    private inner: ChatTransport<ChatMessage>,
    private onChunk: (chunk: ChatChunk) => void,
  ) {}
  async sendMessages(options: Parameters<ChatTransport<ChatMessage>['sendMessages']>[0]) {
    const stream = await this.inner.sendMessages(options);
    const onChunk = this.onChunk;
    return stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          try {
            onChunk(chunk as ChatChunk);
          } catch (e) {
            console.error('[chat]', e);
          }
          controller.enqueue(chunk);
        },
      }),
    );
  }
  reconnectToStream(options: Parameters<ChatTransport<ChatMessage>['reconnectToStream']>[0]) {
    return this.inner.reconnectToStream(options);
  }
}

/** 接口出错时给用户看的话：服务的出错说明；网络错误、读不懂的返回换成中文 */
export function chatErrorText(err: unknown): string {
  const body = (err as { responseBody?: unknown } | null)?.responseBody;
  if (typeof body === 'string') {
    try {
      const j = JSON.parse(body) as Partial<ErrorResponse>;
      if (j.error) return j.error;
    } catch {
      /* 不是 JSON */
    }
  }
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') return `请求失败（HTTP ${status}）`;
  if (err instanceof TypeError) return '连不上洛璃服务';
  if (err instanceof Error && err.message) return err.message;
  return '请求失败';
}
/** 接口出错的 HTTP 状态码（取不到为 undefined） */
export const chatErrorStatus = (err: unknown): number | undefined => {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' ? s : undefined;
};

export const httpChatApi: ChatApi = {
  transport(onChunk) {
    return new ObservedTransport(
      new DefaultChatTransport<ChatMessage>({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages, trigger, requestMetadata }) => ({
          body: chatRequestBody({ trigger, messages, metadata: requestMetadata }),
        }),
      }),
      onChunk,
    );
  },
  // 非 GET 的请求必须带 Content-Type: application/json（访问控制），没有请求体的也写 {}
  abort: (convId) =>
    request<AbortResponse>(`/api/chat/${encodeURIComponent(convId)}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  // 上传：请求体就是图片的原始字节，Content-Type 是图片的类型（访问控制里「只收 JSON」的例外）
  upload: (file, signal) =>
    request<UploadResponse>('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
      signal,
    }),
};
