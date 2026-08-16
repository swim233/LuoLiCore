import { reactive } from 'vue';

export const auth = reactive({ csrf: '', authenticated: false });

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(options.method ?? 'GET') && auth.csrf) headers.set('X-CSRF-Token', auth.csrf);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && location.pathname !== '/login') location.assign('/login');
  const result = await response.json() as { ok: boolean; data?: T; error?: { message: string } };
  if (!result.ok) throw new Error(result.error?.message ?? '请求失败');
  return result.data as T;
}
export async function apiStream<T>(path: string, options: RequestInit, onEvent: (event: T) => void | Promise<void>): Promise<void> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(options.method ?? 'GET') && auth.csrf) headers.set('X-CSRF-Token', auth.csrf);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && location.pathname !== '/login') location.assign('/login');
  if (!response.ok || !response.body) {
    const result = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(result?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await onEvent(JSON.parse(line) as T);
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer) as T);
}

/** 刷新页面后内存里的 csrf 没了，先从 session 换一份回来，否则所有写操作都会 403。 */
export async function hydrateSession(): Promise<boolean> {
  try {
    const me = await api<{ csrf?: string }>('/api/auth/me');
    if (me.csrf) auth.csrf = me.csrf;
    auth.authenticated = true;
    return true;
  } catch { auth.authenticated = false; return false; }
}
