import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, MemoryStore, memoryScopeSubjects } from '@luoli/core';

/**
 * docs/12-sdk.md T2.4：`read()` / `queueWrite()` 两道 primemory 访问闸只比较作用域键
 * （[[memoryScopeSubjects]]），owner 例外整条删除（Q-C）——不再有任何角色能越过闸读写他人的
 * 私有记忆，`read()` 内的 `auditPrivateAccess` 调用随之删除。单列本文件，不与
 * `tests/memory.isolation.test.ts` / `tests/memory.operations.test.ts` 的功能用例合并。
 */
function harness(name: string) {
  const database = `./data/${name}.test.db`;
  const directory = `./data/${name}-memory`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  const log = new LogSink(new OperationsRepository(db));
  return { db, memory: new MemoryStore(db, directory, 1500, 3000, 12, log) };
}

function ownerReadPrivateCount(db: ReturnType<typeof openDatabase>): number {
  return db
    .prepare("SELECT COUNT(*) FROM log_events WHERE kind='memory.owner_read_private'")
    .pluck()
    .get() as number;
}

describe('primemory 访问闸（read / queueWrite，Q-C：owner 例外整条删除）', () => {
  it('跨来源读被拒：同一 userId，subject 属于另一个来源', () => {
    const { db, memory } = harness('gates-cross-source-read');
    const subject = memoryScopeSubjects('acme-sdk', 'u1').primemory; // 'acme-sdk:u1'
    expect(() =>
      memory.read('primemory', subject, 'limited', 'u1', true, 'telegram'),
    ).toThrow('private_memory_forbidden');
    expect(ownerReadPrivateCount(db)).toBe(0);
    closeDatabase(db);
  });

  it('同来源跨会话读被拒：来源相同，userId 不同', () => {
    const { db, memory } = harness('gates-cross-session-read');
    const subject = memoryScopeSubjects('telegram', 'u2').primemory; // 'telegram:u2'
    expect(() =>
      memory.read('primemory', subject, 'limited', 'u1', true),
    ).toThrow('private_memory_forbidden');
    expect(ownerReadPrivateCount(db)).toBe(0);
    closeDatabase(db);
  });

  it('isPrivate 为假时，读与写均被拒（即便 subject 与作用域键相等）', () => {
    const { db, memory } = harness('gates-not-private');
    const subject = memoryScopeSubjects('telegram', 'u1').primemory;
    expect(() =>
      memory.read('primemory', subject, 'limited', 'u1', false),
    ).toThrow('private_memory_forbidden');
    const result = memory.queueWrite(
      { scope: 'primemory', subject, section: '偏好', lines: ['x'], actor: 'user:u1', turnId: 't1', chatId: 'u1', userId: 'u1' },
      'limited',
      false,
      'trusted',
    );
    expect(result).toEqual({ ok: false, error: 'primemory_scope_forbidden' });
    expect(ownerReadPrivateCount(db)).toBe(0);
    closeDatabase(db);
  });

  it('actorRole=owner 且 subject 与作用域键不等时被拒（读与写各一条），不再产生 owner_read_private 审计', () => {
    const { db, memory } = harness('gates-owner-cross-subject');
    const subject = memoryScopeSubjects('telegram', 'u1').primemory; // owner 自己的键是 'telegram:owner'
    expect(() =>
      memory.read('primemory', subject, 'owner', 'owner', true),
    ).toThrow('private_memory_forbidden');
    const result = memory.queueWrite(
      { scope: 'primemory', subject, section: '偏好', lines: ['x'], actor: 'owner', turnId: 't1', chatId: 'owner', userId: 'owner' },
      'owner',
      true,
      'trusted',
    );
    expect(result).toEqual({ ok: false, error: 'primemory_scope_forbidden' });
    // 越过闸这件事本身不再发生：owner 例外删除后不再有「越过之后记一笔」的分支。
    expect(ownerReadPrivateCount(db)).toBe(0);
    closeDatabase(db);
  });

  it('自己读自己（作用域键相等）放行，不论角色', () => {
    const { db, memory } = harness('gates-self-read');
    const subject = memoryScopeSubjects('telegram', 'u1').primemory;
    memory.queueWrite(
      { scope: 'primemory', subject, section: '偏好', lines: ['爱吃辣'], actor: 'user:u1', turnId: 't1', chatId: 'u1', userId: 'u1' },
      'limited',
      true,
      'trusted',
    );
    memory.flush('t1');
    for (const role of ['limited', 'trusted', 'owner'] as const) {
      expect(memory.read('primemory', subject, role, 'u1', true).content).toContain('爱吃辣');
    }
    expect(ownerReadPrivateCount(db)).toBe(0);
    closeDatabase(db);
  });

  it('queueWrite 跨键被拒：subject 与 userId 算出的作用域键不一致', () => {
    const { db, memory } = harness('gates-cross-key-write');
    const subject = memoryScopeSubjects('telegram', 'u2').primemory;
    const result = memory.queueWrite(
      { scope: 'primemory', subject, section: '偏好', lines: ['x'], actor: 'user:u1', turnId: 't1', chatId: 'u1', userId: 'u1' },
      'limited',
      true,
      'trusted',
    );
    expect(result).toEqual({ ok: false, error: 'primemory_scope_forbidden' });
    closeDatabase(db);
  });
});
