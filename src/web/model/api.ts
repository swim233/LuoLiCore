import type {
  ConversationResponse,
  ConversationRow,
  ConversationsResponse,
  ErrorResponse,
  MessagesResponse,
  TodaySummary,
} from '../../server/types';

/* 洛璃服务的数据接口（src/server/api.ts）：用普通的 fetch 调，类型来自 src/server/types.ts。
   开发模式里模拟服务（dev/mock-server.ts）实现同一个接口，所以取数据、翻页、标记已读的逻辑只有一份（sync.ts） */
export interface Api {
  conversations(): Promise<ConversationsResponse>;
  conversation(id: string): Promise<ConversationResponse>;
  messages(id: string, q: { before?: number; limit?: number }): Promise<MessagesResponse>;
  markRead(id: string, seq: number): Promise<ConversationRow>;
  today(): Promise<TodaySummary>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    // 网络错误（服务没运行、连接断了）：浏览器给的是英文原文，换成中文的说法
    throw new ApiError('连不上洛璃服务', 0);
  }
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as Partial<ErrorResponse>;
      if (body.error) message = body.error;
    } catch {
      /* 不是 JSON：用状态码 */
    }
    throw new ApiError(message, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('服务返回的内容读不懂', res.status);
  }
}

const seg = encodeURIComponent;

export const httpApi: Api = {
  conversations: () => request('/api/conversations'),
  conversation: (id) => request(`/api/conversations/${seg(id)}`),
  messages(id, { before, limit }) {
    const q = new URLSearchParams();
    if (before !== undefined) q.set('before', String(before));
    if (limit !== undefined) q.set('limit', String(limit));
    const qs = q.toString();
    return request(`/api/conversations/${seg(id)}/messages${qs ? '?' + qs : ''}`);
  },
  // 非 GET 的请求必须带 Content-Type: application/json（访问控制）
  markRead: (id, seq) =>
    request(`/api/conversations/${seg(id)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq }),
    }),
  today: () => request('/api/today'),
};
