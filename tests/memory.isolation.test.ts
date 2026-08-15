import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperationsRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { MemoryStore } from '@luoli/core';

function harness(name: string) {
  const database = `./data/${name}.test.db`;
  const directory = `./data/${name}-memory`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  const db = openDatabase(database);
  migrateDatabase(db);
  return { db, memory: new MemoryStore(db, directory, 1500, 3000) };
}

describe('private memory isolation', () => {
  it('forbids private-memory reads from group turns', () => {
    const { db, memory } = harness('memory-isolation');
    expect(() => memory.read('primemory', 'user-1', 'limited', 'user-1', false)).toThrow('private_memory_forbidden');
    expect(memory.read('primemory', 'user-1', 'limited', 'user-1', true).content).toBe('');
    expect(() => memory.read('primemory', 'user-1', 'owner', 'user-1', false)).toThrow('private_memory_forbidden');
    expect(memory.read('primemory', 'user-2', 'owner', 'owner', true).content).toBe('');
    expect(new OperationsRepository(db).logs(10)).toEqual([]);
    closeDatabase(db);
  });
});
