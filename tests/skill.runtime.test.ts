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

describe('skill.load 的可观测性', () => {
  /**
   * `scan()` 的 per-skill catch 此前只写 `skills.load_error` 那一列，而那一列只有扩展页在读 ——
   * 「我加的那个 skill 为什么不存在」在日志里一个字都没有，与 `agent.file_invalid` 不对称
   * （docs/28 · L-LOG-01）。而 `skill.load` 又不能逐次记：watcher 一次保存能连发好几个事件、
   * 装一个包要写几十个文件，所以判据是**这份 skill 的签名变了**。
   */
  it('只在真的变了时落一行，解析失败那一档是 error', () => {
    const database = './data/skill-load-log.test.db';
    const skillsDir = './data/skill-load-log-skills';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(`${skillsDir}/good`, { recursive: true });
    writeFileSync(`${skillsDir}/good/SKILL.md`, '---\nname: good\ndescription: 好的\nmin-role: limited\nallowed-tools: [read_file]\n---\n正文很长一点点。\n');
    const db = openDatabase(database); migrateDatabase(db);
    const events: Array<{ level: string; kind: string; data?: unknown }> = [];
    const log = { event: (event: { level: string; kind: string; data?: unknown }) => { events.push(event); return 1; } } as never;
    const skills = new SkillLoader(db, skillsDir, 'trusted', undefined, log);
    skills.scan();
    expect(events.filter((event) => event.kind === 'skill.load')).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'info' });
    expect(events[0]!.data).toMatchObject({ name: 'good', minRole: 'limited', enabled: true, allowedTools: ['read_file'], error: null });
    expect((events[0]!.data as { tokens: number }).tokens).toBeGreaterThan(0);
    // 第二次扫描什么都没变 —— 一行都不许再落，否则 `plugins.watch` 打开时日志会被刷爆。
    events.length = 0;
    skills.scan();
    expect(events).toEqual([]);
    // 坏 frontmatter：error 级，与 `agent.file_invalid` 对称。
    mkdirSync(`${skillsDir}/broken`, { recursive: true });
    writeFileSync(`${skillsDir}/broken/SKILL.md`, '---\nname: mismatch\ndescription: 名字对不上\n---\n正文\n');
    skills.scan();
    const failed = events.filter((event) => event.kind === 'skill.load');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe('error');
    expect(failed[0]!.data).toMatchObject({ name: 'broken', enabled: false });
    closeDatabase(db);
  });
});

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

  /**
   * `skills` 表是盘上那批文件的**读模型**。`persist()` 只 upsert，唯一会删行的是 `remove()`
   * —— 于是在这之前，盘上删掉一个 skill 目录，那一行会永远留在表里、永远显示在扩展页。
   */
  it('prunes rows for skills that vanished from disk, but not when the directory is unreadable', () => {
    const { db, skills } = setup();
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([{ name: 'safe-skill' }]);
    rmSync('./data/skill-runtime-skills/safe-skill', { recursive: true, force: true });
    skills.scan();
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([]);

    // 反方向：目录整个读不到时**不清理**。临时不在（换盘、挂载没起来）就清空整张表，
    // 比留着陈行糟得多 —— 那是一次不可逆的删除，而原因只是一次读失败。
    mkdirSync('./data/skill-runtime-skills/kept', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/kept/SKILL.md', '---\nname: kept\ndescription: 留着\nmin-role: limited\n---\n正文\n');
    skills.scan();
    rmSync('./data/skill-runtime-skills', { recursive: true, force: true });
    const gone = new SkillLoader(db, './data/skill-runtime-skills');
    gone.scan();
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([{ name: 'kept' }]);
    closeDatabase(db);
  });

  // `.staging-*` / `.backups/` 要能住在 skills/ 里（装包靠同分区 renameSync 落位）。
  // 顺带修掉一个独立的老问题：一个 .DS_Store 此前会被扫成一行 load_error 假 skill。
  it('skips dot entries and plain files when scanning', () => {
    const { db, skills } = setup();
    mkdirSync('./data/skill-runtime-skills/.staging-1-abc/inner', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/.staging-1-abc/SKILL.md', '---\nname: whatever\ndescription: 暂存\n---\n正文\n');
    writeFileSync('./data/skill-runtime-skills/.DS_Store', 'junk');
    writeFileSync('./data/skill-runtime-skills/README.md', '# not a skill');
    skills.scan();
    expect(db.prepare('SELECT name FROM skills ORDER BY name').all()).toEqual([{ name: 'safe-skill' }]);
    closeDatabase(db);
  });

  it('classifies source and only fires onChange when the scan result actually changed', () => {
    const { db } = setup();
    mkdirSync('./data/skill-runtime-skills/writing-tools', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/writing-tools/SKILL.md', '---\nname: writing-tools\ndescription: 随包\nmin-role: owner\n---\n正文\n');
    mkdirSync('./data/skill-runtime-skills/from-package', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/from-package/SKILL.md', '---\nname: from-package\ndescription: 装进来的\nmin-role: limited\n---\n正文\n');
    writeFileSync('./data/skill-runtime-skills/from-package/.package.json', '{"installedAt":1}');
    let changes = 0;
    const skills = new SkillLoader(db, './data/skill-runtime-skills', 'limited', () => { changes += 1; });
    skills.scan();
    expect(changes).toBe(1);
    expect(db.prepare('SELECT name,source FROM skills ORDER BY name').all()).toEqual([
      { name: 'from-package', source: 'package' }, { name: 'safe-skill', source: 'local' }, { name: 'writing-tools', source: 'bundled' },
    ]);
    // 装一个包要写几十个文件，watcher 的去抖之外还要这一层：每次写盘都广播的话，
    // 一次安装就是几十条 SSE + 几十次「WebUI 重新拉四个端点」。
    skills.scan();
    expect(changes).toBe(1);
    writeFileSync('./data/skill-runtime-skills/from-package/SKILL.md', '---\nname: from-package\ndescription: 改了描述\nmin-role: limited\n---\n正文\n');
    skills.scan();
    expect(changes).toBe(2);
    closeDatabase(db);
  });

  /**
   * `AC-SKL-006`：写坏一份 frontmatter，坏的**只能是它自己**。
   *
   * 三半都要断，缺一半都不算：坏的那份在表里留下 `load_error`（扩展页的红是从这一列来的，
   * `SkillList.vue` 的 `broken` class）且目录 / `load` / `skill://` 三条路都够不着；同一个
   * 目录下好的那份照常在目录里、照常载得进来；而 `scan()` 自己不抛 —— per-skill catch 一旦
   * 漏掉一种异常，一份手抖写坏的 SKILL.md 就是整台 bot 起不来。
   */
  it('一份 frontmatter 写坏只坏它自己：那份显红且不可用，同目录其他 skill 与装载器照常', () => {
    const database = './data/skill-broken-frontmatter.test.db';
    const skillsDir = './data/skill-broken-frontmatter-skills';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(`${skillsDir}/healthy`, { recursive: true });
    writeFileSync(`${skillsDir}/healthy/SKILL.md`, '---\nname: healthy\ndescription: 好的那份\nmin-role: limited\nallowed-tools: [read_file]\n---\n正文\n');
    writeFileSync(`${skillsDir}/healthy/reference.txt`, 'reference');
    // 最常见的那种手抖：`allowed-tools` 忘了写成数组。zod 在这里抛，落进 per-skill catch。
    mkdirSync(`${skillsDir}/rotten`, { recursive: true });
    writeFileSync(`${skillsDir}/rotten/SKILL.md`, '---\nname: rotten\ndescription: 坏的那份\nmin-role: limited\nallowed-tools: read_file\n---\n正文\n');
    const db = openDatabase(database); migrateDatabase(db);
    const skills = new SkillLoader(db, skillsDir);
    let scanned: ReturnType<SkillLoader['scan']> = [];
    expect(() => { scanned = skills.scan(); }).not.toThrow();
    expect(scanned.map((skill) => skill.name).sort()).toEqual(['healthy', 'rotten']);
    // 显红：那一行还在表里（运维得看见它坏了），但 enabled=0 且 load_error 有话说。
    expect(db.prepare('SELECT name,enabled,load_error AS error FROM skills ORDER BY name').all()).toMatchObject([
      { name: 'healthy', enabled: 1, error: null }, { name: 'rotten', enabled: 0 },
    ]);
    expect((db.prepare("SELECT load_error AS error FROM skills WHERE name='rotten'").get() as { error: string }).error).toBeTruthy();
    // 不可用：目录里没有它，凭名字硬来也载不进来，`skill://` 同样够不着。
    expect(skills.catalog('owner').map((entry) => entry.name)).toEqual(['healthy']);
    expect(skills.load('rotten', 'owner', ['read_file'])).toMatchObject({ ok: false });
    expect(() => skills.resolveResource('skill://rotten/SKILL.md', 'owner')).toThrow('skill_unavailable');
    // 而好的那份一切照常 —— 这一半才是判据的重点。
    expect(skills.catalog('limited')).toEqual([{ name: 'healthy', description: '好的那份' }]);
    expect(skills.load('healthy', 'limited', ['read_file', 'bash'])).toMatchObject({ ok: true, allowedTools: ['read_file'] });
    expect(skills.resolveResource('skill://healthy/reference.txt', 'limited')).toContain('reference.txt');
    // 装载器整体还活着：写端点照旧能建新的，坏的那份也没把后来的扫描带塌。
    expect(skills.create('later', { description: '后来的', body: '正文' })).toMatchObject({ name: 'later', enabled: true });
    expect(skills.scan().map((skill) => skill.name).sort()).toEqual(['healthy', 'later', 'rotten']);
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
