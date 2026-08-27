import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase, readAppKv } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ModelCatalog, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

const model = (over: Record<string, unknown>): Record<string, unknown> => ({
  name: 'M', attachment: true, reasoning: true, tool_call: true, structured_output: true, temperature: true,
  modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200_000, output: 32_000 }, ...over,
});
/** 一份缩微的 models.dev 目录：厂商自家条目、网关条目、只有第三方托管的模型各一组。 */
const CATALOG = {
  anthropic: { id: 'anthropic', name: 'Anthropic', models: {
    'claude-opus-5': model({ name: 'Claude Opus 5', reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }, limit: { context: 400_000, output: 64_000 },
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }, knowledge: '2026-01-01', release_date: '2026-02-02' }),
  } },
  openrouter: { id: 'openrouter', name: 'OpenRouter', api: 'https://openrouter.ai/api/v1', models: {
    'anthropic/claude-opus-5': model({ cost: { input: 5.5, output: 27 } }),
    'deepseek/deepseek-legacy': model({ limit: { context: 64_000, output: 8000 }, cost: { input: 0.4, output: 1.2 } }),
  } },
  novita: { id: 'novita', name: 'Novita', api: 'https://api.novita.ai/v3/openai', models: {
    'deepseek/deepseek-legacy': model({ limit: { context: 64_000, output: 8000 }, cost: { input: 0.2, output: 0.9 } }),
  } },
  deepseek: { id: 'deepseek', name: 'DeepSeek', api: 'https://api.deepseek.com', models: {
    'deepseek-chat': model({ reasoning: false, reasoning_options: [{ type: 'toggle' }], cost: { input: 0.3, output: 1.1 } }),
  } },
};

let payload = JSON.stringify(CATALOG);
let etag = `"${createHash('md5').update(payload).digest('hex')}"`;
let requests = 0;
let conditionals = 0;
let failing = false;
const upstream = createHttpServer((request, response) => {
  requests += 1;
  if (failing) { response.writeHead(503); return response.end('nope'); }
  if (request.headers['if-none-match']) {
    conditionals += 1;
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, { etag }); return response.end(); }
  }
  response.writeHead(200, { 'content-type': 'application/json', etag });
  response.end(payload);
});
let base = '';
beforeAll(async () => { await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise<void>((resolve) => { upstream.close(() => resolve()); }); });

const CACHE = './data/model-catalog.test.json';
function harness(over: Record<string, unknown> = {}) {
  const path = './data/model-catalog.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(CACHE, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' },
    provider: { catalog: { url: `${base}/api.json`, cacheFile: CACHE, ttlHours: 24, timeoutMs: 5000, ...over } } });
  const catalog = new ModelCatalog(db, () => ({ ...config.provider.catalog, allowPrivate: true }));
  return { db, config, catalog };
}

beforeEach(() => { payload = JSON.stringify(CATALOG); etag = `"${createHash('md5').update(payload).digest('hex')}"`; requests = 0; conditionals = 0; failing = false; });

describe('models.dev 目录缓存', () => {
  it('缺缓存时拉一次、TTL 内不再出网、过期后走条件请求', async () => {
    const { db, catalog } = harness();
    const first = await catalog.ensure();
    expect(first.outcome).toBe('fetched');
    expect(first.index?.modelCount).toBe(5);
    expect(existsSync(CACHE)).toBe(true);
    expect(requests).toBe(1);
    expect(readAppKv<{ etag: string; models: number }>(db, 'catalog:models.dev')?.etag).toBe(etag);

    // 命中缓存的路径一次网络都不碰 —— 每开一次「拉取模型」就下 3.7MB 是这个功能最容易犯的错。
    expect((await catalog.ensure()).outcome).toBe('hit');
    expect(requests).toBe(1);

    // 把 fetchedAt 推回 TTL 之外：内容没变时上游只回 304，本地那份原封不动继续用。
    const state = readAppKv<Record<string, unknown>>(db, 'catalog:models.dev')!;
    db.prepare('UPDATE app_kv SET value_json=? WHERE key=?').run(JSON.stringify({ ...state, fetchedAt: Date.now() - 48 * 3_600_000 }), 'catalog:models.dev');
    const stamp = readFileSync(CACHE, 'utf8');
    const revalidated = await catalog.ensure();
    expect(revalidated.outcome).toBe('not-modified');
    expect(conditionals).toBe(1);
    expect(readFileSync(CACHE, 'utf8')).toBe(stamp);
    expect(revalidated.index?.modelCount).toBe(5);
    closeDatabase(db);
  });

  it('force 刷新拿到新内容会覆盖缓存', async () => {
    const { db, catalog } = harness();
    await catalog.ensure();
    payload = JSON.stringify({ ...CATALOG, deepseek: { id: 'deepseek', name: 'DeepSeek', models: {} } });
    etag = `"${createHash('md5').update(payload).digest('hex')}"`;
    const refreshed = await catalog.ensure(true);
    expect(refreshed.outcome).toBe('fetched');
    expect(refreshed.index?.modelCount).toBe(4);
    expect(catalog.status().models).toBe(4);
    closeDatabase(db);
  });

  it('出网失败时降级用旧缓存，没有缓存才报不可用', async () => {
    const { db, catalog } = harness();
    await catalog.ensure();
    failing = true;
    const degraded = await catalog.ensure(true);
    expect(degraded.outcome).toBe('stale');
    expect(degraded.index?.modelCount).toBe(5);
    expect(degraded.error).toContain('503');
    expect(catalog.status().error).toContain('503');

    const fresh = harness();
    const dead = await fresh.catalog.ensure();
    expect(dead.outcome).toBe('unavailable');
    expect(dead.index).toBeNull();
    expect(fresh.catalog.status().available).toBe(false);
    closeDatabase(fresh.db);
    closeDatabase(db);
  });

  it('缓存文件被写坏时重新拉取而不是一直失败', async () => {
    const { db, catalog } = harness();
    await catalog.ensure();
    writeFileSync(CACHE, '{"anthropic":', 'utf8');
    const recovered = await catalog.ensure();
    expect(recovered.outcome).toBe('fetched');
    expect(recovered.index?.modelCount).toBe(5);
    closeDatabase(db);
  });

  it('关掉之后既不出网也不返回目录', async () => {
    const { db, catalog } = harness({ enabled: false });
    const load = await catalog.ensure();
    expect(load.outcome).toBe('disabled');
    expect(load.index).toBeNull();
    expect(requests).toBe(0);
    closeDatabase(db);
  });
});

describe('模型元数据匹配', () => {
  it('provider 对得上就用它自报价，对不上退回厂商官方价', async () => {
    const { db, catalog } = harness();
    const { index } = await catalog.ensure();

    const first = catalog.lookup(index, { kind: 'anthropic', baseUrl: null }, 'claude-opus-5');
    expect(first.match).toBe('provider');
    expect(first.priceIn).toBe(5);
    expect(first.contextWindow).toBe(400_000);
    expect(first.maxOutput).toBe(64_000);
    expect(first.capabilities).toMatchObject({ vision: true, tools: true, reasoning: true, structuredOutput: true });
    expect(first.reasoningControl).toBe('effort');
    expect(first.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(first.modalities.input).toEqual(['text', 'image', 'pdf']);

    // 网关自己在目录里有条目：用它的报价，因为这才是实际被扣的钱。
    const gateway = catalog.lookup(index, { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, 'anthropic/claude-opus-5');
    expect(gateway.match).toBe('provider');
    expect(gateway.catalogProviderId).toBe('openrouter');
    expect(gateway.priceIn).toBe(5.5);

    // 自建中转：目录里没有这家，退回厂商官方价而不是随便挑一家网关的报价。
    const relay = catalog.lookup(index, { kind: 'openai-compatible', baseUrl: 'https://gw.internal/v1' }, 'claude-opus-5');
    expect(relay.match).toBe('official');
    expect(relay.catalogProviderId).toBe('anthropic');
    expect(relay.priceIn).toBe(5);
    expect(catalog.lookup(index, { kind: 'openai-compatible', baseUrl: 'https://gw.internal/v1' }, 'anthropic/claude-opus-5').priceIn).toBe(5);
    closeDatabase(db);
  });

  it('厂商侧查不到时价格留空，只给窗口能力与第三方价区间', async () => {
    const { db, catalog } = harness();
    const { index } = await catalog.ensure();
    const meta = catalog.lookup(index, { kind: 'openai-compatible', baseUrl: 'https://gw.internal/v1' }, 'deepseek/deepseek-legacy');
    expect(meta.match).toBe('third-party');
    // 990 个跨 provider 同名模型里 649 个价格不同：拿哪一家的都是猜，只能把区间摆出来让 owner 填。
    expect(meta.priceIn).toBeNull();
    expect(meta.priceOut).toBeNull();
    expect(meta.priceRange).toEqual({ min: 0.2, max: 0.4, providers: 2 });
    expect(meta.contextWindow).toBe(64_000);
    expect(meta.capabilities.vision).toBe(true);
    closeDatabase(db);
  });

  it('剥掉日期与 :free 后缀再匹配，完全查不到时如实报 none', async () => {
    const { db, catalog } = harness();
    const { index } = await catalog.ensure();
    const dated = catalog.lookup(index, { kind: 'anthropic', baseUrl: null }, 'claude-opus-5-20260202');
    expect(dated.match).toBe('provider');
    expect(dated.normalized).toBe(true);
    expect(dated.catalogModelId).toBe('claude-opus-5');
    expect(catalog.lookup(index, { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, 'deepseek/deepseek-legacy:free').match).toBe('provider');

    const unknown = catalog.lookup(index, { kind: 'openai-compatible', baseUrl: 'https://gw.internal/v1' }, 'nobody-ever-shipped-this');
    expect(unknown.match).toBe('none');
    expect(unknown.priceIn).toBeNull();
    expect(unknown.contextWindow).toBeNull();
    // 目录不可用时不能凭空造元数据：整行都是空的，界面据此提示手填。
    expect(catalog.lookup(null, { kind: 'anthropic', baseUrl: null }, 'claude-opus-5').match).toBe('none');
    closeDatabase(db);
  });
});

describe('WebUI 拉取与导入链路', () => {
  function server(catalog: ModelCatalog, db: ReturnType<typeof openDatabase>, config: ReturnType<typeof configSchema.parse>) {
    const operations = new OperationsRepository(db); const events = new EventBus();
    const log = new LogSink(operations, './data/model-catalog-logs'); const archive = new ArchiveRepository(db);
    const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
      providers: new ProviderStore(db, new Secrets('x'.repeat(32))), modelCatalog: catalog, approvals: new DatabaseApprovalBroker(db, config, events, log),
      maintenance: new MaintenanceService(db, './data/model-catalog.test.db', 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
    const session = operations.createSession(1);
    return { app, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
  }

  it('导入时带上目录里的价格与能力，价格来源如实记录', async () => {
    const { db, config, catalog } = harness();
    const { app, headers } = server(catalog, db, config);
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','relay','openai-compatible','https://gw.internal/v1',1,?,?)").run(now, now);
    const imported = await app.request('/api/models/import', { method: 'POST', headers, body: JSON.stringify({ providerId: 'p',
      models: [{ modelId: 'claude-opus-5', contextWindow: 400_000, maxOutput: 64_000, priceIn: 5, priceOut: 25, priceCacheRead: 0.5, priceCacheWrite: 6.25 },
        { modelId: 'deepseek/deepseek-legacy', contextWindow: 64_000, maxOutput: 8000 }] }) });
    expect(imported.status).toBe(200);
    expect((await imported.json() as { data: { inserted: number; priced: number } }).data).toMatchObject({ inserted: 2, priced: 1 });
    const rows = db.prepare('SELECT model_id AS modelId,price_in AS priceIn,capabilities_json AS capabilities FROM models ORDER BY model_id').all() as Array<{ modelId: string; priceIn: number | null; capabilities: string }>;
    const opus = rows.find((row) => row.modelId === 'claude-opus-5')!;
    expect(opus.priceIn).toBe(5);
    const block = JSON.parse(opus.capabilities) as Record<string, unknown> & { catalog: Record<string, unknown> };
    expect(block).toMatchObject({ vision: true, tools: true, reasoning: true, reasoningControl: 'effort' });
    expect(block.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(block.catalog).toMatchObject({ source: 'models.dev', match: 'official', providerId: 'anthropic', priceSource: 'official' });
    // 只有第三方托管价的那条：价格留空，但区间要留在元数据里，界面才有东西可提示。
    const legacy = rows.find((row) => row.modelId === 'deepseek/deepseek-legacy')!;
    expect(legacy.priceIn).toBeNull();
    expect((JSON.parse(legacy.capabilities) as { catalog: { priceRange: unknown; priceSource: unknown } }).catalog).toMatchObject({ priceRange: { min: 0.2, max: 0.4, providers: 2 }, priceSource: null });
    closeDatabase(db);
  });

  // 「已有价格 = 人手填的」这个假定是错的：导入时从目录带进来的价格同样非空。按下 [补齐元数据] 之后
  // 数字一个没动，出处却从「厂商官方价」被静默改写成「手工填写」，且旧值没留 —— AC-WEB-013c 要的
  // 那份「这价能不能信」一键归零（docs/29 · M-WEB-09）。
  it('补齐元数据不把导入来的定价出处改写成 manual', async () => {
    const { db, config, catalog } = harness();
    const { app, headers } = server(catalog, db, config);
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','relay','openai-compatible','https://gw.internal/v1',1,?,?)").run(now, now);
    await app.request('/api/models/import', { method: 'POST', headers, body: JSON.stringify({ providerId: 'p',
      models: [{ modelId: 'claude-opus-5', contextWindow: 400_000, maxOutput: 64_000, priceIn: 5, priceOut: 25 }] }) });
    const sourceOf = (): unknown => (JSON.parse((db.prepare('SELECT capabilities_json AS capabilities FROM models').get() as { capabilities: string }).capabilities) as { catalog: { priceSource: unknown } }).catalog.priceSource;
    expect(sourceOf()).toBe('official');
    await app.request('/api/models/enrich', { method: 'POST', headers, body: JSON.stringify({}) });
    expect(sourceOf()).toBe('official');
    closeDatabase(db);
  });

  it('补齐已有模型只填空着的价格，手改价之后来源翻成 manual', async () => {
    const { db, config, catalog } = harness();
    const { app, headers } = server(catalog, db, config);
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','relay','openai-compatible','https://gw.internal/v1',1,?,?)").run(now, now);
    db.prepare("INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,enabled,sort,created_at,updated_at) VALUES('m1','p','claude-opus-5',128000,8192,'{}',NULL,1,0,?,?)").run(now, now);
    db.prepare("INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at) VALUES('m2','p','deepseek-chat',128000,8192,'{}',9.9,9.9,1,0,?,?)").run(now, now);
    const enriched = await app.request('/api/models/enrich', { method: 'POST', headers, body: JSON.stringify({}) });
    expect((await enriched.json() as { data: unknown }).data).toMatchObject({ scanned: 2, updated: 2, priced: 1, unmatched: 0 });
    const rows = db.prepare('SELECT id,context_window AS contextWindow,price_in AS priceIn,capabilities_json AS capabilities FROM models ORDER BY id').all() as Array<{ id: string; contextWindow: number; priceIn: number | null; capabilities: string }>;
    expect(rows[0]!.priceIn).toBe(5);
    // 窗口是运维可能按预算调小过的，不给 overwrite 就不动。
    expect(rows[0]!.contextWindow).toBe(128_000);
    // 已经手填过价格的那行不被覆盖，来源标 manual（这行的能力块是空的，从没记过出处 = 只可能是手填的）。
    expect(rows[1]!.priceIn).toBe(9.9);
    expect((JSON.parse(rows[1]!.capabilities) as { catalog: { priceSource: string } }).catalog.priceSource).toBe('manual');

    await app.request('/api/models/enrich', { method: 'POST', headers, body: JSON.stringify({ ids: ['m1'], overwrite: true }) });
    expect((db.prepare('SELECT context_window AS contextWindow FROM models WHERE id=?').get('m1') as { contextWindow: number }).contextWindow).toBe(400_000);

    await app.request('/api/models/m1', { method: 'PATCH', headers, body: JSON.stringify({ priceIn: 4.2 }) });
    const patched = db.prepare('SELECT capabilities_json AS capabilities FROM models WHERE id=?').get('m1') as { capabilities: string };
    expect((JSON.parse(patched.capabilities) as { catalog: { priceSource: string } }).catalog.priceSource).toBe('manual');
    closeDatabase(db);
  });

  // 「补齐元数据」把能力块整块按目录重写 —— 人工标的看图能力必须盖回去。不盖的话一次补齐就把
  // 运维对中转站撒谎的修正静默撤销了，而含图轮次会立刻回到那个看不见图的模型上（docs/21 §10）。
  it('补齐元数据不撤销人工标的看图能力', async () => {
    const { db, config, catalog } = harness();
    const { app, headers } = server(catalog, db, config);
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','relay','openai-compatible','https://gw.internal/v1',1,?,?)").run(now, now);
    db.prepare("INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,enabled,sort,created_at,updated_at) VALUES('m1','p','claude-opus-5',128000,8192,'{}',1,0,?,?)").run(now, now);
    await app.request('/api/models/enrich', { method: 'POST', headers, body: JSON.stringify({}) });
    // 目录说这个模型能看图。
    expect((JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m1') as string) as { vision: boolean }).vision).toBe(true);
    await app.request('/api/models/m1', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: false } }) });
    await app.request('/api/models/enrich', { method: 'POST', headers, body: JSON.stringify({}) });
    const kept = JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m1') as string) as Record<string, unknown>;
    expect(kept).toMatchObject({ vision: false, manual: { vision: false } });
    // 其余能力位照旧按目录刷新，标记只钉住它自己那一位。
    expect(kept).toMatchObject({ tools: true, reasoningControl: 'effort' });
    expect((kept.catalog as { match: string }).match).toBe('official');
    closeDatabase(db);
  });

  it('目录状态端点报出缓存年龄，刷新失败但有旧缓存时仍然可用', async () => {
    const { db, config, catalog } = harness();
    const { app, headers } = server(catalog, db, config);
    await catalog.ensure();
    const status = await (await app.request('/api/models/catalog', { headers })).json() as { data: { available: boolean; models: number; stale: boolean } };
    expect(status.data).toMatchObject({ available: true, models: 5, stale: false });
    failing = true;
    const refreshed = await app.request('/api/models/catalog/refresh', { method: 'POST', headers, body: '{}' });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json() as { data: { outcome: string; error: string } }).data.outcome).toBe('stale');
    closeDatabase(db);
  });
});
