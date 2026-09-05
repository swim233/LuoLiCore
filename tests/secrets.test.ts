import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeIndex, source } from './support/source.js';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema, publicConfig, redact } from '@luoli/core';
import { createServer } from '@luoli/server';

/** 起一台真的服务器：缺主密钥时「界面上看得见什么」只有走端点才问得出来。 */
function harness(name: string, options: { masterKey?: string; config?: Record<string, unknown> } = {}) {
  const path = `./data/secrets-${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(`./data/secrets-${name}-logs`, { recursive: true, force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' }, memory: { dir: `./data/secrets-${name}-memory` }, ...options.config });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations); const archive = new ArchiveRepository(db);
  const providers = new ProviderStore(db, new Secrets(options.masterKey));
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers, approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, providers, headers };
}

describe('secret handling', () => {
  it('encrypts provider keys with randomized AES-GCM values', () => {
    const secrets = new Secrets('a'.repeat(32));
    const first = secrets.encrypt('sk-example-secret-value');
    const second = secrets.encrypt('sk-example-secret-value');
    expect(first).not.toBe(second);
    expect(first).not.toContain('sk-example');
    expect(secrets.decrypt(first)).toBe('sk-example-secret-value');
  });

  // 换 KDF 不能把已经存好的 provider key 变成解不开的垃圾（docs/20 · W-SEC-02）。
  it('still decrypts v1 ciphertext while writing v2', () => {
    const master = 'a'.repeat(32);
    const legacyKey = createHash('sha256').update(master).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const body = Buffer.concat([cipher.update('sk-legacy-value', 'utf8'), cipher.final()]);
    const legacy = `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
    const secrets = new Secrets(master);
    expect(Secrets.isLegacy(legacy)).toBe(true);
    expect(secrets.decrypt(legacy)).toBe('sk-legacy-value');
    const upgraded = secrets.encrypt('sk-legacy-value');
    expect(Secrets.isLegacy(upgraded)).toBe(false);
    expect(secrets.decrypt(upgraded)).toBe('sk-legacy-value');
    // 同一份明文两次加密的 salt 不同，密文自然也不同。
    expect(secrets.encrypt('sk-legacy-value')).not.toBe(upgraded);
    expect(new Secrets('short').weak).toBe(true);
    expect(secrets.weak).toBe(false);
  });

  /**
   * 缺 `LUOLI_MASTER_KEY` 是一种**降级运行**，不是拒绝启动：能改配置、能补密钥的地方正是 WebUI，
   * 起不来就没有能补的地方了（同 `main` 别名缺失那条先例）。所以三件事要同时成立：服务照常起、
   * provider 的密钥功能整个禁用、而禁用要**说出来**——「保存成功但那把 key 没存下」比报错糟得多。
   */
  it('runs without a master key while refusing to store provider keys in the clear', async () => {
    const { app, db, providers, headers } = harness('nomaster');
    const plaintext = 'sk-provider-plaintext-value';
    expect(providers.secretsAvailable).toBe(false);
    // 「没有主密钥」不是「主密钥太短」：后者才是 stderr 那条告警的判据。
    expect(new Secrets(undefined).weak).toBe(false);
    expect(providers.allDecryptedKeys()).toEqual([]);
    expect(() => providers.save({ name: 'openai', kind: 'openai', apiKey: plaintext })).toThrow(/LUOLI_MASTER_KEY/);
    // 服务本身照常在（列表读得到，只是空的），而不是整台 500。
    expect((await app.request('/api/providers', { headers: { cookie: headers.cookie } })).status).toBe(200);
    const response = await app.request('/api/providers', { method: 'POST', headers, body: JSON.stringify({ name: 'openai', kind: 'openai', apiKey: plaintext }) });
    expect(response.status).toBe(400);
    const error = (await response.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('provider_invalid');
    // 界面上的那句话必须点名环境变量，否则运维只知道「保存失败」。
    expect(error.message).toContain('LUOLI_MASTER_KEY');
    // 不出现明文落库：`save` 在 INSERT 之前就抛，那一行整个不存在。
    expect(providers.list()).toEqual([]);
    expect(JSON.stringify(db.prepare('SELECT * FROM providers').all())).not.toContain(plaintext);
    // 不带 key 的 provider 照常存得下（缺的是密钥能力，不是整块 provider 管理）。
    const bare = await app.request('/api/providers', { method: 'POST', headers, body: JSON.stringify({ name: 'local', kind: 'openai', baseUrl: 'https://api.example.com' }) });
    expect(bare.status).toBe(200);
    expect(db.prepare('SELECT api_key_enc FROM providers').pluck().get()).toBeNull();
    closeDatabase(db);
  });

  /**
   * scrypt 把离线爆破的单次成本抬到了 50–100ms，但那抬不动一个 8 位口令（docs/20 · W-SEC-02）。
   * `weak` 自己有单测（上一条），这里钉的是**接线**：判据要真的接到 stderr 上。只留一个没人读的
   * getter 的话，装置上那句告警一个字都不会出现，而库里全部 provider key 的强度就是那个口令。
   */
  it('warns on stderr when the master key is shorter than 32 characters', () => {
    expect(new Secrets('x'.repeat(31)).weak).toBe(true);
    expect(new Secrets('x'.repeat(32)).weak).toBe(false);
    // `Secrets` 的构造与这条判据都在 composeRuntime（apps/bot/src/compose.ts）里，main.ts 不再读它。
    const compose = source('apps/bot/src/compose.ts');
    const at = codeIndex(compose, 'secrets.weak');
    expect(at, 'compose.ts 不再读 secrets.weak —— 短口令从此一声不吭').toBeGreaterThan(0);
    const warning = compose.slice(at, at + 500);
    expect(warning, '判据读到了，但没往 stderr 写').toContain('process.stderr.write');
    expect(warning).toContain('LUOLI_MASTER_KEY');
    expect(warning, '告警得说清「多短算短」').toContain('32');
  });

  /**
   * `tools.web.searchApiKey`（docs/20 · W-SEC-01）。它曾经叫 `searchApiKeyRef` 而被当明文直接用 ——
   * 名字说是引用、行为是明文，两边都没错，合起来是运维以为自己配的是个引用。现在名字诚实了，
   * 代价是它**真的**明文躺在 `config.yaml` / `config_kv` 里，所以另外三件事必须都在：
   * doc 11 说明白、`GET /api/config` 脱敏、日志脱敏。
   */
  it('keeps the plaintext search key named honestly, documented, and redacted on the way out', async () => {
    const key = 'brave-plaintext-search-key';
    const web = configSchema.parse({}).tools.web;
    expect(Object.keys(web)).toContain('searchApiKey');
    expect(Object.keys(web).filter((name) => name.endsWith('Ref')), '`Ref` 后缀承诺的是引用语义，而这个值是明文').toEqual([]);
    const { app, db, headers } = harness('searchkey', { config: { tools: { web: { searchApiKey: key } } } });
    const rendered = await (await app.request('/api/config', { headers: { cookie: headers.cookie } })).json() as { data: { tools: { web: { searchApiKey: string } } } };
    expect(rendered.data.tools.web.searchApiKey).toBe('«redacted»');
    expect(JSON.stringify(rendered)).not.toContain(key);
    // 导出与变更历史走的是同一份 `publicConfig`，端点脱敏了而它没脱敏是分成两份判据的典型形态。
    const raw = configSchema.parse({ tools: { web: { searchApiKey: key } } });
    expect(JSON.stringify(raw), '合并后的配置里它本来就是明文 —— 上面那两条断言正是因此才有意义').toContain(key);
    expect(JSON.stringify(publicConfig(raw))).not.toContain(key);
    closeDatabase(db);
    // 日志侧：`redact` 只认它被喂进去的那份密钥表，所以两条 `log.setSecrets` 都得带上它 ——
    // 启动那次漏了 = 全程明文，热更新那次漏了 = 改过 key 之后开始明文。
    expect(redact({ url: `https://api.search.brave.com/res?token=${key}` }, [key]).url).not.toContain(key);
    // 两处 `log.setSecrets` 都在 composeRuntime（apps/bot/src/compose.ts）里：启动时一次，
    // `rebuildModels()` 热更新时一次，main.ts 不再直接调用它。
    const compose = source('apps/bot/src/compose.ts');
    const wired = [...compose.matchAll(/log\.setSecrets\(\[[^\]]*\]\)/g)].map((match) => match[0]);
    expect(wired.length, 'log.setSecrets 的调用点变了 —— 这条断言的锚点没了').toBe(2);
    for (const call of wired) expect(call, `这一处没把搜索 key 喂进脱敏表：${call}`).toMatch(/tools\.web\.searchApiKey/);
    // doc 11 那一格要自陈明文、给出 `${env:…}` 的写法，并说明读端会脱敏。
    const doc = readFileSync('docs/11-config-reference.md', 'utf8');
    const entry = doc.slice(doc.indexOf('searchApiKey:'), doc.indexOf('searchApiKey:') + 260);
    expect(entry, 'doc 11 没说它是明文存储').toContain('明文');
    expect(entry, 'doc 11 没给出 ${env:…} 的写法').toContain('${env:');
    expect(entry).toContain('脱敏');
  });

  it('redacts keys, bearer values, and Telegram tokens', () => {
    const value = redact({ openai: 'sk-abcdefghijklmnop', auth: 'Bearer topsecret', bot: '12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(JSON.stringify(value)).not.toContain('topsecret');
    expect(JSON.stringify(value)).not.toContain('abcdefghijklmnop');
  });

  it('preserves structural dimensions while redacting secret fields and values', () => {
    const value = redact({ key: 'chat:-100123', chatId: '-100123', traceId: 'trace-1', apiKey: 'visible-api-value', api_key: 'visible-api-value', token: 'visible-token', nested: { password: 'visible-password' }, text: 'sk-abcdefghijklmnop' });
    expect(value.key).toBe('chat:-100123');
    expect(value.chatId).toBe('-100123');
    expect(value.traceId).toBe('trace-1');
    expect(value.apiKey).toBe('«redacted»');
    expect(value.api_key).toBe('«redacted»');
    expect(value.token).toBe('«redacted»');
    expect(value.nested.password).toBe('«redacted»');
    expect(value.text).toBe('«redacted»');
  });
});
