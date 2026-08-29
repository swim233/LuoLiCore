import { Cron } from "croner";
import { ulid } from "ulid";
import type {
  ScheduleRepository,
  ScheduledJob,
  ScheduledJobPatch,
} from "@luoli/db";
import type { Config } from "../config/schema.js";

/**
 * 创建定时任务时须通过的各道闸。
 *
 * 工具（`schedule_create`）与 WebUI（`POST /api/schedules`）共用这一份。两侧各写一遍校验
 * 正是本仓库反复出现的缺陷形态（docs/26 §1「同一道闸修过一次但漏了另一侧」）—— 少一条的后果是
 * WebUI 能创建出工具无法创建的任务，例如每分钟一次的 agent 轮次。
 */
export interface ScheduleCreateRequest {
  name: string;
  mode: "agent" | "notify";
  text: string;
  /** 与 `at` 二选一。`exactOptionalPropertyTypes` 下须显式接受 undefined：zod 的可选字段
   *  解析结果即 `string | undefined`，调用方不应为通过类型检查而额外做条件展开。 */
  cron?: string | undefined;
  at?: string | undefined;
  /** 允许该任务的轮次调用 `stay_silent`（DB 列 `allow_silent`，对外接口统一称 `silent`）。 */
  silent?: boolean | undefined;
}

/**
 * 修改一条任务。不接受 `mode`：切换 mode 会同时改变 `payload` 的语义（任务描述 ↔ 待发送原文）
 * 与是否产生花费，同一字段上的两件事无法只改其一。也不接受 `key`/`chatId`/`createdBy` ——
 * 落点是隔离锚点，创建者是每次触发重算有效角色的依据，设为可写即构成提权入口。
 */
export interface ScheduleUpdateRequest {
  name?: string | undefined;
  text?: string | undefined;
  cron?: string | undefined;
  at?: string | undefined;
  silent?: boolean | undefined;
}

export interface ScheduleCreateContext {
  key: string;
  chatId: string;
  threadId: number | null;
  createdBy: string;
  timezone: string;
  settings: Config["schedule"];
}

/** 仅负责排入调度这一件事的注册器；`ScheduledJobRunner` 满足该接口。 */
export interface ScheduleRegistrar {
  register(job: ScheduledJob): boolean;
  nextRun(id: string): Date | null;
}

export type ScheduleCreateResult =
  | { ok: true; job: ScheduledJob; nextRun: Date | null }
  | { ok: false; error: string; hint: string };

/**
 * `at` 是用户所在时区的墙上时间，而非 UTC。`new Date('2026-08-18T15:00:00')` 按宿主
 * 时区解析，宿主为 UTC 的部署中下午三点会变成晚上十一点。因此自行按给定时区折算：
 * 先按 UTC 读入，再用该时区在该时刻的偏移量校正。
 */
export function parseLocalTime(value: string, timezone: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      value.trim(),
    );
  if (!match) {
    const direct = Date.parse(value);
    return Number.isNaN(direct) ? null : direct;
  }
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  // 偏移量本身依赖具体时刻（夏令时），因此先按 UTC 估算一次，再用估算结果查偏移量收敛一步。
  const offset = (probe: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(probe))
      .reduce<Record<string, string>>((accumulator, part) => {
        accumulator[part.type] = part.value;
        return accumulator;
      }, {});
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return wall - probe;
  };
  return asUtc - offset(asUtc - offset(asUtc));
}

/** cron 两次触发之间的间隔（毫秒）。表达式非法时抛出，由调用方转换为 `{ok:false}`。 */
export function cronIntervalMs(expression: string, timezone: string): number {
  const upcoming = new Cron(expression, { timezone }).nextRuns(2);
  if (upcoming.length < 2) return Number.POSITIVE_INFINITY;
  return upcoming[1]!.getTime() - upcoming[0]!.getTime();
}

/**
 * 每道闸各自一个函数，除 `gateEnabled` 外创建与修改共用。提取的目的是：`updateScheduledJob` 需要
 * 只执行其中若干道（仅修改正文时不应重算触发间隔），而在该处复制一份正是本仓库反复出现的缺陷形态
 * （docs/26 §1）。`createScheduledJob` 的顺序与文案因此保持不变 —— 那两组逐条错误码断言
 * 即本次重构的回归防线。
 */
type Rejection = { ok: false; error: string; hint: string };

/** 仅 `createScheduledJob` 经过这一道，修改路径不经过 —— 理由见 `updateScheduledJob` 的注释。 */
const gateEnabled = (settings: Config["schedule"]): Rejection | null =>
  settings.enabled
    ? null
    : {
        ok: false,
        error: "schedule_disabled",
        hint: "定时任务已被运维停用（schedule.enabled）",
      };

/** 接收已 trim 的名字：调用方还需用它查重名并落库，两次 trim 会形成两份判据。 */
const gateName = (name: string): Rejection | null =>
  name && name.length <= 64
    ? null
    : {
        ok: false,
        error: "invalid_name",
        hint: "任务名不能为空，且不超过 64 个字符",
      };

const gateText = (
  text: string,
  mode: "agent" | "notify",
  settings: Config["schedule"],
): Rejection | null => {
  if (!text)
    return {
      ok: false,
      error: "invalid_text",
      hint: mode === "agent" ? "需提供任务描述" : "需提供待发送的正文",
    };
  if (text.length > settings.maxPayloadChars)
    return {
      ok: false,
      error: "text_too_long",
      hint: `正文最多 ${settings.maxPayloadChars} 字（schedule.maxPayloadChars）`,
    };
  return null;
};

/**
 * `notify` 不调用模型，`stay_silent` 在该路径上不会被调用 —— 可存储但运行时不读取的开关劣于
 * 没有该开关（docs/20 · W-CFG-02：运维据其调整后发现行为未变）。
 */
const gateSilent = (
  silent: boolean | undefined,
  mode: "agent" | "notify",
): Rejection | null =>
  silent && mode === "notify"
    ? {
        ok: false,
        error: "invalid_silent",
        hint: "notify 模式触发时原样发送预写正文，不调用模型，因此 silent 不适用",
      }
    : null;

const gateCron = (
  expression: string,
  timezone: string,
  settings: Config["schedule"],
): Rejection | null => {
  let interval: number;
  try {
    interval = cronIntervalMs(expression, timezone);
  } catch (error) {
    return {
      ok: false,
      error: "invalid_cron",
      hint: `cron 表达式不合法：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (interval < settings.minIntervalMinutes * 60_000) {
    return {
      ok: false,
      error: "interval_too_short",
      hint: `两次触发间隔不能小于 ${settings.minIntervalMinutes} 分钟（schedule.minIntervalMinutes）`,
    };
  }
  return null;
};

/** 通过后返回该时刻：让调用方再 parse 一次会形成第二份判据，且两次之间夏令时边界可能漂移。 */
function gateAt(at: string, timezone: string): number | Rejection {
  const runAt = parseLocalTime(at, timezone);
  if (runAt === null)
    return {
      ok: false,
      error: "invalid_at",
      hint: "时间格式无法解析，请使用 2026-08-18T15:00 格式",
    };
  if (runAt <= Date.now())
    return {
      ok: false,
      error: "at_in_the_past",
      hint: `${at}（${timezone}）已过去；错过的触发点不会补跑`,
    };
  return runAt;
}

/** `excludeId` 用于改名场景：任务改为自身当前的名字不算重名。 */
function gateDuplicate(
  jobs: ScheduleRepository,
  key: string,
  name: string,
  excludeId?: string,
): Rejection | null {
  const existing = jobs.byName(key, name);
  if (!existing || existing.id === excludeId) return null;
  return {
    ok: false,
    error: "duplicate_name",
    hint: `该会话已存在名为「${name}」的活跃任务，请更换名称或先取消该任务`,
  };
}

/**
 * `ux_sched_name` 是部分唯一索引，预检与写入之间存在窗口（`db/src/schedule.ts` 的 `create` 已确立该规则）。
 *
 * 判定 `code` 而非 `String(error)`：better-sqlite3 的 `SqliteError.message` 为
 * 「UNIQUE constraint failed: scheduled_jobs.key, scheduled_jobs.name」，`toString()` 结果中
 * 不含 `SQLITE_CONSTRAINT` 字样 —— 按文本判定会使该 catch 恒等于原样重抛，多实例下
 * 触及该窗口时 HTTP 侧返回 500 而非 `duplicate_name`。
 */
const duplicateOrThrow = (error: unknown, name: string): Rejection => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("SQLITE_CONSTRAINT"))
    throw error;
  return {
    ok: false,
    error: "duplicate_name",
    hint: `该会话已存在名为「${name}」的活跃任务，请更换名称或先取消该任务`,
  };
};

export function createScheduledJob(
  jobs: ScheduleRepository,
  registrar: ScheduleRegistrar,
  request: ScheduleCreateRequest,
  context: ScheduleCreateContext,
): ScheduleCreateResult {
  const live = context.settings;
  const disabled = gateEnabled(live);
  if (disabled) return disabled;
  const name = request.name.trim();
  const badName = gateName(name);
  if (badName) return badName;
  const text = request.text.trim();
  const badText = gateText(text, request.mode, live);
  if (badText) return badText;
  const badSilent = gateSilent(request.silent, request.mode);
  if (badSilent) return badSilent;
  if ((request.cron === undefined) === (request.at === undefined))
    return {
      ok: false,
      error: "invalid_schedule",
      hint: "cron 与 at 必须且只能提供一个",
    };
  let runAt: number | null = null;
  if (request.at !== undefined) {
    const parsed = gateAt(request.at, context.timezone);
    if (typeof parsed !== "number") return parsed;
    runAt = parsed;
  } else {
    const badCron = gateCron(request.cron!, context.timezone, live);
    if (badCron) return badCron;
  }
  if (jobs.countActive(context.key) >= live.maxPerChat) {
    return {
      ok: false,
      error: "too_many_jobs",
      hint: `该会话的活跃任务已达 ${live.maxPerChat} 个（schedule.maxPerChat），请先取消不再需要的任务`,
    };
  }
  const duplicate = gateDuplicate(jobs, context.key, name);
  if (duplicate) return duplicate;
  const job = jobs.create({
    id: ulid(),
    key: context.key,
    chatId: context.chatId,
    threadId: context.threadId,
    createdBy: context.createdBy,
    name,
    mode: request.mode,
    cron: request.cron ?? null,
    runAt,
    timezone: context.timezone,
    payload: text,
    allowSilent: request.silent === true,
  });
  // 无法排入调度器则回滚：留下一条永不触发的 active 行比创建失败更难排查。
  if (!registrar.register(job)) {
    jobs.finish(job.id, "cancelled", "failed");
    return {
      ok: false,
      error: "schedule_register_failed",
      hint: "任务已创建但无法排入调度器，已回滚",
    };
  }
  return { ok: true, job, nextRun: registrar.nextRun(job.id) };
}

/**
 * 修改一条活跃任务。工具（`schedule_update`）与 WebUI（`PATCH /api/schedules/:id`）共用这一份，
 * 理由同 `createScheduledJob`。
 *
 * 不经过 `gateEnabled` —— 与 `createScheduledJob` 的这处不对称是有意为之，不要当作遗漏补回。
 * `schedule.enabled=false` 时任务不会触发（`ScheduledJobRunner.fire` 一侧照常 skip），
 * 因此修改它没有副作用；而拒绝编辑的代价是：要修复一条异常任务，运维必须先打开总开关，
 * 该操作会重新武装全部任务。创建仍然拒绝 —— 总开关关闭时新建一条不会触发的任务，
 * 除了造成已排入的错觉外没有其他作用。
 *
 * 另有两处易错点：
 *
 * - `cron` 与 `at` 均未提供时，触发时间原样保留且不重新校验。运维事后把 `minIntervalMinutes`
 *   从 5 调到 60 后，仅修改正文不应以 `interval_too_short` 失败 —— 该任务是在旧规则下
 *   合法创建的，收紧规则的语义是限制新建，而非冻结存量。
 * - 时区一律取 `job.timezone` 而非 `general.timezone`。任务的语义锚定在创建时的时区上
 *   （迁移 0007 的注释），用全局时区解释 `at` 会将早八点静默偏移数小时，且两侧都不报错。
 *
 * 不判定 `too_many_jobs`：修改不增加活跃任务数。
 */
export function updateScheduledJob(
  jobs: ScheduleRepository,
  registrar: ScheduleRegistrar,
  job: ScheduledJob,
  request: ScheduleUpdateRequest,
  settings: Config["schedule"],
): ScheduleCreateResult {
  if (
    request.name === undefined &&
    request.text === undefined &&
    request.cron === undefined &&
    request.at === undefined &&
    request.silent === undefined
  ) {
    // 不返回虚假成功：调用方（通常是模型）会认为修改已生效，而库中未发生任何变更。
    return {
      ok: false,
      error: "nothing_to_update",
      hint: "name / text / cron / at / silent 至少提供一个",
    };
  }
  // 任务已结束这一事实须优先返回，不能被下方各道闸抢先响应：`PATCH {cron:'* * * * *'}` 作用于
  // 已取消的任务时此前返回 `interval_too_short`，而运维需要的信息是该任务已不存在、需重建。
  // 权威判据仍是 `jobs.update` 的 `WHERE state='active'`（只有该条防得住并发），此处只统一口径。
  if (job.state !== "active")
    return {
      ok: false,
      error: "not_active",
      hint: "该任务已结束或已取消，不可修改；请重新创建",
    };
  const patch: ScheduledJobPatch = {};
  if (request.name !== undefined) {
    const name = request.name.trim();
    const badName = gateName(name);
    if (badName) return badName;
    const duplicate = gateDuplicate(jobs, job.key, name, job.id);
    if (duplicate) return duplicate;
    patch.name = name;
  }
  if (request.text !== undefined) {
    const text = request.text.trim();
    const badText = gateText(text, job.mode, settings);
    if (badText) return badText;
    patch.payload = text;
  }
  if (request.silent !== undefined) {
    const badSilent = gateSilent(request.silent, job.mode);
    if (badSilent) return badSilent;
    patch.allowSilent = request.silent;
  }
  if (request.cron !== undefined && request.at !== undefined)
    return {
      ok: false,
      error: "invalid_schedule",
      hint: "cron 与 at 只能提供一个（均不提供时保持原样）",
    };
  if (request.cron !== undefined) {
    const badCron = gateCron(request.cron, job.timezone, settings);
    if (badCron) return badCron;
    patch.trigger = { cron: request.cron, runAt: null };
  } else if (request.at !== undefined) {
    const parsed = gateAt(request.at, job.timezone);
    if (typeof parsed !== "number") return parsed;
    patch.trigger = { cron: null, runAt: parsed };
  }
  let updated: ScheduledJob | null;
  try {
    updated = jobs.update(job.id, patch);
  } catch (error) {
    return duplicateOrThrow(error, patch.name ?? job.name);
  }
  if (!updated)
    return {
      ok: false,
      error: "not_active",
      hint: "该任务已结束或已取消，不可修改；请重新创建",
    };
  // 无条件重排：`register` 第一步即 `scheduler.remove(name)`，重注册本身幂等，而为触发时间是否变化
  // 增加分支会增加漏排的可能。无法排入则整行回滚 —— 恢复旧 name/payload/cron，并把旧 cron 排回。
  if (!registrar.register(updated)) {
    jobs.update(job.id, {
      name: job.name,
      payload: job.payload,
      allowSilent: job.allowSilent === 1,
      trigger:
        job.cron === null
          ? { cron: null, runAt: job.runAt! }
          : { cron: job.cron, runAt: null },
    });
    registrar.register(job);
    return {
      ok: false,
      error: "schedule_register_failed",
      hint: "改动无法排入调度器，已回滚至修改前的状态",
    };
  }
  return { ok: true, job: updated, nextRun: registrar.nextRun(updated.id) };
}

/** 面向模型与 WebUI 的任务视图。两侧共用同一份，避免界面显示 active 而模型报告不存在。 */
export function scheduledJobView(
  job: ScheduledJob,
  next: Date | null,
): Record<string, unknown> {
  return {
    name: job.name,
    mode: job.mode,
    state: job.state,
    ...(job.cron
      ? { cron: job.cron }
      : { at: new Date(job.runAt!).toISOString() }),
    timezone: job.timezone,
    payload: job.payload,
    runCount: job.runCount,
    // 对外接口统一称 `silent`（DB 列 `allow_silent`、repo 字段 `allowSilent`）。映射点仅此处
    // 与 `app.ts` 的 `scheduleRow` 两处 —— 增加映射点会使三个名字之间的权威关系变得不明确。
    silent: job.allowSilent === 1,
    ...(next ? { nextRun: next.toISOString() } : {}),
    ...(job.lastRunAt
      ? {
          lastRunAt: new Date(job.lastRunAt).toISOString(),
          lastState: job.lastState,
        }
      : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
  };
}
