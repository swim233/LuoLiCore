import { untrusted } from '@luoli/shared';
import { guardedFetch } from '../net/outbound.js';
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
  const response = await guardedFetch(raw, { method: 'GET', signal: abortSignal, headers: { 'user-agent': 'LuoLiCore/0.1' } }, { allowPrivate: false, maxBytes });
  return { ok: response.ok, status: response.status, url: response.url, content: untrusted(`web:${new URL(response.url).hostname}`, response.body.toString('utf8')), truncated: response.truncated };
}
