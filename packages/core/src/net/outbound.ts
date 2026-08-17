import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
import { isIP, type LookupFunction } from 'node:net';

const DEFAULT_PORTS = new Set([80, 443, 8080, 8443]);
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)$/i;

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

interface SafeTarget { url: URL; address: string; family: 4 | 6 }
async function safeTarget(raw: string, policy: OutboundPolicy): Promise<SafeTarget> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.allowPrivate && !(policy.allowedPorts ?? DEFAULT_PORTS).has(port)) throw new Error('port_blocked');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (!policy.allowPrivate && privateAddress(hostname)) throw new Error('ssrf_blocked');
    return { url, address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true });
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
export interface OutboundPolicy { allowPrivate: boolean; allowedPorts?: ReadonlySet<number>; maxRedirects?: number; maxBytes?: number }

function requestOnce(target: SafeTarget, init: RequestInit, maxBytes: number): Promise<GuardedResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<GuardedResponse>();
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = target.url.host;
  const lookupPinned: LookupFunction = (_hostname, _options, callback) => callback(null, target.address, target.family);
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

export async function guardedFetch(raw: string, init: RequestInit = {}, policy: OutboundPolicy): Promise<GuardedResponse> {
  let target = await safeTarget(raw, policy);
  let headers = new Headers(init.headers);
  const maxRedirects = policy.maxRedirects ?? 3;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await requestOnce(target, { ...init, headers }, policy.maxBytes ?? 2_097_152);
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const locationValue = response.headers.location;
    const location = Array.isArray(locationValue) ? locationValue[0] : locationValue;
    if (!location || redirects === maxRedirects) throw new Error('too_many_redirects');
    const next = await safeTarget(new URL(location, target.url).href, policy);
    if (next.url.origin !== target.url.origin) headers = new Headers([...headers].filter(([key]) => !AUTH_HEADER.test(key)));
    target = next;
  }
  throw new Error('redirect_error');
}
