import { mkdirSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink } from '@luoli/core';

/**
 * 一个 span 只落一行，所以「开始时给的 data」和「结束时给的 data」必须都在那一行里。
 *
 * 此前 `end()` 把开始那份整体顶掉，于是 `tool.call` 的 `input` 一次都没进过库 ——
 * WebUI 的对话详情因此只有工具输出、没有工具输入。失败路径更糟：`end(undefined, error)`
 * 让那一行既没有输入也没有输出，排障时只剩「某个工具报错了」。
 */
function sink(name: string): { log: LogSink; db: ReturnType<typeof openDatabase>; close: () => void } {
  const database = `./data/${name}.test.db`; const directory = `./data/${name}-logs`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
  const db = openDatabase(database); migrateDatabase(db);
  return { log: new LogSink(new OperationsRepository(db), directory, [], { level: 'debug', console: 'off' }), db, close: () => { closeDatabase(db); } };
}

// 直查库而不走 `operations.logs()`：那个查询刻意不返回 `data_json`（列表一次上千行，
// 单条载荷能到 bodyMaxBytes），而这几条断言要看的正是载荷本身。
const payload = (db: ReturnType<typeof openDatabase>, kind: string): Record<string, unknown> => {
  const row = db.prepare('SELECT data_json AS data FROM log_events WHERE kind=? ORDER BY id LIMIT 1').get(kind) as { data: string | null } | undefined;
  return JSON.parse(row?.data ?? '{}') as Record<string, unknown>;
};

describe('LogSink.span 的载荷是开始与结束的合并', () => {
  it('工具调用的输入与输出落在同一行里', () => {
    const { log, db, close } = sink('log-span-merge');
    log.span({ level: 'info', kind: 'tool.call', summary: 'read_file', data: { input: { path: 'a.md' } } })
      .end({ output: { ok: true, bytes: 12 } });
    expect(payload(db, 'tool.call')).toEqual({ input: { path: 'a.md' }, output: { ok: true, bytes: 12 } });
    close();
  });

  it('失败的调用仍然保留自己的输入', () => {
    const { log, db, close } = sink('log-span-error');
    log.span({ level: 'info', kind: 'tool.call', summary: 'bash', data: { input: { command: 'false' } } })
      .end(undefined, new Error('exit 1'));
    // 关键是 input 还在：只有 `{error}` 的那一行说不出「它当时想干什么」。
    expect(payload(db, 'tool.call')).toEqual({ input: { command: 'false' }, error: 'exit 1' });
    close();
  });

  it('结束值不是对象时挂在 result 下，不顶掉开始那份', () => {
    const { log, db, close } = sink('log-span-scalar');
    log.span({ level: 'info', kind: 'model.call', summary: 'x/y', data: { stepNumber: 3, provider: 'x' } }).end('done');
    expect(payload(db, 'model.call')).toEqual({ stepNumber: 3, provider: 'x', result: 'done' });
    close();
  });

  it('结束时不给载荷也不会把开始那份抹掉', () => {
    const { log, db, close } = sink('log-span-empty');
    log.span({ level: 'info', kind: 'tg.api', summary: 'sendMessage', data: { method: 'sendMessage' } }).end();
    expect(payload(db, 'tg.api')).toEqual({ method: 'sendMessage' });
    close();
  });

  it('重复 end 只落一行', () => {
    const { log, db, close } = sink('log-span-once');
    const span = log.span({ level: 'info', kind: 'tool.call', summary: 'glob', data: { input: {} } });
    span.end({ output: 1 }); span.end({ output: 2 });
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='tool.call'").pluck().get()).toBe(1);
    close();
  });
});
