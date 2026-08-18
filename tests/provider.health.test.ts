import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, ModelRegistry, PROVIDER_FAILURES_TO_DOWN, ProviderStore, Secrets, runProviderHealthCheck } from '@luoli/core';

/**
 * `docs/04 §5.3` 最后一条：每 `provider.healthCheckCron` 一次 1-token 探测，连续失败 3 次标 `down`
 * 并从 fallback 链跳过，30 分钟后自动重试。**这一整条以前没有实现**（`docs/13 · AC-PROV-008` 却勾着
 * `[x]`，点名的 `provider.catalog.test.ts` 只测手工「测试连接」端点）。少了它的代价见
 * `logs/2026-08-18`：ksm-api 变黑洞之后三个轮次各在开轮 363 秒后才 fallback
 * （`3 × requestTimeoutMs` + 退避），一轮 600 秒的预算最多够走一步，全部以「太久没有进展」收尾。
 */

const OK = { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };

function probe(run: () => unknown): LanguageModel {
  return { specificationVersion: 'v4', provider: 'test', modelId: 'probe', supportedUrls: {},
    doGenerate: async () => run() as never, doStream: async () => run() as never } as unknown as LanguageModel;
}

const status = (message: string, statusCode: number): Error => Object.assign(new Error(message), { statusCode });

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/${name}-logs`, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const providers = new ProviderStore(db, new Secrets('x'.repeat(32)));
  const log = new LogSink(new OperationsRepository(db), `./data/${name}-logs`);
  const registry = new ModelRegistry(db, providers);
  const now = Date.now();
  /** 一个 provider + 一个模型；`modelId` 可以重复（同一个模型名挂在两个 provider 下是常态）。 */
  const add = (providerName: string, modelId: string): { providerId: string; rowId: string } => {
    const providerId = providers.save({ name: providerName, kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: `sk-${providerName}-0123456789abcdef` });
    const rowId = `${providerName}:${modelId}`;
    db.prepare(`INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,128000,4096,'{}',1,2,1,0,?,?)`).run(rowId, providerId, modelId, now, now);
    return { providerId, rowId };
  };
  const alias = (aliasName: string, rowIds: string[]): void => {
    db.prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)').run(aliasName, JSON.stringify(rowIds), now);
  };
  const state = (providerId: string): { health_state: string | null; health_fail_count: number } =>
    db.prepare('SELECT health_state,health_fail_count FROM providers WHERE id=?').get(providerId) as { health_state: string | null; health_fail_count: number };
  const sweep = async (models: Record<string, () => unknown>, timeoutMs = 50): Promise<void> => {
    await runProviderHealthCheck({ db, log, keyFor: (providerId) => providers.key(providerId),
      models: { probeCandidate: (providerId) => (models[providerId] ? { model: probe(models[providerId]!), modelId: 'probe' } : null) } },
      { timeoutMs, failuresToDown: PROVIDER_FAILURES_TO_DOWN });
  };
  return { db, providers, registry, add, alias, state, sweep, close: (): void => closeDatabase(db) };
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
      await bed.sweep({ [dead.providerId]: () => new Promise(() => undefined), [alive.providerId]: () => OK });
      expect(bed.state(dead.providerId)).toEqual({ health_state: null, health_fail_count: attempt });
      bed.registry.rebuild(30);
      expect(chainIds(bed.registry, 'main')).toEqual([dead.rowId, alive.rowId]);
    }

    await bed.sweep({ [dead.providerId]: () => new Promise(() => undefined), [alive.providerId]: () => OK });
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
    await bed.sweep({ [flaky.providerId]: () => { throw status('bad gateway', 502); } });
    await bed.sweep({ [flaky.providerId]: () => { throw status('bad gateway', 502); } });
    expect(bed.state(flaky.providerId).health_fail_count).toBe(2);
    await bed.sweep({ [flaky.providerId]: () => OK });
    expect(bed.state(flaky.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    // 归零之后再失败一次只累计：`health_state` 还是上一次成功写下的 up，因为 `health_checked_at`
    // 是冷却期的起点，够不到阈值就提前推它会让真的 down 之后那 30 分钟算错。
    await bed.sweep({ [flaky.providerId]: () => { throw status('bad gateway', 502); } });
    expect(bed.state(flaky.providerId)).toEqual({ health_state: 'up', health_fail_count: 1 });
    bed.close();
  });

  it('4xx 不计入：上游答了话就说明它活着，参数/模型名的问题不该把整个 provider 判死', async () => {
    const bed = harness('provider-health-4xx');
    const picky = bed.add('picky', 'm1');
    bed.alias('main', [picky.rowId]);
    for (const _ of [1, 2, 3, 4]) await bed.sweep({ [picky.providerId]: () => { throw status('max_tokens must be >= 16', 400); } });
    expect(bed.state(picky.providerId)).toEqual({ health_state: null, health_fail_count: 0 });
    // 400 还要把计数**归零**：不然「探测模型常年 400 + 调用路径偶尔攒一次超时」几天下来也能凑够三次。
    bed.registry.recordFailure({ id: 'm1', rowId: picky.rowId }, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN);
    bed.registry.recordFailure({ id: 'm1', rowId: picky.rowId }, 'request_timeout_15000ms', PROVIDER_FAILURES_TO_DOWN);
    await bed.sweep({ [picky.providerId]: () => { throw status('max_tokens must be >= 16', 400); } });
    expect(bed.state(picky.providerId)).toEqual({ health_state: null, health_fail_count: 0 });
    bed.close();
  });

  it('认证被拒当场标 down，不等三次', async () => {
    const bed = harness('provider-health-auth');
    const bad = bed.add('bad-key', 'm1');
    bed.alias('main', [bad.rowId]);
    await bed.sweep({ [bad.providerId]: () => { throw status('invalid api key', 401); } });
    expect(bed.state(bad.providerId)).toEqual({ health_state: 'down', health_fail_count: 1 });
    bed.close();
  });

  it('冷却期过了自己回到链里（30 分钟）', () => {
    const bed = harness('provider-health-cooldown');
    const dead = bed.add('dead', 'm1');
    bed.db.prepare("UPDATE providers SET health_state='down',health_checked_at=?,health_fail_count=3 WHERE id=?").run(Date.now() - 31 * 60_000, dead.providerId);
    bed.alias('main', [dead.rowId]);
    bed.registry.rebuild(30);
    expect(chainIds(bed.registry, 'main')).toEqual([dead.rowId]);
    expect(bed.registry.isDown({ id: 'm1', rowId: dead.rowId })).toBe(false);
    bed.close();
  });

  it('探测的候选与别名无关：还没进任何别名的 provider 同样会被探', async () => {
    const bed = harness('provider-health-unaliased');
    const orphan = bed.add('orphan', 'm1');
    bed.registry.rebuild(30);
    expect(bed.registry.probeCandidate(orphan.providerId)?.modelId).toBe('m1');
    await bed.sweep({ [orphan.providerId]: () => OK });
    expect(bed.state(orphan.providerId)).toEqual({ health_state: 'up', health_fail_count: 0 });
    bed.close();
  });
});

describe('provider failures reported from the call path', () => {
  // 10 分钟一次的探测最坏还要放 10 分钟的轮次去踩坑，所以真实调用的超时喂同一个计数器。
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
