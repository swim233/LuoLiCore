import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentManager, AgentResultStore, SkillLoader } from '@luoli/core';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

describe('skills and subagents', () => {
  it('only exposes skill metadata and intersects allowed tools', () => {
    const dbPath = './data/skills.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    const root = resolve('data/skills-fixture');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(`${root}/report`, { recursive: true });
    writeFileSync(`${root}/report/SKILL.md`, `---\nname: report\ndescription: 生成报告\nallowed-tools: [read_file, bash]\nmin-role: trusted\n---\n# Secret body\nOnly loaded on demand.`);
    const db = openDatabase(dbPath);
    migrateDatabase(db);
    const loader = new SkillLoader(db, root);
    loader.scan();
    expect(loader.catalog('trusted')).toEqual([{ name: 'report', description: '生成报告' }]);
    expect(JSON.stringify(loader.catalog('trusted'))).not.toContain('Secret body');
    expect(loader.load('report', 'trusted', ['read_file']).allowedTools).toEqual(['read_file']);
    expect(loader.load('report', 'limited', ['read_file'])).toMatchObject({ ok: false });
    closeDatabase(db);
  });

  it('keeps subagent role at or below its parent', () => {
    const dbPath = './data/agents.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    const db = openDatabase(dbPath);
    migrateDatabase(db);
    db.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state) VALUES ('t','chat:1','1','1','trusted','running')").run();
    const manager = new AgentManager(db, new AgentResultStore(resolve('data/agent-results-test')), [{ name: 'coder', description: 'code', modelAlias: 'high', maxSteps: 2, minRole: 'trusted', tools: [], resultMaxChars: 10, instructions: 'code' }], 3, 10);
    const parent = manager.createMain('t', 'trusted', 'main');
    const child = manager.spawn(parent, 'coder', 'complete this task').run;
    expect(child.effectiveRole).toBe('trusted');
    closeDatabase(db);
  });
});
