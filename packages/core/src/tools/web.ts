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

const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object', 'canvas', 'audio', 'video']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer',
  'blockquote', 'pre', 'table', 'thead', 'tbody', 'ul', 'ol', 'dl', 'dd', 'dt', 'main', 'nav', 'aside', 'form', 'figure', 'figcaption', 'hr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', middot: '·' };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (all, body: string) => {
    if (!body.startsWith('#')) return ENTITIES[body.toLowerCase()] ?? all;
    const hex = body.startsWith('#x') || body.startsWith('#X');
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10_FF_FF ? String.fromCodePoint(code) : all;
  });
}
/**
 * HTML → 纯文本。此前 `web_fetch` 把整份 HTML 原样交给模型，而一个普通页面九成是 script /
 * style / 导航 —— 按 `tools.maxOutputBytes`（64KB）截断之后经常连正文的第一段都没进去，
 * 模型于是「取回来了但什么也没读到」（docs/05 §3.6 要的是「转 markdown」这一步）。
 *
 * 刻意不用正则拼这件事：输入是最多 `maxResponseBytes`（2MB）的不可信文本，而
 * `<script[^>]*>[\s\S]*?<\/script>` 这类形状在「一堆开标签、没有闭标签」的输入上是 O(n²)
 * 回溯 —— 与 docs/24 · R-SEC-01（grep 换 RE2）同一条教训：接受任意输入就必须有线性上界。
 * 单趟扫描没有这个问题，代价是它不是 DOM，只是「取标签之间的字，块级标签处换行」。
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let index = 0;
  let dropping: string | null = null;
  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next < 0) { if (!dropping) out.push(html.slice(index)); break; }
    if (!dropping && next > index) out.push(html.slice(index, next));
    if (html.startsWith('<!--', next)) { const close = html.indexOf('-->', next + 4); index = close < 0 ? html.length : close + 3; continue; }
    const end = html.indexOf('>', next);
    // 未闭合的 `<`：后面整段都不是可信的标签结构，停在这里比把半个页面的属性倒出来好。
    if (end < 0) break;
    const tag = html.slice(next + 1, end);
    index = end + 1;
    const name = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = tag.startsWith('/');
    if (dropping) { if (closing && name === dropping) dropping = null; continue; }
    if (!closing && DROP_TAGS.has(name)) { if (!tag.trimEnd().endsWith('/')) dropping = name; continue; }
    if (name === 'br') out.push('\n');
    else if (name === 'li' && !closing) out.push('\n- ');
    else if (BLOCK_TAGS.has(name)) out.push('\n\n');
  }
  return decodeEntities(out.join('')).replaceAll('\r', '').replace(/[^\S\n]+/g, ' ')
    .split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** `content-type` 缺失或撒谎的站点不少，所以类型头之外再看正文开头长什么样。 */
function looksLikeHtml(contentType: string, body: string): boolean {
  if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType)) return true;
  return !contentType && /^\s*<(!doctype\s+html|html[\s>])/i.test(body);
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

/**
 * 搜索请求**也走 `guardedFetch`** —— 这里此前是全仓库唯一一条裸 `fetch`，而它带着搜索 API key
 * （`x-subscription-token` / `x-api-key`）：undici 的 fetch 只按规范摘 `Authorization` / `Cookie` /
 * `Proxy-Authorization`，自定义认证头会跟着 302 原样送到新主机，同时没有 SSRF 策略、没有响应体
 * 上界（`response.json()` 全收）。目标域名是常量，所以这是纵深防御缺口而不是可直接利用的漏洞，
 * 但代价是一个 302 就能带走搜索 key（docs/27 · S-04）。
 *
 * **`maxRedirects: 0`**：搜索 API 不需要重定向，一次 3xx 就该当异常而不是跟过去。
 */
export type SearchProvider = 'brave' | 'serper' | 'tavily' | 'exa';
/**
 * 四家搜索 API 的差异**全在这两个函数里**：打哪个地址、认证头叫什么、请求体怎么写、结果数组藏在
 * 哪个键下面。抽出来是为了能在不出网的情况下断言它 —— 加一家 provider 时错的正是这四件事，
 * 而错了的表现是「搜索永远返回 0 条」或「key 送不上去」，两者都要真打一次上游才看得见。
 */
export function searchRequest(provider: SearchProvider, apiKey: string, query: string, limit: number): { target: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider === 'brave') {
    headers['x-subscription-token'] = apiKey;
    return { target: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, method: 'GET', headers };
  }
  if (provider === 'serper') {
    headers['x-api-key'] = apiKey;
    return { target: 'https://google.serper.dev/search', method: 'POST', headers, body: JSON.stringify({ q: query, num: limit }) };
  }
  // exa 不带 `contents` 时每条只有 title/url/publishedDate —— 那要模型对每一条再 web_fetch 一次才
  // 知道值不值得看。`highlights` 给的是命中片段，与 brave 的 description / serper 的 snippet 对齐；
  // 全文（`contents.text`）刻意不要：按页计费，且十条正文足以顶掉半个上下文窗口。
  if (provider === 'exa') {
    headers['x-api-key'] = apiKey;
    return { target: 'https://api.exa.ai/search', method: 'POST', headers, body: JSON.stringify({ query, numResults: limit, contents: { highlights: true } }) };
  }
  return { target: 'https://api.tavily.com/search', method: 'POST', headers, body: JSON.stringify({ api_key: apiKey, query, max_results: limit }) };
}
/** 结果数组的位置：brave 在 `web.results`、serper 在 `organic`，tavily 与 exa 都在 `results`。 */
export function searchResults(provider: SearchProvider, raw: Record<string, unknown>): unknown[] {
  const values = provider === 'brave' ? (raw.web as { results?: unknown[] } | undefined)?.results : provider === 'serper' ? raw.organic : raw.results;
  return Array.isArray(values) ? values : [];
}
export async function webSearch(provider: SearchProvider, apiKey: string, query: string, limit: number, abortSignal: AbortSignal, options: WebRetryOptions = DEFAULT_WEB_RETRY, maxBytes = 1_048_576): Promise<Record<string, unknown>> {
  if (!apiKey) return { ok: false, error: 'web_search_key_missing' };
  const { target, method, headers, body } = searchRequest(provider, apiKey, query, limit);
  return await withWebRetries<Record<string, unknown>>(options, abortSignal, async (attempt) => {
    let response;
    try { response = await guardedFetch(target, { method, headers, ...(body ? { body } : {}), signal: abortSignal },
      { allowPrivate: false, maxRedirects: 0, maxBytes, timeoutMs: options.timeoutMs }); }
    catch (error) {
      if (abortSignal.aborted) throw error;
      // 拒绝类错误（重定向、协议、SSRF）再试三次也是同一个结果。与 `webFetch` 不同的是这里
      // **不往上抛**：搜索失败是要交给模型读的一句话，不是 SSRF 断言依赖的「不许去」。
      const code = errorCode(error);
      return fatal(error) ? { done: { ok: false, error: code } } : { retry: code };
    }
    if (!response.ok) {
      const failure = `search_http_${response.status}`;
      return retriableStatus(response.status) ? { retry: failure } : { done: { ok: false, error: failure } };
    }
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>; }
    catch { return { done: { ok: false, error: response.truncated ? 'search_response_truncated' : 'search_bad_json' } }; }
    const values = searchResults(provider, raw);
    return { done: { ok: true, provider, ...(attempt ? { attempts: attempt + 1 } : {}), results: values.slice(0, limit), content: untrusted(`search:${provider}`, JSON.stringify(values)) } };
  }, (failure, attempts) => ({ ok: false, error: failure, attempts, hint: `已重试 ${options.retries} 次仍未取到搜索结果（${failure}）；换个说法或稍后再试，不要立刻重复调用。` }));
}

/**
 * 拒绝类错误照旧抛给注册表（它统一转成 `ok:false`）—— SSRF 那组断言依赖「不合法的目标一律抛」，
 * 而重试耗尽走的是结构化失败：一个是「不许去」，另一个是「去了三次没通」。
 */
export async function webFetch(raw: string, maxBytes: number, abortSignal: AbortSignal, options: WebRetryOptions = DEFAULT_WEB_RETRY,
  hosts: { allowlist?: readonly string[]; denylist?: readonly string[] } = {}): Promise<Record<string, unknown>> {
  return await withWebRetries<Record<string, unknown>>(options, abortSignal, async (attempt) => {
    let response;
    try { response = await guardedFetch(raw, { method: 'GET', signal: abortSignal, headers: { 'user-agent': 'LuoLiCore/0.1' } }, { allowPrivate: false, maxBytes, timeoutMs: options.timeoutMs,
      ...(hosts.allowlist?.length ? { allowHosts: hosts.allowlist } : {}), ...(hosts.denylist?.length ? { denyHosts: hosts.denylist } : {}) }); }
    catch (error) {
      // 用户取消或整轮超时：这不是「上游抖了一下」，重试只会拖着一个已经没人等的轮次。
      if (abortSignal.aborted || fatal(error)) throw error;
      return { retry: errorCode(error) };
    }
    if (retriableStatus(response.status)) {
      const advertised = retryAfterMs(response.headers);
      return { retry: `web_http_${response.status}`, ...(advertised === null ? {} : { afterMs: advertised }) };
    }
    const body = response.body.toString('utf8');
    const html = looksLikeHtml(String(response.headers['content-type'] ?? ''), body);
    return { done: { ok: response.ok, status: response.status, url: response.url, ...(attempt ? { attempts: attempt + 1 } : {}),
      // `extracted` 要交出去：模型看到的是抽取后的正文，不知道这一点它会以为页面上就没有那些
      // 表格和脚本里的数据，而不是「这里只给了正文」。
      ...(html ? { extracted: 'text' as const } : {}), content: untrusted(`web:${new URL(response.url).hostname}`, html ? htmlToText(body) : body), truncated: response.truncated } };
  }, (failure, attempts) => ({ ok: false, error: failure, attempts, hint: `已重试 ${options.retries} 次仍未取回内容（${failure}）；换个 URL 或稍后再试，不要立刻重复调用同一个地址。` }));
}
