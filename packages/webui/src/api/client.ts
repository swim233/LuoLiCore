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
