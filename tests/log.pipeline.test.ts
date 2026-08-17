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
});
