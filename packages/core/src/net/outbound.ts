import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
import { isIP, type LookupFunction } from 'node:net';

const DEFAULT_PORTS = new Set([80, 443, 8080, 8443]);
// `x-subscription-token` 是 Brave 搜索 API 的 key 头（`tools/web.ts`）。跨源重定向摘认证头这件事
// 只按名单判，名单漏一个头就等于那一个凭据能被 302 带走。
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|x-subscription-token)$/i;

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

function inCidr(address: string, base: string, prefix: number): boolean {
  const value = ipv4Number(address); const origin = ipv4Number(base);
  if (value === null || origin === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (origin & mask);
}

export function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!;
  if (normalized.startsWith('::ffff:')) {
    const tail = normalized.slice(7);
    if (isIP(tail) === 4) return privateAddress(tail);
    const [high, low] = tail.split(':').map((part) => Number.parseInt(part || '0', 16));
    if (Number.isFinite(high) && Number.isFinite(low)) return privateAddress(`${(high! >>> 8) & 255}.${high! & 255}.${(low! >>> 8) & 255}.${low! & 255}`);
    return true;
  }
  if (normalized.startsWith('64:ff9b:') || normalized.startsWith('2002:')) return true;
  if (normalized === '::1' || normalized === '0.0.0.0' || normalized === '::') return true;
  if (isIP(normalized) === 4) return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ].some(([base, prefix]) => inCidr(normalized, base as string, prefix as number));
  return normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized);
}

/**
 * `dns.lookup` 不认 AbortSignal（getaddrinfo 取消不了）。不在这里拦一道，解析不动的域名会把
 * 预算全耗在 DNS 上 —— 对调用方来说和「连上之后不吐字」是同一种卡死。剩下那次查询自己跑完后
 * 结果被丢掉即可。
 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return await work;
  const reason = (): Error => signal.reason instanceof Error ? signal.reason : new Error('aborted');
  if (signal.aborted) throw reason();
  let onAbort!: () => void;
  // 监听器必须收回：不带 timeoutMs 的调用方传进来的往往是**整轮**那个信号，一次调用留一个
  // 永不触发的监听器，一轮里几十次抓取就是几十个。
  const aborted = new Promise<never>((_, reject) => { onAbort = (): void => reject(reason()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

interface SafeTarget { url: URL; address: string; family: 4 | 6 }
async function safeTarget(raw: string, policy: OutboundPolicy, signal?: AbortSignal | null): Promise<SafeTarget> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.allowPrivate && !(policy.allowedPorts ?? DEFAULT_PORTS).has(port)) throw new Error('port_blocked');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // 域名策略在 DNS 之前判，而且**每一跳重定向都会再走一遍这里** —— 否则 allowlist 只挡得住
  // 第一跳，一个放行域名的 302 就能把请求带去任何地方（docs/22 · V-SSRF-01 同一处教训）。
  if (policy.denyHosts?.length && hostMatches(hostname, policy.denyHosts)) throw new Error('host_denied');
  if (policy.allowHosts?.length && !hostMatches(hostname, policy.allowHosts)) throw new Error('host_not_allowed');
  if (isIP(hostname)) {
    if (!policy.allowPrivate && privateAddress(hostname)) throw new Error('ssrf_blocked');
    return { url, address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const addresses = await abortable(lookup(hostname, { all: true }), signal);
  if (!addresses.length || (!policy.allowPrivate && addresses.some((entry) => privateAddress(entry.address)))) throw new Error('ssrf_blocked');
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export interface GuardedResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
}
export interface OutboundPolicy {
  allowPrivate: boolean;
  allowedPorts?: ReadonlySet<number>;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** `tools.web.allowlist`：非空时**只有**命中的域名放行（白名单语义）。 */
  allowHosts?: readonly string[];
  /** `tools.web.denylist`：命中即拒，**优先于** allowlist。 */
  denyHosts?: readonly string[];
}

/**
 * 域名 glob 匹配：`example.com` 精确匹配，`*.example.com` 匹配任意子域（不含裸域）。
 * 大小写不敏感，尾点归一化 —— `EXAMPLE.COM.` 和 `example.com` 是同一个主机。
 */
export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!pattern) return false;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
    return host === pattern;
  });
}

function requestOnce(target: SafeTarget, init: RequestInit, maxBytes: number): Promise<GuardedResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<GuardedResponse>();
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = target.url.host;
  // Node ≥20 的 autoSelectFamily 默认开，net.connect 用 `{ all: true }` 调 lookup，此时回调要的是
  // 数组；回传字符串会让它读到 `addresses[0].address === undefined`，抛 `Invalid IP address: undefined`。
  // 表现是 web_fetch 在现代 Node 上 100% 失败，而 tests/web.test.ts 只覆盖了 SSRF 拒绝路径，
  // 放行路径一次都没真正跑过，所以这条一直没被发现。
  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
    method: init.method ?? 'GET', headers, lookup: lookupPinned,
    ...(target.url.protocol === 'https:' ? { servername: target.url.hostname } : {}),
  }, (response) => {
    const chunks: Buffer[] = []; let bytes = 0; let truncated = false; let settled = false;
    const finish = (): void => {
      if (settled) return; settled = true;
      resolve({ status: response.statusCode ?? 0, statusText: response.statusMessage ?? '', ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        url: target.url.href, headers: response.headers, body: Buffer.concat(chunks), truncated });
    };
    response.on('data', (raw: Buffer) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) { truncated = true; response.destroy(); return; }
      const kept = chunk.subarray(0, remaining); chunks.push(kept); bytes += kept.length;
      if (kept.length < chunk.length) { truncated = true; response.destroy(); }
    });
    response.on('end', finish); response.on('close', finish); response.on('error', (error) => truncated ? finish() : reject(error));
  });
  request.on('error', reject);
  const signal = init.signal;
  const abort = (): void => { request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted')); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) request.write(init.body);
    else { request.destroy(new Error('unsupported_request_body')); return promise; }
  }
  request.end();
  return promise.finally(() => signal?.removeEventListener('abort', abort));
}

/**
 * `timeoutMs` 覆盖整次抓取（DNS + 全部重定向跳），因为 `http.request` 默认**没有任何超时**：
 * 目标主机不回 SYN、或者连上之后一个字节都不发时，这个 promise 永远不 settle。调用它的
 * `web_fetch` 又是在一轮对话里同步等着的，唯一兜底是 10 分钟的 `concurrency.turnTimeoutMs`
 * —— 用户看到的就是 bot 收了消息然后再也不说话（logs/2026-08-17 有多轮死在这一类等待上）。
 */
export async function guardedFetch(raw: string, init: RequestInit = {}, policy: OutboundPolicy): Promise<GuardedResponse> {
  const deadline = policy.timeoutMs ? AbortSignal.timeout(policy.timeoutMs) : null;
  const signal = deadline ? (init.signal ? AbortSignal.any([init.signal, deadline]) : deadline) : init.signal;
  let target = await safeTarget(raw, policy, signal);
  let headers = new Headers(init.headers);
  const maxRedirects = policy.maxRedirects ?? 3;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await requestOnce(target, { ...init, headers, signal: signal ?? null }, policy.maxBytes ?? 2_097_152);
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const locationValue = response.headers.location;
    const location = Array.isArray(locationValue) ? locationValue[0] : locationValue;
    if (!location || redirects === maxRedirects) throw new Error('too_many_redirects');
    const next = await safeTarget(new URL(location, target.url).href, policy, signal);
    if (next.url.origin !== target.url.origin) headers = new Headers([...headers].filter(([key]) => !AUTH_HEADER.test(key)));
    target = next;
  }
  throw new Error('redirect_error');
}
