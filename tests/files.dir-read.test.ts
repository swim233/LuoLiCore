import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { FileTools, PathJail, SkillLoader, ToolRegistry, configSchema, registerBuiltins } from '@luoli/core';
import type { ApprovalBroker, LogSink } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 读一个**目录**必须是一个明确的错误码，不是 `ok:true` + 空正文。
 *
 * `statSync(目录).size` 在 btrfs 上是 0，于是 `readSlice` 的 `want = min(limit, size-offset)` 是 0、
 * `readLineWindow` 的 `position < size` 一次循环都不进 —— `readSync` 从不被调用，**EISDIR 永远不抛**，
 * 交回的是一个 `ok:true` + 空正文，而空正文交给一个全量覆盖的写端就是一次静默清空。ext4 上目录
 * 的 size 是 4096，会如实抛 EISDIR —— 也就是说这条路此前的行为**取决于文件系统**，而那不是一个
 * 能留在判据上的东西（ACP 那条路早就在 `acp/fs.ts` 的 `#target` 里显式判过了，这里补的是模型
 * 自己那条工具路）。
 *
 * **所以这一族的断言一律压在错误码上，绝不断言「抛了 EISDIR」** —— 那句话在 btrfs 上不成立、
 * 在 ext4 上成立，而 CI 跑在哪个不知道。
 */
function fresh(name: string, maxRead = 65_536): { root: string; files: FileTools } {
  const root = resolve(`data/dir-read-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { root, files: new FileTools(new PathJail(root, []), maxRead, 65_536) };
}

describe('read / readText 读到目录时报 path_is_directory', () => {
  it('空目录与非空目录都一样 —— 判据不能是文件系统怎么填 size', () => {
    const { root, files } = fresh('both-shapes');
    mkdirSync(`${root}/empty`, { recursive: true });
    mkdirSync(`${root}/full`, { recursive: true });
    writeFileSync(`${root}/full/a.txt`, 'hello\n');
    for (const path of ['empty', 'full', '.']) {
      // 空目录是 btrfs 上那个静默档（size 0 → 一次 readSync 都不发生）；非空目录在 ext4 上会抛
      // EISDIR。两档收成同一句话，用例因此在两种文件系统上是同一个结果。
      expect(files.read(path), path).toMatchObject({ ok: false, error: 'path_is_directory' });
      expect(files.readText(path), path).toMatchObject({ ok: false, error: 'path_is_directory' });
    }
  });

  it('绝不交回正文字段 —— 空正文喂给全量覆盖的写端就是清空文件', () => {
    const { root, files } = fresh('no-body');
    mkdirSync(`${root}/dir`, { recursive: true });
    const read = files.read('dir');
    const text = files.readText('dir');
    expect(Object.keys(read).sort()).toEqual(['error', 'hint', 'ok']);
    expect(Object.keys(text).sort()).toEqual(['error', 'hint', 'ok']);
    // hint 要说得出下一步：`read()` 那边指向 list_dir，`readText()` 那条链上没有列目录的 method。
    expect(String(read.hint)).toContain('list_dir');
    expect(String(text.hint)).toContain('目录');
  });

  it('目录判据排在窗口参数之前 —— 「那是个目录」比「limit 要 ≥1」有用', () => {
    const { root, files } = fresh('before-window');
    mkdirSync(`${root}/dir`, { recursive: true });
    // `limit: 0` 单独出现时是 `invalid_line_window`（那条闸自己有用例），撞上目录时让位。
    expect(files.readText('dir', { limit: 0 })).toMatchObject({ ok: false, error: 'path_is_directory' });
    expect(files.readText('dir', { line: Number.NaN })).toMatchObject({ ok: false, error: 'path_is_directory' });
    writeFileSync(`${root}/a.txt`, 'x\n');
    expect(files.readText('a.txt', { limit: 0 })).toMatchObject({ ok: false, error: 'invalid_line_window' });
  });

  it('越界仍然排在最前 —— 安全信号不该被「那是个目录」盖掉', () => {
    const { root, files } = fresh('escape-first');
    mkdirSync(`${root}/dir`, { recursive: true });
    expect(() => files.read('../')).toThrow('path_outside_workspace');
    expect(() => files.readText('../')).toThrow('path_outside_workspace');
  });

  it('错误码复用 delete_file 那一个，不新造一个同义词', () => {
    const { root, files } = fresh('shared-code');
    mkdirSync(`${root}/dir`, { recursive: true });
    // `FileTools.remove` 早就在用 `path_is_directory`（「要连里面一起删就显式 recursive」那一档）。
    // 三条路同一个码，模型不用记两个说的是同一件事的词。
    expect(files.remove('dir')).toMatchObject({ ok: false, error: 'path_is_directory' });
    expect(files.read('dir')).toMatchObject({ error: 'path_is_directory' });
    expect(files.readText('dir')).toMatchObject({ error: 'path_is_directory' });
  });

  it('对照：文件照旧读得出来，两条路都没被读死', () => {
    const { root, files } = fresh('control');
    writeFileSync(`${root}/a.txt`, 'line-1\nline-2\n');
    expect(files.read('a.txt')).toMatchObject({ ok: true, content: '1\tline-1\n2\tline-2' });
    expect(files.readText('a.txt')).toMatchObject({ ok: true, content: 'line-1\nline-2\n', lines: 2 });
    // 不存在的路径行为一个字不变：照旧抛 ENOENT（`#isDirectory` 把「解不开」算成「不是目录」）。
    expect(() => files.read('nope.txt')).toThrow(/ENOENT/);
    expect(() => files.readText('nope.txt')).toThrow(/ENOENT/);
  });

  /**
   * 写侧同一句话。此前写一个目录路径会死在 `write()` 里备份那步的 `cpSync` 上，报一句**不带
   * `EISDIR`** 的 `Recursive option not enabled` —— 模型拿它没法做任何事，还会以为是权限或磁盘问题。
   * ACP 那条路早就在 `acp/fs.ts` 判过，模型自己那条 `write_file` 一直没有。
   */
  it('写一个目录路径也是 path_is_directory，不是 cpSync 那句 Recursive option not enabled', () => {
    const { root, files } = fresh('write-dir');
    mkdirSync(`${root}/dir`, { recursive: true });
    writeFileSync(`${root}/dir/keep.txt`, 'keep\n');
    const written = files.write('dir', 'x');
    expect(written).toMatchObject({ ok: false, error: 'path_is_directory' });
    expect(String(written.hint)).not.toContain('Recursive option');
    // 树没被碰过 —— 这条闸排在 mkdir / 备份 / tmp 落地之前。
    expect(files.read('dir/keep.txt')).toMatchObject({ ok: true });
    // 对照：同名文件照旧写得进；目录判据没把正常的写一起挡掉。
    expect(files.write('dir/new.txt', 'y')).toMatchObject({ ok: true, bytes: 1 });
  });
});

const log = { span: () => ({ id: 's', end: () => undefined }), event: () => undefined } as unknown as LogSink;

/**
 * `read_file` 的 `skill://` 支路是**另一条**读路径：它压根不经过 `FileTools`，直接调 `readSlice`。
 * 上面那一族因此一条都不覆盖它 —— 同一个 bug 类，同一个错误码，只是住在 `builtins.ts` 里。
 * 所以这一族走真的注册表 + 真的 `SkillLoader`：断言的对象是模型实际拿到的那份返回。
 */
function skillHarness(name: string): { db: ReturnType<typeof openDatabase>; registry: ToolRegistry; context: object } {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const directory = resolve(`data/${name}-skills`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(`${directory}/demo/assets`, { recursive: true });
  writeFileSync(`${directory}/demo/SKILL.md`, '---\nname: demo\ndescription: d\nmin-role: limited\n---\nbody\n');
  writeFileSync(`${directory}/demo/assets/note.txt`, 'hello\n');
  const db = openDatabase(path);
  migrateDatabase(db);
  const skills = new SkillLoader(db, directory, 'limited');
  skills.scan();
  const registry = new ToolRegistry(log, { request: async () => true } as ApprovalBroker, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  // 依赖只喂 `read_file` 这条路要的两样（`skills` 与 `filesFor`）：`admit()` 只看被点名那个工具
  // 自己的闸，别的工具的 `available()` 一次都不会被调。
  registerBuiltins(registry, { skills, filesFor: () => new FileTools(new PathJail(resolve('./data'), []), 65_536, 65_536),
    sandbox: { plan: () => ({ allowed: false }) }, schedule: { deliverable: () => false }, telegram: null, log, maxWebBytes: 1000 } as never);
  const turn = { turnId: 't', key: 'k', chatId: 'c', threadId: null, initiatorUserId: 'u', effectiveRole: 'owner',
    isPrivate: true, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
    delta: [], abortSignal: new AbortController().signal, config: configSchema.parse({}) } as unknown as RuntimeTurnContext;
  return { db, registry, context: { turn, workspace: resolve('./data'), agentKind: 'main' } };
}

describe('read_file 的 skill:// 支路同样报 path_is_directory', () => {
  it('目录形状的 skill 资源不再是 ok:true + 空正文', async () => {
    const { db, registry, context } = skillHarness('dir-read-skill');
    // `read_file` 带 `untrustedOutput`，所以注册表把返回整份序列化进 `content` 再包一层信封 ——
    // 错误码因此在 `content` 里，`ok` 仍从原返回抬上来。断言压的是模型真正看到的那一份。
    const file = await registry.execute('read_file', { path: 'skill://demo/assets/note.txt' }, context as never) as { ok: boolean; content: string };
    expect(file.ok).toBe(true);
    expect(file.content).toContain('hello');
    // 目录那一档：`statSync(目录).size` 在 btrfs 上是 0 → `readSlice` 的 want 是 0 → `readSync`
    // 从不被调用 → EISDIR 永远不抛 → 旧实现交回 `ok:true` + 空正文。`readSlice` 本身没被改成会抛
    // （它还有别的调用方），判据加在这条支路上。
    const directory = await registry.execute('read_file', { path: 'skill://demo/assets' }, context as never) as { ok: boolean; content: string };
    expect(directory.ok).toBe(false);
    expect(directory.content).toContain('path_is_directory');
    // 错误码与 `FileTools` 那两条路是同一个，没为这条支路新造同义词。
    expect(directory.content).not.toContain('EISDIR');
    closeDatabase(db);
  });
});
