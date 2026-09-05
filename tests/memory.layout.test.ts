import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { migrateMemoryLayout } from '@luoli/core';
import { code, codeIndex, source } from './support/source.js';

/**
 * `migrateMemoryLayout()` 的判据是文件系统而非库里的门闸，fixture 因此分两半：
 * 磁盘一份旧布局目录树，库一份经 0019 迁移、`id`/`subject` 已是按来源新形态、但 `path`
 * 仍指向旧磁盘路径的 memory_docs 行（`reports/T2.1.impl.md` 记录的正是这个中间态）。
 */
function harness(name: string) {
  const root = `./data/${name}`;
  rmSync(root, { recursive: true, force: true });
  const memoryDir = join(root, 'memory');
  const dataDir = join(root, 'state');
  mkdirSync(memoryDir, { recursive: true });
  const db = openDatabase(join(root, 'luoli.db'));
  migrateDatabase(db); // 全量跑到最新，含已提交的 0019
  const insertDoc = db.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at)
    VALUES (?,?,?,?,1,1,'h',1)`);
  return { root, memoryDir, dataDir, db, insertDoc };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 造一份完整的旧布局：PUBMEMORY、CHARACTER、ASSIST 三份来源级文件，两个用户的 PRIMEMORY。 */
function seedLegacyLayout(memoryDir: string, insertDoc: Database.Statement) {
  const content = {
    pub: '# 公开记忆\n\n## 其他\n- 旧内容\n',
    character: '# 人设\n\n旧人设正文\n',
    assist: '# 工作指导\n\n旧指导正文\n',
    prime1001: '# 私有记忆（甲）\n\n## 其他\n- 甲的旧内容\n',
    prime1002: '# 私有记忆（乙）\n\n## 其他\n- 乙的旧内容\n',
  };
  writeFileSync(join(memoryDir, 'PUBMEMORY.md'), content.pub);
  writeFileSync(join(memoryDir, 'CHARACTER.md'), content.character);
  writeFileSync(join(memoryDir, 'ASSIST.md'), content.assist);
  mkdirSync(join(memoryDir, 'private', '1001'), { recursive: true });
  mkdirSync(join(memoryDir, 'private', '1002'), { recursive: true });
  writeFileSync(join(memoryDir, 'private', '1001', 'PRIMEMORY.md'), content.prime1001);
  writeFileSync(join(memoryDir, 'private', '1002', 'PRIMEMORY.md'), content.prime1002);
  insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', join(memoryDir, 'PUBMEMORY.md'));
  insertDoc.run('character:telegram', 'character', 'telegram', join(memoryDir, 'CHARACTER.md'));
  insertDoc.run('assist:telegram', 'assist', 'telegram', join(memoryDir, 'ASSIST.md'));
  insertDoc.run('primemory:telegram:1001', 'primemory', 'telegram:1001', join(memoryDir, 'private', '1001', 'PRIMEMORY.md'));
  insertDoc.run('primemory:telegram:1002', 'primemory', 'telegram:1002', join(memoryDir, 'private', '1002', 'PRIMEMORY.md'));
  return content;
}

describe('migrateMemoryLayout()', () => {
  it('搬迁旧布局：新路径完整、PUBMEMORY 与 private 旧路径清空、根目录模板仍在、path 列同步、镜像与权限正确', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-basic');
    const content = seedLegacyLayout(memoryDir, insertDoc);

    const result = migrateMemoryLayout(db, memoryDir, dataDir);

    // 验收 1：搬迁条数正确（3 份来源级 + 2 份 primemory），跳过、冲突、自愈均为 0。
    expect(result).toMatchObject({ migrated: 5, skipped: 0, conflicts: 0, healed: 0 });

    // 新路径文件完整，内容与旧文件逐字节一致。
    const sourceDir = join(memoryDir, 'sources', 'telegram');
    expect(readFileSync(join(sourceDir, 'PUBMEMORY.md'), 'utf8')).toBe(content.pub);
    expect(readFileSync(join(sourceDir, 'CHARACTER.md'), 'utf8')).toBe(content.character);
    expect(readFileSync(join(sourceDir, 'ASSIST.md'), 'utf8')).toBe(content.assist);
    expect(readFileSync(join(sourceDir, 'private', '1001', 'PRIMEMORY.md'), 'utf8')).toBe(content.prime1001);
    expect(readFileSync(join(sourceDir, 'private', '1002', 'PRIMEMORY.md'), 'utf8')).toBe(content.prime1002);

    // PUBMEMORY.md 与 private/ 是移动：旧路径不再有文件。
    expect(existsSync(join(memoryDir, 'PUBMEMORY.md'))).toBe(false);
    expect(existsSync(join(memoryDir, 'private', '1001', 'PRIMEMORY.md'))).toBe(false);
    expect(existsSync(join(memoryDir, 'private', '1002', 'PRIMEMORY.md'))).toBe(false);

    // CHARACTER.md / ASSIST.md 是复制：根目录模板仍在，内容不变。
    expect(readFileSync(join(memoryDir, 'CHARACTER.md'), 'utf8')).toBe(content.character);
    expect(readFileSync(join(memoryDir, 'ASSIST.md'), 'utf8')).toBe(content.assist);

    // 验收 4：memory_docs.path 指向的文件存在，且已改写为新路径。
    const paths = db.prepare('SELECT id,path FROM memory_docs ORDER BY id').all() as Array<{ id: string; path: string }>;
    expect(paths).toEqual([
      { id: 'assist:telegram', path: join(sourceDir, 'ASSIST.md') },
      { id: 'character:telegram', path: join(sourceDir, 'CHARACTER.md') },
      { id: 'primemory:telegram:1001', path: join(sourceDir, 'private', '1001', 'PRIMEMORY.md') },
      { id: 'primemory:telegram:1002', path: join(sourceDir, 'private', '1002', 'PRIMEMORY.md') },
      { id: 'pubmemory:telegram', path: join(sourceDir, 'PUBMEMORY.md') },
    ]);
    for (const row of paths) expect(existsSync(row.path), `${row.id} 的 path 指向的文件不存在`).toBe(true);

    // 前置镜像：只在有待搬项时写，键是旧相对路径，值是旧内容的 sha256。
    const premigrationPath = join(dataDir, 'memory-premigration.json');
    expect(existsSync(premigrationPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(premigrationPath, 'utf8')) as Record<string, string>;
    expect(snapshot).toEqual({
      'PUBMEMORY.md': sha256(content.pub),
      'CHARACTER.md': sha256(content.character),
      'ASSIST.md': sha256(content.assist),
      'private/1001/PRIMEMORY.md': sha256(content.prime1001),
      'private/1002/PRIMEMORY.md': sha256(content.prime1002),
    });

    // 验收 5：目录 0700，文件 0600。
    for (const dir of [
      join(memoryDir, 'sources'),
      sourceDir,
      join(sourceDir, 'private'),
      join(sourceDir, 'private', '1001'),
    ])
      expect((statSync(dir).mode & 0o777).toString(8), `${dir} 目录权限不是 0700`).toBe('700');
    for (const file of [
      join(sourceDir, 'PUBMEMORY.md'),
      join(sourceDir, 'CHARACTER.md'),
      join(sourceDir, 'ASSIST.md'),
      join(sourceDir, 'private', '1001', 'PRIMEMORY.md'),
    ])
      expect((statSync(file).mode & 0o777).toString(8), `${file} 文件权限不是 0600`).toBe('600');
    expect((statSync(premigrationPath).mode & 0o777).toString(8)).toBe('600');

    closeDatabase(db);
  });

  it('幂等：再运行一次无任何变化，搬迁条数为 0，镜像文件不被覆盖', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-idempotent');
    seedLegacyLayout(memoryDir, insertDoc);
    migrateMemoryLayout(db, memoryDir, dataDir);

    const premigrationPath = join(dataDir, 'memory-premigration.json');
    const before = readFileSync(premigrationPath, 'utf8');
    const beforePaths = db.prepare('SELECT id,path FROM memory_docs ORDER BY id').all();

    const second = migrateMemoryLayout(db, memoryDir, dataDir);

    // 验收 2：搬迁条数为 0；copy 类文件旧新路径稳态共存不算冲突（否则每次启动都会重复报警）；
    // 已经在正确新路径上的行不重复计入自愈。
    expect(second).toMatchObject({ migrated: 0, conflicts: 0, healed: 0 });
    expect(second.skipped).toBeGreaterThan(0);
    // 镜像文件已存在则不覆盖：内容与第一次运行后完全一致。
    expect(readFileSync(premigrationPath, 'utf8')).toBe(before);
    // memory_docs.path 不再变化。
    expect(db.prepare('SELECT id,path FROM memory_docs ORDER BY id').all()).toEqual(beforePaths);

    closeDatabase(db);
  });

  it('全新安装（旧布局文件均不存在）：搬迁条数为 0，不写前置镜像', () => {
    const { memoryDir, dataDir, db } = harness('memory-layout-fresh-install');

    const result = migrateMemoryLayout(db, memoryDir, dataDir);

    expect(result).toMatchObject({ migrated: 0, conflicts: 0, healed: 0 });
    expect(existsSync(join(dataDir, 'memory-premigration.json'))).toBe(false);

    closeDatabase(db);
  });

  it('move 类文件旧路径与新路径同时存在：不覆盖新文件，记一条 warn（conflicts=1）', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-conflict');
    writeFileSync(join(memoryDir, 'PUBMEMORY.md'), '# 公开记忆\n\n## 其他\n- 旧的\n');
    const sourceDir = join(memoryDir, 'sources', 'telegram');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'PUBMEMORY.md'), '# 公开记忆\n\n## 其他\n- 新路径上已经有的内容\n');
    insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', join(memoryDir, 'PUBMEMORY.md'));

    const result = migrateMemoryLayout(db, memoryDir, dataDir);

    // 验收 3：冲突计数为 1，样本指向 PUBMEMORY.md，且未覆盖新文件；冲突不算自愈
    // （自愈的前提是旧路径已经不在，这里旧路径还在，是异常态，不是中断态）。
    expect(result.conflicts).toBe(1);
    expect(result.conflictSample).toBe('PUBMEMORY.md');
    expect(result.migrated).toBe(0);
    expect(result.healed).toBe(0);
    expect(readFileSync(join(sourceDir, 'PUBMEMORY.md'), 'utf8')).toBe('# 公开记忆\n\n## 其他\n- 新路径上已经有的内容\n');
    // 旧文件原样保留（冲突项不删除旧文件）。
    expect(readFileSync(join(memoryDir, 'PUBMEMORY.md'), 'utf8')).toBe('# 公开记忆\n\n## 其他\n- 旧的\n');
    // memory_docs.path 未被这一条冲突改写。
    expect(db.prepare('SELECT path FROM memory_docs WHERE id=?').pluck().get('pubmemory:telegram'))
      .toBe(join(memoryDir, 'PUBMEMORY.md'));
    // 冲突不触发前置镜像：没有任何一项处于「待搬」状态。
    expect(existsSync(join(dataDir, 'memory-premigration.json'))).toBe(false);

    closeDatabase(db);
  });

  /**
   * 上面那条用例只断言了 `migrateMemoryLayout()` 的返回值——返回值不是 warn。
   * 「记一条 warn」这半句判据长在调用点（`apps/bot/src/main.ts`）：conflicts 非零时
   * 走 `tagged("warn", ...)` 而不是 `tagged("info", ...)`。按源码结构断言，
   * 不信任行为侧的 `result.conflicts` 已经覆盖过（`tests/support/source.ts` 是这类判据的
   * 唯一读取口）。判据是顺序：`if (memoryLayout.conflicts)` 分支内、离它最近的一个
   * `"warn"` 出现在该分支之后，且该分支携带的文案（含 `conflictSample`）紧随其后。
   */
  it('main.ts 的冲突分支记的是 warn 级日志，不是 info', () => {
    const main = source('apps/bot/src/main.ts');
    const branch = codeIndex(main, 'if (memoryLayout.conflicts)');
    expect(branch).toBeGreaterThan(-1);
    const level = main.indexOf(code('"warn"'), branch);
    const message = codeIndex(main, '项记忆文件旧路径与新路径同时存在');
    expect(level).toBeGreaterThan(branch);
    expect(message).toBeGreaterThan(level);
  });

  /**
   * 自愈：move 类文件的中断态——`renameSync` 已经把文件搬到新路径、旧路径已经不在，
   * 但 `memory_docs.path` 那一次 `UPDATE` 没跟上（进程在两者之间被杀掉）。这不是
   * plan 字面判据「旧存在且新不存在则搬」能覆盖的状态：旧路径已经不存在，不会被判成
   * pending；只改库，不该再碰一次磁盘上已经在正确位置的文件。
   */
  it('自愈：旧路径已消失、新路径已存在但 path 列未同步——收敛 path，不搬文件，不计入 migrated', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-heal-basic');
    const sourceDir = join(memoryDir, 'sources', 'telegram');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(sourceDir, 'private', '1001'), { recursive: true });
    writeFileSync(join(sourceDir, 'PUBMEMORY.md'), '# 公开记忆\n\n## 其他\n- 已经在新路径\n');
    writeFileSync(join(sourceDir, 'private', '1001', 'PRIMEMORY.md'), '# 私有记忆（甲）\n\n## 其他\n- 已经在新路径\n');
    // 库里的 path 仍是旧路径——旧文件本身已经不在盘上，这正是中断态。
    insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', join(memoryDir, 'PUBMEMORY.md'));
    insertDoc.run('primemory:telegram:1001', 'primemory', 'telegram:1001', join(memoryDir, 'private', '1001', 'PRIMEMORY.md'));
    const pubMtime = statSync(join(sourceDir, 'PUBMEMORY.md')).mtimeMs;
    const primeMtime = statSync(join(sourceDir, 'private', '1001', 'PRIMEMORY.md')).mtimeMs;

    const result = migrateMemoryLayout(db, memoryDir, dataDir);

    // 返回值里新增的唯一字段：healed=2（pubmemory 与 primemory 各一行），其余计数不受影响。
    expect(result).toMatchObject({ migrated: 0, conflicts: 0, healed: 2 });
    // path 收敛到新路径。
    expect(db.prepare('SELECT path FROM memory_docs WHERE id=?').pluck().get('pubmemory:telegram'))
      .toBe(join(sourceDir, 'PUBMEMORY.md'));
    expect(db.prepare('SELECT path FROM memory_docs WHERE id=?').pluck().get('primemory:telegram:1001'))
      .toBe(join(sourceDir, 'private', '1001', 'PRIMEMORY.md'));
    // 自愈只改库，不碰磁盘：内容与 mtime 都不变。
    expect(readFileSync(join(sourceDir, 'PUBMEMORY.md'), 'utf8')).toBe('# 公开记忆\n\n## 其他\n- 已经在新路径\n');
    expect(statSync(join(sourceDir, 'PUBMEMORY.md')).mtimeMs).toBe(pubMtime);
    expect(statSync(join(sourceDir, 'private', '1001', 'PRIMEMORY.md')).mtimeMs).toBe(primeMtime);
    // 不产生前置镜像：没有任何一项处于「待搬」（pending）状态。
    expect(existsSync(join(dataDir, 'memory-premigration.json'))).toBe(false);

    closeDatabase(db);
  });

  it('自愈是幂等的：同一中断态连跑三次，第二、三次 healed 均为 0', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-heal-idempotent');
    const sourceDir = join(memoryDir, 'sources', 'telegram');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'PUBMEMORY.md'), '# 公开记忆\n\n## 其他\n- 已经在新路径\n');
    insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', join(memoryDir, 'PUBMEMORY.md'));

    const first = migrateMemoryLayout(db, memoryDir, dataDir);
    expect(first.healed).toBe(1);
    const second = migrateMemoryLayout(db, memoryDir, dataDir);
    const third = migrateMemoryLayout(db, memoryDir, dataDir);

    // 判别式：若实现写成「对所有落入这一分支的项无条件执行一次 UPDATE」，这里会永远非 0。
    expect(second.healed).toBe(0);
    expect(third.healed).toBe(0);

    closeDatabase(db);
  });

  it('path 本就正确时零动作：healed=0，path 与 updated_at 均不变', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-heal-noop');
    const sourceDir = join(memoryDir, 'sources', 'telegram');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'PUBMEMORY.md'), '# 公开记忆\n\n## 其他\n- 已经在新路径\n');
    insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', join(sourceDir, 'PUBMEMORY.md'));
    // 把 updated_at 改成一个哨兵值：UPDATE 的 SET 子句只有 path，真的零动作时这一列不该被带动。
    db.prepare('UPDATE memory_docs SET updated_at=? WHERE id=?').run(987654321, 'pubmemory:telegram');

    const result = migrateMemoryLayout(db, memoryDir, dataDir);

    expect(result).toMatchObject({ migrated: 0, conflicts: 0, healed: 0 });
    const row = db.prepare('SELECT path,updated_at AS updatedAt FROM memory_docs WHERE id=?').get('pubmemory:telegram') as { path: string; updatedAt: number };
    expect(row.path).toBe(join(sourceDir, 'PUBMEMORY.md'));
    expect(row.updatedAt).toBe(987654321);

    closeDatabase(db);
  });

  it('旧新路径皆不存在时不凭空改写 path（不把一行指向不存在的文件）', () => {
    const { memoryDir, dataDir, db, insertDoc } = harness('memory-layout-heal-neither');
    // 库里有这一行，但两侧磁盘上都没有对应文件——不应发生在正常写入路径下，
    // 出现了也不该被本函数当成待自愈项处理（自愈的前提是新路径确实存在）。
    const staleOldPath = join(memoryDir, 'PUBMEMORY.md');
    insertDoc.run('pubmemory:telegram', 'pubmemory', 'telegram', staleOldPath);

    const result = migrateMemoryLayout(db, memoryDir, dataDir);

    expect(result).toMatchObject({ migrated: 0, conflicts: 0, healed: 0 });
    expect(db.prepare('SELECT path FROM memory_docs WHERE id=?').pluck().get('pubmemory:telegram'))
      .toBe(staleOldPath);
    expect(existsSync(join(memoryDir, 'sources', 'telegram', 'PUBMEMORY.md'))).toBe(false);

    closeDatabase(db);
  });
});
