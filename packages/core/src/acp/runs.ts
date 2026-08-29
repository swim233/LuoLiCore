import { ulid } from 'ulid';
import type { Sqlite } from '@luoli/db';

/**
 * M13 · 一次 ACP 调用在 `agent_runs` 上留下的那一行。
 *
 * 新增的只有一件事：外部花费落库。它写入 `external_cost_usd` / `external_usage_json`
 * 两列（迁移 `0014`），`cost_usd` 恒写 0，因为那个数字不属于本系统：它是外部 agent 自身 provider
 * 账单的累计值，口径由对方决定、本系统无法核对，也没有 tokens × prices 可供重算。写进 `cost_usd`
 * 会让它出现在每一个 `SUM(cost_usd)` 中，与自身成本并列展示则诱导读者把两者相加。
 *
 * 同一判据的另外两半（`docs/04 §6.2`）：不进 `usage_ledger`（那张表的行带 provider 身份，
 * `provider_id` / `model_id` 必填、用量页按它分桶，写入 `provider_id='omp'` 等于凭空造出一个本系统
 * 并不拥有的 provider），不进 `quota_counters` / `turns.cost_usd`（配额的分母是本系统的 key，
 * 掺入外部花费后该比例看似权威、实则无意义）。
 *
 * 行在执行结束后一次性插入，不存在 `state='running'` 阶段。ACP 这条路没有中途需要更新的字段
 * （steps / tokens 全程为 0），而保留一个 running 窗口就多一份要靠 `recoverAfterCrash` 收尾的状态。
 */
export interface AcpRunRecord {
  /** 本轮 turnId（`AcpTrace.traceId`）。取不到则不落行：挂不上 turn 的 trace 行无从读取。 */
  turnId: string;
  /** agent 配置中的名字。落库时加前缀成 `acp:<name>`，与本系统的子 agent 名字空间隔离。 */
  agent: string;
  dir: string;
  task: string;
  ok: boolean;
  /** `AcpRunResult.error`，`ok` 时不给。 */
  error?: string | undefined;
  stopReason?: string | undefined;
  /** 返回给模型的正文（已按 `maxOutputBytes` 限长），写入 `result_summary`。 */
  output: string;
  toolCalls: number;
  /**
   * `usage_update.cost.amount` 的累计值。`null` 表示对方一次都没上报，与上报了 0 是两回事，
   * 因此这一列可空而非 default 0。
   */
  costUsd: number | null;
  /** `external_usage_json` 的载荷。需自描述：读者要能看出这些数字并非来自本系统。 */
  usage: Record<string, unknown>;
  startedAt: number;
  finishedAt: number;
}

/** `AcpManager` 只依赖这一个动作，使用例无需接入真实数据库。 */
export interface AcpRunLedger {
  /** 插入一行，返回 `agent_runs.id`。抛错由调用方处理（记账失败不应让一次成功的调用变成失败）。 */
  record(entry: AcpRunRecord): string;
}

export class AcpRunRecorder implements AcpRunLedger {
  constructor(private readonly db: Sqlite) {}

  record(entry: AcpRunRecord): string {
    const id = ulid();
    /**
     * 挂在本轮主 run 之下（`depth: 1`），而不是作为 `parent_run_id` 为空的孤立行。ACP 调用发生在
     * 主 agent 的一次工具调用中，trace 树上就应处于该位置；查不到主 run（如试跑）时退回 `depth: 0`。
     */
    const parent = this.db.prepare("SELECT id FROM agent_runs WHERE turn_id=? AND kind='main'").pluck().get(entry.turnId) as string | undefined;
    this.db.prepare(`INSERT INTO agent_runs(id,turn_id,parent_run_id,depth,kind,agent_name,model_alias,effective_role,task_input,
      state,tool_calls,cost_usd,external_cost_usd,external_usage_json,result_summary,error,started_at,finished_at)
      VALUES (?,?,?,?,'sub',?,'external',?,?,?,?,0,?,?,?,?,?,?)`).run(
      id, entry.turnId, parent ?? null, parent ? 1 : 0,
      `acp:${entry.agent}`,
      /**
       * 固定写 `owner` 而不是接受参数。`spawn_acp` 的第一道门是 `available()` 判 `role === 'owner'`
       * 且仅私聊，`execute()` 再判一次 `effectiveRole !== 'owner'` 并直接拒绝，能走到这里的有效角色
       * 只可能是 owner。保留参数反而多出一条可能与那道门分叉的路径。
       */
      'owner',
      entry.task,
      // 只有用户 `/cancel` 这一档记 cancelled；`acp_timeout` / `acp_cost_exceeded` 同样由本系统发出
      // cancel，但两者各有后续处理，记成 failed 加 error 码比并入 cancelled 更清晰。
      entry.ok ? 'done' : entry.error === 'acp_cancelled' ? 'cancelled' : 'failed',
      entry.toolCalls,
      entry.costUsd,
      JSON.stringify(entry.usage),
      entry.output || null,
      entry.error ?? null,
      entry.startedAt, entry.finishedAt);
    return id;
  }
}
