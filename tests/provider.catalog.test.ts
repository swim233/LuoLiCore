import { rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema, probeProvider } from '@luoli/core';
import { createServer } from '@luoli/server';

const GOOD_KEY = 'sk-good-key-0123456789abcdef';

/** 真实的上游：探测走的是 fetch，用本地 http server 才能覆盖鉴权头、状态码与响应体形状。 */
const upstream = createHttpServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const send = (status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (url.pathname === '/v1/models') {
    if (request.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(401, { error: { message: `invalid key, sent ${request.headers.authorization}` } });
    return send(200, { object: 'list', data: [{ id: 'gpt-mini', object: 'model' }, { id: 'gpt-large', object: 'model' }, { id: 'gpt-mini', object: 'model' }] });
  }
  if (url.pathname === '/anthropic/v1/models') {
    if (request.headers['x-api-key'] !== GOOD_KEY || request.headers['anthropic-version'] !== '2023-06-01') return send(401, { error: 'bad key' });
    return send(200, { data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }], has_more: false });
  }
  if (url.pathname === '/google/v1beta/models') {
    if (request.headers['x-goog-api-key'] !== GOOD_KEY) return send(403, { error: 'bad key' });
    return send(200, { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }] });
  }
  if (url.pathname === '/nogateway/models') return send(404, { error: 'not found' });
  if (url.pathname === '/html/models') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<html>login</html>'); }
  return send(404, { error: 'unknown' });
});
let base = '';
beforeAll(async () => { await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise<void>((resolve) => { upstream.close(() => resolve()); }); });

function harness() {
  const path = './data/provider-catalog.test.db'; for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db); const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' }, provider: { allowPrivateBaseUrl: true } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations); const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  const provider = async (name: string, kind: string, suffix: string, apiKey: string): Promise<string> => {
    const created = await app.request('/api/providers', { method: 'POST', headers, body: JSON.stringify({ name, kind, baseUrl: `${base}${suffix}`, apiKey }) });
    return (await created.json() as { data: { id: string } }).data.id;
  };
  return { app, db, headers, provider };
}

describe('provider connectivity probe', () => {
  it('reports latency and model count, and restores health_state on success', async () => {
    const { app, db, headers, provider } = harness();
    const id = await provider('local', 'openai-compatible', '/v1', GOOD_KEY);
    db.prepare("UPDATE providers SET health_state='down',health_error='previous failure' WHERE id=?").run(id);
    const response = await app.request(`/api/providers/${id}/test`, { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(200);
    const data = (await response.json() as { data: { reachable: boolean; code: string; models: number; latencyMs: number } }).data;
    expect(data).toMatchObject({ reachable: true, code: 'ok', models: 2 });
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
    expect(db.prepare('SELECT health_state,health_error FROM providers WHERE id=?').get(id)).toEqual({ health_state: 'up', health_error: null });
    closeDatabase(db);
  });

  it('marks only auth failures down and never echoes the key', async () => {
    const { app, db, headers, provider } = harness();
    const bad = await provider('bad-key', 'openai-compatible', '/v1', 'sk-wrong-key-0123456789abcdef');
    const rejected = await app.request(`/api/providers/${bad}/test`, { method: 'POST', headers, body: '{}' });
    const body = await rejected.text();
    expect(JSON.parse(body).data).toMatchObject({ reachable: false, code: 'unauthorized', status: 401 });
    expect(body).not.toContain('sk-wrong-key');
    expect(db.prepare('SELECT health_state FROM providers WHERE id=?').pluck().get(bad)).toBe('down');
    // 网关没有 /models 不等于对话不可用：不能因此把 provider 摘掉，否则整条 fallback 链被打断。
    const missing = await provider('no-catalog', 'openai-compatible', '/nogateway', GOOD_KEY);
    const notFound = await app.request(`/api/providers/${missing}/test`, { method: 'POST', headers, body: '{}' });
    expect((await notFound.json() as { data: { code: string } }).data.code).toBe('not_found');
    expect(db.prepare('SELECT health_state,health_checked_at FROM providers WHERE id=?').get(missing)).toMatchObject({ health_state: null });
    expect(db.prepare('SELECT health_checked_at FROM providers WHERE id=?').pluck().get(missing)).toBeGreaterThan(0);
    closeDatabase(db);
  });

  it('tests draft credentials without touching stored health', async () => {
    const { app, db, headers, provider } = harness();
    const id = await provider('draft', 'openai-compatible', '/nogateway', 'sk-wrong-key-0123456789abcdef');
    const response = await app.request(`/api/providers/${id}/test`, { method: 'POST', headers, body: JSON.stringify({ kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: GOOD_KEY }) });
    expect((await response.json() as { data: { reachable: boolean } }).data.reachable).toBe(true);
    expect(db.prepare('SELECT health_state,health_checked_at FROM providers WHERE id=?').get(id)).toEqual({ health_state: null, health_checked_at: null });
    closeDatabase(db);
  });
});

describe('model catalog import', () => {
  it('lists upstream models and imports the selected ones exactly once', async () => {
    const { app, db, headers, provider } = harness();
    const id = await provider('local', 'openai-compatible', '/v1', GOOD_KEY);
    const listed = await app.request(`/api/providers/${id}/models`, { headers: { cookie: headers.cookie } });
    const models = (await listed.json() as { data: { models: Array<{ modelId: string }> } }).data.models;
    expect(models.map((model) => model.modelId)).toEqual(['gpt-large', 'gpt-mini']);
    const payload = JSON.stringify({ providerId: id, models, contextWindow: 200_000, maxOutput: 16_384 });
    const first = await app.request('/api/models/import', { method: 'POST', headers, body: payload });
    expect((await first.json() as { data: { inserted: number; skipped: number } }).data).toMatchObject({ inserted: 2, skipped: 0 });
    const again = await app.request('/api/models/import', { method: 'POST', headers, body: payload });
    expect((await again.json() as { data: { inserted: number; skipped: number } }).data).toMatchObject({ inserted: 0, skipped: 2 });
    expect(db.prepare('SELECT COUNT(*) FROM models WHERE provider_id=?').pluck().get(id)).toBe(2);
    // 定价必须留空（docs/04 §5.5 不自动抓取），窗口用请求里的默认值。
    expect(db.prepare("SELECT context_window,max_output,price_in,price_out FROM models WHERE model_id='gpt-mini'").get())
      .toEqual({ context_window: 200_000, max_output: 16_384, price_in: null, price_out: null });
    closeDatabase(db);
  });

  it('rejects malformed imports and unknown providers', async () => {
    const { app, db, headers, provider } = harness();
    const id = await provider('local', 'openai-compatible', '/v1', GOOD_KEY);
    expect((await app.request('/api/models/import', { method: 'POST', headers, body: JSON.stringify({ providerId: 'nope', models: [{ modelId: 'x' }] }) })).status).toBe(404);
    expect((await app.request('/api/models/import', { method: 'POST', headers, body: JSON.stringify({ providerId: id, models: [] }) })).status).toBe(400);
    expect((await app.request('/api/models/import', { method: 'POST', headers, body: JSON.stringify({ providerId: id, models: [{ displayName: 'no id' }] }) })).status).toBe(400);
    expect((await app.request('/api/models/import', { method: 'POST', headers, body: JSON.stringify({ providerId: id, models: Array.from({ length: 201 }, (_, index) => ({ modelId: `m${index}` })) }) })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) FROM models').pluck().get()).toBe(0);
    closeDatabase(db);
  });

  it('surfaces upstream failures as 502 instead of an empty catalog', async () => {
    const { app, headers, db, provider } = harness();
    const html = await provider('html', 'openai-compatible', '/html', GOOD_KEY);
    const response = await app.request(`/api/providers/${html}/models`, { headers: { cookie: headers.cookie } });
    expect(response.status).toBe(502);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('invalid_response');
    closeDatabase(db);
  });
});

describe('probe normalization', () => {
  it('reads anthropic display names and google token limits', async () => {
    const anthropic = await probeProvider({ name: 'anthropic', kind: 'anthropic', baseUrl: `${base}/anthropic/v1` }, GOOD_KEY, 15_000, true);
    expect(anthropic.models).toEqual([{ modelId: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: null, maxOutput: null }]);
    const google = await probeProvider({ name: 'google', kind: 'google', baseUrl: `${base}/google/v1beta` }, GOOD_KEY, 15_000, true);
    expect(google.models).toEqual([{ modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1_048_576, maxOutput: 65_536 }]);
    const wrongHeader = await probeProvider({ name: 'google', kind: 'google', baseUrl: `${base}/google/v1beta` }, 'sk-nope-0123456789abcdef', 15_000, true);
    expect(wrongHeader).toMatchObject({ reachable: false, code: 'unauthorized', status: 403 });
  });

  it('fails closed when the base url or the upstream is missing', async () => {
    expect(await probeProvider({ name: 'gateway', kind: 'openai-compatible', baseUrl: '' }, GOOD_KEY)).toMatchObject({ reachable: false, code: 'missing_base_url' });
    const dead = await probeProvider({ name: 'dead', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }, GOOD_KEY, 2000, true);
    expect(dead.code === 'network' || dead.code === 'timeout').toBe(true);
    expect(dead.models).toEqual([]);
  });

  /**
   * 被本机出网策略拦下与「上游不可达」必须分成两个 code：周期健康检查据 `network` 计入连续失败，
   * 而推理路径走 AI SDK 自己的 fetch、根本不过 `guardedFetch` 这道守卫 —— 混成一个的话，一个跑在
   * 私网上、对话完全正常的自建 provider 会被健康检查判成 `down`（`docs/04 §5.3`）。
   */
  it('separates outbound-policy rejections from unreachable upstreams', async () => {
    const blocked = await probeProvider({ name: 'local', kind: 'openai-compatible', baseUrl: `${base}/v1` }, GOOD_KEY, 2000);
    expect(blocked).toMatchObject({ reachable: false, code: 'blocked', status: null });
    expect(blocked.message).toContain('provider.allowPrivateBaseUrl');
    expect(await probeProvider({ name: 'local', kind: 'openai-compatible', baseUrl: `${base}/v1` }, GOOD_KEY, 2000, true)).toMatchObject({ reachable: true, code: 'ok' });
  });
});
