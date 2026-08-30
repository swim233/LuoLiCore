import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { SkillLoader } from '@luoli/core';

function setup() {
  const database = './data/skill-runtime.test.db';
  const skillsDir = './data/skill-runtime-skills';
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
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
   * `scan()` 的 per-skill catch 此前只写 `skills.load_error` 那一列，而该列只有扩展页在读：
   * 新增的 skill 为何不存在，日志里没有任何记录，与 `agent.file_invalid` 不对称
   * （docs/28 · L-LOG-01）。而 `skill.load` 不能逐次记录：watcher 一次保存会连发多个事件、
   * 装一个包要写数十个文件，因此判据是这份 skill 的签名发生了变化。
   */
  it('只在真的变了时落一行，解析失败那一档是 error', () => {
    const database = './data/skill-load-log.test.db';
    const skillsDir = './data/skill-load-log-skills';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
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
    // 第二次扫描没有任何变化，不得再落任何一行，否则 `plugins.watch` 打开时日志会被刷满。
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

  // 说明文档类 skill 的可见性要随它所讲的工具变化。缺这条的实测代价：四份自撰写说明文档只受
  // `min-role` 限制，而它们讲的工具由 `tools.selfExtend.*` 控制且出厂关闭，模型读完文档找不到
  // 工具，转而用 bash 逆向代码库、取 sessions 表里的会话直接调用 WebUI API 完成操作。
  it('hides a skill whose requires-tools are not available this turn', () => {
    const { db, skills } = setup();
    mkdirSync('./data/skill-runtime-skills/needs-tool', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/needs-tool/SKILL.md',
      `---\nname: needs-tool\ndescription: 讲怎么用 install_mcp\nmin-role: limited\nrequires-tools: [install_mcp]\n---\n正文\n`);
    skills.scan();
    expect(skills.catalog('limited').map((entry) => entry.name)).toContain('needs-tool');
    expect(skills.catalog('limited', ['read_file']).map((entry) => entry.name)).not.toContain('needs-tool');
    expect(skills.catalog('limited', ['read_file', 'install_mcp']).map((entry) => entry.name)).toContain('needs-tool');
    // 目录过滤不是边界：模型可凭上一轮记住的名称直接 load_skill。
    expect(skills.load('needs-tool', 'limited', ['read_file'])).toMatchObject({ ok: false, error: 'skill_requires_unavailable_tools' });
    expect(skills.load('needs-tool', 'limited', ['read_file', 'install_mcp'])).toMatchObject({ ok: true });
    closeDatabase(db);
  });

  // 交集为空必须判为失败而非空集：空集在 `admit()` 一侧（`context.skillAllowedTools.size &&`）是
  // falsy，收窄会被整条跳过，于是「仅允许 read_file」在运行时变成不做任何限制。该集合现在必填、
  // 挂在 `ToolExecutionContext` 上而不是 turn 上 —— 每个 agent run 各持一份，worker 载入带
  // `allowed-tools` 的 skill 收窄的只是自己那一份，不会波及共享同一个 turn 对象的父轮。
  it('fails the load when allowed-tools intersects to nothing', () => {
    const { db, skills } = setup();
    expect(skills.load('safe-skill', 'limited', ['bash', 'web_search'])).toMatchObject({ ok: false, error: 'skill_tools_unavailable' });
    closeDatabase(db);
  });

  /**
   * `allowed-tools: []` 表示未声明，而不是收窄到零个工具（docs/07 §2.2）。空数组在 JS 里是
   * truthy，判据写成真值判断就落进已声明那一档，交集恒为空，于是上一条用例的拒绝对任何角色都
   * 成立（`[].includes(x)` 与角色无关，owner 持有全部工具同样被拒），而这份 skill 仍挂在目录里
   * 供模型反复调用。实测代价：一份 `install_skill` 装好的 skill 在扩展页保存一次即失效，此后
   * 九天 6 次 `load_skill` 全部失败，hint 里那对括号是空的，而括号内本应列出已声明的工具。
   */
  it('把 allowed-tools: [] 当成未声明，而不是收窄到零个工具', () => {
    const { db, skills } = setup();
    mkdirSync('./data/skill-runtime-skills/empty-allow', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/empty-allow/SKILL.md',
      '---\nname: empty-allow\ndescription: 空列表\nmin-role: limited\nallowed-tools: []\n---\n正文\n');
    skills.scan();
    expect(skills.read('empty-allow')!.allowedTools).toBeUndefined();
    expect(skills.catalog('limited').map((entry) => entry.name)).toContain('empty-allow');
    expect(skills.load('empty-allow', 'limited', ['read_file', 'bash']))
      .toMatchObject({ ok: true, narrows: false, allowedTools: ['read_file', 'bash'] });
    // 反向：确有声明且确实一个都不可用时仍必须失败，上一条用例的判据没被这次放宽覆盖掉。
    expect(skills.load('safe-skill', 'limited', ['bash'])).toMatchObject({ ok: false, error: 'skill_tools_unavailable' });
    closeDatabase(db);
  });

  /**
   * `skills` 表是盘上那批文件的读模型。`persist()` 只做 upsert，唯一删行的是 `remove()`，
   * 因此在此之前，盘上删掉一个 skill 目录，对应行会一直留在表里、一直显示在扩展页。
   */
  it('prunes rows for skills that vanished from disk, but not when the directory is unreadable', () => {
    const { db, skills } = setup();
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([{ name: 'safe-skill' }]);
    rmSync('./data/skill-runtime-skills/safe-skill', { recursive: true, force: true });
    skills.scan();
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([]);

    // 反方向：目录整体读不到时不做清理。因临时不可达（换盘、挂载未就绪）就清空整张表，
    // 比留着陈旧行更糟：那是一次不可逆的删除，起因只是一次读失败。
    mkdirSync('./data/skill-runtime-skills/kept', { recursive: true });
    writeFileSync('./data/skill-runtime-skills/kept/SKILL.md', '---\nname: kept\ndescription: 留着\nmin-role: limited\n---\n正文\n');
    skills.scan();
    rmSync('./data/skill-runtime-skills', { recursive: true, force: true });
    const gone = new SkillLoader(db, './data/skill-runtime-skills');
    gone.scan();
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([{ name: 'kept' }]);
    closeDatabase(db);
  });

  // `.staging-*` / `.backups/` 要能放在 skills/ 里（装包依赖同分区 renameSync 落位）。
  // 同时修掉一个独立的既有问题：一个 .DS_Store 此前会被扫成一行 load_error 的伪 skill。
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
    // 装一个包要写数十个文件，watcher 的去抖之外还需要这一层：每次写盘都广播时，
    // 一次安装就是数十条 SSE 加数十次 WebUI 重新拉取四个端点。
    skills.scan();
    expect(changes).toBe(1);
    writeFileSync('./data/skill-runtime-skills/from-package/SKILL.md', '---\nname: from-package\ndescription: 改了描述\nmin-role: limited\n---\n正文\n');
    skills.scan();
    expect(changes).toBe(2);
    closeDatabase(db);
  });

  /**
   * `AC-SKL-006`：写坏一份 frontmatter，受影响的只能是它自己。
   *
   * 三项判据缺一不可：坏的那份在表里留下 `load_error`（扩展页的红色标记取自该列，
   * `SkillList.vue` 的 `broken` class），且目录 / `load` / `skill://` 三条路都不可达；同一目录下
   * 好的那份照常在目录里、照常载得进来；`scan()` 自身不抛异常 —— per-skill catch 一旦漏掉某类
   * 异常，一份写坏的 SKILL.md 就会让整个进程起不来。
   */
  it('一份 frontmatter 写坏只坏它自己：那份显红且不可用，同目录其他 skill 与装载器照常', () => {
    const database = './data/skill-broken-frontmatter.test.db';
    const skillsDir = './data/skill-broken-frontmatter-skills';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(`${skillsDir}/healthy`, { recursive: true });
    writeFileSync(`${skillsDir}/healthy/SKILL.md`, '---\nname: healthy\ndescription: 好的那份\nmin-role: limited\nallowed-tools: [read_file]\n---\n正文\n');
    writeFileSync(`${skillsDir}/healthy/reference.txt`, 'reference');
    // 最常见的书写错误：`allowed-tools` 没写成数组。zod 在这里抛出，落进 per-skill catch。
    mkdirSync(`${skillsDir}/rotten`, { recursive: true });
    writeFileSync(`${skillsDir}/rotten/SKILL.md`, '---\nname: rotten\ndescription: 坏的那份\nmin-role: limited\nallowed-tools: read_file\n---\n正文\n');
    const db = openDatabase(database); migrateDatabase(db);
    const skills = new SkillLoader(db, skillsDir);
    let scanned: ReturnType<SkillLoader['scan']> = [];
    expect(() => { scanned = skills.scan(); }).not.toThrow();
    expect(scanned.map((skill) => skill.name).sort()).toEqual(['healthy', 'rotten']);
    // 标记为损坏：那一行还在表里（运维需要看见它坏了），但 enabled=0 且 load_error 有内容。
    expect(db.prepare('SELECT name,enabled,load_error AS error FROM skills ORDER BY name').all()).toMatchObject([
      { name: 'healthy', enabled: 1, error: null }, { name: 'rotten', enabled: 0 },
    ]);
    expect((db.prepare("SELECT load_error AS error FROM skills WHERE name='rotten'").get() as { error: string }).error).toBeTruthy();
    // 不可用：目录里没有它，凭名称直接载入同样失败，`skill://` 也不可达。
    expect(skills.catalog('owner').map((entry) => entry.name)).toEqual(['healthy']);
    expect(skills.load('rotten', 'owner', ['read_file'])).toMatchObject({ ok: false });
    expect(() => skills.resolveResource('skill://rotten/SKILL.md', 'owner')).toThrow('skill_unavailable');
    // 好的那份一切照常，这一项才是判据的重点。
    expect(skills.catalog('limited')).toEqual([{ name: 'healthy', description: '好的那份' }]);
    expect(skills.load('healthy', 'limited', ['read_file', 'bash'])).toMatchObject({ ok: true, allowedTools: ['read_file'] });
    expect(skills.resolveResource('skill://healthy/reference.txt', 'limited')).toContain('reference.txt');
    // 装载器整体仍可用：写端点照旧能建新的，坏的那份也没影响后续扫描。
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

  /**
   * 装载侧一直是完整的（写 frontmatter，并据此把所需工具不在本轮工具集里的 skill 挡出目录），
   * 而写入侧没有这个字段：表单发了、服务端回 200、文件里却没有，表现为用户自己没填
   * （docs/29 · M-WEB-11）。它是门控字段，丢了等于新建的 skill 永远进得了目录，
   * 哪怕它讲的工具这一轮完全不可用，而那正是这个字段存在的理由。
   */
  it('requires-tools 写得进去，也不会被一次不带它的编辑抹掉', () => {
    const { db } = setup();
    const skills = new SkillLoader(db, './data/skill-runtime-skills', () => 'limited');
    skills.scan();
    expect(skills.create('gated-skill', { description: 'Gated', body: 'Body', requiresTools: ['bash'] })).toMatchObject({ requiresTools: ['bash'] });
    // 门控确实生效：bash 不在本轮工具集里时它不进目录。
    expect(skills.catalog('limited', ['read_file']).map((entry) => entry.name)).not.toContain('gated-skill');
    expect(skills.catalog('limited', ['read_file', 'bash']).map((entry) => entry.name)).toContain('gated-skill');
    // 只改正文不应清掉门控，allowedTools 一直是这样处理的。
    expect(skills.update('gated-skill', { body: 'Second body' })).toMatchObject({ requiresTools: ['bash'] });
    // 给了就以给的为准，包括清空这一档。
    expect(skills.update('gated-skill', { requiresTools: [] }).requiresTools ?? []).toEqual([]);
    expect(() => skills.update('gated-skill', { requiresTools: [1] as unknown as string[] })).toThrow('invalid_skill_requires_tools');
    closeDatabase(db);
  });

  /**
   * 读出侧承认空数组等于未声明还不够，写入侧不得再产生这个值。`allowed-tools` 此前是无条件写入的
   * （相邻的 `requires-tools` 一直带 `.length` 守卫），于是两条路都会把空列表写到盘上：
   * `write_skill` 不传这个参数（其 schema 写明不确定则不要提供）建出来的 skill 落盘即不可载入；
   * WebUI 扩展页那个留空的「允许工具」输入框（placeholder 为「留空 = 沿用当前角色全部可用工具」）
   * 保存一次就把一份正常的 skill 改成任何角色都载不进来。
   */
  it('不落空的 allowed-tools，而传 [] 是清空收窄不是锁死', () => {
    const { db } = setup();
    const skills = new SkillLoader(db, './data/skill-runtime-skills', () => 'limited');
    skills.scan();
    expect(skills.create('fresh-skill', { description: 'Fresh', body: 'Body' }).allowedTools).toBeUndefined();
    expect(readFileSync('./data/skill-runtime-skills/fresh-skill/SKILL.md', 'utf8')).not.toContain('allowed-tools');
    expect(skills.load('fresh-skill', 'limited', ['read_file'])).toMatchObject({ ok: true, narrows: false });
    // 有声明时照常收窄，这次放宽的只有空列表那一档。
    expect(skills.update('fresh-skill', { allowedTools: ['read_file'] })).toMatchObject({ allowedTools: ['read_file'] });
    expect(skills.load('fresh-skill', 'limited', ['read_file', 'bash']))
      .toMatchObject({ ok: true, narrows: true, allowedTools: ['read_file'] });
    // 传入 `[]` 表示清掉收窄、回到不收窄那一档，而不是把这份 skill 锁死。
    expect(skills.update('fresh-skill', { allowedTools: [] }).allowedTools).toBeUndefined();
    expect(skills.load('fresh-skill', 'limited', ['read_file', 'bash'])).toMatchObject({ ok: true, narrows: false });
    closeDatabase(db);
  });
});
