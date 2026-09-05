import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { PromptDocuments } from '@luoli/core';

/**
 * T2.5-fix 验收：`rollback()` 的次键从 `id DESC` 改 `rowid DESC`。
 *
 * `memory_revisions.id` 是 ulid，同一毫秒内不保证字典序与生成序一致（实测同进程连生成 5 个
 * 即可能乱序）。旧实现 `ORDER BY ts DESC, id DESC` 把 `id` 当同毫秒内的单调次键，两次 `save()`
 * 落在同一毫秒时排序可能与真实写入顺序相反，`rollback()` 定位到错误的修订、内容不回退。
 * `memory_revisions` 是普通 rowid 表（`id TEXT PRIMARY KEY` 不别名 rowid），插入顺序单调，
 * 借用 `rowid` 作次键不受 ulid 同毫秒乱序影响。
 *
 * 用例冻结时钟令两次 `save()` 落同一毫秒，再直接改写两条修订的 `id` 列，强制成与真实写入
 * 顺序相反的字典序——复现 ulid 同毫秒乱序的最坏情形，而不依赖随机数是否恰好乱序。
 */
function harness(name: string) {
  const root = `./data/${name}`;
  rmSync(root, { recursive: true, force: true });
  const memoryDir = join(root, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const db = openDatabase(join(root, 'luoli.db'));
  migrateDatabase(db);
  return { memoryDir, db };
}

describe('PromptDocuments.rollback() 同毫秒次键', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('两次 save 落同一毫秒，rollback 仍能回到前一版', () => {
    const { memoryDir, db } = harness('prompt-documents-rollback-samems');
    const documents = new PromptDocuments(db, memoryDir);
    documents.ensure();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    documents.save('assist', 'telegram', '第一版', 'webui');
    documents.save('assist', 'telegram', '第二版', 'webui');
    vi.useRealTimers();

    const revisions = db
      .prepare(
        "SELECT rowid AS rowid_,id,ts FROM memory_revisions WHERE doc_id='assist:telegram' ORDER BY rowid ASC",
      )
      .all() as Array<{ rowid_: number; id: string; ts: number }>;
    expect(revisions).toHaveLength(2);
    // 确认两条修订确实落在同一毫秒——用例的前提条件，不是本用例要验证的行为。
    expect(revisions[0]!.ts).toBe(revisions[1]!.ts);

    // 强制改写 id：第一条修订（rowid 更小、真实更早写入）拿到字典序更大的 id，
    // 复现 ulid 同毫秒乱序的最坏情形——`id DESC` 排序会把它排到最前，`rowid DESC` 不受影响。
    const olderRevisionId = 'z-forced-older';
    const newerRevisionId = 'a-forced-newer';
    db.prepare('UPDATE memory_revisions SET id=? WHERE rowid=?').run(
      olderRevisionId,
      revisions[0]!.rowid_,
    );
    db.prepare('UPDATE memory_revisions SET id=? WHERE rowid=?').run(
      newerRevisionId,
      revisions[1]!.rowid_,
    );

    const rolledBack = documents.rollback('assist:telegram', olderRevisionId, 'webui');
    expect(rolledBack.id).toBe('assist:telegram');
    const path = join(memoryDir, 'sources', 'telegram', 'ASSIST.md');
    expect(readFileSync(path, 'utf8')).toBe('第一版');

    closeDatabase(db);
  });
});
