import type { Sqlite } from './database.js';

export type ScheduledJobMode = 'agent' | 'notify';
export type ScheduledJobState = 'active' | 'done' | 'cancelled';

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
  createdAt: number;
  updatedAt: number;
}

export interface NewScheduledJob {
  id: string; key: string; chatId: string; threadId: number | null; createdBy: string; name: string;
  mode: ScheduledJobMode; cron: string | null; runAt: number | null; timezone: string; payload: string;
}

const COLUMNS = `id,key,chat_id AS chatId,thread_id AS threadId,created_by AS createdBy,name,mode,cron,run_at AS runAt,timezone,payload,
  state,run_count AS runCount,last_run_at AS lastRunAt,last_state AS lastState,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt`;

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
    this.db.prepare(`INSERT INTO scheduled_jobs(id,key,chat_id,thread_id,created_by,name,mode,cron,run_at,timezone,payload,state,created_at,updated_at)
      VALUES (@id,@key,@chatId,@threadId,@createdBy,@name,@mode,@cron,@runAt,@timezone,@payload,'active',@now,@now)`)
      .run({ ...input, now });
    return this.byId(input.id)!;
  }

  byId(id: string): ScheduledJob | null {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE id=?`).get(id) as ScheduledJob | undefined) ?? null;
  }

  byName(key: string, name: string): ScheduledJob | null {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE key=? AND name=? AND state='active'`).get(key, name) as ScheduledJob | undefined) ?? null;
  }

  /** 装载用：跨会话取全部活跃任务，只有进程启动时的 `ScheduledJobRunner.load()` 该调它。 */
  listActive(): ScheduledJob[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE state='active' ORDER BY created_at`).all() as ScheduledJob[];
  }

  /** 本会话的任务：活跃的在前，结束的按最近排，供 `schedule_list` 与 WebUI 用。 */
  listByKey(key: string, limit = 50): ScheduledJob[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE key=?
      ORDER BY (state='active') DESC,COALESCE(last_run_at,created_at) DESC LIMIT ?`).all(key, limit) as ScheduledJob[];
  }

  countActive(key: string): number {
    return this.db.prepare("SELECT COUNT(*) FROM scheduled_jobs WHERE key=? AND state='active'").pluck().get(key) as number;
  }

  /** 返回是否真的改动了一行：调用方要能区分「取消掉了」和「本来就没有 / 已经结束了」。 */
  finish(id: string, state: Exclude<ScheduledJobState, 'active'>, lastState?: string): boolean {
    return this.db.prepare("UPDATE scheduled_jobs SET state=?,last_state=COALESCE(?,last_state),updated_at=? WHERE id=? AND state='active'")
      .run(state, lastState ?? null, Date.now(), id).changes === 1;
  }

  /** 一次触发的结果。`lastError` 显式置 null 而不是 COALESCE：上一次的错误不该粘在这一次成功上。 */
  markRun(id: string, input: { state: string; error?: string; at?: number }): void {
    const at = input.at ?? Date.now();
    this.db.prepare('UPDATE scheduled_jobs SET run_count=run_count+1,last_run_at=?,last_state=?,last_error=?,updated_at=? WHERE id=?')
      .run(at, input.state, input.error ?? null, at, id);
  }

  /** 保留清理：结束的行留 `schedule.retentionDays` 天，活跃的永不删。 */
  purge(before: number): number {
    return this.db.prepare("DELETE FROM scheduled_jobs WHERE state<>'active' AND updated_at<?").run(before).changes;
  }
}
