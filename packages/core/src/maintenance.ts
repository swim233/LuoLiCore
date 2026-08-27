import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Sqlite } from "@luoli/db";
import type { LogSink } from "./log/sink.js";

/** 落在磁盘上、由 DB 行指路的两棵 blob 目录。给不出路径的那一棵就不扫（测试里常只给一棵）。 */
export interface BlobDirectories {
  /** `attachments.local_path` 指向的媒体目录（`media.dir`）。 */
  files?: string;
  /**
   * `agent_runs.result_full_ref` 指向的子 agent 全文目录。库里那一列存的是**相对这棵目录**的
   * 路径（`AgentResultStore.put`，docs/28 · L-OPS-06），所以这个值同时是读出侧的解析基准 ——
   * 给错了不只是「扫错目录」，还会让每一条 ref 都解析到别处。存量绝对路径行仍能认（`resolve`
   * 对绝对路径是恒等），它们正是错配保护要拦下来的信号。
   */
  agentResults?: string;
}

/**
 * `maintenance.retention.*` + `media.retentionDays`。**每一项 0 = 不清** —— 保留期是运维策略，
 * 缺省不能变成「悄悄删了」。
 * 只有派生数据在这里：`turns` / `tasks` 是 trace 的骨架，不给它们保留期是刻意的（见 schema 注释）。
 */
export interface RetentionDays {
  usage?: number;
  quotaCounters?: number;
  configRevisions?: number;
  memoryRevisions?: number;
  /** `media.retentionDays`（不在 `maintenance.retention.*` 下，但过期动作在同一处执行）。 */
  media?: number;
}

export class MaintenanceService {
  constructor(
    private readonly db: Sqlite,
    private readonly databasePath: string,
    private readonly backupKeep: number,
    private readonly retentionDays: number,
    private readonly logsDir = "./logs",
    private readonly blobs: BlobDirectories = {},
    private readonly gzipAfterDays = 0,
    private readonly scheduleRetentionDays = 30,
    private readonly retention: RetentionDays = {},
    /**
     * 日志在**这一层**发，不在调用方。此前 `maintenance.*` 是 `main.ts` 那五条 cron 的包装层落的，
     * 而 `POST /api/maintenance/:action` 直接调这些方法就返回 —— 同一个操作从两个入口跑，
     * 可观测性不一样：从 WebUI 跑只剩审计中间件那条「方法 + 路径」的 `webui.action`，
     * 清了多少行、回收了多少字节、`gc-files` 为什么 `refused` 一概看不到（docs/29 · M-LOG-01）。
     * 落在这里之后两条路自动一致，将来第三个入口也不用再抄一遍。
     */
    private readonly log?: LogSink,
  ) {}

  backup(label = "manual"): string {
    const directory = resolve(dirname(this.databasePath), "backup");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `luoli-${Date.now()}-${label}.db`);
    // 绑参数而不是自己转义引号：`VACUUM INTO` 收 SQL 表达式（同 `db/database.ts`，docs/27 · T-05）。
    this.db.prepare("VACUUM INTO ?").run(path);
    const backups = readdirSync(directory)
      .map((name) => join(directory, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const expired = backups.slice(this.backupKeep);
    for (const stale of expired) unlinkSync(stale);
    this.log?.event({
      level: "info",
      kind: "maintenance.backup",
      summary: `Backup written to ${path}`,
      data: { path, label, kept: this.backupKeep, removed: expired.length },
    });
    return path;
  }

  /**
   * `VACUUM` 在 WAL 模式下把**整库重写一遍进 WAL**，所以跑完这一刻 WAL 就有整库那么大；
   * 不 checkpoint 就只能等下一次自动 checkpoint，而那要攒够写入把 WAL 推过
   * `wal_autocheckpoint` 阈值 —— 实测 37MB 的库上 WAL 冲到 39,325,432 字节、**84 秒后仍是
   * 38MB**，而 `db.vacuumCron` 默认周日 5 点，于是每次周维护之后 WAL 要以整库大小挂约 23 小时
   * （docs/28 · L-OPS-05）。一个「收缩主库」的动作让占盘翻倍，正好反了。
   * 挂在这里而不是靠 `cleanup()` 那次：同一 tick 内两个 cron 的先后并不稳定（实测两种顺序都有），
   * 而 `db.vacuumCron`（周）比 `general.maintenanceCron`（日）稀疏，指望后者兜是指望不上的。
   */
  vacuum(): void {
    const startedAt = Date.now();
    this.db.exec("VACUUM");
    this.checkpoint();
    this.log?.event({
      level: "info",
      kind: "maintenance.vacuum",
      summary: "VACUUM complete",
      durationMs: Date.now() - startedAt,
    });
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  /**
   * `logs.gzipAfterDays`：比这个天数更早、且还没压过的 `.jsonl` 就地压成 `.jsonl.gz`。
   * 0 表示不压。压缩发生在删除之前 —— 保留期内的老日志占的盘能小一个数量级，而 `blobs/`
   * 那些单独的 JSON 载荷不动（按 `file_ref` 懒加载的路径不认 `.gz`，压了就读不出来）。
   */
  #gzipOldLogs(cutoffDay: string): number {
    let compressed = 0;
    let days: string[];
    try {
      days = readdirSync(this.logsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            /^\d{4}-\d{2}-\d{2}$/.test(entry.name) &&
            entry.name < cutoffDay,
        )
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    for (const day of days) {
      const directory = join(this.logsDir, day);
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl") && !/\.jsonl\.\d+$/.test(name)) continue;
        const path = join(directory, name);
        try {
          writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)), {
            mode: 0o600,
          });
          unlinkSync(path);
          compressed += 1;
        } catch {
          /* 读不到或写不进就跳过：压缩是省盘，不是正确性 */
        }
      }
    }
    return compressed;
  }

  cleanup(now = Date.now()): Record<string, number> {
    const logCutoff = now - this.retentionDays * 86_400_000;
    const updateCutoff = now - 7 * 86_400_000;
    const approvalsCutoff = now - 90 * 86_400_000;
    const logs = this.db
      .prepare("DELETE FROM log_events WHERE ts<?")
      .run(logCutoff).changes;
    const updates = this.db
      .prepare("DELETE FROM processed_updates WHERE ts<?")
      .run(updateCutoff).changes;
    const sessions = this.db
      .prepare("DELETE FROM sessions WHERE expires_at<?")
      .run(now).changes;
    const approvals = this.db
      .prepare(
        "DELETE FROM approvals WHERE requested_at<? AND state!='pending'",
      )
      .run(approvalsCutoff).changes;
    this.db
      .prepare(
        "UPDATE approvals SET state='expired' WHERE state='pending' AND expires_at<?",
      )
      .run(now);
    const cutoffDay = new Date(logCutoff).toISOString().slice(0, 10);
    let logDirectories = 0;
    try {
      for (const day of readdirSync(this.logsDir, { withFileTypes: true })) {
        if (
          !day.isDirectory() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(day.name) ||
          day.name >= cutoffDay
        )
          continue;
        rmSync(join(this.logsDir, day.name), { recursive: true, force: true });
        logDirectories += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 子 agent 的全文结果是调试产物，和日志同龄同命：按 `logs.retentionDays` 过期。
    // 只清文件、把 `result_full_ref` 置空，`result_summary` 留着 —— 摘要是上下文里已经引用过的
    // 东西，删了会让历史轮次的引述变成悬空（docs/22 · I-09）。
    let agentResults = 0;
    for (const row of this.db
      .prepare(
        "SELECT id,result_full_ref AS path FROM agent_runs WHERE result_full_ref IS NOT NULL AND finished_at IS NOT NULL AND finished_at<?",
      )
      .all(logCutoff) as Array<{ id: string; path: string }>) {
      // ref 是相对 `blobs.agentResults` 的（存量绝对路径行 resolve 后是它自己）。
      try {
        rmSync(resolve(this.blobs.agentResults ?? ".", row.path), {
          force: true,
        });
      } catch {
        continue;
      }
      this.db
        .prepare("UPDATE agent_runs SET result_full_ref=NULL WHERE id=?")
        .run(row.id);
      agentResults += 1;
    }
    // 已结束的定时任务行（完成 / 取消）按 `schedule.retentionDays` 清。**活跃的永不删** ——
    // 一条还在排的任务被清掉的表现是「bot 突然不再提醒了」，而库里什么痕迹都没有。
    const schedules = this.db
      .prepare(
        "DELETE FROM scheduled_jobs WHERE state<>'active' AND updated_at<?",
      )
      .run(now - this.scheduleRetentionDays * 86_400_000).changes;
    // 四张派生数据表的保留期（`maintenance.retention.*`，docs/27 · R-05）。0 = 不清，所以
    // `expire` 在天数为 0 / 未给时**一行都不动** —— 默认沉默地删数据比不删危险得多。
    const expire = (days: number | undefined, sql: string): number =>
      days && days > 0
        ? this.db.prepare(sql).run(now - days * 86_400_000).changes
        : 0;
    const usage = expire(
      this.retention.usage,
      "DELETE FROM usage_ledger WHERE ts<?",
    );
    // `updated_at` 而不是 bucket 字符串：当前账期的行每轮都在更新，不可能落在保留期之外，
    // 而按 bucket 解析日期得先知道它是日还是月账期 —— 那是两套格式。
    const quotaCounters = expire(
      this.retention.quotaCounters,
      "DELETE FROM quota_counters WHERE updated_at<?",
    );
    const configRevisions = expire(
      this.retention.configRevisions,
      "DELETE FROM config_revisions WHERE ts<?",
    );
    const memoryRevisions = expire(
      this.retention.memoryRevisions,
      "DELETE FROM memory_revisions WHERE ts<?",
    );
    // 媒体文件按 `media.retentionDays` 过期（docs/14 §2 Q9-a）：**删文件、留行**。行删掉的话
    // 历史消息里那条「[图片]」会连同 mime/尺寸/已提取正文一起消失，上下文与检索结果都缺一块。
    // `download_state='expired'` 是刻意的：只把 `local_path` 置空会和「下载失败」（'failed'）
    // 混成同一种状态，运维分不出是过期清的还是当初就没下来。gcFiles() 扫不到这些文件 ——
    // 它只找没有任何 DB 行指向的孤儿，而这些行一直指着。
    let mediaFiles = 0;
    if (this.retention.media && this.retention.media > 0) {
      const mediaCutoff = now - this.retention.media * 86_400_000;
      const forget = this.db.prepare(
        "UPDATE attachments SET local_path=NULL,download_state='expired' WHERE id=?",
      );
      for (const row of this.db
        .prepare(
          "SELECT id,local_path AS path FROM attachments WHERE local_path IS NOT NULL AND created_at<?",
        )
        .all(mediaCutoff) as Array<{ id: string; path: string }>) {
        // force:true 不为「文件已经不在了」抛错 —— 那种行同样该标成 expired，否则每天扫一遍
        // 都要再试一次这条永远删不掉的路径。
        try {
          rmSync(row.path, { force: true });
        } catch {
          continue;
        }
        forget.run(row.id);
        mediaFiles += 1;
      }
      /**
       * `web_assets` 走同一个保留期，但**删行不留行**：`attachments` 留行是因为历史消息里那条
       * 「[图片]」要保住 mime / 尺寸 / 已提取正文；网页图那条 `webasset://` part 自己就带着
       * 「这张图取自哪」的文本，行没了读出侧照旧交回占位文本（`hydrateAttachment` 的
       * `missing` 分支）。留一堆 `local_path=NULL` 的行只是让 `gcFiles` 与这里都得多绕一次。
       */
      const webAssets = this.db
        .prepare(
          "SELECT id,local_path AS path FROM web_assets WHERE created_at<?",
        )
        .all(mediaCutoff) as Array<{ id: string; path: string | null }>;
      const drop = this.db.prepare("DELETE FROM web_assets WHERE id=?");
      /**
       * **按文件分组，而不是按行删文件。** 文件名取内容哈希，所以同一张图被取两次时两行共享同一份
       * 字节（`docs/03 §2.4`）。见行就删文件会把**还在保留期内**那行的图一起弄没 —— 表现不是报错，
       * 是那张图提前变成「[图片已不可用：附件文件已丢失]」。这种情况下行照删、字节留给那一行。
       * 删不掉的文件则把行留到下次（与上面 `attachments` 同一条：宁可重试，不留孤儿）。
       */
      const referencedLater = this.db
        .prepare(
          "SELECT 1 FROM web_assets WHERE local_path=? AND created_at>=? LIMIT 1",
        )
        .pluck();
      const expiredByPath = new Map<string, string[]>();
      for (const row of webAssets) {
        if (!row.path) {
          drop.run(row.id);
          continue;
        }
        expiredByPath.set(row.path, [
          ...(expiredByPath.get(row.path) ?? []),
          row.id,
        ]);
      }
      for (const [path, ids] of expiredByPath) {
        if (!referencedLater.get(path, mediaCutoff)) {
          try {
            rmSync(path, { force: true });
          } catch {
            continue;
          }
          mediaFiles += 1;
        }
        for (const id of ids) drop.run(id);
      }
    }
    // 压缩在删除之后：已经过保留期的目录整个没了，没必要先压再删。
    const compressed =
      this.gzipAfterDays > 0
        ? this.#gzipOldLogs(
            new Date(now - this.gzipAfterDays * 86_400_000)
              .toISOString()
              .slice(0, 10),
          )
        : 0;
    const result = {
      logs,
      logDirectories,
      updates,
      sessions,
      approvals,
      agentResults,
      schedules,
      compressed,
      usage,
      quotaCounters,
      configRevisions,
      memoryRevisions,
      mediaFiles,
    };
    this.log?.event({
      level: "info",
      kind: "maintenance.cleanup",
      summary: "Cleanup complete",
      data: result,
    });
    // checkpoint 放在这条日志**之后**：它自己也是一次写入，先 checkpoint 的话跑完这一刻 WAL 里
    // 正好躺着这一行，「把 WAL 收回 0」在调用方看来就不成立（AC-DB-006 量的就是返回之后那一刻）。
    this.checkpoint();
    return result;
  }

  /**
   * 孤儿 blob 清理：磁盘上有、但没有任何 DB 行指向的文件。这不是过期策略 —— 这些文件已经
   * 谁都取不到了（下载中途崩溃、`INSERT OR REPLACE` 换掉了 `local_path`、手工删过库行）。
   * 此前这个端点直接返回 `not_implemented`，两棵目录因此只涨不落（docs/22 · I-09）。
   */
  gcFiles(): Record<string, number | string[]> {
    const sweep = (
      directory: string | undefined,
      referenced: Set<string>,
      table: string,
    ): { removed: number; bytes: number; refused?: string } => {
      const result: { removed: number; bytes: number; refused?: string } = {
        removed: 0,
        bytes: 0,
      };
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
          try {
            entries = readdirSync(current, { withFileTypes: true });
          } catch {
            return;
          }
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
      /**
       * 上面那道守卫只挡「一条带路径的行都没有」这种**全错配**，而它自己描述的场景
       * （`LUOLI_DATA_DIR` 指到别处）产生的是**部分错配**：`referenced` 非空，于是它结构性地
       * 永远不触发。实测 `agent_runs` 269 行带 ref、其中 161 行指向另一个部署根，
       * 被删掉的正是「盘上在新根、库里记着旧根」那 74 份（docs/28 · L-OPS-06）。
       *
       * **阈值取「非零即拒」而不是某个百分比**：一条指向目录外的 ref 在这棵目录里护不住任何
       * 文件，于是它本该保护的那一份就会被当成孤儿删掉 —— ref 与可能被误删的文件是一对一的，
       * 不存在「可以接受的错配比例」。
       *
       * 「合法的目录外 ref」确实存在一种：运维改过 `media.dir` 而把老文件留在原地不动 ——
       * 此时老行指着的文件还在，新目录里的每个文件也都有行指着，其实没什么可误删的。
       * 这种部署会被这道保护挡住（少清一次孤儿），所以文案必须给出可操作的下一步；
       * 反过来放行的代价是删掉别人的数据，不对称得很明显。
       *
       * **想收窄成「目录外且盘上已经不在」的话别做 —— 那是错的。** 本轮的装置正是「生产 data/
       * 的完整副本」：老根的文件还在，而新根那份仍然会被整批当孤儿删掉，收窄之后这道保护
       * 恰好在真实事故那一刻放行。
       * 子 agent 结果那一列此后存相对路径（`AgentResultStore.put`），从此天然免疫；
       * 剩下会走到这里的绝对路径行就是启动期归一化刻意留下的、要人先看一眼的那些。
       */
      const prefix = root.endsWith(sep) ? root : root + sep;
      const outside = [...referenced].filter(
        (path) => !path.startsWith(prefix),
      );
      if (outside.length) {
        result.refused =
          `${table} 里有 ${outside.length}/${referenced.size} 行指向 ${root} 之外（例如 ${outside[0]}）—— 库与这棵目录很可能来自两套部署，或者目录搬过而库里的行没跟着改。` +
          `拒绝清理：那些行在这棵目录里护不住任何文件，照着删会把本该留下的数据当孤儿删空。` +
          `确认之后要么把这些行的路径改到当前目录，要么把 LUOLI_DATA_DIR / media.dir 指回原处，再跑一次。`;
        return result;
      }
      const walk = (current: string): void => {
        let entries;
        try {
          entries = readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) {
            walk(path);
            continue;
          }
          if (!entry.isFile() || referenced.has(path)) continue;
          try {
            result.bytes += statSync(path).size;
            unlinkSync(path);
            result.removed += 1;
          } catch {
            /* 竞态删除或无权限，跳过 */
          }
        }
      };
      walk(root);
      return result;
    };
    // 路径按 resolve 后比对：DB 里存的是相对路径（`attachments.local_path` 相对 cwd、
    // `agent_runs.result_full_ref` 相对结果目录），磁盘遍历给的是绝对路径，不归一化的话每个
    // 文件都会被判成孤儿——那是把整棵媒体目录删空。**存相对路径的那一半是保护而不是共犯**：
    // 归一化用的 base 与 walk 的 root 同源，目录整体搬走也不会对不上（docs/28 · L-OPS-06）。
    const referenced = (
      column: string,
      table: string,
      base = ".",
    ): Set<string> =>
      new Set(
        (
          this.db
            .prepare(
              `SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL`,
            )
            .pluck()
            .all() as string[]
        ).map((path) => resolve(base, path)),
      );
    /**
     * **`media.dir` 下现在有两张表在引用文件**：`attachments`（Telegram 附件）与 `web_assets`
     * （`web_fetch` / MCP 抓回来的图）。少并一张的表现不是报错，是那张表的文件被静静当孤儿删掉
     * —— 这个坑本仓踩过两次（docs/25 §10 删掉 76 个真实附件、docs/28 · L-OPS-06 删掉 74 份全文）。
     */
    const mediaRefs = new Set([
      ...referenced("local_path", "attachments"),
      ...referenced("local_path", "web_assets"),
    ]);
    const files = sweep(this.blobs.files, mediaRefs, "attachments/web_assets");
    const results = sweep(
      this.blobs.agentResults,
      referenced(
        "result_full_ref",
        "agent_runs",
        this.blobs.agentResults ?? ".",
      ),
      "agent_runs",
    );
    const refused = [files.refused, results.refused].filter(
      (reason): reason is string => Boolean(reason),
    );
    // 拒绝的理由必须交回给调用方：静静地「删了 0 个」会让运维以为目录本来就是干净的。
    const result = {
      files: files.removed,
      fileBytes: files.bytes,
      agentResults: results.removed,
      agentResultBytes: results.bytes,
      ...(refused.length ? { refused } : {}),
    };
    // 被拒是 warn 而不是 info：它唯一的触发条件是「库与目录来自两套部署」，正是运维最该立刻
    // 停手的那一种，混在 info 里等于把它藏起来（同 WebUI 那条不自动消失的 Toast）。
    this.log?.event({
      level: refused.length ? "warn" : "info",
      kind: "maintenance.gc_files",
      summary: refused.length
        ? `Orphan sweep refused: ${refused.join("; ")}`
        : `Swept ${files.removed + results.removed} orphan files`,
      data: result,
    });
    return result;
  }

  rebuildFts(): void {
    const startedAt = Date.now();
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    this.log?.event({
      level: "info",
      kind: "maintenance.rebuild_fts",
      summary: "FTS index rebuilt",
      durationMs: Date.now() - startedAt,
    });
  }
}
