import { reactive } from "vue";

export const auth = reactive({ csrf: "", authenticated: false });

/**
 * 服务端的错误体带 `code` 与 `details`，而调用方此前只拿得到 `message` —— 想按错误种类分支
 * （`relax_requires_confirmation` 要弹二次确认再重发）就只能去匹配文案。带上它们，`.message`
 * 的既有用法一个都不受影响。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  // FormData 例外：multipart 的 Content-Type 里带一个浏览器生成的 boundary，自己写死
  // `application/json` 之后服务端 `parseBody()` 解不出任何字段，而且**不会报错** ——
  // 表现是「上传了但服务端说没收到 file」。
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(options.method ?? "GET") && auth.csrf)
    headers.set("X-CSRF-Token", auth.csrf);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && location.pathname !== "/login")
    location.assign("/login");
  // 服务端那边 `app.onError` + 未匹配 `/api/*` 的 404 已经保证了信封，但**非 JSON 响应不该
  // 表现成 SyntaxError**：裸 `response.json()` 遇到一份 `text/plain` 会抛
  // `Unexpected token 'I'`，界面上的报错和真实原因（端点崩了 / 反代插了一页 502）毫无关系。
  // 下面 `apiStream` 一直是 `.catch(() => null)` 的 —— 这里补齐同一个文件里的另一半。
  const result = (await response.json().catch(() => null)) as {
    ok: boolean;
    data?: T;
    error?: { message: string; code?: string; details?: unknown };
  } | null;
  if (!result)
    throw new ApiError(
      `请求失败：HTTP ${response.status}`,
      "non_json_response",
    );
  if (!result.ok)
    throw new ApiError(
      result.error?.message ?? "请求失败",
      result.error?.code ?? "unknown",
      result.error?.details,
    );
  return result.data as T;
}
export async function apiStream<T>(
  path: string,
  options: RequestInit,
  onEvent: (event: T) => void | Promise<void>,
): Promise<void> {
  const headers = new Headers(options.headers);
  // FormData 例外：multipart 的 Content-Type 里带一个浏览器生成的 boundary，自己写死
  // `application/json` 之后服务端 `parseBody()` 解不出任何字段，而且**不会报错** ——
  // 表现是「上传了但服务端说没收到 file」。
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(options.method ?? "GET") && auth.csrf)
    headers.set("X-CSRF-Token", auth.csrf);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && location.pathname !== "/login")
    location.assign("/login");
  if (!response.ok || !response.body) {
    const result = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      result?.error?.message ?? `请求失败：HTTP ${response.status}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await onEvent(JSON.parse(line) as T);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer) as T);
}

/** 刷新页面后内存里的 csrf 没了，先从 session 换一份回来，否则所有写操作都会 403。 */
export async function hydrateSession(): Promise<boolean> {
  try {
    const me = await api<{ csrf?: string }>("/api/auth/me");
    if (me.csrf) auth.csrf = me.csrf;
    auth.authenticated = true;
    return true;
  } catch {
    auth.authenticated = false;
    return false;
  }
}
