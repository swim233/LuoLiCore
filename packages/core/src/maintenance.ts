import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Sqlite } from '@luoli/db';

/** 落在磁盘上、由 DB 行指路的两棵 blob 目录。给不出路径的那一棵就不扫（测试里常只给一棵）。 */
export interface BlobDirectories {
  /** `attachments.local_path` 指向的媒体目录（`media.dir`）。 */
  files?: string;
  /** `agent_runs.result_full_ref` 指向的子 agent 全文目录。 */
  agentResults?: string;
}

export class MaintenanceService {
  constructor(private readonly db: Sqlite, private readonly databasePath: string, private readonly backupKeep: number, private readonly retentionDays: number, private readonly logsDir = './logs', private readonly blobs: BlobDirectories = {},
    private readonly gzipAfterDays = 0, private readonly scheduleRetentionDays = 30) {}

  backup(label = 'manual'): string {
    const directory = resolve(dirname(this.databasePath), 'backup');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `luoli-${Date.now()}-${label}.db`);
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const backups = readdirSync(directory).map((name) => join(directory, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const expired of backups.slice(this.backupKeep)) unlinkSync(expired);
    return path;
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * `logs.gzipAfterDays`：比这个天数更早、且还没压过的 `.jsonl` 就地压成 `.jsonl.gz`。
   * 0 表示不压。压缩发生在删除之前 —— 保留期内的老日志占的盘能小一个数量级，而 `blobs/`
   * 那些单独的 JSON 载荷不动（按 `file_ref` 懒加载的路径不认 `.gz`，压了就读不出来）。
   */
  #gzipOldLogs(cutoffDay: string): number {
    let compressed = 0;
    let days: string[];
    try { days = readdirSync(this.logsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < cutoffDay).map((entry) => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    for (const day of days) {
      const directory = join(this.logsDir, day);
      let entries: string[];
      try { entries = readdirSync(directory); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl') && !/\.jsonl\.\d+$/.test(name)) continue;
        const path = join(directory, name);
        try {
          writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)), { mode: 0o600 });
          unlinkSync(path);
          compressed += 1;
        } catch { /* 读不到或写不进就跳过：压缩是省盘，不是正确性 */ }
      }
    }
    return compressed;
  }

  cleanup(now = Date.now()): Record<string, number> {
    const logCutoff = now - this.retentionDays * 86_400_000;
    const updateCutoff = now - 7 * 86_400_000;
    const approvalsCutoff = now - 90 * 86_400_000;
    const logs = this.db.prepare('DELETE FROM log_events WHERE ts<?').run(logCutoff).changes;
    const updates = this.db.prepare('DELETE FROM processed_updates WHERE ts<?').run(updateCutoff).changes;
    const sessions = this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now).changes;
    const approvals = this.db.prepare("DELETE FROM approvals WHERE requested_at<? AND state!='pending'").run(approvalsCutoff).changes;
    this.db.prepare("UPDATE approvals SET state='expired' WHERE state='pending' AND expires_at<?").run(now);
    const cutoffDay = new Date(logCutoff).toISOString().slice(0, 10);
    let logDirectories = 0;
    try {
      for (const day of readdirSync(this.logsDir, { withFileTypes: true })) {
        if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name) || day.name >= cutoffDay) continue;
        rmSync(join(this.logsDir, day.name), { recursive: true, force: true }); logDirectories += 1;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // 子 agent 的全文结果是调试产物，和日志同龄同命：按 `logs.retentionDays` 过期。
    // 只清文件、把 `result_full_ref` 置空，`result_summary` 留着 —— 摘要是上下文里已经引用过的
    // 东西，删了会让历史轮次的引述变成悬空（docs/22 · I-09）。
    // **媒体附件不在这里过期**：`data/files/**` 是用户数据，自动过期策略是 docs/14 §2 Q9 的
    // 未决问题，替需求方决定不合适。gcFiles() 只扫没有任何 DB 行指向的孤儿。
    let agentResults = 0;
    for (const row of this.db.prepare("SELECT id,result_full_ref AS path FROM agent_runs WHERE result_full_ref IS NOT NULL AND finished_at IS NOT NULL AND finished_at<?").all(logCutoff) as Array<{ id: string; path: string }>) {
      try { rmSync(row.path, { force: true }); } catch { continue; }
      this.db.prepare('UPDATE agent_runs SET result_full_ref=NULL WHERE id=?').run(row.id);
      agentResults += 1;
    }
    // 已结束的定时任务行（完成 / 取消）按 `schedule.retentionDays` 清。**活跃的永不删** ——
    // 一条还在排的任务被清掉的表现是「bot 突然不再提醒了」，而库里什么痕迹都没有。
    const schedules = this.db.prepare("DELETE FROM scheduled_jobs WHERE state<>'active' AND updated_at<?")
      .run(now - this.scheduleRetentionDays * 86_400_000).changes;
    // 压缩在删除之后：已经过保留期的目录整个没了，没必要先压再删。
    const compressed = this.gzipAfterDays > 0 ? this.#gzipOldLogs(new Date(now - this.gzipAfterDays * 86_400_000).toISOString().slice(0, 10)) : 0;
    this.checkpoint();
    return { logs, logDirectories, updates, sessions, approvals, agentResults, schedules, compressed };
  }

  /**
   * 孤儿 blob 清理：磁盘上有、但没有任何 DB 行指向的文件。这不是过期策略 —— 这些文件已经
   * 谁都取不到了（下载中途崩溃、`INSERT OR REPLACE` 换掉了 `local_path`、手工删过库行）。
   * 此前这个端点直接返回 `not_implemented`，两棵目录因此只涨不落（docs/22 · I-09）。
   */
  gcFiles(): Record<string, number | string[]> {
    const sweep = (directory: string | undefined, referenced: Set<string>, table: string): { removed: number; bytes: number; refused?: string } => {
      const result: { removed: number; bytes: number; refused?: string } = { removed: 0, bytes: 0 };
      if (!directory) return result;
      /**
       * **fail-closed 的错配保护**：`referenced` 是空的、而目录里有文件，几乎只有一个成因 ——
       * 这个 DB 和这棵目录属于**两套部署**（最常见的是 `LUOLI_DATA_DIR` 指到别处，而
       * `media.dir` 仍是 cwd 相对路径）。此时「没有行指向它」不代表它是孤儿，而代表我们在拿
       * 错的库问问题，照着删就是把另一套部署的用户数据清空。
       *
       * 这不是假设出来的风险：第七轮的验证过程里就是这么删掉了 76 个真实附件和 90 份子 agent
       * 全文（`docs/25 §10`）。真·空部署的目录本来就是空的，所以拒绝不会误伤它。
       */
      if (!referenced.size) {
        let hasFiles = false;
        const probe = (current: string): void => {
          if (hasFiles) return;
          let entries;
          try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (hasFiles) return;
            if (entry.isDirectory()) probe(join(current, entry.name));
            else if (entry.isFile()) hasFiles = true;
          }
        };
        probe(resolve(directory));
        if (hasFiles) {
          result.refused = `${table} 里一条带路径的行都没有，而 ${directory} 下有文件 —— 这通常意味着库与目录来自两套部署（检查 LUOLI_DATA_DIR 与 media.dir 是否指向同一处）。拒绝清理。`;
          return result;
        }
      }
      const root = resolve(directory);
      const walk = (current: string): void => {
        let entries;
        try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) { walk(path); continue; }
          if (!entry.isFile() || referenced.has(path)) continue;
          try { result.bytes += statSync(path).size; unlinkSync(path); result.removed += 1; } catch { /* 竞态删除或无权限，跳过 */ }
        }
      };
      walk(root);
      return result;
    };
    // 路径按 resolve 后比对：DB 里存的可能是相对路径（`./data/files/...`），磁盘遍历给的是
    // 绝对路径，不归一化的话每个文件都会被判成孤儿——那是把整棵媒体目录删空。
    const referenced = (column: string, table: string): Set<string> =>
      new Set((this.db.prepare(`SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL`).pluck().all() as string[]).map((path) => resolve(path)));
    const files = sweep(this.blobs.files, referenced('local_path', 'attachments'), 'attachments');
    const results = sweep(this.blobs.agentResults, referenced('result_full_ref', 'agent_runs'), 'agent_runs');
    const refused = [files.refused, results.refused].filter((reason): reason is string => Boolean(reason));
    // 拒绝的理由必须交回给调用方：静静地「删了 0 个」会让运维以为目录本来就是干净的。
    return { files: files.removed, fileBytes: files.bytes, agentResults: results.removed, agentResultBytes: results.bytes,
      ...(refused.length ? { refused } : {}) };
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }
}
