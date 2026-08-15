import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentManager, AgentResultStore } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

function harness() {
  const path = './data/subagent.test.db';
  const results = './data/subagent-results';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  rmSync(results, { recursive: true, force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const manager = new AgentManager(db, new AgentResultStore(results), [{ name: 'researcher', description: 'r', modelAlias: 'low', maxSteps: 3, minRole: 'limited', tools: [], resultMaxChars: 4, instructions: 'r' }, { name: 'coder', description: 'c', modelAlias: 'high', maxSteps: 3, minRole: 'trusted', tools: [], resultMaxChars: 100, instructions: 'c' }], 3, 10);
  return { db, manager };
}

describe('subagent contracts', () => {
  it('enforces role, depth and result paging without putting transcript in context', () => {
    const { db, manager } = harness();
    const limited = manager.createMain('turn-limited', 'limited', 'main');
    expect(() => manager.spawn(limited, 'coder', 'complete this coding task')).toThrow('权限不足');
    const trusted = manager.createMain('turn-trusted', 'trusted', 'main');
    const { run } = manager.spawn(trusted, 'researcher', 'complete this research task');
    expect(run.effectiveRole).toBe('limited');
    const result = manager.finish(run, 'abcdef');
    expect(result).toMatchObject({ summary: 'abcd', truncated: true });
    expect(manager.result(run.id, 2, 3)).toEqual({ content: 'cde', nextOffset: 5 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM context_messages').get() as { count: number }).count).toBe(0);
    closeDatabase(db);
  });

  it('keeps ask and answer as distinct audit rows', () => {
    const { db, manager } = harness();
    const parent = manager.createMain('turn-ask', 'trusted', 'main');
    const { run } = manager.spawn(parent, 'researcher', 'complete this research task');
    const ask = manager.ask(run, parent, { question: 'which?' });
    manager.answer(ask, 'safe', 'rule');
    const rows = db.prepare('SELECT kind,payload_json AS payload FROM agent_messages ORDER BY created_at,id').all() as Array<{ kind: string; payload: string }>;
    expect(rows.map((row) => row.kind).sort()).toEqual(['answer', 'ask']);
    expect(rows.find((row) => row.kind === 'ask')?.payload).toContain('which');
    expect(rows.find((row) => row.kind === 'answer')?.payload).toContain('safe');
    closeDatabase(db);
  });

  it('records timeout answers without overwriting the ask', () => {
    const { db, manager } = harness();
    const parent = manager.createMain('turn-timeout', 'trusted', 'main');
    const { run } = manager.spawn(parent, 'researcher', 'complete this research task');
    const ask = manager.ask(run, parent, { question: 'need input' });
    manager.answer(ask, null, 'timeout');
    expect(db.prepare('SELECT state FROM agent_messages WHERE id=?').pluck().get(ask)).toBe('timeout');
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages WHERE kind='answer'").pluck().get()).toBe(1);
    closeDatabase(db);
  });

  it('keeps an interrupted main run failed when its final result arrives late', () => {
    const { db, manager } = harness();
    const run = manager.createMain('turn-interrupted', 'trusted', 'main');
    manager.fail(run, 'stream_interrupted');
    manager.finish(run, 'late completion');
    expect(db.prepare('SELECT state,error,result_summary FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({
      state: 'failed',
      error: 'stream_interrupted',
      result_summary: null,
    });
    closeDatabase(db);
  });
});
