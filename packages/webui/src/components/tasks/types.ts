import type { GridColumn, TagSeverity } from '../../ui/types';

/**
 * 「任务与审批」页三张卡共用的行类型、列定义与那两条纯函数。
 *
 * 放在 `.ts` 而不是留在 SFC 里的理由只有一个：**`.vue` 不进 `tsc`**（根 tsconfig 那条
 * `packages` 下的 `.vue` include 是空转，`ConsoleView.vue` 开头那段注释自陈过这件事害过人）。
 * 能挪出模板旁边的判据就别留在那儿。
 *
 * 三张卡的端点、分页游标、弹窗、busy 态零交集 —— 共用的只有这一份形状。
 */

// ── 行类型 ────────────────────────────────────────────────────────────────────

/**
 * `GET /api/tasks` 的一行。**不含 `progress_json`**：列表不发它（一行进度可以有几 KB），
 * 只有 `GET /api/tasks/:id` 才发解析后的 `progress`。
 */
export interface TaskRow {
  id: string; turn_id: string; agent_run_id: string | null; chat_id: string; user_id: string;
  title: string; state: string; result_summary: string | null;
  created_at: number; updated_at: number; finished_at: number | null;
  /** 服务端 `principalLabel` 反查出来的显示名。前端**不实现第二份**反查规则。 */
  chatLabel: string | null; userLabel: string | null;
}

/** `GET /api/approvals` 的一行 —— `approvals` 表原样直出，所以是 snake_case。 */
export interface ApprovalRow {
  id: string; turn_id: string; agent_run_id: string | null; span_id: string | null; chat_id: string;
  requester_user_id: string; tool_name: string; input_json: string; risk: string; state: string;
  requested_at: number; expires_at: number;
  decided_by: string | null; decided_at: number | null; decision_channel: string | null;
}

/**
 * `GET /api/schedules` 的一行。`silent` / `silentStreak` 是**对外线上的名字**，
 * DB 列叫 `allow_silent` / `silent_streak`，映射只在服务端的 `scheduleRow` 与
 * `scheduledJobView` 两处发生 —— 前端一律只认这一份。
 */
export interface ScheduleJob {
  id: string; key: string; chatId: string; threadId: number | null; createdBy: string;
  name: string; mode: 'agent' | 'notify'; state: string;
  chatLabel: string | null; creatorLabel: string | null;
  /** `cron` 与 `at` 恒有且只有一个（表上有 CHECK）。`at` 是 **UTC 瞬时**，不是墙钟。 */
  cron?: string; at?: string;
  timezone: string; payload: string; runCount: number;
  nextRun?: string; lastRunAt?: string; lastState?: string | null; lastError?: string;
  silent?: boolean; silentStreak?: number;
}

/** `GET /api/schedules` 的信封。不分页（行数有界），但撞 `listAll` 上限时要说出来。 */
export interface ScheduleList {
  available: boolean; enabled: boolean; timezone: string; jobs: ScheduleJob[];
  settings?: { maxPerChat: number; minIntervalMinutes: number; maxPayloadChars: number };
  total?: number; truncated?: boolean;
}

/** 定时任务卡只用得到会话的 key —— 下拉的 value 与 label 都是它。 */
export interface ChatOption { key: string }

export interface Paged<T> { items: T[]; total: number; page: number; size: number }
/**
 * 审批信封。`pending` 是**服务端全表** `COUNT(*) WHERE state='pending'`，不是当前页里数出来的 ——
 * 左侧导航那个角标读的就是它，翻到第 2 页角标不该变（`AC-WEB-049`）。
 */
export interface ApprovalPage extends Paged<ApprovalRow> { pending: number }

// ── 状态标签 ──────────────────────────────────────────────────────────────────

export const SCHEDULE_STATES: Record<string, { label: string; severity: TagSeverity }> = {
  active: { label: '在排', severity: 'success' }, done: { label: '已完成', severity: 'secondary' }, cancelled: { label: '已停用', severity: 'warn' },
};
/** 上一次触发的结果。`skipped` 的原因是排障的关键 —— 它意味着任务响了但什么都没发生。 */
export const SCHEDULE_RUN_STATES: Record<string, { label: string; severity: TagSeverity }> = {
  committed: { label: '成功', severity: 'success' }, failed: { label: '失败', severity: 'danger' },
  skipped: { label: '跳过', severity: 'warn' }, missed: { label: '错过', severity: 'warn' }, cancelled: { label: '停用', severity: 'secondary' },
  /** 那一轮确实提交了，只是没投递 —— 与 `failed` / `skipped` 必须分得开，否则「一直在失败」会看起来很安静。 */
  silent: { label: '静默', severity: 'secondary' },
};
/** `tasks` 表的四档。字面沿用会话详情里 `turnState()` 那套说法，同一个东西不该有两种叫法。 */
export const TASK_STATES: Record<string, { label: string; severity: TagSeverity }> = {
  running: { label: '进行中', severity: 'info' }, done: { label: '已完成', severity: 'success' },
  failed: { label: '失败', severity: 'danger' }, cancelled: { label: '已取消', severity: 'warn' },
};

// ── 列定义 ────────────────────────────────────────────────────────────────────

// `chat` 列的数据来自服务端反查好的 `chatLabel` / `userLabel`：一张跨会话的表里只显示裸
// Telegram id，认不出这条子 agent 任务是谁在哪儿派的。
export const TASK_COLUMNS: GridColumn[] = [{ key: 'title', header: '标题' }, { key: 'state', header: '状态', width: '7rem' }, { key: 'chat', header: '会话', width: '10rem' }, { key: 'updated_at', header: '更新时间', width: '13rem' }, { key: 'actions', header: '', width: '7rem' }];
// `actions` 比原来宽 2rem：这一列从「立即触发 + 停掉」变成三个按钮，11rem 会把「编辑」挤到第二行。
export const SCHEDULE_COLUMNS: GridColumn[] = [{ key: 'name', header: '任务' }, { key: 'chatLabel', header: '会话' }, { key: 'mode', header: '模式', width: '6rem' }, { key: 'trigger', header: '触发', width: '11rem' }, { key: 'nextRun', header: '下一次', width: '12rem' }, { key: 'last', header: '上一次', width: '12rem' }, { key: 'state', header: '状态', width: '6rem' }, { key: 'actions', header: '', width: '13rem' }];
export const APPROVAL_COLUMNS: GridColumn[] = [{ key: 'tool_name', header: '工具' }, { key: 'risk', header: '风险', width: '7rem' }, { key: 'state', header: '状态', width: '7rem' }, { key: 'requested_at', header: '请求时间', width: '12rem' }, { key: 'actions', header: '', width: '12rem' }];

/**
 * 一段时长的说法。前两档与总览页在途 turn 那个 `elapsed()` **逐字一致** —— 同一个东西不该
 * 有两种叫法，而运维会在两张表之间来回看。多出来的「小时」档是这里独有的：那张表看的是
 * 正在跑的轮次（不会久到按小时算），这里看的是历史任务，`1203 分 4 秒` 读不出来。
 */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

// ── 墙钟 ──────────────────────────────────────────────────────────────────────

/** 表单里那格一次性时间的格式。服务端收的也是这个形状（按任务行上的时区解释）。 */
export const WALL_CLOCK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * UTC 瞬时 → **指定时区上的墙钟串**（`YYYY-MM-DDTHH:mm`）。
 *
 * `scheduledJobView` 发的 `at` 是 `toISOString()` 的 UTC 瞬时，而表单收的是行上时区的墙钟。
 * 直接把 ISO 回填进输入框的话，`Asia/Shanghai` 上一个「早八点」的任务会显示成
 * `…T00:00:00.000Z`，人顺手改成 `08:00` 再存 —— 任务被静默挪后 8 小时，两次操作各自都不报错。
 *
 * 认不出来的时区串**交白卷**（返回空串）而不是退回浏览器时区：给一个偏移几小时且看不出偏移的
 * 墙钟，比一格空输入框危险得多。
 */
export function toWallClock(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  } catch { return ''; }
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  // 一部分实现的 h23 在午夜给 `24`，那个串再喂回 `datetime-local` 是不合法的。
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  const wall = `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}`;
  return WALL_CLOCK_RE.test(wall) ? wall : '';
}
