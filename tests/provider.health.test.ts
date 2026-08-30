import { rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, ModelRegistry, PROVIDER_FAILURES_TO_DOWN, ProviderStore, Secrets, runProviderHealthCheck } from '@luoli/core';

/**
 * `docs/04 §5.3` 最后一条：每 `provider.healthCheckCron` 对启用的 provider 探一次模型目录接口
 * （`GET {baseUrl}/models`，不发补全），连续失败 3 次标 `down` 并从 fallback 链跳过，30 分钟后自动重试。
 * **这一整条以前没有实现**（`docs/13 · AC-PROV-008` 却勾着 `[x]`，点名的 `provider.catalog.test.ts`
 * 只测手工「测试连接」端点）。少了它的代价见 `logs/2026-08-18`：ksm-api 变黑洞之后三个轮次各在开轮
 * 363 秒后才 fallback（`3 × requestTimeoutMs` + 退避），一轮 600 秒的预算最多够走一步，
 * 全部以「太久没有进展」收尾。
 */

/** 探测走的是 fetch，用本地 http server 才能覆盖状态码、响应体形状与「连上了但不返回」。 */
type Route = (request: IncomingMessage, response: ServerResponse) => void;
const routes = new Map<string, Route>();
const pending = new Set<ServerResponse>();
const upstream = createHttpServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const route = routes.get(url.pathname.split('/')[1] ?? '');
  pending.add(response); response.on('close', () => pending.delete(response));
  if (route) return route(request, response);
  response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'unknown provider' }));
});
let base = '';
beforeAll(async () => { await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`; });
// 挂起那一路的响应永远不 end，不掐掉的话 `close()` 等不回来。
afterAll(async () => { for (const response of pending) response.destroy(); await new Promise<void>((resolve) => { upstream.close(() => resolve()); }); });

const json = (status: number, body: unknown): Route => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
};
const CATALOG = json(200, { object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] });
/** 连上了但不返回 —— 这一整节要防的那种故障，判据是探测在 `timeoutMs` 到点后自己收场。 */
const HANG: Route = () => undefined;

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-logs`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const providers = new ProviderStore(db, new Secrets('x'.repeat(32)));
  const log = new LogSink(new OperationsRepository(db));
  const registry = new ModelRegistry(db, providers);
  const now = Date.now();
  /** 同一个 provider 挂第二个模型（一份凭据下多个模型是常态）。 */
  const addModel = (providerId: string, modelId: string, rowId = `${providerId}:${modelId}`): string => {
    db.prepare(`INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,128000,4096,'{}',1,2,1,0,?,?)`).run(rowId, providerId, modelId, now, now);
    return rowId;
  };
  /** provider 名同时是上游路径的第一段（`baseUrl` = `${base}/<名字>`），`sweep` 按名字给它挂路由。 */
  const provider = (providerName: string): string =>
    providers.save({ name: providerName, kind: 'openai-compatible', baseUrl: `${base}/${providerName}`, apiKey: `sk-${providerName}-0123456789abcdef` });
  /** 一个 provider + 一个模型；`modelId` 可以重复（同一个模型名挂在两个 provider 下是常态）。 */
  const add = (providerName: string, modelId: string): { providerId: string; rowId: string } => {
    const providerId = provider(providerName);
    return { providerId, rowId: addModel(providerId, modelId, `${providerName}:${modelId}`) };
  };
  const alias = (aliasName: string, rowIds: string[]): void => {
    db.prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)').run(aliasName, JSON.stringify(rowIds), now);
  };
  const state = (providerId: string): { health_state: string | null; health_fail_count: number } =>
    db.prepare('SELECT health_state,health_fail_count FROM providers WHERE id=?').get(providerId) as { health_state: string | null; health_fail_count: number };
  const check = (allowPrivate: boolean, timeoutMs: number, keyFor = (providerId: string): string | null => providers.key(providerId)) =>
    runProviderHealthCheck({ db, log, keyFor }, { timeoutMs, failuresToDown: PROVIDER_FAILURES_TO_DOWN, allowPrivate });
  const sweep = async (behaviors: Record<string, Route>, timeoutMs = 300): Promise<void> => {
    routes.clear();
    for (const [providerName, route] of Object.entries(behaviors)) routes.set(providerName, route);
    await check(true, timeoutMs);
  };
  return { db, providers, registry, add, addModel, provider, alias, state, check, sweep, close: (): void => closeDatabase(db) };
}

const chainIds = (registry: ModelRegistry, alias: string): string[] => registry.chain(alias).map((candidate) => candidate.info.id);

describe('provider health check', () => {
  it('标 down 只在连续失败到阈值之后，并且把它从 fallback 链里摘掉', async () => {
    const bed = harness('provider-health-down');
    const dead = bed.add('dead-gateway', 'deepseek-v4-flash');
    const alive = bed.add('healthy', 'grok-4.5');
    bed.alias('main', [dead.rowId, alive.rowId]);
    bed.registry.rebuild(30);
    expect(chainIds(bed.registry, 'main')).toEqual([dead.rowId, alive.rowId]);

    // 前两次只累计，`health_state` 一动不动：一次网络抖动不该让 provider 从链里消失。
    for (const attempt of [1, 2]) {
      await bed.sweep({ 'dead-gateway': HANG, healthy: CATALOG });
      expect(bed.state(dead.providerId)).toEqual({ health_state: null, health_fail_count: attempt });
      bed.registry.rebuild(30);
      expect(chainIds(bed.registry, 'main')).toEqual([dead.rowId, alive.rowId]);
    }

    await bed.sweep({ 'dead-gateway': HANG, healthy: CATALOG });
    expect(bed.state(dead.providerId)).toEqual({ health_state: 'down', health_fail_count: PROVIDER_FAILURES_TO_DOWN });
    // 健康的那个每次都被写回 up，计数保持 0 —— 探测本身不该给它留下痕迹。
    expect(bed.state(alive.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    bed.registry.rebuild(30);
    expect(chainIds(bed.registry, 'main')).toEqual([alive.rowId]);
    // 已经不在链里的候选照样要能被判成 down：调用路径上那个 `isDown` 判的正是这些。
    expect(bed.registry.isDown({ id: 'deepseek-v4-flash', rowId: dead.rowId })).toBe(true);
    expect(bed.registry.isDown({ id: 'grok-4.5', rowId: alive.rowId })).toBe(false);
    bed.close();
  });

  it('中间成功一次就归零，不会攒够三次', async () => {
    const bed = harness('provider-health-reset');
    const flaky = bed.add('flaky', 'm1');
    bed.alias('main', [flaky.rowId]);
    await bed.sweep({ flaky: json(502, { error: 'bad gateway' }) });
    await bed.sweep({ flaky: json(502, { error: 'bad gateway' }) });
    expect(bed.state(flaky.providerId).health_fail_count).toBe(2);
    await bed.sweep({ flaky: CATALOG });
    expect(bed.state(flaky.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    // 归零之后再失败一次只累计：`health_state` 还是上一次成功写下的 up，因为 `health_checked_at`
    // 是冷却期的起点，够不到阈值就提前推它会让真的 down 之后那 30 分钟算错。
    await bed.sweep({ flaky: json(502, { error: 'bad gateway' }) });
    expect(bed.state(flaky.providerId)).toEqual({ health_state: 'up', health_fail_count: 1 });
    bed.close();
  });

  it('答了话就不计入：没有 /models 的自建网关不该被判死', async () => {
    const bed = harness('provider-health-4xx');
    const picky = bed.add('picky', 'm1');
    bed.alias('main', [picky.rowId]);
    // 404（网关不实现模型目录）、400（参数不合）、200 但不是 JSON（登录页）三档都只说明上游在响应。
    const answers: Route[] = [json(404, { error: 'not found' }), json(400, { error: 'bad request' }),
      (_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>login</html>'); }];
    for (const answer of [...answers, ...answers]) {
      await bed.sweep({ picky: answer });
      expect(bed.state(picky.providerId)).toEqual({ health_state: null, health_fail_count: 0 });
    }
    // 还要把计数**归零**：不然「目录接口常年 404 + 调用路径偶尔攒一次超时」几天下来也能凑够三次。
    bed.registry.recordFailure({ id: 'm1', rowId: picky.rowId }, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN);
    bed.registry.recordFailure({ id: 'm1', rowId: picky.rowId }, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN);
    await bed.sweep({ picky: json(404, { error: 'not found' }) });
    expect(bed.state(picky.providerId)).toEqual({ health_state: null, health_fail_count: 0 });
    bed.close();
  });

  it('认证被拒当场标 down，不等三次', async () => {
    const bed = harness('provider-health-auth');
    const bad = bed.add('bad-key', 'm1');
    bed.alias('main', [bad.rowId]);
    await bed.sweep({ 'bad-key': json(401, { error: 'invalid api key' }) });
    expect(bed.state(bad.providerId)).toEqual({ health_state: 'down', health_fail_count: 1 });
    bed.close();
  });

  // 判据不能退回补全：那样每个 provider 每 10 分钟一次真实推理请求，且要求它已经配了启用模型。
  it('探测不发补全：上游只收到一次 GET /models', async () => {
    const bed = harness('provider-health-no-inference');
    const watched = bed.add('watched', 'm1');
    const seen: Array<{ method: string; path: string }> = [];
    await bed.sweep({ watched: (request, response) => { seen.push({ method: request.method ?? '', path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname }); CATALOG(request, response); } });
    expect(seen).toEqual([{ method: 'GET', path: '/watched/models' }]);
    expect(bed.state(watched.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    bed.close();
  });

  it('不依赖启用模型：一个模型都没配的 provider 同样会被探', async () => {
    const bed = harness('provider-health-nomodels');
    const orphan = bed.provider('orphan');
    bed.registry.rebuild(30);
    await bed.sweep({ orphan: CATALOG });
    expect(bed.state(orphan)).toEqual({ health_state: 'up', health_fail_count: 0 });
    await bed.sweep({ orphan: json(401, { error: 'invalid api key' }) });
    expect(bed.state(orphan)).toEqual({ health_state: 'down', health_fail_count: 1 });
    bed.close();
  });

  it('API Key 解不开时跳过，不拿一次无凭据的探测把 provider 判死', async () => {
    const bed = harness('provider-health-nokey');
    const broken = bed.add('broken', 'm1');
    routes.clear(); routes.set('broken', json(401, { error: 'invalid api key' }));
    const outcomes = await bed.check(true, 300, () => { throw new Error('unable to decrypt'); });
    expect(outcomes).toMatchObject([{ state: 'skipped', code: 'no_master_key', counted: false }]);
    expect(bed.state(broken.providerId)).toEqual({ health_state: null, health_fail_count: 0 });
    bed.close();
  });

  /**
   * 推理走 AI SDK 自己的 fetch，不过 `guardedFetch` 那道守卫：出网策略拦下探测，不代表这个
   * provider 对话不通。把它计入连续失败等于三个 cron 间隔之后摘掉一个完全可用的自建 provider。
   */
  it('被出网策略拦下时跳过，不计入连续失败', async () => {
    const bed = harness('provider-health-blocked');
    const local = bed.add('local', 'm1');
    routes.clear(); routes.set('local', CATALOG);
    for (const _ of [1, 2, 3])
      expect(await bed.check(false, 300)).toMatchObject([{ state: 'skipped', code: 'blocked', counted: false }]);
    expect(bed.state(local.providerId)).toEqual({ health_state: null, health_fail_count: 0 });
    bed.close();
  });

  it('冷却期过了自己回到链里（30 分钟），并且把库里那一行也改回 up', async () => {
    const bed = harness('provider-health-cooldown');
    const dead = bed.add('dead', 'm1');
    bed.db.prepare("UPDATE providers SET health_state='down',health_checked_at=?,health_fail_count=3,health_error='request_timeout_15000ms' WHERE id=?").run(Date.now() - 31 * 60_000, dead.providerId);
    bed.alias('main', [dead.rowId]);
    // 还在冷却期内的那一行不探：探测的过滤条件与 `rebuild()` 同一份，否则只有目录接口活着的黑洞
    // 网关每个 cron 间隔就被探回 up 一次，30 分钟冷却形同虚设。
    await bed.sweep({ dead: CATALOG });
    expect(bed.state(dead.providerId)).toEqual({ health_state: 'down', health_fail_count: 3 });

    bed.db.prepare('UPDATE providers SET health_checked_at=? WHERE id=?').run(Date.now() - 31 * 60_000, dead.providerId);
    bed.registry.rebuild(30);
    expect(chainIds(bed.registry, 'main')).toEqual([dead.rowId]);
    expect(bed.registry.isDown({ id: 'm1', rowId: dead.rowId })).toBe(false);
    /**
     * **放行这件事必须写回库。** 只在内存里放行的话它带着 `health_fail_count=3` 承接真实流量，
     * 下一次超时（4 >= 3）当场再 down 30 分钟 —— 30 分 down / 一个 cron 间隔 up 地抖，而 WebUI
     * 全程显示 down。`health_error` 留着当「上次失败原因」给界面看。
     */
    expect(bed.state(dead.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    expect(bed.db.prepare('SELECT health_error FROM providers WHERE id=?').pluck().get(dead.providerId)).toBe('request_timeout_15000ms');
    // 而且这一次 rebuild 之后它就在探测范围内了 —— `main.ts` 的 `provider-health` 正是靠「先 rebuild
    // 再探」才能在同一 tick 里探到刚放回来的这个。
    await bed.sweep({ dead: CATALOG });
    expect(bed.db.prepare('SELECT health_error FROM providers WHERE id=?').pluck().get(dead.providerId)).toBeNull();
    bed.close();
  });
});

describe('provider failures reported from the call path', () => {
  // 10 分钟一次的探测最坏还要放 10 分钟的轮次去踩坑，所以真实调用的超时喂同一个计数器。
  // 目录接口探测更只能证明网关在答话：只答目录、补全挂起的那种故障只有这一路能发现。
  it('连续超时到阈值同样标 down，并且当场就能被 isDown 判出来', () => {
    const bed = harness('provider-failure-calls');
    const dead = bed.add('dead-gateway', 'deepseek-v4-flash');
    const alive = bed.add('healthy', 'grok-4.5');
    bed.alias('main', [dead.rowId, alive.rowId]);
    bed.registry.rebuild(30);
    const candidate = { id: 'deepseek-v4-flash', rowId: dead.rowId };
    expect(bed.registry.recordFailure(candidate, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN)).toBe(false);
    expect(bed.registry.recordFailure(candidate, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN)).toBe(false);
    expect(bed.registry.isDown(candidate)).toBe(false);
    expect(bed.registry.recordFailure(candidate, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN)).toBe(true);
    // 没有 rebuild：链还是老的（记账要能反查到服务这一步的那一行），但下一步不会再试它。
    expect(chainIds(bed.registry, 'main')).toEqual([dead.rowId, alive.rowId]);
    expect(bed.registry.isDown(candidate)).toBe(true);
    expect(bed.registry.isDown({ id: 'grok-4.5', rowId: alive.rowId })).toBe(false);
    bed.close();
  });

  /**
   * 「**连续**失败」少了归零就是「累计失败」：计数在库里、重启也不清，跨轮次零散攒够三次同样能
   * 判死一个一直在答话的 provider。归零的判据与探测那条一致 —— 上游服务成功一次就说明它活着。
   */
  it('服务成功一次就归零，并且当场放开这个 provider', () => {
    const bed = harness('provider-failure-served');
    const flaky = bed.add('flaky', 'm1');
    bed.alias('main', [flaky.rowId]);
    bed.registry.rebuild(30);
    const candidate = { id: 'm1', rowId: flaky.rowId };
    for (const _ of [1, 2]) bed.registry.recordFailure(candidate, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN);
    expect(bed.state(flaky.providerId).health_fail_count).toBe(2);
    bed.registry.recordSuccess(candidate);
    expect(bed.state(flaky.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    // 归零之后再攒两次仍够不到阈值。
    for (const _ of [1, 2]) expect(bed.registry.recordFailure(candidate, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN)).toBe(false);
    expect(bed.registry.isDown(candidate)).toBe(false);
    // 已经判死之后又服务成功（冷却到期放回来的那一路）：`#down` 也要跟着放开，否则这一轮里
    // 每一步都还在跳过一个已经好了的 provider。
    expect(bed.registry.recordFailure(candidate, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN)).toBe(true);
    expect(bed.registry.isDown(candidate)).toBe(true);
    bed.registry.recordSuccess(candidate);
    expect(bed.registry.isDown(candidate)).toBe(false);
    expect(bed.state(flaky.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    bed.close();
  });

  // 401/403 与「计数到阈值」跳过的粒度必须一样：只标命中那一行的话，同一份凭据下的第二个模型
  // 不被跳过 —— 而 401 在中间件里是短路 throw，这一轮白烧一次注定失败的往返还不会往下 fallback。
  it('认证被拒时该 provider 名下每个模型都被跳过，不只是命中的那一行', () => {
    const bed = harness('provider-failure-401-rows');
    const gateway = bed.add('gateway', 'model-a');
    const sibling = bed.addModel(gateway.providerId, 'model-b');
    const other = bed.add('other', 'model-c');
    bed.alias('main', [gateway.rowId, sibling, other.rowId]);
    bed.registry.rebuild(30);
    bed.registry.markProviderDown('model-a', 'unauthorized');
    expect(bed.registry.isDown({ id: 'model-a', rowId: gateway.rowId })).toBe(true);
    expect(bed.registry.isDown({ id: 'model-b', rowId: sibling })).toBe(true);
    expect(bed.registry.isDown({ id: 'model-c', rowId: other.rowId })).toBe(false);
    bed.close();
  });

  // 同一个 model_id 挂在两个 provider 下是常态（本部署 deepseek-v4-flash 就同时在 ksm-api 与
  // deepseek-official 上）。按名字反查会把健康的那一个判死 —— 标 down 是破坏性操作，只认行 id。
  it('同名模型不会连累另一个 provider', () => {
    const bed = harness('provider-failure-samename');
    const first = bed.add('gateway-a', 'deepseek-v4-flash');
    const second = bed.add('gateway-b', 'deepseek-v4-flash');
    bed.alias('main', [first.rowId, second.rowId]);
    bed.registry.rebuild(30);
    for (const _ of [1, 2, 3]) bed.registry.recordFailure({ id: 'deepseek-v4-flash', rowId: first.rowId }, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN);
    expect(bed.state(first.providerId).health_state).toBe('down');
    expect(bed.state(second.providerId).health_state).toBeNull();
    expect(bed.registry.isDown({ id: 'deepseek-v4-flash', rowId: second.rowId })).toBe(false);
    bed.close();
  });
});
