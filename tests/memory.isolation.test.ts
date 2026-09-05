import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { MemoryStore } from '@luoli/core';

function harness(name: string) {
  const database = `./data/${name}.test.db`;
  const directory = `./data/${name}-memory`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  return { db, memory: new MemoryStore(db, directory, 1500, 3000) };
}

// T2.3 起 primemory 的 subject 是复合键 `telegram:<userId>`（`memoryScopeSubjects`），
// 不再是裸 userId——下面四条按调用方（`builtins.ts`）实际会传的形态构造。
// T2.4 删除 owner 例外（Q-C）后，owner 跨键读取（原 :24 行）不再返回空文档，改为与其他
// 角色一样被拒——两道闸只比较作用域键，不再有角色能越过它。
describe('private memory isolation', () => {
  it('forbids private-memory reads from group turns', () => {
    const { db, memory } = harness('memory-isolation');
    expect(() => memory.read('primemory', 'telegram:user-1', 'limited', 'user-1', false)).toThrow('private_memory_forbidden');
    expect(memory.read('primemory', 'telegram:user-1', 'limited', 'user-1', true).content).toBe('');
    expect(() => memory.read('primemory', 'telegram:user-1', 'owner', 'user-1', false)).toThrow('private_memory_forbidden');
    expect(() => memory.read('primemory', 'telegram:user-2', 'owner', 'owner', true)).toThrow('private_memory_forbidden');
    expect(new OperationsRepository(db).logs(10)).toEqual([]);
    closeDatabase(db);
  });
});
