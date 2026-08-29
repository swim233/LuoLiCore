import { gzipSync } from "node:zlib";
import {
  chmodSync,
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

/** 位于磁盘上、由 DB 行索引的两棵 blob 目录。未提供路径的那一棵不扫描（测试中常只提供一棵）。 */
export interface BlobDirectories {
  /** `attachments.local_path` 所指向的媒体目录（`media.dir`）。 */
  files?: string;
  /**
   * `agent_runs.result_full_ref` 所指向的子 agent 全文目录。库中该列存储的是相对该目录的
   * 路径（`AgentResultStore.put`，docs/28 · L-OPS-06），因此该值同时是读出侧的解析基准 ——
   * 传错不仅意味着扫描错误的目录，还会使每一条 ref 都解析到别处。存量的绝对路径行仍可识别
   * （`resolve` 对绝对路径是恒等的），它们正是错配保护需要拦截的信号。
   */
  agentResults?: string;
}

/**
 * `maintenance.retention.*` 与 `media.retentionDays`。每一项取 0 表示不清理 —— 保留期属运维策略，
 * 默认值不能表现为静默删除。
 * 此处只包含派生数据：`turns` / `tasks` 是 trace 的骨架，不为它们设置保留期是刻意的（见 schema 注释）。
 */
export interface RetentionDays {
  usage?: number;
  quotaCounters?: number;
  configRevisions?: number;
  memoryRevisions?: number;
  /** `media.retentionDays`（不属于 `maintenance.retention.*`，但过期处理在同一处执行）。 */
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
     * 日志在本层输出，而非在调用方。此前 `maintenance.*` 由 `main.ts` 中五条 cron 的包装层记录，
     * 而 `POST /api/maintenance/:action` 直接调用这些方法后返回 —— 同一操作经两个入口执行时
     * 可观测性不一致：从 WebUI 执行时只剩审计中间件记录的方法与路径（`webui.action`），
     * 清理了多少行、回收了多少字节、`gc-files` 因何 `refused` 全都不可见（docs/29 · M-LOG-01）。
     * 移到本层之后两条路径自动一致，将来新增第三个入口也无需重复实现。
     */
    private readonly log?: LogSink,
  ) {}

  backup(label = "manual"): string {
    const directory = resolve(dirname(this.databasePath), "backup");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `luoli-${Date.now()}-${label}.db`);
    // 使用参数绑定而非自行转义引号：`VACUUM INTO` 接受 SQL 表达式（同 `db/database.ts`，docs/27 · T-05）。
    this.db.prepare("VACUUM INTO ?").run(path);
    // `VACUUM INTO` 创建的文件采用 SQLite 自身的 `0666 & ~umask` —— 常见 umask 下即 0644，
    // 构成一份全局可读的整库快照（docs/29 · `M-SEC-01`）。目录的 0700 只阻止同机其他用户遍历，
    // 而权限位随文件保留：备份一旦被复制、打包或同步出去，该目录级限制即不再生效。
    chmodSync(path, 0o600);
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
   * `VACUUM` 在 WAL 模式下会将整库重写进 WAL，因此执行完成时 WAL 的大小与整库相当；
   * 不执行 checkpoint 就只能等待下一次自动 checkpoint，而那需要累积足够写入将 WAL 推过
   * `wal_autocheckpoint` 阈值 —— 实测 37MB 的库上 WAL 增至 39,325,432 字节，84 秒后仍为
   * 38MB，而 `db.vacuumCron` 默认为周日 5 点，于是每次周维护之后 WAL 会以整库大小保持约 23 小时
   * （docs/28 · L-OPS-05）。一个用于收缩主库的操作却使磁盘占用翻倍，与目标相反。
   * 放在此处而非依赖 `cleanup()`：同一 tick 内两个 cron 的先后顺序不稳定（实测两种顺序均出现），
   * 而 `db.vacuumCron`（每周）比 `general.maintenanceCron`（每日）稀疏，无法依赖后者兜底。
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
   * `logs.gzipAfterDays`：早于该天数且尚未压缩的 `.jsonl` 就地压缩为 `.jsonl.gz`。
   * 0 表示不压缩。压缩发生在删除之前 —— 保留期内的历史日志占用可降低一个数量级，而 `blobs/`
   * 中独立的 JSON 载荷不处理（按 `file_ref` 懒加载的路径不识别 `.gz`，压缩后将无法读取）。
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
          /* 无法读取或写入即跳过：压缩用于节省磁盘，不涉及正确性 */
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
    // 子 agent 的全文结果属调试产物，与日志同周期：按 `logs.retentionDays` 过期。
    // 只删除文件并将 `result_full_ref` 置空，保留 `result_summary` —— 摘要已被上下文引用，
    // 删除会使历史轮次中的引用悬空（docs/22 · I-09）。
    let agentResults = 0;
    for (const row of this.db
      .prepare(
        "SELECT id,result_full_ref AS path FROM agent_runs WHERE result_full_ref IS NOT NULL AND finished_at IS NOT NULL AND finished_at<?",
      )
      .all(logCutoff) as Array<{ id: string; path: string }>) {
      // ref 相对于 `blobs.agentResults`（存量绝对路径行经 resolve 后仍为其自身）。
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
    // 已结束的定时任务行（完成或取消）按 `schedule.retentionDays` 清理。活跃任务永不删除 ——
    // 仍在排期的任务被清除的表现是 bot 突然停止提醒，而库中不留任何痕迹。
    const schedules = this.db
      .prepare(
        "DELETE FROM scheduled_jobs WHERE state<>'active' AND updated_at<?",
      )
      .run(now - this.scheduleRetentionDays * 86_400_000).changes;
    // 四张派生数据表的保留期（`maintenance.retention.*`，docs/27 · R-05）。0 表示不清理，因此
    // `expire` 在天数为 0 或未提供时不修改任何行 —— 默认静默删除数据的风险远高于不删除。
    const expire = (days: number | undefined, sql: string): number =>
      days && days > 0
        ? this.db.prepare(sql).run(now - days * 86_400_000).changes
        : 0;
    const usage = expire(
      this.retention.usage,
      "DELETE FROM usage_ledger WHERE ts<?",
    );
    // 使用 `updated_at` 而非 bucket 字符串：当前账期的行每轮都在更新，不可能落在保留期之外，
    // 而按 bucket 解析日期需先确定它是日账期还是月账期 —— 那是两套格式。
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
    // 媒体文件按 `media.retentionDays` 过期（docs/14 §2 Q9-a）：删除文件、保留行。删除行会使
    // 历史消息中的「[图片]」连同 mime、尺寸、已提取正文一并消失，上下文与检索结果都会缺失。
    // `download_state='expired'` 是刻意设置的：仅将 `local_path` 置空会与下载失败（'failed'）
    // 混为同一状态，运维无法区分是过期清理还是当初未下载成功。gcFiles() 扫描不到这些文件 ——
    // 它只查找没有任何 DB 行指向的孤儿，而这些行始终指向它们。
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
        // force:true 不会因文件已不存在而抛错 —— 这类行同样应标为 expired，否则每天扫描时
        // 都会重试这条永远无法删除的路径。
        try {
          rmSync(row.path, { force: true });
        } catch {
          continue;
        }
        forget.run(row.id);
        mediaFiles += 1;
      }
      /**
       * `web_assets` 采用同一保留期，但删除行而不保留：`attachments` 保留行是因为历史消息中的
       * 「[图片]」需保留 mime、尺寸与已提取正文；网页图片的 `webasset://` part 自身即包含图片
       * 来源的文本，行删除后读出侧照常返回占位文本（`hydrateAttachment` 的 `missing` 分支）。
       * 保留大量 `local_path=NULL` 的行只会使 `gcFiles` 与此处都多一层处理。
       */
      const webAssets = this.db
        .prepare(
          "SELECT id,local_path AS path FROM web_assets WHERE created_at<?",
        )
        .all(mediaCutoff) as Array<{ id: string; path: string | null }>;
      const drop = this.db.prepare("DELETE FROM web_assets WHERE id=?");
      /**
       * 按文件分组处理，而不是按行删除文件。文件名取自内容哈希，因此同一张图片被获取两次时两行
       * 共享同一份字节（`docs/03 §2.4`）。逐行删除文件会连带删除仍在保留期内那行的图片 ——
       * 表现不是报错，而是该图片提前变为图片已不可用的占位文本。此种情况下照常删除行，
       * 字节保留给仍在保留期内的那一行。无法删除的文件则将行保留到下次处理
       * （与上方 `attachments` 相同：宁可重试，不留孤儿）。
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
    // 压缩在删除之后执行：已超过保留期的目录整体已被删除，无需先压缩再删除。
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
    // checkpoint 放在该日志之后：它本身也是一次写入，若先 checkpoint，执行完成时 WAL 中恰好
    // 存在这一行，将 WAL 收缩为 0 在调用方看来即不成立（AC-DB-006 度量的正是返回之后的那一刻）。
    this.checkpoint();
    return result;
  }

  /**
   * 孤儿 blob 清理：磁盘上存在但没有任何 DB 行指向的文件。这不是过期策略 —— 这些文件已无法
   * 被任何路径访问（下载中途崩溃、`INSERT OR REPLACE` 替换了 `local_path`、手工删除过库行）。
   * 此前该端点直接返回 `not_implemented`，两棵目录因此只增不减（docs/22 · I-09）。
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
       * fail-closed 的错配保护：`referenced` 为空而目录中存在文件，几乎只有一种成因 ——
       * 该 DB 与该目录属于两套不同的部署（最常见的是 `LUOLI_DATA_DIR` 指向别处，而
       * `media.dir` 仍是相对 cwd 的路径）。此时没有行指向某文件并不表示它是孤儿，而表示查询
       * 使用了错误的库，据此删除等于清空另一套部署的用户数据。
       *
       * 这不是假设的风险：第七轮验证过程中即因此删除了 76 个真实附件与 90 份子 agent
       * 全文（`docs/25 §10`）。真正的空部署目录本就为空，因此该拒绝不会造成误伤。
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
          result.refused = `${table} 中不存在任何带路径的行，而 ${directory} 下有文件，这通常意味着库与目录来自两套部署（检查 LUOLI_DATA_DIR 与 media.dir 是否指向同一处）。拒绝清理。`;
          return result;
        }
      }
      const root = resolve(directory);
      /**
       * 上面那道守卫只拦截不存在任何带路径行的全量错配，而它所描述的场景
       * （`LUOLI_DATA_DIR` 指向别处）产生的是部分错配：`referenced` 非空，因此它在结构上
       * 永不触发。实测 `agent_runs` 有 269 行带 ref，其中 161 行指向另一个部署根，
       * 被删除的正是文件位于新根而库中记录旧根的那 74 份（docs/28 · L-OPS-06）。
       *
       * 阈值取非零即拒而非某个百分比：一条指向目录之外的 ref 在该目录内无法保护任何文件，
       * 因此它本应保护的那一份会被当作孤儿删除 —— ref 与可能被误删的文件是一一对应的，
       * 不存在可接受的错配比例。
       *
       * 合法的目录外 ref 确实存在一种情形：运维修改过 `media.dir` 而将旧文件留在原位 ——
       * 此时旧行指向的文件仍在，新目录中的每个文件也都有行指向，实际没有可误删的内容。
       * 这类部署会被该保护拦截（少执行一次孤儿清理），因此文案必须给出可操作的下一步；
       * 反之放行的代价是删除他人的数据，两者的不对称性非常明显。
       *
       * 不要将条件收窄为目录外且磁盘上已不存在 —— 那是错误的。本轮的测试环境正是生产 data/
       * 的完整副本：旧根的文件仍在，而新根的那份仍会被整批当作孤儿删除，收窄之后该保护
       * 恰好会在真实事故发生时放行。
       * 子 agent 结果所在列此后存储相对路径（`AgentResultStore.put`），从此天然免疫；
       * 剩余会到达此处的绝对路径行，正是启动期归一化刻意保留、需要人工确认的那些。
       */
      const prefix = root.endsWith(sep) ? root : root + sep;
      const outside = [...referenced].filter(
        (path) => !path.startsWith(prefix),
      );
      if (outside.length) {
        result.refused =
          `${table} 中有 ${outside.length}/${referenced.size} 行指向 ${root} 之外（例如 ${outside[0]}），库与该目录很可能来自两套部署，或目录已迁移而库中的行未同步更新。` +
          `拒绝清理：这些行无法保护该目录中的任何文件，按此删除会将应保留的数据当作孤儿清空。` +
          `确认后请将这些行的路径改为当前目录，或将 LUOLI_DATA_DIR / media.dir 指回原处，再重新执行。`;
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
            /* 竞态删除或权限不足，跳过 */
          }
        }
      };
      walk(root);
      return result;
    };
    // 路径经 resolve 后比对：DB 中存储的是相对路径（`attachments.local_path` 相对 cwd、
    // `agent_runs.result_full_ref` 相对结果目录），磁盘遍历给出的是绝对路径，不归一化的话每个
    // 文件都会被判为孤儿，即清空整棵媒体目录。存储相对路径的一侧是保护而非风险来源：
    // 归一化使用的 base 与 walk 的 root 同源，目录整体迁移后仍能匹配（docs/28 · L-OPS-06）。
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
     * `media.dir` 下目前有两张表引用文件：`attachments`（Telegram 附件）与 `web_assets`
     * （`web_fetch` / MCP 抓取的图片）。遗漏其中一张的表现不是报错，而是该表的文件被静默当作
     * 孤儿删除 —— 本仓库已发生两次（docs/25 §10 删除 76 个真实附件、docs/28 · L-OPS-06 删除 74 份全文）。
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
    // 拒绝原因必须返回给调用方：静默返回删除 0 个会使运维误认为目录本就是干净的。
    const result = {
      files: files.removed,
      fileBytes: files.bytes,
      agentResults: results.removed,
      agentResultBytes: results.bytes,
      ...(refused.length ? { refused } : {}),
    };
    // 被拒记为 warn 而非 info：它唯一的触发条件是库与目录来自两套部署，正是运维应立即
    // 停止操作的情形，混在 info 中等于将其隐藏（与 WebUI 中不自动消失的 Toast 同理）。
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
