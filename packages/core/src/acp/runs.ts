import { ulid } from 'ulid';
import type { Sqlite } from '@luoli/db';

/**
 * M13 · 一次 ACP 调用在 `agent_runs` 上留下的那一行。
 *
 * **只有一件事是新的：外部花费落库了。** 而它落的是 `external_cost_usd` / `external_usage_json`
 * 两列（迁移 `0014`），`cost_usd` 恒写 0 —— 那个数字不是我们的钱：它是外部 agent 自己那份 provider
 * 账单的累计值，口径由它定、我们无法核对、也没有 tokens × prices 可以重算。写进 `cost_usd` 等于
 * 让它出现在每一个 `SUM(cost_usd)` 里，摆在自己的成本旁边就是邀请人把两者相加。
 *
 * 同一条判据的另外两半（`docs/04 §6.2`）：**不进 `usage_ledger`**（那张表的行有 provider 身份，
 * `provider_id` / `model_id` 必填、用量页按它分桶，塞一条 `provider_id='omp'` 等于凭空造一个我们
 * 不拥有的 provider），**不进 `quota_counters` / `turns.cost_usd`**（配额的分母是本系统的 key，
 * 掺进外部花费之后那个比例看起来权威、实际无意义）。
 *
 * **行在跑完之后一次性插入**，没有 `state='running'` 那一段。ACP 这条路没有中途要更新的字段
 * （steps / tokens 全程是 0），而留一个 running 窗口就多一份要靠 `recoverAfterCrash` 收尾的状态。
 */
export interface AcpRunRecord {
  /** 本轮 turnId（`AcpTrace.traceId`）。拿不到就不落行 —— 一条挂不上 turn 的 trace 行没有读法。 */
  turnId: string;
  /** agent 配置里的名字。落库时前缀成 `acp:<name>`，与本系统的子 agent 名字空间分开。 */
  agent: string;
  dir: string;
  task: string;
  ok: boolean;
  /** `AcpRunResult.error`，`ok` 时不给。 */
  error?: string | undefined;
  stopReason?: string | undefined;
  /** 交回模型的那段正文（已按 `maxOutputBytes` 有界），进 `result_summary`。 */
  output: string;
  toolCalls: number;
  /**
   * `usage_update.cost.amount` 的累计值。**`null` = 它一次都没报过**，与「它报了 0」是两件事，
   * 所以这一列可空而不是 default 0。
   */
  costUsd: number | null;
  /** `external_usage_json` 的载荷。自描述 —— 读的人要能看出这些数字的出处不是本系统。 */
  usage: Record<string, unknown>;
  startedAt: number;
  finishedAt: number;
}

/** `AcpManager` 只认这一个动作，好让用例不必带一个真库。 */
export interface AcpRunLedger {
  /** 落一行，交回 `agent_runs.id`。**抛错由调用方兜**（记账失败不该让一次成功的调用变成失败）。 */
  record(entry: AcpRunRecord): string;
}

export class AcpRunRecorder implements AcpRunLedger {
  constructor(private readonly db: Sqlite) {}

  record(entry: AcpRunRecord): string {
    const id = ulid();
    /**
     * 挂在本轮主 run 之下（`depth: 1`），而不是当一条 `parent_run_id` 为空的孤儿。ACP 调用发生在
     * 主 agent 的一次工具调用里，trace 树上它就该在那儿；查不到主 run（试跑之类）时退回 `depth: 0`。
     */
    const parent = this.db.prepare("SELECT id FROM agent_runs WHERE turn_id=? AND kind='main'").pluck().get(entry.turnId) as string | undefined;
    this.db.prepare(`INSERT INTO agent_runs(id,turn_id,parent_run_id,depth,kind,agent_name,model_alias,effective_role,task_input,
      state,tool_calls,cost_usd,external_cost_usd,external_usage_json,result_summary,error,started_at,finished_at)
      VALUES (?,?,?,?,'sub',?,'external',?,?,?,?,0,?,?,?,?,?,?)`).run(
      id, entry.turnId, parent ?? null, parent ? 1 : 0,
      `acp:${entry.agent}`,
      /**
       * **写死 `owner` 而不是接一个参数。** `spawn_acp` 的第一道门是 `available()` 判 `role === 'owner'`
       * 且仅私聊，`execute()` 再判一次 `effectiveRole !== 'owner'` 直接拒 —— 能走到这里的有效角色
       * 只可能是 owner。留一个参数反而多出一条能与那道门分叉的路径。
       */
      'owner',
      entry.task,
      // 只有用户 `/cancel` 那一档记 cancelled；`acp_timeout` / `acp_cost_exceeded` 也是我们发的
      // cancel，但它们各自有下一步该做的事，记成 failed + error 码比并进 cancelled 说得清。
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
