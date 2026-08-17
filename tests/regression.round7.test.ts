import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, FileTools, LogSink, MaintenanceService, MemoryStore, PathJail, ProviderStore, QuotaGuard, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';
import { estimateTextTokens } from '@luoli/shared';

/** 第七轮整改的回归用例：`docs/22 §4` 里那批「当前行为正确或影响有限」的条目，逐条钉住修法。 */

function server(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const logDir = `./data/${name}-logs`;
  rmSync(logDir, { recursive: true, force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' }, logs: { dir: logDir }, ...extra });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, logDir);
  const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30, logDir), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

const data = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;

describe('I-01 · 消息分页走 SQL', () => {
  it('第 21 页仍有内容，total 不封顶在 1000', async () => {
    const { app, db, headers } = server('round7-messages');
    const insert = db.prepare(`INSERT INTO messages(chat_id,tg_message_id,direction,from_kind,kind,text,raw_json,tg_date,received_at)
      VALUES ('c',?,'in','user','text',?,'{}',?,?)`);
    db.transaction(() => { for (let index = 1; index <= 1200; index += 1) insert.run(index, `m${index}`, index, index); })();
    // 旧实现：LIMIT 1000 拉回来再在内存里切 → 第 21 页（1001..1050）空，total 恒为 1000。
    const page21 = await data<{ total: number; items: unknown[] }>(await app.request('/api/messages?page=21&size=50', { headers: { cookie: headers.cookie } }));
    expect(page21.total).toBe(1200);
    expect(page21.items).toHaveLength(50);
    const page24 = await data<{ items: Array<{ text: string }> }>(await app.request('/api/messages?page=24&size=50', { headers: { cookie: headers.cookie } }));
    expect(page24.items).toHaveLength(50);
    // 按 tg_date DESC：第 24 页（1151..1200 条）落在最早的那批上。
    expect(page24.items.at(-1)?.text).toBe('m1');
    closeDatabase(db);
  });
});

describe('I-13 · 未匹配的 /api/* 返回 404 JSON', () => {
  it('不再落进 SPA 兜底拿到 200 + index.html', async () => {
    const { app, db, headers } = server('round7-api404');
    const response = await app.request('/api/no-such-endpoint', { headers: { cookie: headers.cookie } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json() as { error: { code: string } }).error.code).toBe('not_found');
    closeDatabase(db);
  });
});

describe('I-12 · CSP 补齐四条指令', () => {
  it('object-src / base-uri / form-action / frame-ancestors 都在', async () => {
    const { app, db } = server('round7-csp');
    const csp = (await app.request('/api/ping')).headers.get('content-security-policy') ?? '';
    for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) expect(csp).toContain(directive);
    closeDatabase(db);
  });
});

describe('I-06 · PUT /api/config 落库的是校验后的值', () => {
  it('zod 的强制转换进 config_kv，schema 外的路径当场拒掉', async () => {
    const { app, db, headers } = server('round7-config-write');
    // 单个标量键新旧实现存的是同一串（JSON 数字进出都是 3000），这条只是基线，不是判据。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'output.streamBufferMs': 3000 }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='output.streamBufferMs'").pluck().get()).toBe('3000');
    // 判据在这里：写祖先键时 zod 补出来的兄弟默认值必须一起落库。旧实现存的是请求体原值，
    // 于是 `config_kv` 里只有 `{"tokens":40000}`，下次启动重放覆盖层就把 messages 等键抹成默认 ——
    // 而运维在界面上看到的是「已保存」。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit': { tokens: 40_000 } }) })).status).toBe(200);
    const limit = JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='context.limit'").pluck().get() as string) as Record<string, unknown>;
    expect(limit.tokens).toBe(40_000);
    expect(Object.keys(limit).length).toBeGreaterThan(1);
    // 旧实现：schema 外的键照样落进 config_kv，等下次启动 loadConfig 再逐条剔除并告警。
    const unknown = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'general.nosuchkey': 1 }) });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe('unknown_config_key');
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='general.nosuchkey'").pluck().get()).toBe(0);
    closeDatabase(db);
  });

  // AC-CFG-012 此前**没有对应用例**：`/api/quota` 那条原型污染断言在，而 AC 点名的
  // `PUT /api/config` 那条没有。同一个 `mergeDotted`，但断言要落在 AC 说的那个端点上。
  it('AC-CFG-012 · __proto__ / constructor 键当场 400，且不污染 Object.prototype', async () => {
    const { app, db, headers } = server('round7-proto');
    for (const key of ['__proto__.polluted', 'constructor.polluted', 'general.__proto__.x', 'a.prototype.b']) {
      const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ [key]: 'x' }) });
      expect(response.status, key).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code, key).toBe('invalid_config_key');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // 污染发生在**校验之前**，一次请求就能让此后所有配置写入失败（docs/20 · W-CFG-01）——
    // 所以还要断言随后一个完全无关的合法写入仍然成功。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit.maxMessages': 180 }) })).status).toBe(200);
    closeDatabase(db);
  });
});

describe('I-03 · 读不到的条目跳过而不是整次失败', () => {
  it('一个断链软链不再让 list/glob/grep 返回 ok:false', () => {
    const root = resolve('./data/round7-files');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, 'real.txt'), 'needle\n');
    symlinkSync(resolve(root, 'gone.txt'), resolve(root, 'broken.txt'));
    const files = new FileTools(new PathJail(root, []), 4096, 4096);
    const list = files.list('.', 1) as { ok: boolean; entries: Array<{ path: string }>; skipped: number };
    expect(list.ok).toBe(true);
    expect(list.skipped).toBe(1);
    expect(list.entries.map((entry) => entry.path)).toContain('real.txt');
    const globbed = files.glob('*.txt', '.') as { ok: boolean; matches: string[]; skipped: number };
    expect(globbed.ok).toBe(true);
    expect(globbed.matches).toContain('real.txt');
    const grepped = files.grep('needle', '.') as { ok: boolean; matches: Array<{ path: string }>; skipped: number };
    expect(grepped.ok).toBe(true);
    expect(grepped.matches.map((match) => match.path)).toEqual(['real.txt']);
  });
});

describe('I-05 · 落盘前按新内容复核去重与硬上限', () => {
  it('别的轮次已经写进去的同一条不再重复落盘', () => {
    const database = './data/round7-memory.test.db';
    const directory = './data/round7-memory';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmSync(directory, { recursive: true, force: true });
    const db = openDatabase(database); migrateDatabase(db);
    const memory = new MemoryStore(db, directory, 100_000, 300_000, 12, 0);
    const write = (turnId: string) => memory.queueWrite({ scope: 'pubmemory', subject: null, section: '偏好',
      lines: ['他喝手冲不加糖'], actor: 'test', turnId, chatId: 'c', userId: 'u' }, 'owner', false, 'trusted');
    // 两轮各自在**同一份快照**上通过了去重（PUBMEMORY 是全局单份），随后先后落盘。
    write('t1'); write('t2');
    expect(memory.flush('t1')).toMatchObject({ documents: 1 });
    // 旧实现：t2 的判据取自 queueWrite 那一刻的空文档，于是同一条又写一遍。
    expect(memory.flush('t2')).toMatchObject({ documents: 0, duplicates: 1 });
    const lines = memory.read('pubmemory', null, 'owner').content.split('\n').filter((line) => line.includes('手冲'));
    expect(lines).toHaveLength(1);
    closeDatabase(db);
  });

  it('落盘时超过硬上限就整组跳过，不越过闸门', () => {
    const database = './data/round7-memory-limit.test.db';
    const directory = './data/round7-memory-limit';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmSync(directory, { recursive: true, force: true });
    const db = openDatabase(database); migrateDatabase(db);
    // 两条各自都装得下、加起来装不下。queueWrite 判的都是空文档那一刻的快照，所以两条都放行；
    // 谁先落盘谁写成，后落盘的那条在 flush 里才第一次看到「文档已经这么大了」。
    const bulk = 'X'.repeat(4000); const other = 'Y'.repeat(4000);
    const hardLimit = estimateTextTokens(bulk) + 200;
    const memory = new MemoryStore(db, directory, hardLimit, hardLimit, 12, 0);
    const queue = (turnId: string, section: string, line: string) => memory.queueWrite({ scope: 'pubmemory', subject: null, section,
      lines: [line], actor: 'test', turnId, chatId: 'c', userId: 'u' }, 'owner', false, 'trusted');
    expect(queue('t1', 'A', other)).toMatchObject({ ok: true, pending: true });
    expect(queue('t2', 'B', bulk)).toMatchObject({ ok: true, pending: true });
    expect(memory.flush('t2')).toMatchObject({ documents: 1 });
    // 旧实现：flush 不复核硬上限，这一条照样落盘，文档从此再也裁不回来。
    expect(memory.flush('t1')).toMatchObject({ documents: 0, rejected: 1 });
    expect(memory.read('pubmemory', null, 'owner').content).not.toContain(other);
    closeDatabase(db);
  });
});

describe('I-02 · quota_counters.turns 数的是轮次', () => {
  it('一轮里多步结算只 +1', () => {
    const path = './data/round7-quota.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const guard = new QuotaGuard(db, 'UTC');
    const reservation = guard.reserve({ chatId: 'c', userId: 'u', estimateUsd: 0.05,
      limits: { globalDaily: 10, globalMonthly: 100, chatDaily: 10, chatMonthly: 100, userDaily: 10, userMonthly: 100 } });
    expect(reservation).not.toBeNull();
    // 旧实现：commit 里 turns=turns+1，而 commit 是每一步之后都调的 → 这里会数成 6。
    for (let step = 0; step < 6; step += 1) guard.commit(reservation!, 0.001);
    expect(db.prepare("SELECT turns FROM quota_counters WHERE scope='global' AND window='day'").pluck().get()).toBe(1);
    // 六行（3 scope × 2 window）合成一条 UPDATE 之后，每一行的花费仍然对得上。
    expect(db.prepare("SELECT COUNT(*) FROM quota_counters WHERE cost_usd > 0").pluck().get()).toBe(6);
    guard.release(reservation!);
    closeDatabase(db);
  });
});

describe('I-09 · 孤儿 blob 真的被清理', () => {
  it('gcFiles 删没有 DB 行指向的文件、留下有行指向的', () => {
    const path = './data/round7-gc.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const filesDir = resolve('./data/round7-gc-files');
    const resultsDir = resolve('./data/round7-gc-results');
    for (const directory of [filesDir, resultsDir]) { rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true }); }
    const db = openDatabase(path); migrateDatabase(db);
    const kept = resolve(filesDir, 'kept.jpg');
    mkdirSync(resolve(filesDir, 'nested'), { recursive: true });
    writeFileSync(kept, 'x'.repeat(10));
    writeFileSync(resolve(filesDir, 'nested', 'orphan.jpg'), 'y'.repeat(20));
    const keptResult = resolve(resultsDir, 'run-kept.txt');
    writeFileSync(keptResult, 'summary');
    writeFileSync(resolve(resultsDir, 'run-orphan.txt'), 'nobody points here');
    db.prepare(`INSERT INTO messages(id,chat_id,tg_message_id,direction,from_kind,kind,raw_json,tg_date,received_at) VALUES (1,'c',1,'in','user','photo','{}',1,1)`).run();
    db.prepare(`INSERT INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,local_path,download_state,extract_state,created_at)
      VALUES ('a1',1,'c','photo','f','u',?, 'done','skipped',1)`).run(kept);
    db.prepare(`INSERT INTO agent_runs(id,turn_id,kind,agent_name,model_alias,effective_role,state,result_full_ref,started_at,finished_at)
      VALUES ('r1','t1','sub','a','main','owner','done',?,1,1)`).run(keptResult);
    const maintenance = new MaintenanceService(db, path, 2, 30, './data/round7-gc-logs', { files: filesDir, agentResults: resultsDir });
    // 旧实现：这个端点直接返回 not_implemented，两棵目录只涨不落。
    expect(maintenance.gcFiles()).toMatchObject({ files: 1, agentResults: 1, fileBytes: 20 });
    expect(maintenance.gcFiles()).toMatchObject({ files: 0, agentResults: 0 });
    // cleanup 按 logs.retentionDays 过期子 agent 全文，但**不动**媒体附件（docs/14 §2 Q9 未决）。
    db.prepare("UPDATE agent_runs SET finished_at=? WHERE id='r1'").run(Date.now() - 40 * 86_400_000);
    expect(maintenance.cleanup()).toMatchObject({ agentResults: 1 });
    expect(db.prepare("SELECT result_full_ref FROM agent_runs WHERE id='r1'").pluck().get()).toBeNull();
    expect(db.prepare("SELECT local_path FROM attachments WHERE id='a1'").pluck().get()).toBe(kept);
    closeDatabase(db);
  });
});
