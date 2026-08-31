import type { GridColumn, TagSeverity } from "../../ui/types";

/**
 * 「任务与审批」页三张卡共用的行类型、列定义与两条纯函数。
 *
 * 放在 `.ts` 而不是留在 SFC 内的唯一理由：`.vue` 不进 `tsc`（根 tsconfig 中 `packages` 下的
 * `.vue` include 不生效，`ConsoleView.vue` 开头的注释记录过由此引发的问题）。
 * 能移出模板的判据不要留在模板旁边。
 *
 * 三张卡的端点、分页游标、弹窗、busy 态没有交集，共用的只有这一份形状。
 */

// ── 行类型 ────────────────────────────────────────────────────────────────────

/**
 * `GET /api/tasks` 的一行。不含 `progress_json`：列表不发送它（单行进度可达数 KB），
 * 只有 `GET /api/tasks/:id` 才发送解析后的 `progress`。
 */
export interface TaskRow {
  id: string;
  turn_id: string;
  agent_run_id: string | null;
  chat_id: string;
  user_id: string;
  title: string;
  state: string;
  result_summary: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  /** 服务端 `principalLabel` 反查得到的显示名。前端不实现第二份反查规则。 */
  chatLabel: string | null;
  userLabel: string | null;
}

/** `GET /api/approvals` 的一行。`approvals` 表逐列直出，因此是 snake_case。 */
export interface ApprovalRow {
  id: string;
  turn_id: string;
  agent_run_id: string | null;
  span_id: string | null;
  chat_id: string;
  requester_user_id: string;
  tool_name: string;
  input_json: string;
  risk: string;
  state: string;
  requested_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  decision_channel: string | null;
  /**
   * 服务端 `principalLabel` 反查得到的裁决者显示名。前端不实现第二份反查规则：
   * `decided_by` 有三种写法（`user:<tgId>` / `owner` / `system`），在此拆解 `user:` 前缀会使
   * 该格式变成前后端各存一半的隐式契约。查不到时为 `null`，此时显示 `decided_by` 原串。
   */
  decidedByLabel: string | null;
}

/**
 * `GET /api/schedules` 的一行。`silent` / `silentStreak` 是对外接口上的名字，
 * DB 列名为 `allow_silent` / `silent_streak`，映射只在服务端的 `scheduleRow` 与
 * `scheduledJobView` 两处发生，前端一律只认这一份。
 */
export interface ScheduleJob {
  id: string;
  key: string;
  chatId: string;
  threadId: number | null;
  createdBy: string;
  name: string;
  mode: "agent" | "notify";
  state: string;
  chatLabel: string | null;
  creatorLabel: string | null;
  /** `cron` 与 `at` 恒有且只有一个（表上有 CHECK）。`at` 是 UTC 瞬时，不是墙钟时间。 */
  cron?: string;
  at?: string;
  timezone: string;
  payload: string;
  runCount: number;
  nextRun?: string;
  lastRunAt?: string;
  lastState?: string | null;
  lastError?: string;
  silent?: boolean;
  silentStreak?: number;
}

/** `GET /api/schedules` 的信封。不分页（行数有界），但触及 `listAll` 上限时需明确提示。 */
export interface ScheduleList {
  available: boolean;
  enabled: boolean;
  timezone: string;
  jobs: ScheduleJob[];
  settings?: {
    maxPerChat: number;
    minIntervalMinutes: number;
    maxPayloadChars: number;
  };
  total?: number;
  truncated?: boolean;
}

/** 定时任务卡只需要会话的 key，下拉的 value 与 label 都取它。 */
export interface ChatOption {
  key: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
/**
 * 审批信封。`pending` 取服务端全表 `COUNT(*) WHERE state='pending'`，而非当前页统计：
 * 左侧导航的角标读取的就是它，翻到第 2 页时角标不应变化（`AC-WEB-049`）。
 */
export interface ApprovalPage extends Paged<ApprovalRow> {
  pending: number;
}

// ── 状态标签 ──────────────────────────────────────────────────────────────────

export const SCHEDULE_STATES: Record<
  string,
  { label: string; severity: TagSeverity }
> = {
  active: { label: "启用中", severity: "success" },
  done: { label: "已完成", severity: "secondary" },
  cancelled: { label: "已停用", severity: "warn" },
};
/** 上一次触发的结果。`skipped` 的原因是排障关键：它意味着任务触发了但没有产生任何动作。 */
export const SCHEDULE_RUN_STATES: Record<
  string,
  { label: string; severity: TagSeverity }
> = {
  committed: { label: "成功", severity: "success" },
  failed: { label: "失败", severity: "danger" },
  skipped: { label: "跳过", severity: "warn" },
  missed: { label: "错过", severity: "warn" },
  cancelled: { label: "停用", severity: "secondary" },
  /** 该轮次确实提交了，只是没有投递。必须与 `failed` / `skipped` 区分开，否则持续失败的状态不会被察觉。 */
  silent: { label: "静默", severity: "secondary" },
};
/** `tasks` 表的四档。文案沿用会话详情中 `turnState()` 的措辞，同一事物不应有两种叫法。 */
export const TASK_STATES: Record<
  string,
  { label: string; severity: TagSeverity }
> = {
  running: { label: "进行中", severity: "info" },
  done: { label: "已完成", severity: "success" },
  failed: { label: "失败", severity: "danger" },
  cancelled: { label: "已取消", severity: "warn" },
};

// ── 列定义 ────────────────────────────────────────────────────────────────────

// `chat` 列的数据来自服务端反查好的 `chatLabel` / `userLabel`：跨会话的表中只显示裸
// Telegram id 时，无法辨认某条子 agent 任务由谁在何处派发。
export const TASK_COLUMNS: GridColumn[] = [
  { key: "title", header: "标题" },
  { key: "state", header: "状态", width: "7rem" },
  { key: "chat", header: "会话", width: "10rem" },
  { key: "updated_at", header: "更新时间", width: "13rem" },
  { key: "actions", header: "操作", width: "7rem" },
];
// 三个动作的实测内容宽约 13.4rem；列宽还需包含单元格左右 padding，固定布局下取 15.5rem。
export const SCHEDULE_COLUMNS: GridColumn[] = [
  { key: "name", header: "任务" },
  { key: "chatLabel", header: "会话" },
  { key: "mode", header: "模式", width: "6rem" },
  { key: "trigger", header: "触发", width: "11rem" },
  { key: "nextRun", header: "下一次", width: "12rem" },
  { key: "last", header: "上一次", width: "12rem" },
  { key: "state", header: "状态", width: "6rem" },
  { key: "actions", header: "操作", width: "15.5rem" },
];
export const APPROVAL_COLUMNS: GridColumn[] = [
  { key: "tool_name", header: "工具" },
  { key: "risk", header: "风险", width: "7rem" },
  { key: "state", header: "状态", width: "7rem" },
  { key: "requested_at", header: "请求时间", width: "12rem" },
  { key: "actions", header: "操作", width: "12rem" },
];

/**
 * 时长的表述。前两档与总览页在途 turn 的 `elapsed()` 逐字一致：同一事物不应有两种叫法，
 * 而运维会在两张表之间来回对照。额外的「小时」档为此处独有：那张表展示的是正在运行的轮次
 * （不会长到按小时计），这里展示的是历史任务，`1203 分 4 秒` 无法直观阅读。
 */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} 分 ${seconds % 60} 秒`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

// ── 墙钟 ──────────────────────────────────────────────────────────────────────

/** 表单中一次性时间输入的格式。服务端接收的也是这个形状（按任务行上的时区解释）。 */
export const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * UTC 瞬时转换为指定时区上的墙钟串（`YYYY-MM-DDTHH:mm`）。
 *
 * `scheduledJobView` 发送的 `at` 是 `toISOString()` 的 UTC 瞬时，而表单接收的是行上时区的墙钟。
 * 直接把 ISO 回填进输入框时，`Asia/Shanghai` 上一个早八点的任务会显示为
 * `…T00:00:00.000Z`，用户顺手改成 `08:00` 再保存，任务被静默推后 8 小时，两次操作均不报错。
 *
 * 无法识别的时区串返回空串而不是回退到浏览器时区：给出一个偏移数小时且看不出偏移的墙钟，
 * 比一格空输入框危险得多。
 */
export function toWallClock(
  iso: string | null | undefined,
  timezone: string,
): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
  } catch {
    return "";
  }
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  // 部分实现的 h23 在午夜返回 `24`，该串再传回 `datetime-local` 是不合法的。
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  const wall = `${pick("year")}-${pick("month")}-${pick("day")}T${hour}:${pick("minute")}`;
  return WALL_CLOCK_RE.test(wall) ? wall : "";
}
