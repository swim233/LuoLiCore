import { reactive } from "vue";

export const auth = reactive({ csrf: "", authenticated: false });
export const AUTH_REQUIRED_EVENT = "luoli:auth-required";

/** 交给 App 内的 Vue Router 切换登录页。整页导航会在新文档首帧前暴露浏览器默认画布。 */
export function requestLogin(): void {
  auth.csrf = "";
  auth.authenticated = false;
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

/**
 * 服务端的错误体带 `code` 与 `details`，而调用方此前只能取到 `message`：想按错误种类分支
 * （`relax_requires_confirmation` 需二次确认后重发）只能匹配文案。这里一并带上，`.message`
 * 的既有用法不受影响。
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
  // FormData 例外：multipart 的 Content-Type 中带有浏览器生成的 boundary，若在此写死
  // `application/json`，服务端 `parseBody()` 解析不出任何字段，且不会报错，
  // 表现为上传成功但服务端提示未收到 file。
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(options.method ?? "GET") && auth.csrf)
    headers.set("X-CSRF-Token", auth.csrf);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && location.pathname !== "/login")
    requestLogin();
  // 服务端的 `app.onError` 与未匹配 `/api/*` 的 404 已保证信封结构，但非 JSON 响应不应
  // 表现为 SyntaxError：直接调用 `response.json()` 遇到 `text/plain` 会抛出
  // `Unexpected token 'I'`，界面上的报错与真实原因（端点异常、反向代理返回 502 页面）无关。
  // 下方 `apiStream` 一直使用 `.catch(() => null)`，这里补齐同一文件中的另一半。
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
  // FormData 例外：multipart 的 Content-Type 中带有浏览器生成的 boundary，若在此写死
  // `application/json`，服务端 `parseBody()` 解析不出任何字段，且不会报错，
  // 表现为上传成功但服务端提示未收到 file。
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(options.method ?? "GET") && auth.csrf)
    headers.set("X-CSRF-Token", auth.csrf);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && location.pathname !== "/login")
    requestLogin();
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

/** 刷新页面后内存中的 csrf 丢失，先从 session 换取一份，否则所有写操作都会返回 403。 */
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
