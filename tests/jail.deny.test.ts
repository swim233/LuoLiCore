import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTools, PathJail, configSchema, selfAuthoringDenyGlobs } from '@luoli/core';

/**
 * `tools.fs.denyGlobs` 里以 `/**` 结尾的那些同时拒绝那个目录**本身**（`PathJail` 在构造时派生一条
 * 去掉后缀的模式）。
 *
 * 守的是一条完整绕行：minimatch 下 `X/**` 不匹配 `X` 自己，而 `FileTools.move` 一道额外的闸都没有
 * （`remove` 有「显式 recursive + 深度 ≥2」两道，`move` 什么都没有）。于是
 * `move_file('skills','x')` → 整棵树落到名单之外 → 随便改一个**已启用** plugin 的源码 →
 * `move_file('x','skills')` 搬回去，而 `docs/07 §6.1`「内容变了就打回未启用」那道闸住在
 * `PluginManager.writeSource` 里、这条路根本不经过它。
 *
 * 修在 `PathJail` 而不是 `move` 上：判据只该有一份，`list_dir` / `grep` / `read` / `remove` 走的是
 * 同一个 `resolve`。**这不是新开一道门**，是把一道本来就想有的门修严 —— 所以这一族里同样有
 * 「不以 `/**` 结尾的 glob 语义一个字不变」和「兄弟前缀不被误伤」两条对照。
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
    // 这一条是修好的那半边：此前它返回路径，于是 move / delete 拿得到那棵树。
    expect(() => jail.resolve('protected')).toThrow('path_denied');
    expect(() => jail.resolve('./protected')).toThrow('path_denied');
    expect(() => jail.resolve(`${root}/protected`)).toThrow('path_denied');
    // 原来就拒的那半边一个字没变。
    expect(() => jail.resolve('protected/nested')).toThrow('path_denied');
    expect(() => jail.resolve('protected/nested/a.txt')).toThrow('path_denied');
    expect(() => jail.resolve('protected/does-not-exist.txt')).toThrow('path_denied');
    // 同一个 jail 里别的路径照旧能解 —— 上面几条不是把整条路读死了。
    expect(jail.resolve('ok.txt')).toBe(`${root}/ok.txt`);
    expect(jail.resolve('.')).toBe(root);
  });

  it('兄弟前缀不被误伤：`X/**` 拒 X，但不拒 X-backup', () => {
    const { root, deny } = fresh('sibling');
    for (const dir of ['skills', 'skills-backup', 'skillset']) mkdirSync(`${root}/${dir}`, { recursive: true });
    const jail = deny([`${root}/skills/**`]);
    expect(() => jail.resolve('skills')).toThrow('path_denied');
    // 派生模式走的仍然是 minimatch，不是字符串前缀比较 —— 后者会把这两个也一起吃掉。
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
    // 这两个 glob 一个也没被派生成「连目录一起拒」，所以父目录照旧解得开。
    expect(jail.resolve('data')).toBe(`${root}/data`);
    expect(jail.resolve('keys')).toBe(`${root}/keys`);
    expect(jail.resolve('data/other.txt')).toBe(`${root}/data/other.txt`);
  });

  it('`<root>` 仍在匹配时替换 —— 派生模式没把替换时机挪到构造函数', () => {
    // 那个时机是行为的一部分：挪到构造时会让「进程 cwd 在构造之后变了」静默改变语义。
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
    // 绕行的第一步就断掉。`move` 自己一道闸都没有（没有 recursive、没有深度下限），所以拦住它的
    // 只可能是 jail —— 下面那条对照证明这一点。
    expect(() => subject.move('skills', 'stolen')).toThrow('path_denied');
    expect(() => subject.move('plugins', 'stolen')).toThrow('path_denied');
    // 反方向也一样：把一棵自己造的树搬**进** skills/ 同样是绕过 writeSource。
    mkdirSync(`${root}/mine`, { recursive: true });
    expect(() => subject.move('mine', 'skills')).toThrow('path_denied');
    expect(() => subject.move('mine', 'skills/injected')).toThrow('path_denied');
    // delete 那条路上此前靠「深度 ≥2」兜着（`skills` 深度 1），现在是 denyGlobs 明确拒的。
    expect(() => subject.remove('skills', true)).toThrow('path_denied');
    // 树一个字节都没动。
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
 * host-fs 形状的 jail：**边界与相对路径的解析基点是两个不同的目录**。生产里那一对是 `/` 与会话
 * workspace（`tools.fs.allowHostFsForOwner`）；这里拿一个临时目录当「整机根」而不是真的传 `/` ——
 * 判据形状一模一样，而万一闸被放空，被搬走的是 `data/` 底下一棵自己造的树，不是宿主的 `/etc`。
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
    // 模型写出来的就是这个形态：基点是 `<boundary>/deep/nested/workspace`，边界底下的东西一律
    // 带一串 `..`。旧实现量的是 `relative(jail.root, target)`，那三段 `..` 被一起数进来 ——
    // `one` 数出 4 层、闸放行，而它离边界只有一层。
    expect(files.remove('../../../one', true)).toMatchObject({ ok: false, error: 'recursive_delete_too_shallow' });
    expect(existsSync(`${boundary}/one/two/three`)).toBe(true);
    // 边界自己是 0 层（`relative` 交回空串），同样拒。
    expect(files.remove('../../..', true)).toMatchObject({ ok: false, error: 'recursive_delete_too_shallow' });
    expect(existsSync(boundary)).toBe(true);
    // 二级及更深照旧放行 —— 这道闸没有被改成「host-fs 模式下什么都删不掉」。
    expect(files.remove('../../../one/two', true)).toMatchObject({ ok: true, recursive: true });
    expect(existsSync(`${boundary}/one/two`)).toBe(false);
  });

  it('hint 里那个数也是边界基准，不是路径里的段数', () => {
    const { boundary, files } = hostFs('hint');
    mkdirSync(`${boundary}/one`, { recursive: true });
    // 显示路径与深度刻意不同基准：前者相对会话目录（原样交回来还能解回同一个文件），
    // 后者相对边界。所以这句话里出现的是 `../../../one` 和 1，而不是 `../../../one` 和 4。
    expect(files.remove('../../../one', true)).toMatchObject({ hint: expect.stringContaining('只有 1 层') });
    expect(files.remove('../../..', true)).toMatchObject({ hint: expect.stringContaining('只有 0 层') });
  });

  it('`depthFromBoundary` 数的是边界那一侧 —— 判据没有被搬到 jail 之外重算', () => {
    const { boundary, base, jail } = hostFs('depth');
    mkdirSync(`${boundary}/one/two`, { recursive: true });
    expect(jail.depthFromBoundary(boundary)).toBe(0);
    expect(jail.depthFromBoundary(jail.resolve('../../../one'))).toBe(1);
    expect(jail.depthFromBoundary(jail.resolve('../../../one/two'))).toBe(2);
    // 会话目录自己离边界三层，而它相对**自己**是 0 —— 两个基准差的就是这个。
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
    const big = 'x'.repeat(70_000); // fresh() 给的 maxWriteBytes 是 65536
    // `jail.resolve` 是**抛**而不是返回 `{ok:false}`，所以这一族的断言形状与上面那些不同。
    // 旧实现先量 `Buffer.byteLength` 再解析路径：这三条都报 `write_too_large` —— 什么都没落盘，
    // 但安全信号被一句体积抱怨盖住了，而模型据此去拆分内容重试，它永远拆不出一个不越界的路径。
    expect(() => subject.write('protected/a.txt', big)).toThrow('path_denied');
    expect(() => subject.write('protected', big)).toThrow('path_denied');
    expect(() => subject.write('../escaped.txt', big)).toThrow('path_outside_workspace');
    expect(existsSync(`${root}/protected/a.txt`)).toBe(false);
    // 对照：路径没问题时照旧是体积闸那一档 —— 上面三条不是「反正都拒」才恰好过的。
    expect(subject.write('ok.txt', big)).toMatchObject({ ok: false, error: 'write_too_large' });
    expect(existsSync(`${root}/ok.txt`)).toBe(false);
    expect(subject.write('ok.txt', 'x')).toMatchObject({ ok: true, bytes: 1 });
  });
});
