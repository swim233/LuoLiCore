import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

describe('structured log pipeline', () => {
  it('filters levels, rotates files, and splits large payloads into blobs', () => {
    const database = './data/log-pipeline.test.db'; const directory = './data/log-pipeline-logs';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true }); rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
    const db = openDatabase(database); migrateDatabase(db); const operations = new OperationsRepository(db);
    const log = new LogSink(operations, directory, [], { level: 'info', maxFileMb: 0.00005, bodyMaxBytes: 32, console: 'off' });
    expect(log.event({ level: 'debug', kind: 'debug.hidden', summary: 'hidden' })).toBe(0);
    log.event({ level: 'info', kind: 'system.test', summary: 'large', data: { value: 'x'.repeat(100) } });
    log.event({ level: 'info', kind: 'system.test', summary: 'rotate', data: { value: 'y'.repeat(100) } });
    log.close();
    const day = new Date().toISOString().slice(0, 10); const entries = readdirSync(resolve(directory, day));
    expect(entries.some((name) => name.startsWith('system.jsonl.'))).toBe(true);
    const latest = readFileSync(resolve(directory, day, 'system.jsonl'), 'utf8'); expect(latest).toContain('fileRef');
    expect(operations.logs(10).every((entry) => (entry as { level: string }).level !== 'debug')).toBe(true);
    closeDatabase(db);
  });

  /**
   * 大载荷这条路有两个半边，两边都成立才算数（docs/10 §3）：写入侧把原文挪进
   * `logs/<day>/blobs/*.json`、行里只留 `{fileRef,bytes}` —— 不挪的话一条带请求体的
   * `model.call` 就能把 `log_events` 撑爆；**读出侧必须顺着 `fileRef` 解引用** ——
   * 不解引用的话日志页点开一行看到的就是那个占位对象，「到底往上游发了什么」等于丢了。
   */
  it('大 payload 落独立文件、行里只留 file_ref，日志页顺着引用把原文懒加载回来', async () => {
    const database = './data/log-blobref.test.db'; const directory = './data/log-blobref-logs';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true }); rmSync(directory, { recursive: true, force: true });
    const db = openDatabase(database); migrateDatabase(db); const operations = new OperationsRepository(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid' }, logs: { dir: directory, bodyMaxBytes: 512 } });
    const log = new LogSink(operations, directory, [], { bodyMaxBytes: config.logs.bodyMaxBytes, console: 'off' });
    const payload = { request: { body: { model: 'gpt', input: 'x'.repeat(4000) } } };
    const small = log.event({ level: 'info', kind: 'model.call', summary: '没超阈值', data: { request: { body: { input: 'hi' } } } });
    const big = log.event({ level: 'info', kind: 'model.call', summary: '超了阈值', data: payload });
    log.close();
    const row = (id: number): { data: string; ref: string | null } =>
      db.prepare('SELECT data_json AS data,file_ref AS ref FROM log_events WHERE id=?').get(id) as { data: string; ref: string | null };
    // `file_ref` 那一列必须真的被写上：照 doc 03 的 DDL 去查库的人只认这一列，只藏在 data_json 里
    // 等于「没有 file_ref 就是没有大载荷」。行内载荷只剩引用本身。
    const stored = row(big);
    expect(stored.ref).toMatch(/^\d{4}-\d{2}-\d{2}\/blobs\/.+\.json$/);
    expect(JSON.parse(stored.data)).toEqual({ fileRef: stored.ref, bytes: Buffer.byteLength(JSON.stringify(payload)) });
    expect(stored.data).not.toContain('xxxx');
    // 阈值以下的不挪：多一次文件 IO、多一个要按 retentionDays 清理的文件，都是白付的。
    expect(stored.ref).not.toBe(row(small).ref); expect(row(small).ref).toBeNull();
    expect(JSON.parse(row(small).data)).toEqual({ request: { body: { input: 'hi' } } });
    // 独立文件里躺的是**原文**，一字不差 —— 落盘时截过一次，排障要看的那份就永远拿不回来了。
    expect(JSON.parse(readFileSync(resolve(directory, stored.ref!), 'utf8'))).toEqual(payload);
    // 懒加载那条路：日志页点开一行（`GET /api/logs/:id`）与「复制完整载荷」（`…/data`）都要给
    // 解引用之后的正文。列表刻意不带载荷，所以这两条是界面上唯一能看到它的地方。
    const events = new EventBus(); const archive = new ArchiveRepository(db);
    const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
      providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
      maintenance: new MaintenanceService(db, database, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
    const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}` };
    const detail = (await (await app.request(`/api/logs/${big}`, { headers })).json() as { data: { text: string; bytes: number; fileRef: string } }).data;
    expect(detail.fileRef).toBe(stored.ref);
    expect(JSON.parse(detail.text)).toEqual(payload);
    expect(await (await app.request(`/api/logs/${big}/data`, { headers })).json()).toEqual(payload);
    closeDatabase(db);
  });

  /**
   * 入库失败**不许往外抛**。`log.event` 的调用点全在 catch 块、`.catch()` 回调和 `main.ts` 的
   * crash handler 里，让它抛等于把「日志写不进去」升级成「轮次失败」，再升级成
   * 「crash handler 自己抛、`process.exit(1)` 走不到」。用关库来造这个条件 —— 这正是关停竞态里
   * 会真的发生的那一幕：`poller.drain()` 宽限期用完就返回，在途 handler 之后才 settle，
   * 那时 `closeDatabase` 已经跑过（docs/10 §6）。
   */
  it('入库失败时返回 0 而不抛，且告警回调只被叫一次（不打转）', () => {
    const database = './data/log-dbfail.test.db'; const directory = './data/log-dbfail-logs';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true }); rmSync(directory, { recursive: true, force: true });
    const db = openDatabase(database); migrateDatabase(db);
    const log = new LogSink(new OperationsRepository(db), directory, [], { level: 'info', console: 'off' });
    const failures: unknown[] = [];
    // 真实装配里这个回调是 `alerts.fire('db_write_failed')`，而 `AlertDispatcher.raise()` 第一件事
    // 就是再记一行 `alert.raised` —— 库坏了这一路会绕回 LogSink。照那个形状复现一次。
    log.onWriteFailure = (error) => { failures.push(error); log.event({ level: 'error', kind: 'alert.raised', summary: 're-entry' }); };
    expect(log.event({ level: 'info', kind: 'system.test', summary: 'before close' })).toBeGreaterThan(0);
    closeDatabase(db);
    expect(() => log.event({ level: 'error', kind: 'turn.end', summary: 'after close' })).not.toThrow();
    expect(log.event({ level: 'error', kind: 'turn.end', summary: 'again' })).toBe(0);
    // 两次 event 各报一次；重入的那一次被闸住，否则这里会是 4 条甚至无限。
    expect(failures).toHaveLength(2);
    // 落盘那一路不受库影响：排障时至少还有 JSONL。
    const day = new Date().toISOString().slice(0, 10);
    expect(readFileSync(resolve(directory, day, 'turn.jsonl'), 'utf8')).toContain('after close');
    log.close();
  });
});
