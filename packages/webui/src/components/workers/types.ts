import type { GridColumn, TagSeverity } from "../../ui/types";

/**
 * 「Worker 运行记录」页两张卡共用的行类型、列定义与标签映射。
 *
 * 放在 `.ts` 而不是留在 SFC 内的理由同 `components/tasks/types.ts`：`.vue` 不进 `tsc`，
 * 留在模板旁边的那部分等于没有类型检查。
 */

// ── 行类型 ────────────────────────────────────────────────────────────────────

/** `GET /api/worker-runs` 的一行。整份 `task_input` 只在详情里，列表拿到的是 `taskLine`。 */
export interface WorkerRunRow {
  id: string;
  turnId: string;
  parentRunId: string | null;
  depth: number;
  workerKind: "lw" | "harness" | "acp";
  agentName: string;
  modelAlias: string;
  effectiveRole: string;
  state: string;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 外部 agent 自报，未经核对，不进任何聚合。**与 `costUsd` 分开显示，不相加。** */
  externalCostUsd: number | null;
  taskLine: string;
  resultSummary: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** `GET /api/worker-runs/:id` 多出来的那几列，加上服务端 join 出来的所属轮次。 */
export interface WorkerRunDetail extends Omit<WorkerRunRow, "taskLine"> {
  providerId: string | null;
  modelId: string | null;
  taskInput: string | null;
  externalUsageJson: string | null;
  resultFullRef: string | null;
  turn: {
    key: string;
    chatId: string;
    state: string;
    error: string | null;
  } | null;
  /** 服务端 `principalLabel` 反查得到的会话显示名。前端不实现第二份反查规则。 */
  chatLabel: string | null;
}

export interface WorkerRunPage {
  items: WorkerRunRow[];
  total: number;
  page: number;
  size: number;
}

// ── 标签 ──────────────────────────────────────────────────────────────────────

/**
 * 三档 worker（`agent_runs.worker_kind`，迁移 `0018`）。`hint` 挂在徽标的 `title` 上：
 * 三者的花费口径与可观测程度都不同，只印一个英文缩写读不出区别。
 */
export const WORKER_KINDS: Record<
  string,
  { label: string; severity: TagSeverity; hint: string }
> = {
  lw: {
    label: "lw",
    severity: "info",
    hint: "内建轻任务 worker，权限等同派它的那一轮，花费记在 costUsd 上",
  },
  harness: {
    label: "harness",
    severity: "warn",
    hint: "外部 CLI harness，内部工具调用不经本系统的注册表",
  },
  acp: {
    label: "acp",
    severity: "warn",
    hint: "外部编码 agent，花费由它自报，记在 externalCostUsd 上",
  },
};
/** `agent_runs.state` 的四档。文案沿用任务卡的 `TASK_STATES`，同一事物不应有两种叫法。 */
export const WORKER_RUN_STATES: Record<
  string,
  { label: string; severity: TagSeverity }
> = {
  running: { label: "进行中", severity: "info" },
  done: { label: "已完成", severity: "success" },
  failed: { label: "失败", severity: "danger" },
  cancelled: { label: "已取消", severity: "warn" },
};

// ── 列定义 ────────────────────────────────────────────────────────────────────

export const WORKER_RUN_COLUMNS: GridColumn[] = [
  { key: "workerKind", header: "类型", width: "6.5rem" },
  { key: "state", header: "状态", width: "6.5rem" },
  { key: "taskLine", header: "任务" },
  { key: "turnId", header: "轮次", width: "9rem" },
  { key: "steps", header: "步数 / 工具", width: "8rem" },
  { key: "cost", header: "花费", width: "8rem" },
  // 外部花费单独占一格。合进上一格就是把「我们的钱」和「它自己说的钱」摆成一个数。
  { key: "externalCost", header: "外部自报", width: "8rem" },
  { key: "elapsed", header: "耗时", width: "7rem" },
  { key: "startedAt", header: "开始时间", width: "12rem" },
];

/** 试跑面板逐行收到的 NDJSON 事件（`POST /api/workers/dryrun`）。 */
export type WorkerDryRunEvent =
  | {
      type: "step";
      step: number;
      finishReason: string;
      text: string;
      toolCalls: unknown[];
      toolResults: unknown[];
    }
  | {
      type: "usage";
      step: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  | { type: "final"; summary: string; fullRef: string; truncated: boolean }
  | { type: "error"; message: string };
