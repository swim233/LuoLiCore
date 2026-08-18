import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink } from '@luoli/core';

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
