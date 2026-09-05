import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, MemoryStore } from '@luoli/core';
import { OperationsRepository } from '@luoli/db';

function harness() {
  const database = './data/memory-operations.test.db';
  const directory = './data/memory-operations-memory';
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  const log = new LogSink(new OperationsRepository(db));
  return { db, memory: new MemoryStore(db, directory, 100, 3000, 2, log) };
}

// T2.3 起 primemory 的 subject 是复合键 `telegram:<userId>`（`memoryScopeSubjects`）——
// `userId` 字段本身保持裸 id 不变（它落 revisions/来源标注/审计日志，不参与路径）。
describe('memory operations', () => {
  it('caps sections, writes unified revisions, and forgets private memory', () => {
    const { db, memory } = harness();
    for (const [index, section] of ['A', 'B', 'C'].entries()) {
      memory.queueWrite({ scope: 'primemory', subject: 'telegram:u1', section, lines: [`line ${index}`], actor: 'user:u1', turnId: `t${index}`, chatId: 'u1', userId: 'u1' }, 'limited', true, 'trusted');
      memory.flush(`t${index}`);
    }
    // 自读自己那份：owner 例外整条删除后（docs/12-sdk.md §14.1 Q-C），`read()` 不再允许跨键读取，
    // 越权读取那半用例移到下面单独一条，改走 `auditPrivateAccess()` 直调（WebUI 现在唯一的调用形态）。
    const content = memory.read('primemory', 'telegram:u1', 'limited', 'u1', true).content;
    expect((content.match(/^## /gm) ?? []).length).toBeLessThanOrEqual(2);
    expect((db.prepare('SELECT diff FROM memory_revisions ORDER BY ts DESC LIMIT 1').pluck().get() as string)).toContain('@@');
    closeDatabase(db);
  });

  it('auditPrivateAccess / lastOwnerRead 配对可用（WebUI 直调，read() 内部已不再触发）', () => {
    const { db, memory } = harness();
    memory.auditPrivateAccess('u1', 'webui', 'read');
    expect((db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='memory.owner_read_private'").pluck().get() as number)).toBe(1);
    // `user_id` 落的是**被看的那个人**，不是看的人 —— `lastOwnerRead` 与用户自己的 `/memory` 按它查。
    // 问责要让被看的人看得见：只落一条只有 owner 翻得到的日志，那是记录不是问责（docs/29 · M-MEM-01）。
    expect(db.prepare("SELECT user_id FROM log_events WHERE kind='memory.owner_read_private'").pluck().get()).toBe('u1');
    expect(memory.lastOwnerRead('u1')).toMatchObject({ op: 'read' });
    expect(memory.lastOwnerRead('someone-else')).toBeNull();
    // 改别人那份记 op='write'，比看更重。
    memory.auditPrivateAccess('u1', 'webui', 'write');
    expect(memory.lastOwnerRead('u1')).toMatchObject({ op: 'write' });
    closeDatabase(db);
  });

  it('discards pending writes from a failed turn', () => {
    const { db, memory } = harness();
    memory.queueWrite({ scope: 'primemory', subject: 'telegram:u1', section: 'A', lines: ['must not persist'], actor: 'user:u1', turnId: 'failed', chatId: 'u1', userId: 'u1' }, 'limited', true, 'trusted');
    expect(memory.discard('failed')).toBe(1);
    expect(memory.flush('failed')).toEqual({ ok: true, documents: 0 });
    expect(memory.read('primemory', 'telegram:u1', 'limited', 'u1', true).content).toBe('');
    closeDatabase(db);
  });
});
