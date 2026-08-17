import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { SkillLoader } from '@luoli/core';

function setup() {
  const database = './data/skill-runtime.test.db';
  const skillsDir = './data/skill-runtime-skills';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(`${skillsDir}/safe-skill`, { recursive: true });
  writeFileSync(`${skillsDir}/safe-skill/SKILL.md`, `---\nname: safe-skill\ndescription: Safe skill\nmin-role: limited\nallowed-tools: [read_file]\n---\nUse only files.\n`);
  writeFileSync(`${skillsDir}/safe-skill/reference.txt`, 'reference');
  const db = openDatabase(database); migrateDatabase(db);
  const skills = new SkillLoader(db, skillsDir); skills.scan();
  return { db, skills };
}

describe('skill runtime', () => {
  it('catalogs, narrows allowed tools, and confines skill resources', () => {
    const { db, skills } = setup();
    expect(skills.catalog('limited')).toEqual([{ name: 'safe-skill', description: 'Safe skill' }]);
    expect(skills.load('safe-skill', 'limited', ['read_file', 'bash'])).toMatchObject({ ok: true, allowedTools: ['read_file'] });
    expect(skills.resolveResource('skill://safe-skill/reference.txt', 'limited')).toContain('reference.txt');
    expect(() => skills.resolveResource('skill://safe-skill/../../secret', 'limited')).toThrow('path_outside_skill');
    closeDatabase(db);
  });

  it('creates, edits, rescans, and removes SKILL.md through the loader', () => {
    const { db } = setup();
    const skills = new SkillLoader(db, './data/skill-runtime-skills', () => 'limited');
    skills.scan();
    expect(skills.create('new-skill', { description: 'Created', body: 'First body', allowedTools: ['read_file'] })).toMatchObject({
      name: 'new-skill', description: 'Created', body: 'First body', minRole: 'limited', allowedTools: ['read_file'], enabled: true,
    });
    expect(skills.update('new-skill', { description: 'Edited', body: 'Second body', minRole: 'trusted', enabled: false })).toMatchObject({
      description: 'Edited', body: 'Second body', minRole: 'trusted', enabled: false,
    });
    const reloaded = new SkillLoader(db, './data/skill-runtime-skills');
    reloaded.scan();
    expect(reloaded.read('new-skill')).toMatchObject({ description: 'Edited', minRole: 'trusted', enabled: false });
    expect(reloaded.remove('new-skill')).toBe(true);
    expect(reloaded.read('new-skill')).toBeNull();
    expect(reloaded.remove('new-skill')).toBe(false);
    closeDatabase(db);
  });
});
