import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { untrusted } from '@luoli/shared';

function privateAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split('%')[0]!;
  if (normalized.startsWith('::ffff:')) {
    const tail = normalized.slice(7);
    if (isIP(tail) === 4) return privateAddress(tail);
    const [high, low] = tail.split(':').map((part) => Number.parseInt(part || '0', 16));
    if (Number.isFinite(high) && Number.isFinite(low)) return privateAddress(`${(high! >>> 8) & 255}.${high! & 255}.${(low! >>> 8) & 255}.${low! & 255}`);
    return true;
  }
  if (normalized === '::1' || normalized === '0.0.0.0' || normalized === '::') return true;
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0] = normalized.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}
interface SafeTarget { url: URL; address: string; family: 4 | 6 }
async function safeTarget(raw: string): Promise<SafeTarget> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (privateAddress(hostname)) throw new Error('ssrf_blocked');
    return { url, address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error('ssrf_blocked');
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

function pinnedRequest(target: SafeTarget, maxBytes: number, abortSignal: AbortSignal): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const lookupPinned: LookupFunction = (_hostname, _options, callback) => callback(null, target.address, target.family);
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, { method: 'GET', headers: { Host: target.url.host, 'User-Agent': 'LuoLiCore/0.1' }, lookup: lookupPinned, ...(target.url.protocol === 'https:' ? { servername: target.url.hostname } : {}) }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0; let truncated = false;
      response.on('data', (chunk: Buffer) => {
        if (bytes >= maxBytes) { truncated = true; response.destroy(); return; }
        const remaining = maxBytes - bytes; const value = chunk.subarray(0, remaining); chunks.push(value); bytes += value.length;
        if (value.length < chunk.length) { truncated = true; response.destroy(); }
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8'), truncated }));
      response.on('close', () => { if (truncated) resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8'), truncated }); });
      response.on('error', reject);
    });
    request.on('error', reject);
    if (abortSignal.aborted) request.destroy(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('aborted'));
    else abortSignal.addEventListener('abort', () => request.destroy(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('aborted')), { once: true });
    request.end();
  });
}
export async function webSearch(provider: 'brave' | 'serper' | 'tavily', apiKey: string, query: string, limit: number, abortSignal: AbortSignal): Promise<Record<string, unknown>> {
  if (!apiKey) return { ok: false, error: 'web_search_key_missing' };
  const target = provider === 'brave' ? `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}` : provider === 'serper' ? 'https://google.serper.dev/search' : 'https://api.tavily.com/search';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: string | undefined;
  if (provider === 'brave') headers['x-subscription-token'] = apiKey;
  else if (provider === 'serper') { headers['x-api-key'] = apiKey; body = JSON.stringify({ q: query, num: limit }); }
  else body = JSON.stringify({ api_key: apiKey, query, max_results: limit });
  const response = await fetch(target, { method: provider === 'brave' ? 'GET' : 'POST', headers, ...(body ? { body } : {}), signal: abortSignal });
  if (!response.ok) return { ok: false, error: `search_http_${response.status}` };
  const raw = await response.json() as Record<string, unknown>;
  const values = provider === 'brave' ? (raw.web as { results?: unknown[] } | undefined)?.results : provider === 'serper' ? raw.organic : raw.results;
  return { ok: true, provider, results: Array.isArray(values) ? values.slice(0, limit) : [], content: untrusted(`search:${provider}`, JSON.stringify(values ?? [])) };
}

export async function webFetch(raw: string, maxBytes: number, abortSignal: AbortSignal): Promise<Record<string, unknown>> {
  let target = await safeTarget(raw);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await pinnedRequest(target, maxBytes, abortSignal);
    if (response.status >= 300 && response.status < 400) {
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location || redirects === 3) return { ok: false, error: 'too_many_redirects' };
      target = await safeTarget(new URL(location, target.url).href);
      continue;
    }
    return { ok: response.status >= 200 && response.status < 300, status: response.status, url: target.url.href, content: untrusted(`web:${target.url.hostname}`, response.text), truncated: response.truncated };
  }
  return { ok: false, error: 'redirect_error' };
}
