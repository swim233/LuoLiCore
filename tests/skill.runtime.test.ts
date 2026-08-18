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

  // 说明书类 skill 的可见性要跟着它讲的那个工具走。少了这条的实测代价：四份自撰写说明书只被
  // `min-role` 挡着，而它们讲的工具受 `tools.selfExtend.*` 控制、出厂是关的 —— 模型读完说明书
  // 找不到工具，转头用 bash 逆向代码库、自己拿 sessions 表里的会话去打 WebUI API 把事办了。
  it('hides a skill whose requires-tools are not available this turn', () => {
    const { db, skills } = setup();
    mkdirSync('./data/skill-runtime-skills/needs-tool', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/needs-tool/SKILL.md',
      `---\nname: needs-tool\ndescription: 讲怎么用 install_mcp\nmin-role: limited\nrequires-tools: [install_mcp]\n---\n正文\n`);
    skills.scan();
    expect(skills.catalog('limited').map((entry) => entry.name)).toContain('needs-tool');
    expect(skills.catalog('limited', ['read_file']).map((entry) => entry.name)).not.toContain('needs-tool');
    expect(skills.catalog('limited', ['read_file', 'install_mcp']).map((entry) => entry.name)).toContain('needs-tool');
    // 目录过滤不是边界：模型可以凭上一轮记住的名字直接 load_skill 过来。
    expect(skills.load('needs-tool', 'limited', ['read_file'])).toMatchObject({ ok: false, error: 'skill_requires_unavailable_tools' });
    expect(skills.load('needs-tool', 'limited', ['read_file', 'install_mcp'])).toMatchObject({ ok: true });
    closeDatabase(db);
  });

  // 交集为空必须是失败而不是空集：空集在 `admit()` 那边（`skillAllowedTools?.size &&`）是 falsy，
  // 收窄会被整条跳过，于是「只准用 read_file」在运行时变成「什么都准用」。
  it('fails the load when allowed-tools intersects to nothing', () => {
    const { db, skills } = setup();
    expect(skills.load('safe-skill', 'limited', ['bash', 'web_search'])).toMatchObject({ ok: false, error: 'skill_tools_unavailable' });
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
