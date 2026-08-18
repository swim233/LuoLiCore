import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { SkillLoader, installSkillPackage, type SkillPackageLimits } from '@luoli/core';
import { zipFixture, type ZipFixtureEntry } from './fixtures/zip.js';

/**
 * 装 skill 包（docs/07 §2.5）。这份用例是这条通道的主防线 —— 它收的是**用户从聊天里丢进来的
 * 压缩包**，里面的每一个字段都是外部输入。zip 由 `fixtures/zip.ts` 手搓，理由见那里。
 */

type ZipEntry = ZipFixtureEntry;

const SKILL_MD = '---\nname: demo\ndescription: A demo skill\n---\n\n# Demo\n\nRun the wrapper.\n';
const LIMITS: SkillPackageLimits = { maxEntries: 50, maxTotalBytes: 1_000_000, maxFileBytes: 200_000, allowExecutable: true };

let counter = 0;
function setup(limits: Partial<SkillPackageLimits> = {}) {
  counter += 1;
  const database = `./data/skill-package-${counter}.test.db`;
  const skillsDir = `./data/skill-package-${counter}-skills`;
  const inbox = `./data/skill-package-${counter}-inbox`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(inbox, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  const db = openDatabase(database); migrateDatabase(db);
  const skills = new SkillLoader(db, skillsDir, () => 'limited');
  skills.scan();
  const zipAt = (name: string, entries: ZipEntry[]): string => {
    const path = join(inbox, name);
    writeFileSync(path, zipFixture(entries));
    return path;
  };
  const install = (source: string, options: Partial<Parameters<typeof installSkillPackage>[2]> = {}) =>
    installSkillPackage(skills, source, { limits: { ...LIMITS, ...limits }, minRoleFloor: 'trusted', ...options });
  return { db, skills, skillsDir, inbox, zipAt, install };
}
const names = (dir: string): string[] => readdirSync(dir).filter((entry) => !entry.startsWith('.'));

describe('装 skill 包', () => {
  it('装一个多文件包：落地即停用，附属文件与执行位都在', async () => {
    const { db, skills, skillsDir, zipAt, install } = setup();
    const source = zipAt('demo.zip', [
      { name: 'demo/' }, { name: 'demo/SKILL.md', content: SKILL_MD },
      { name: 'demo/scripts/invoke.sh', content: '#!/bin/sh\necho hi\n', mode: 0o100755 },
      { name: 'demo/bin/tool', content: 'ELF', mode: 0o100755 },
      { name: 'demo/references/cli.md', content: '# reference', mode: 0o100644 },
    ]);
    const result = await install(source);
    expect(result.name).toBe('demo');
    expect(result.files.sort()).toEqual(['.package.json', 'SKILL.md', 'bin/tool', 'references/cli.md', 'scripts/invoke.sh']);
    // **落地即停用**：包带着 scripts/ 与 bin/，「skill 是纯文本」那条豁免在这一档不成立。
    expect(skills.read('demo')).toMatchObject({ enabled: false, minRole: 'trusted' });
    expect(skills.catalog('owner')).toEqual([]);
    const mode = (path: string): number => statSync(join(skillsDir, 'demo', path)).mode & 0o777;
    expect(mode('scripts/invoke.sh')).toBe(0o700);
    expect(mode('bin/tool')).toBe(0o700);
    // 执行位只给 scripts/ 与 bin/：一份 .md 不需要能跑。
    expect(mode('references/cli.md')).toBe(0o600);
    expect(mode('SKILL.md')).toBe(0o600);
    expect(db.prepare('SELECT source FROM skills WHERE name=?').get('demo')).toEqual({ source: 'package' });
    closeDatabase(db);
  });

  /**
   * **实测踩到的**：那个真实的音乐包是 Windows 打的（`create_system=0`），外部属性高 16 位
   * 恒为 0。按「原本带执行位的才给」办，装完是一个 `bin/` 里的二进制跑不起来的包 ——
   * 而那正是这条通道存在的理由。分发给终端用户的 zip 多半不保留权限位，这是常态不是例外。
   */
  it('包不带 Unix 模式位时（Windows 打的），按目录约定给 scripts/ 与 bin/ 执行位', async () => {
    const { db, skillsDir, zipAt, install } = setup();
    // mode: 0 = 外部属性高 16 位全零，正是 Windows 打包的形状。
    await install(zipAt('windows.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD, mode: 0 },
      { name: 'demo/scripts/invoke.sh', content: 'exec ../bin/tool "$@"', mode: 0 },
      { name: 'demo/bin/tool', content: 'ELF', mode: 0 },
      { name: 'demo/references/cli.md', content: '# ref', mode: 0 },
    ]));
    const mode = (path: string): number => statSync(join(skillsDir, 'demo', path)).mode & 0o777;
    expect(mode('scripts/invoke.sh')).toBe(0o700);
    expect(mode('bin/tool')).toBe(0o700);
    // 硬规则不变：位置之外一律不给。属性只是位置约定之上的额外收窄。
    expect(mode('references/cli.md')).toBe(0o600);
    expect(mode('SKILL.md')).toBe(0o600);
    closeDatabase(db);
  });

  // 反过来：包**带**模式位时就按它办 —— scripts/ 下一个明确不可执行的文件不该被提上去。
  it('包带 Unix 模式位时，scripts/ 下没标执行位的文件不给执行位', async () => {
    const { db, skillsDir, zipAt, install } = setup();
    await install(zipAt('unix.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD, mode: 0o100644 },
      { name: 'demo/scripts/invoke.sh', content: 'echo', mode: 0o100755 },
      { name: 'demo/scripts/helper.txt', content: 'notes', mode: 0o100644 },
    ]));
    const mode = (path: string): number => statSync(join(skillsDir, 'demo', path)).mode & 0o777;
    expect(mode('scripts/invoke.sh')).toBe(0o700);
    expect(mode('scripts/helper.txt')).toBe(0o600);
    closeDatabase(db);
  });

  it('allowExecutable 关掉之后连 scripts/ 与 bin/ 也不给执行位', async () => {
    const { db, skillsDir, zipAt, install } = setup({ allowExecutable: false });
    await install(zipAt('demo.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD },
      { name: 'demo/scripts/invoke.sh', content: 'echo hi', mode: 0o100755 },
    ]));
    expect(statSync(join(skillsDir, 'demo/scripts/invoke.sh')).mode & 0o777).toBe(0o600);
    closeDatabase(db);
  });

  // zip-slip 三形态。判据有两道（名字形状 + resolve 之后的前缀包含），任何一道单独都得挡住。
  it('拒绝穿越、绝对路径与符号链接条目，且 skills/ 之外一个字节都不写', async () => {
    const { db, skillsDir, inbox, zipAt, install } = setup();
    const outside = join(inbox, 'pwned');
    const cases: Array<[string, ZipEntry[], string]> = [
      ['穿越', [{ name: 'demo/SKILL.md', content: SKILL_MD }, { name: 'demo/../../pwned', content: 'x' }], 'skill_package_path_escape'],
      ['绝对路径', [{ name: 'demo/SKILL.md', content: SKILL_MD }, { name: '/etc/pwned', content: 'x' }], 'skill_package_absolute_entry'],
      ['符号链接', [{ name: 'demo/SKILL.md', content: SKILL_MD }, { name: 'demo/link', content: '/etc', mode: 0o120777 }], 'skill_package_symlink'],
    ];
    for (const [label, entries, code] of cases) {
      await expect(install(zipAt(`${label}.zip`, entries)), label).rejects.toThrow(code);
      expect(existsSync(outside), label).toBe(false);
      expect(names(skillsDir), label).toEqual([]);
    }
    closeDatabase(db);
  });

  it('条目数上限在读目录时就挡住，一个字节都还没写', async () => {
    const { db, skillsDir, zipAt, install } = setup({ maxEntries: 3 });
    await expect(install(zipAt('entries.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD }, { name: 'demo/a', content: 'a' },
      { name: 'demo/b', content: 'b' }, { name: 'demo/c', content: 'c' },
    ]))).rejects.toThrow('skill_package_too_many_entries');
    expect(names(skillsDir)).toEqual([]);
    closeDatabase(db);
  });

  it('单文件与总体积两道上限各自生效，且判的是实际写出的字节数', async () => {
    const { db, skillsDir, zipAt, install } = setup({ maxFileBytes: 1024, maxTotalBytes: 3000 });
    await expect(install(zipAt('file.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD }, { name: 'demo/big', content: Buffer.alloc(4096, 0x61) },
    ]))).rejects.toThrow('skill_package_file_too_large');
    await expect(install(zipAt('total.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD },
      { name: 'demo/a', content: Buffer.alloc(1000, 0x61) }, { name: 'demo/b', content: Buffer.alloc(1000, 0x61) },
      { name: 'demo/c', content: Buffer.alloc(1000, 0x61) }, { name: 'demo/d', content: Buffer.alloc(1000, 0x61) },
    ]))).rejects.toThrow('skill_package_too_large');
    // 压缩炸弹：4 KB 的零压成几十字节，头里还谎报成 1 字节。**信头就等于不设防** ——
    // 我们从头到尾按写出的字节数累计，所以谎报与否都在同一道闸上停下（yauzl 自己的
    // `validateEntrySizes` 是第二道，谁先响都行，响了就不留东西）。
    await expect(install(zipAt('bomb.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD },
      { name: 'demo/bomb', content: Buffer.alloc(4096, 0), deflate: true, declaredSize: 1 },
    ]))).rejects.toThrow();
    expect(names(skillsDir)).toEqual([]);
    closeDatabase(db);
  });

  it('包根有歧义时列出候选，带 subdir 重试能装上', async () => {
    const { db, zipAt, install } = setup();
    // 那个音乐包就是这个形状：同一个 zip 里 windows 与 linux 两套，各带一份 SKILL.md。
    const source = zipAt('two.zip', [
      { name: 'demo-win/SKILL.md', content: SKILL_MD },
      { name: 'demo-linux/SKILL.md', content: SKILL_MD },
      { name: 'demo-linux/scripts/invoke.sh', content: 'echo', mode: 0o100755 },
    ]);
    await expect(install(source)).rejects.toMatchObject({ code: 'skill_ambiguous_root', candidates: expect.arrayContaining(['demo-win', 'demo-linux']) });
    const result = await install(source, { subdir: 'demo-linux', name: 'demo-linux' });
    expect(result.name).toBe('demo-linux');
    expect(result.files).toContain('scripts/invoke.sh');
    closeDatabase(db);
  });

  it('包根一份 SKILL.md 也没有时直接报错', async () => {
    const { db, zipAt, install } = setup();
    await expect(install(zipAt('none.zip', [{ name: 'demo/readme.md', content: '# hi' }]))).rejects.toThrow('skill_md_not_found');
    closeDatabase(db);
  });

  // 包是别人写的：这三个字段不能由它自己说了算。
  it('强制改写 name / enabled / min-role，不接受包里写的值', async () => {
    const { db, skills, skillsDir, zipAt, install } = setup();
    await install(zipAt('claims.zip', [{ name: 'pkg/SKILL.md', content: '---\nname: 别的名字\ndescription: d\nmin-role: limited\nenabled: true\nversion: 1.2\n---\n正文\n' }]), { name: 'renamed' });
    const written = skills.read('renamed');
    expect(written).toMatchObject({ enabled: false, minRole: 'trusted' });
    const raw = readFileSync(join(skillsDir, 'renamed/SKILL.md'), 'utf8');
    expect(raw).toContain('name: renamed');       // scan() 要求 name === 目录名
    expect(raw).toContain('version: 1.2');        // 其余 frontmatter 原样留着
    closeDatabase(db);
  });

  it('min-role 只能被下限抬高，抬不低', async () => {
    const { db, skills, zipAt, install } = setup();
    const source = zipAt('roles.zip', [{ name: 'demo/SKILL.md', content: '---\nname: demo\ndescription: d\nmin-role: owner\n---\n正文\n' }]);
    await install(source, { minRoleFloor: 'trusted' });
    expect(skills.read('demo')).toMatchObject({ minRole: 'owner' });   // 写得更严的照旧
    closeDatabase(db);
  });

  it('拒绝覆写随包发的四份说明书', async () => {
    const { db, zipAt, install } = setup();
    await expect(install(zipAt('reserved.zip', [{ name: 'x/SKILL.md', content: SKILL_MD }]), { name: 'writing-tools' }))
      .rejects.toThrow('skill_reserved');
    closeDatabase(db);
  });

  it('重名要 overwrite，覆盖时旧的那棵留档进 .backups/', async () => {
    const { db, skillsDir, zipAt, install } = setup();
    const source = zipAt('demo.zip', [{ name: 'demo/SKILL.md', content: SKILL_MD }]);
    await install(source);
    await expect(install(source)).rejects.toThrow('skill_already_exists');
    expect(await install(source, { overwrite: true })).toMatchObject({ backedUp: true });
    const backups = readdirSync(join(skillsDir, '.backups'));
    expect(backups.some((entry) => entry.startsWith('demo-'))).toBe(true);
    // 留档目录是点号开头的，所以不会被 scan() 当成一个名字对不上的坏 skill 扫出来。
    expect(db.prepare('SELECT name FROM skills').all()).toEqual([{ name: 'demo' }]);
    closeDatabase(db);
  });

  it('从目录装：同一套校验，符号链接照样拒', async () => {
    const { db, skills, inbox, install } = setup();
    const tree = join(inbox, 'tree');
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    writeFileSync(join(tree, 'SKILL.md'), SKILL_MD);
    writeFileSync(join(tree, 'scripts/run.sh'), 'echo', { mode: 0o755 });
    expect(await install(tree)).toMatchObject({ name: 'demo', backedUp: false });
    expect(skills.read('demo')).toMatchObject({ enabled: false });

    const evil = join(inbox, 'evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'SKILL.md'), SKILL_MD.replace('name: demo', 'name: evil'));
    symlinkSync('/etc', join(evil, 'link'));
    await expect(install(evil, { name: 'evil' })).rejects.toThrow('skill_package_symlink');
    closeDatabase(db);
  });

  it('装到一半失败时不留半棵目录、不留行，覆盖失败还会把旧的放回去', async () => {
    const { db, skills, skillsDir, zipAt, install } = setup();
    await install(zipAt('good.zip', [{ name: 'demo/SKILL.md', content: SKILL_MD }, { name: 'demo/keep.txt', content: 'original' }]));
    // 第二个包的 SKILL.md 合法，但 scripts/ 里那个条目会在写的时候撞上单文件上限。
    await expect(install(zipAt('bad.zip', [
      { name: 'demo/SKILL.md', content: SKILL_MD }, { name: 'demo/huge', content: Buffer.alloc(300_000, 0x61) },
    ]), { overwrite: true })).rejects.toThrow('skill_package_file_too_large');
    // 旧的那份原封不动 —— 装新的失败不该顺带把能用的那份弄没了。
    expect(readFileSync(join(skillsDir, 'demo/keep.txt'), 'utf8')).toBe('original');
    expect(skills.read('demo')).toMatchObject({ name: 'demo' });
    expect(names(skillsDir)).toEqual(['demo']);
    closeDatabase(db);
  });

  it('暂存目录用完就消失，不留在 skills/ 里', async () => {
    const { db, skillsDir, zipAt, install } = setup();
    await install(zipAt('demo.zip', [{ name: 'demo/SKILL.md', content: SKILL_MD }]));
    expect(readdirSync(skillsDir).filter((entry) => entry.startsWith('.staging'))).toEqual([]);
    closeDatabase(db);
  });
});
