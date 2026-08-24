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
  /** 与 `runAt` 二者其一：周期任务给 cron 表达式，一次性任务给绝对时间。 */
  cron: string | null;
  runAt: number | null;
  timezone: string;
  payload: string;
  state: ScheduledJobState;
  runCount: number;
  lastRunAt: number | null;
  lastState: string | null;
  lastError: string | null;
  /** 0/1：这条任务允许模型宣布「本轮不用汇报」（迁移 0013，docs/02 §10.5）。 */
  allowSilent: number;
  /** 连续静默次数。任何非 silent 的触发结果归零；`SILENT_STREAK_WARN` 之后 `schedule.silent` 升 warn。 */
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
  /** 可选（默认 0）：这一位是后加的，既有调用方一处都不用改。 */
  allowSilent?: boolean;
}

/**
 * `update` 的补丁。给出的字段才写，缺席的原样保留 —— 「只改了一句正文」不该顺手把触发时间
 * 也重新算一遍（`updateScheduledJob` 那条红线）。
 */
export interface ScheduledJobPatch {
  name?: string;
  payload?: string;
  allowSilent?: boolean;
  /**
   * 触发方式**整块**换。表上有 `CHECK ((cron IS NULL) + (run_at IS NULL) = 1)`，做成两个各自
   * 独立的可选字段的话，「从 at 改成 cron」那一步一定炸：写 cron 时 run_at 还在，两列都非空。
   */
  trigger?: { cron: string; runAt: null } | { cron: null; runAt: number };
}

const COLUMNS = `id,key,chat_id AS chatId,thread_id AS threadId,created_by AS createdBy,name,mode,cron,run_at AS runAt,timezone,payload,
  state,run_count AS runCount,last_run_at AS lastRunAt,last_state AS lastState,last_error AS lastError,
  allow_silent AS allowSilent,silent_streak AS silentStreak,created_at AS createdAt,updated_at AS updatedAt`;

/**
 * `scheduled_jobs` 的唯一访问入口。
 *
 * **每个读方法都吃 `key`**（除了装载用的 `listActive`）：会话隔离在这一层强制，跟
 * `ScopedArchiveRepository` 同样的理由 —— 工具侧只要漏传一次 key，一个群成员就能列出、
 * 取消别的会话的任务（docs/05 §8：工具的 inputSchema 里没有 chatId 这类字段）。
 */
export class ScheduleRepository {
  constructor(private readonly db: Sqlite) {}

  /** 重名（同会话、同为活跃）会撞 `ux_sched_name` 抛 SQLITE_CONSTRAINT —— 调用方要把它翻成 `{ok:false}`。 */
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

  /** 装载用：跨会话取全部活跃任务，只有进程启动时的 `ScheduledJobRunner.load()` 该调它。 */
  listActive(): ScheduledJob[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_jobs WHERE state='active' ORDER BY created_at`,
      )
      .all() as ScheduledJob[];
  }

  /**
   * **跨会话**取全部任务，活跃的在前。只给 WebUI 的运维面板用（单 owner 身份，docs/14 A15）——
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

  /** 本会话的任务：活跃的在前，结束的按最近排，供 `schedule_list` 与 WebUI 用。 */
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

  /** 返回是否真的改动了一行：调用方要能区分「取消掉了」和「本来就没有 / 已经结束了」。 */
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
   * 一次触发的结果。`lastError` 显式置 null 而不是 COALESCE：上一次的错误不该粘在这一次成功上。
   *
   * `silent_streak` 用一句 `CASE` **就地**算：读一次再写回去在多实例下就是丢更新
   * （docs/01 §3.1 那张表的第一行），而这条计数正是「这条任务已经安静了多久」的唯一凭据。
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
   * 改一条**活跃**任务。0 changes（不存在或已结束）返回 null —— 调用方要能把它翻成 409，
   * 而不是回一个假成功。给了什么改什么：缺席的列一个字不碰。
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
   * 硬删指定的一行（含活跃的）。**与 `purge(before)` 是两件事** —— 那个按保留期清理已结束的
   * 任务，名字撞了写错一次就是全库已结束任务被清空。
   *
   * 活跃行的调用方必须**先** `runner.unregister(id)`：cron 留着而行没了，下一次触发扫到的是
   * 一条不存在的任务。
   */
  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM scheduled_jobs WHERE id=?").run(id)
        .changes === 1
    );
  }

  /** 保留清理：结束的行留 `schedule.retentionDays` 天，活跃的永不删。 */
  purge(before: number): number {
    return this.db
      .prepare(
        "DELETE FROM scheduled_jobs WHERE state<>'active' AND updated_at<?",
      )
      .run(before).changes;
  }
}
