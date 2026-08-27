import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ModelRegistry, ProviderStore, Secrets, aliasSettingsSchema, retryDelay } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

describe('provider retry policy', () => {
  it('honors retry-after and caps exponential backoff', () => {
    expect(retryDelay(0, 12_000, 1000, 30_000)).toBe(12_000);
    expect(retryDelay(10, null, 1000, 30_000)).toBeLessThanOrEqual(30_000);
    expect(retryDelay(1, null, 1000, 30_000)).toBeGreaterThanOrEqual(1600);
  });

  /**
   * AC-PROV-016 / docs/20 · W-PROV-01。旧实现拿 `sha256(String(attempt))` 当抖动源 —— 对同一个
   * attempt 它是**常量**，于是并发的几十次重试全退避到同一毫秒再一起打过去，等于没有抖动。
   * 判据因此是「同一个 attempt 反复求值互不相同」，光断区间是断不出这个 bug 的。
   */
  it('同一个 attempt 反复求值互不相同：抖动是真随机，不是 attempt 的函数', () => {
    const samples = Array.from({ length: 200 }, () => retryDelay(3, null, 1000, 30_000));
    expect(new Set(samples).size).toBeGreaterThan(50);
    // 真随机也得留在这一档的合法区间里（基数 ±20%），否则「抖动」就成了乱数。
    const base = 1000 * 2 ** 3;
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(base * 0.8);
    expect(Math.max(...samples)).toBeLessThanOrEqual(base * 1.2);
  });

  it('estimates reservations from configured input and output prices', () => {
    const registry = Object.create(ModelRegistry.prototype) as ModelRegistry;
    expect(registry.estimateModel({ priceIn: 2, priceOut: 10, maxOutput: 2000 }, 4000)).toBeCloseTo(0.018, 12);
    expect(registry.estimateModel({ priceIn: null, priceOut: 10, maxOutput: 2000 }, 4000)).toBeNull();
  });
});

describe('alias sampling settings', () => {
  it('rejects keys outside the whitelist and values outside the documented ranges', () => {
    expect(aliasSettingsSchema.safeParse({ temperature: 0.7, reasoning: 'high' }).success).toBe(true);
    expect(aliasSettingsSchema.safeParse({ temperature: 3 }).success).toBe(false);
    expect(aliasSettingsSchema.safeParse({ reasoning: 'insane' }).success).toBe(false);
    expect(aliasSettingsSchema.safeParse({ maxOutputTokens: 1.5 }).success).toBe(false);
    expect(aliasSettingsSchema.safeParse({ providerOptions: { anthropic: {} } }).success).toBe(false);
  });

  it('binds settings to the alias the model actually came from', () => {
    const path = './data/provider-alias.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','p','openai-compatible','http://127.0.0.1:9/v1',1,?,?)").run(now, now);
    db.prepare("INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,enabled,created_at,updated_at) VALUES('m','p','test-model',128000,8192,'{}',1,?,?)").run(now, now);
    const insertAlias = db.prepare('INSERT INTO model_aliases(alias,model_ids_json,settings_json,updated_at) VALUES (?,?,?,?)');
    insertAlias.run('main', JSON.stringify(['m']), JSON.stringify({ temperature: 0.3 }), now);
    insertAlias.run('low', JSON.stringify(['m']), JSON.stringify({ temperature: 1, maxOutputTokens: 512 }), now);
    insertAlias.run('title', JSON.stringify(['m']), '{"temperature":"hot"}', now);
    const registry = new ModelRegistry(db, new ProviderStore(db, new Secrets('x'.repeat(32))));
    registry.rebuild();
    expect(registry.settings('main')).toEqual({ temperature: 0.3 });
    expect(registry.settings('low')).toEqual({ temperature: 1, maxOutputTokens: 512 });
    // 未配置的别名解析到 main 的模型，参数也必须是 main 的，不能串到别的别名上。
    expect(registry.settings('vision')).toEqual({ temperature: 0.3 });
    // 脏行只丢参数，不能让整个别名连模型一起消失。
    expect(registry.settings('title')).toEqual({});
    expect(registry.aliases()).toContain('title');
    closeDatabase(db);
  });
});
