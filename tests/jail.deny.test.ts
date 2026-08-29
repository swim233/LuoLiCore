import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTools, PathJail, configSchema, selfAuthoringDenyGlobs } from '@luoli/core';

/**
 * `tools.fs.denyGlobs` 中以 `/**` 结尾的模式同时拒绝该目录本身（`PathJail` 在构造时派生一条
 * 去掉后缀的模式）。
 *
 * 该断言防的是一条完整绕行路径：minimatch 下 `X/**` 不匹配 `X` 本身，而 `FileTools.move` 没有任何额外闸
 * （`remove` 有显式 recursive 与深度 ≥2 两道，`move` 没有）。因此
 * `move_file('skills','x')` 使整棵树脱离名单，随后可修改已启用 plugin 的源码，再用
 * `move_file('x','skills')` 移回，而 `docs/07 §6.1` 中内容变更即回退为未启用的闸位于
 * `PluginManager.writeSource`，该路径完全不经过它。
 *
 * 修复放在 `PathJail` 而不是 `move` 上：判据只应有一份，`list_dir` / `grep` / `read` / `remove` 使用
 * 同一个 `resolve`。这不是新增限制，而是收紧一道本就应存在的限制，因此这一组中同样包含
 * 不以 `/**` 结尾的 glob 语义保持不变、以及兄弟前缀不被误伤两条对照。
 */
function fresh(name: string): { root: string; deny: (globs: readonly string[]) => PathJail; files: (globs: readonly string[]) => FileTools } {
  const root = resolve(`data/jail-deny-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const deny = (globs: readonly string[]): PathJail => new PathJail(root, globs);
  return { root, deny, files: (globs) => new FileTools(deny(globs), 65_536, 65_536) };
}

describe('denyGlobs 的 X/** 同时拒绝 X 自己', () => {
  it('目录本身与目录底下的文件都拒', () => {
    const { root, deny } = fresh('self');
    mkdirSync(`${root}/protected/nested`, { recursive: true });
    writeFileSync(`${root}/protected/nested/a.txt`, 'x');
    writeFileSync(`${root}/ok.txt`, 'x');
    const jail = deny([`${root}/protected/**`]);
    // 这一条对应修复的部分：此前它返回路径，使 move 与 delete 能够访问该目录树。
    expect(() => jail.resolve('protected')).toThrow('path_denied');
    expect(() => jail.resolve('./protected')).toThrow('path_denied');
    expect(() => jail.resolve(`${root}/protected`)).toThrow('path_denied');
    // 原本即拒绝的部分行为保持不变。
    expect(() => jail.resolve('protected/nested')).toThrow('path_denied');
    expect(() => jail.resolve('protected/nested/a.txt')).toThrow('path_denied');
    expect(() => jail.resolve('protected/does-not-exist.txt')).toThrow('path_denied');
    // 同一 jail 中的其他路径仍可解析，上述几条不是将整条路径全部禁止。
    expect(jail.resolve('ok.txt')).toBe(`${root}/ok.txt`);
    expect(jail.resolve('.')).toBe(root);
  });

  it('兄弟前缀不被误伤：`X/**` 拒 X，但不拒 X-backup', () => {
    const { root, deny } = fresh('sibling');
    for (const dir of ['skills', 'skills-backup', 'skillset']) mkdirSync(`${root}/${dir}`, { recursive: true });
    const jail = deny([`${root}/skills/**`]);
    expect(() => jail.resolve('skills')).toThrow('path_denied');
    // 派生模式仍使用 minimatch 而不是字符串前缀比较，后者会将这两项一并匹配。
    expect(jail.resolve('skills-backup')).toBe(`${root}/skills-backup`);
    expect(jail.resolve('skillset')).toBe(`${root}/skillset`);
  });

  it('不以 /** 结尾的 glob 语义一个字不变', () => {
    const { root, deny } = fresh('literal');
    mkdirSync(`${root}/data`, { recursive: true });
    mkdirSync(`${root}/keys`, { recursive: true });
    const jail = deny([`${root}/data/luoli.db*`, '**/*.pem']);
    expect(() => jail.resolve('data/luoli.db')).toThrow('path_denied');
    expect(() => jail.resolve('data/luoli.db-wal')).toThrow('path_denied');
    expect(() => jail.resolve('keys/server.pem')).toThrow('path_denied');
    // 这两个 glob 均未派生出连同目录一并拒绝的模式，因此父目录仍可解析。
    expect(jail.resolve('data')).toBe(`${root}/data`);
    expect(jail.resolve('keys')).toBe(`${root}/keys`);
    expect(jail.resolve('data/other.txt')).toBe(`${root}/data/other.txt`);
  });

  it('`<root>` 仍在匹配时替换 —— 派生模式没把替换时机挪到构造函数', () => {
    // 该时机是行为的一部分：移到构造时会使进程 cwd 在构造之后变化时语义被静默改变。
    const jail = new PathJail(process.cwd(), ['<root>/config/**', '<root>/memory/**']);
    expect(() => jail.resolve('config')).toThrow('path_denied');
    expect(() => jail.resolve('config/config.yaml')).toThrow('path_denied');
    expect(() => jail.resolve('memory')).toThrow('path_denied');
    expect(jail.resolve('package.json')).toBe(`${process.cwd()}/package.json`);
  });

  it('默认那份 denyGlobs 与 selfAuthoringDenyGlobs 覆盖的目录本身也都进不去', () => {
    const jail = new PathJail(process.cwd(), configSchema.parse({}).tools.fs.denyGlobs);
    for (const path of ['config', 'memory', 'skills', 'plugins']) {
      expect(() => jail.resolve(path), path).toThrow('path_denied');
    }
    const { root, deny } = fresh('derived');
    mkdirSync(`${root}/custom-skills/a`, { recursive: true });
    mkdirSync(`${root}/custom-plugins/a`, { recursive: true });
    const derived = deny(selfAuthoringDenyGlobs({ skillsDir: `${root}/custom-skills`, pluginsDir: `${root}/custom-plugins` }));
    expect(() => derived.resolve('custom-skills')).toThrow('path_denied');
    expect(() => derived.resolve('custom-plugins')).toThrow('path_denied');
    expect(() => derived.resolve('custom-skills/a/SKILL.md')).toThrow('path_denied');
  });

  it('`**/.ssh/**` 这类深处的命中连那个目录一起拒', () => {
    const { root, deny } = fresh('ssh');
    mkdirSync(`${root}/home/user/.ssh`, { recursive: true });
    writeFileSync(`${root}/home/user/.ssh/id_rsa`, 'PRIVATE');
    const jail = deny(['**/.ssh/**']);
    expect(() => jail.resolve('home/user/.ssh')).toThrow('path_denied');
    expect(() => jail.resolve('home/user/.ssh/id_rsa')).toThrow('path_denied');
    expect(jail.resolve('home/user')).toBe(`${root}/home/user`);
  });
});

describe('自撰写目录的整棵搬走：move 那条完整绕行被挡住', () => {
  it('move / delete 目标是被保护目录本身时都抛 path_denied，树还在原地', () => {
    const { root, files } = fresh('move');
    mkdirSync(`${root}/skills/demo`, { recursive: true });
    writeFileSync(`${root}/skills/demo/SKILL.md`, '# demo\n');
    mkdirSync(`${root}/plugins/demo`, { recursive: true });
    writeFileSync(`${root}/plugins/demo/plugin.js`, 'module.exports = {};\n');
    const subject = files(selfAuthoringDenyGlobs({ skillsDir: `${root}/skills`, pluginsDir: `${root}/plugins` }));
    // 绕行的第一步即被阻断。`move` 自身没有任何闸（无 recursive、无深度下限），因此拦截它的
    // 只能是 jail，下面那条对照可证明这一点。
    expect(() => subject.move('skills', 'stolen')).toThrow('path_denied');
    expect(() => subject.move('plugins', 'stolen')).toThrow('path_denied');
    // 反方向同样成立：将自建目录树移入 skills/ 同样绕过 writeSource。
    mkdirSync(`${root}/mine`, { recursive: true });
    expect(() => subject.move('mine', 'skills')).toThrow('path_denied');
    expect(() => subject.move('mine', 'skills/injected')).toThrow('path_denied');
    // delete 路径此前依赖深度 ≥2 兜底（`skills` 深度为 1），现在由 denyGlobs 明确拒绝。
    expect(() => subject.remove('skills', true)).toThrow('path_denied');
    // 目录树未发生任何改动。
    expect(existsSync(`${root}/skills/demo/SKILL.md`)).toBe(true);
    expect(existsSync(`${root}/plugins/demo/plugin.js`)).toBe(true);
    expect(existsSync(`${root}/stolen`)).toBe(false);
  });

  it('对照：move 对一个没被保护的一级目录照旧成功 —— 拦住上一条的只可能是 denyGlobs', () => {
    const { root, files } = fresh('move-control');
    mkdirSync(`${root}/plain/deep`, { recursive: true });
    writeFileSync(`${root}/plain/deep/a.txt`, 'x');
    const subject = files(selfAuthoringDenyGlobs({ skillsDir: `${root}/skills`, pluginsDir: `${root}/plugins` }));
    expect(subject.move('plain', 'moved')).toMatchObject({ ok: true, from: 'plain', to: 'moved' });
    expect(existsSync(`${root}/moved/deep/a.txt`)).toBe(true);
  });
});

/**
 * host-fs 形态的 jail：边界与相对路径的解析基点是两个不同的目录。生产环境中这一对为 `/` 与会话
 * workspace（`tools.fs.allowHostFsForOwner`）；这里用一个临时目录充当整机根而不是实际传入 `/`，
 * 判据形状完全一致，而一旦闸失效，被移动的是 `data/` 下自建的目录树而非宿主的 `/etc`。
 */
function hostFs(name: string): { boundary: string; base: string; jail: PathJail; files: FileTools } {
  const boundary = resolve(`data/jail-hostfs-${name}`);
  rmSync(boundary, { recursive: true, force: true });
  const base = `${boundary}/deep/nested/workspace`;
  mkdirSync(base, { recursive: true });
  const jail = new PathJail(boundary, [], { base });
  return { boundary, base, jail, files: new FileTools(jail, 65_536, 65_536) };
}

describe('递归删除的深度闸对着可达边界量，不是相对路径的解析基点', () => {
  it('host-fs 形状下边界底下的一级目录仍然拒 —— `..` 段不算深度', () => {
    const { boundary, files } = hostFs('shallow');
    mkdirSync(`${boundary}/one/two/three`, { recursive: true });
    // 模型生成的正是这种形态：基点为 `<boundary>/deep/nested/workspace`，边界下的路径一律
    // 带有一串 `..`。旧实现计算的是 `relative(jail.root, target)`，三段 `..` 被一并计入，
    // 使 `one` 被判定为 4 层并放行，而它距边界只有一层。
    expect(files.remove('../../../one', true)).toMatchObject({ ok: false, error: 'recursive_delete_too_shallow' });
    expect(existsSync(`${boundary}/one/two/three`)).toBe(true);
    // 边界自身为 0 层（`relative` 返回空串），同样拒绝。
    expect(files.remove('../../..', true)).toMatchObject({ ok: false, error: 'recursive_delete_too_shallow' });
    expect(existsSync(boundary)).toBe(true);
    // 二级及更深路径仍然放行：这道闸没有被改成 host-fs 模式下完全禁止删除。
    expect(files.remove('../../../one/two', true)).toMatchObject({ ok: true, recursive: true });
    expect(existsSync(`${boundary}/one/two`)).toBe(false);
  });

  it('hint 里那个数也是边界基准，不是路径里的段数', () => {
    const { boundary, files } = hostFs('hint');
    mkdirSync(`${boundary}/one`, { recursive: true });
    // 显示路径与深度刻意使用不同基准：前者相对会话目录（原样返回后仍能解析回同一文件），
    // 后者相对边界。因此这条信息中给出的是 `../../../one` 与 1，而不是 `../../../one` 与 4。
    expect(files.remove('../../../one', true)).toMatchObject({ hint: expect.stringContaining('只有 1 层') });
    expect(files.remove('../../..', true)).toMatchObject({ hint: expect.stringContaining('只有 0 层') });
  });

  it('`depthFromBoundary` 数的是边界那一侧 —— 判据没有被搬到 jail 之外重算', () => {
    const { boundary, base, jail } = hostFs('depth');
    mkdirSync(`${boundary}/one/two`, { recursive: true });
    expect(jail.depthFromBoundary(boundary)).toBe(0);
    expect(jail.depthFromBoundary(jail.resolve('../../../one'))).toBe(1);
    expect(jail.depthFromBoundary(jail.resolve('../../../one/two'))).toBe(2);
    // 会话目录距边界三层，而相对其自身为 0，两个基准的差异正在于此。
    expect(jail.depthFromBoundary(base)).toBe(3);
    expect(jail.depthFromBoundary(jail.resolve('.'))).toBe(3);
  });

  it('默认模式（边界 === 基点）行为一个字不变', () => {
    const { root, files } = fresh('depth-default');
    mkdirSync(`${root}/one/two/three`, { recursive: true });
    const subject = files([]);
    expect(subject.remove('one', true)).toMatchObject({ ok: false, error: 'recursive_delete_too_shallow' });
    expect(subject.remove('one/two', true)).toMatchObject({ ok: true, recursive: true });
    expect(existsSync(`${root}/one/two`)).toBe(false);
  });
});

describe('write 的路径判据排在体积闸之前', () => {
  it('越界 / 命中 denyGlobs 的超大写入报的是路径，不是 write_too_large', () => {
    const { root, files } = fresh('write-order');
    mkdirSync(`${root}/protected`, { recursive: true });
    const subject = files([`${root}/protected/**`]);
    const big = 'x'.repeat(70_000); // fresh() 提供的 maxWriteBytes 为 65536
    // `jail.resolve` 抛出异常而不是返回 `{ok:false}`，因此这一组断言的形状与上面几条不同。
    // 旧实现先计算 `Buffer.byteLength` 再解析路径：这三条均报 `write_too_large`，虽未写入任何内容，
    // 但安全信号被体积错误掩盖，模型据此拆分内容重试，而拆分永远无法得到一个合法路径。
    expect(() => subject.write('protected/a.txt', big)).toThrow('path_denied');
    expect(() => subject.write('protected', big)).toThrow('path_denied');
    expect(() => subject.write('../escaped.txt', big)).toThrow('path_outside_workspace');
    expect(existsSync(`${root}/protected/a.txt`)).toBe(false);
    // 对照：路径合法时仍落在体积闸这一档，上面三条并非因为一律拒绝才通过。
    expect(subject.write('ok.txt', big)).toMatchObject({ ok: false, error: 'write_too_large' });
    expect(existsSync(`${root}/ok.txt`)).toBe(false);
    expect(subject.write('ok.txt', 'x')).toMatchObject({ ok: true, bytes: 1 });
  });
});
