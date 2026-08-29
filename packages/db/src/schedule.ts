import type { Sqlite } from "./database.js";

export type ScheduledJobMode = "agent" | "notify";
export type ScheduledJobState = "active" | "done" | "cancelled";

export interface ScheduledJob {
  id: string;
  key: string;
  chatId: string;
  threadId: number | null;
  createdBy: string;
  name: string;
  mode: ScheduledJobMode;
  /** 与 `runAt` 二选一：周期任务填 cron 表达式，一次性任务填绝对时间。 */
  cron: string | null;
  runAt: number | null;
  timezone: string;
  payload: string;
  state: ScheduledJobState;
  runCount: number;
  lastRunAt: number | null;
  lastState: string | null;
  lastError: string | null;
  /** 0/1：该任务允许模型声明本轮不投递（迁移 0013，docs/02 §10.5）。 */
  allowSilent: number;
  /** 连续静默次数。任何非 silent 的触发结果将其归零；超过 `SILENT_STREAK_WARN` 后 `schedule.silent` 升为 warn。 */
  silentStreak: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewScheduledJob {
  id: string;
  key: string;
  chatId: string;
  threadId: number | null;
  createdBy: string;
  name: string;
  mode: ScheduledJobMode;
  cron: string | null;
  runAt: number | null;
  timezone: string;
  payload: string;
  /** 可选，默认 0：该字段是后加的，既有调用方无需修改。 */
  allowSilent?: boolean;
}

/**
 * `update` 的补丁：只写入给出的字段，缺席字段保持原值。仅修改正文不应连带重算触发时间
 * （`updateScheduledJob` 的约束）。
 */
export interface ScheduledJobPatch {
  name?: string;
  payload?: string;
  allowSilent?: boolean;
  /**
   * 触发方式整块替换。表上有约束 `CHECK ((cron IS NULL) + (run_at IS NULL) = 1)`，若拆成两个独立的
   * 可选字段，「从 at 改为 cron」必然违反约束：写入 cron 时 run_at 仍在，两列同时非空。
   */
  trigger?: { cron: string; runAt: null } | { cron: null; runAt: number };
}

const COLUMNS = `id,key,chat_id AS chatId,thread_id AS threadId,created_by AS createdBy,name,mode,cron,run_at AS runAt,timezone,payload,
  state,run_count AS runCount,last_run_at AS lastRunAt,last_state AS lastState,last_error AS lastError,
  allow_silent AS allowSilent,silent_streak AS silentStreak,created_at AS createdAt,updated_at AS updatedAt`;

/**
 * `scheduled_jobs` 的唯一访问入口。
 *
 * 每个读方法都要求传入 `key`（装载用的 `listActive` 除外）：会话隔离在这一层强制，理由同
 * `ScopedArchiveRepository`。工具侧只要漏传一次 key，群成员就能列出并取消其他会话的任务
 * （docs/05 §8：工具的 inputSchema 中没有 chatId 一类字段）。
 */
export class ScheduleRepository {
  constructor(private readonly db: Sqlite) {}

  /** 同会话内活跃任务重名会违反 `ux_sched_name` 并抛 SQLITE_CONSTRAINT，调用方需将其转为 `{ok:false}`。 */
  create(input: NewScheduledJob): ScheduledJob {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO scheduled_jobs(id,key,chat_id,thread_id,created_by,name,mode,cron,run_at,timezone,payload,allow_silent,state,created_at,updated_at)
      VALUES (@id,@key,@chatId,@threadId,@createdBy,@name,@mode,@cron,@runAt,@timezone,@payload,@allowSilent,'active',@now,@now)`,
      )
      .run({ ...input, allowSilent: input.allowSilent ? 1 : 0, now });
    return this.byId(input.id)!;
  }

  byId(id: string): ScheduledJob | null {
    return (
      (this.db
        .prepare(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE id=?`)
        .get(id) as ScheduledJob | undefined) ?? null
    );
  }

  byName(key: string, name: string): ScheduledJob | null {
    return (
      (this.db
        .prepare(
          `SELECT ${COLUMNS} FROM scheduled_jobs WHERE key=? AND name=? AND state='active'`,
        )
        .get(key, name) as ScheduledJob | undefined) ?? null
    );
  }

  /** 装载用：跨会话取全部活跃任务，仅供进程启动时的 `ScheduledJobRunner.load()` 调用。 */
  listActive(): ScheduledJob[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_jobs WHERE state='active' ORDER BY created_at`,
      )
      .all() as ScheduledJob[];
  }

  /**
   * 跨会话取全部任务，活跃的排在前面。仅供 WebUI 运维面板使用（单 owner 身份，docs/14 A15）。
   * 工具侧一律走 `listByKey`，会话隔离在那一层是硬边界。
   */
  listAll(limit = 500): ScheduledJob[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_jobs
      ORDER BY (state='active') DESC,COALESCE(last_run_at,created_at) DESC LIMIT ?`,
      )
      .all(limit) as ScheduledJob[];
  }

  /** 本会话的任务：活跃的在前，已结束的按时间倒序，供 `schedule_list` 与 WebUI 使用。 */
  listByKey(key: string, limit = 50): ScheduledJob[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_jobs WHERE key=?
      ORDER BY (state='active') DESC,COALESCE(last_run_at,created_at) DESC LIMIT ?`,
      )
      .all(key, limit) as ScheduledJob[];
  }

  countActive(key: string): number {
    return this.db
      .prepare(
        "SELECT COUNT(*) FROM scheduled_jobs WHERE key=? AND state='active'",
      )
      .pluck()
      .get(key) as number;
  }

  /** 返回是否真的更新了一行：调用方需要区分「已取消」与「不存在或已结束」。 */
  finish(
    id: string,
    state: Exclude<ScheduledJobState, "active">,
    lastState?: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE scheduled_jobs SET state=?,last_state=COALESCE(?,last_state),updated_at=? WHERE id=? AND state='active'",
        )
        .run(state, lastState ?? null, Date.now(), id).changes === 1
    );
  }

  /**
   * 记录一次触发的结果。`lastError` 显式置 null 而非 COALESCE：上一次的错误不应残留在本次成功上。
   *
   * `silent_streak` 用一句 `CASE` 就地计算：读出后再写回在多实例下会丢更新（docs/01 §3.1 表首行），
   * 而该计数是判断任务已静默多久的唯一凭据。
   */
  markRun(
    id: string,
    input: { state: string; error?: string; at?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET run_count=run_count+1,last_run_at=@at,last_state=@state,last_error=@error,
      silent_streak=CASE WHEN @state='silent' THEN silent_streak+1 ELSE 0 END,updated_at=@at WHERE id=@id`,
      )
      .run({
        id,
        at: input.at ?? Date.now(),
        state: input.state,
        error: input.error ?? null,
      });
  }

  /**
   * 修改一条活跃任务。changes 为 0（不存在或已结束）时返回 null，调用方据此返回 409 而非假成功。
   * 只写入给出的字段，缺席的列不做修改。
   */
  update(id: string, patch: ScheduledJobPatch): ScheduledJob | null {
    const assignments: string[] = [];
    const values: Record<string, unknown> = { id, now: Date.now() };
    if (patch.name !== undefined) {
      assignments.push("name=@name");
      values.name = patch.name;
    }
    if (patch.payload !== undefined) {
      assignments.push("payload=@payload");
      values.payload = patch.payload;
    }
    if (patch.allowSilent !== undefined) {
      assignments.push("allow_silent=@allowSilent");
      values.allowSilent = patch.allowSilent ? 1 : 0;
    }
    if (patch.trigger !== undefined) {
      assignments.push("cron=@cron", "run_at=@runAt");
      values.cron = patch.trigger.cron;
      values.runAt = patch.trigger.runAt;
    }
    if (!assignments.length) return null;
    const changed = this.db
      .prepare(
        `UPDATE scheduled_jobs SET ${assignments.join(",")},updated_at=@now WHERE id=@id AND state='active'`,
      )
      .run(values).changes;
    return changed === 1 ? this.byId(id) : null;
  }

  /**
   * 硬删除指定行（含活跃任务）。与 `purge(before)` 是两个不同操作：后者按保留期清理已结束的任务，
   * 两者混淆一次即导致全库已结束任务被清空。
   *
   * 删除活跃行的调用方必须先调用 `runner.unregister(id)`：cron 仍注册而行已删除时，
   * 下次触发扫到的是一条不存在的任务。
   */
  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM scheduled_jobs WHERE id=?").run(id)
        .changes === 1
    );
  }

  /** 保留期清理：已结束的行保留 `schedule.retentionDays` 天，活跃行永不删除。 */
  purge(before: number): number {
    return this.db
      .prepare(
        "DELETE FROM scheduled_jobs WHERE state<>'active' AND updated_at<?",
      )
      .run(before).changes;
  }
}
