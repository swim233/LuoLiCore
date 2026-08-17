import { untrusted } from '@luoli/shared';
import { guardedFetch } from '../net/outbound.js';
import { abortablePause, retryDelay } from '../provider/store.js';

/**
 * 单次尝试的墙钟上限与瞬时失败的重试次数。两条都必须有：
 * - 没有 `timeoutMs`，一个黑洞地址就能把整轮对话挂到 `turnTimeoutMs`（10 分钟）为止；
 * - 没有 `retries`，一次 502 / TCP 重置就直接变成 `ok:false` 交给模型，而模型通常只会换个说法
 *   再调一次（每次都要重付一遍上下文），或者干脆放弃并告诉用户「取不到」。
 * 只有这两个**幂等的读工具**能这么重试：写工具重试等于重复副作用（docs/05 §8.1）。
 */
export interface WebRetryOptions { timeoutMs: number; retries: number }
export const DEFAULT_WEB_RETRY: WebRetryOptions = { timeoutMs: 15_000, retries: 2 };
// 网页侧的瞬时故障（网关 502、限流、TCP 重置）是秒级恢复的，没必要按 provider 那套 1s→30s 的
// 节奏等：一轮对话的墙钟预算比一次上游调用紧得多。抖动仍复用 retryDelay（真随机，docs/20 · W-PROV-01）。
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 4000;
/** 再试一百次也是同一个结果的错误：语义性拒绝、地址不合法、重定向环。原样抛给注册表转成 ok:false。 */
const FATAL_ERRORS = new Set(['unsupported_protocol', 'port_blocked', 'ssrf_blocked', 'too_many_redirects', 'redirect_error', 'unsupported_request_body']);

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' || error.name === 'AbortError' ? 'web_timeout' : error.message.slice(0, 200);
  return 'web_error';
}
function fatal(error: unknown): boolean {
  // URL 解析失败抛的是 TypeError（`new URL()`）；重试它只是在重复同一个拼写错误。
  return error instanceof TypeError || (error instanceof Error && FATAL_ERRORS.has(error.message));
}
/** 站点自己答的 4xx 是「答案」，原样交给模型；只有这几类是「这一次没打通」。 */
function retriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
function retryAfterMs(headers: Record<string, string | string[] | undefined>): number | null {
  const raw = headers['retry-after'];
  const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_MAX_MS) : null;
}

export type WebAttempt<T> = { done: T } | { retry: string; afterMs?: number };
/**
 * 重试骨架。「这一次算不算值得再试」由调用方判（错误分类是每个工具自己的事），退避、可中断的
 * 等待、以及**耗尽之后交回什么**只写一遍：耗尽时给的是结构化失败而不是抛异常，因为模型需要
 * 知道「试了几次、卡在哪一步」才能决定是换个 URL 还是如实告诉用户取不到。
 */
export async function withWebRetries<T>(options: WebRetryOptions, abortSignal: AbortSignal, run: (attempt: number) => Promise<WebAttempt<T>>, exhausted: (failure: string, attempts: number) => T): Promise<T> {
  let failure = 'web_unreachable';
  let wait: number | null = null;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (attempt) await abortablePause(wait ?? retryDelay(attempt - 1, null, RETRY_BASE_MS, RETRY_MAX_MS), abortSignal);
    const outcome = await run(attempt);
    if ('done' in outcome) return outcome.done;
    failure = outcome.retry;
    wait = outcome.afterMs ?? null;
  }
  return exhausted(failure, options.retries + 1);
}

export async function webSearch(provider: 'brave' | 'serper' | 'tavily', apiKey: string, query: string, limit: number, abortSignal: AbortSignal, options: WebRetryOptions = DEFAULT_WEB_RETRY): Promise<Record<string, unknown>> {
  if (!apiKey) return { ok: false, error: 'web_search_key_missing' };
  const target = provider === 'brave' ? `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}` : provider === 'serper' ? 'https://google.serper.dev/search' : 'https://api.tavily.com/search';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: string | undefined;
  if (provider === 'brave') headers['x-subscription-token'] = apiKey;
  else if (provider === 'serper') { headers['x-api-key'] = apiKey; body = JSON.stringify({ q: query, num: limit }); }
  else body = JSON.stringify({ api_key: apiKey, query, max_results: limit });
  return await withWebRetries<Record<string, unknown>>(options, abortSignal, async (attempt) => {
    // 裸 fetch 只带轮次信号时同样没有上限：搜索 API 挂在半开连接上照样卡死一整轮。
    const signal = AbortSignal.any([abortSignal, AbortSignal.timeout(options.timeoutMs)]);
    let response: Response;
    try { response = await fetch(target, { method: provider === 'brave' ? 'GET' : 'POST', headers, ...(body ? { body } : {}), signal }); }
    catch (error) {
      if (abortSignal.aborted) throw error;
      return { retry: errorCode(error) };
    }
    if (!response.ok) {
      const failure = `search_http_${response.status}`;
      return retriableStatus(response.status) ? { retry: failure } : { done: { ok: false, error: failure } };
    }
    const raw = await response.json() as Record<string, unknown>;
    const values = provider === 'brave' ? (raw.web as { results?: unknown[] } | undefined)?.results : provider === 'serper' ? raw.organic : raw.results;
    return { done: { ok: true, provider, ...(attempt ? { attempts: attempt + 1 } : {}), results: Array.isArray(values) ? values.slice(0, limit) : [], content: untrusted(`search:${provider}`, JSON.stringify(values ?? [])) } };
  }, (failure, attempts) => ({ ok: false, error: failure, attempts, hint: `已重试 ${options.retries} 次仍未取到搜索结果（${failure}）；换个说法或稍后再试，不要立刻重复调用。` }));
}

/**
 * 拒绝类错误照旧抛给注册表（它统一转成 `ok:false`）—— SSRF 那组断言依赖「不合法的目标一律抛」，
 * 而重试耗尽走的是结构化失败：一个是「不许去」，另一个是「去了三次没通」。
 */
export async function webFetch(raw: string, maxBytes: number, abortSignal: AbortSignal, options: WebRetryOptions = DEFAULT_WEB_RETRY): Promise<Record<string, unknown>> {
  return await withWebRetries<Record<string, unknown>>(options, abortSignal, async (attempt) => {
    let response;
    try { response = await guardedFetch(raw, { method: 'GET', signal: abortSignal, headers: { 'user-agent': 'LuoLiCore/0.1' } }, { allowPrivate: false, maxBytes, timeoutMs: options.timeoutMs }); }
    catch (error) {
      // 用户取消或整轮超时：这不是「上游抖了一下」，重试只会拖着一个已经没人等的轮次。
      if (abortSignal.aborted || fatal(error)) throw error;
      return { retry: errorCode(error) };
    }
    if (retriableStatus(response.status)) {
      const advertised = retryAfterMs(response.headers);
      return { retry: `web_http_${response.status}`, ...(advertised === null ? {} : { afterMs: advertised }) };
    }
    return { done: { ok: response.ok, status: response.status, url: response.url, ...(attempt ? { attempts: attempt + 1 } : {}), content: untrusted(`web:${new URL(response.url).hostname}`, response.body.toString('utf8')), truncated: response.truncated } };
  }, (failure, attempts) => ({ ok: false, error: failure, attempts, hint: `已重试 ${options.retries} 次仍未取回内容（${failure}）；换个 URL 或稍后再试，不要立刻重复调用同一个地址。` }));
}
