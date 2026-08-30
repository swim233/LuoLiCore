import { ulid } from "ulid";
import type { Role } from "@luoli/shared";
import type { Sqlite } from "@luoli/db";
import type { AgentResultStore } from "../prompt/documents.js";

/**
 * `agent_runs.worker_kind`（迁移 `0018`）。主 run 为 NULL —— 它不是 worker。
 *
 * `kind` 那一列上有 `CHECK (kind IN ('main','sub'))`，改它要重建整张 trace 骨架表，因此三条
 * worker 路径照旧记 `kind='sub'`，靠这一列区分。此前区分靠的是 `agent_name GLOB 'acp:*'`
 * 加 `model_alias='external'` 两个字符串判据，而字符串判据只在没人起名叫 `acp:x` 时成立。
 */
export const WORKER_KINDS = ["lw", "harness", "acp"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/** lw-worker 的 `agent_name`。只有一种 worker，名字不再是可配置项。 */
export const LW_WORKER_NAME = "lw";

export interface AgentRun {
  id: string;
  turnId: string;
  parentRunId: string | null;
  depth: number;
  agentName: string;
  effectiveRole: Role;
}

export class AgentManager {
  constructor(
    private readonly db: Sqlite,
    private readonly results: AgentResultStore,
    private readonly maxWorkersPerTurn: number,
  ) {}

  result(
    runId: string,
    offset = 0,
    limit = 65_536,
  ): { content: string; nextOffset: number | null } {
    // 列中存放的是相对结果目录的 ref（docs/28 · L-OPS-06），路径拼接在 `AgentResultStore` 中完成，
    // 只有那里知道当前配置指向哪个目录。
    const row = this.db
      .prepare(
        "SELECT result_full_ref AS ref FROM agent_runs WHERE id=? AND state='done'",
      )
      .get(runId) as { ref: string | null } | undefined;
    if (!row?.ref) throw new Error("agent_result_unavailable");
    return this.results.read(row.ref, offset, limit);
  }

  createMain(turnId: string, role: Role, modelAlias: string): AgentRun {
    const existing = this.db
      .prepare(
        "SELECT id,turn_id AS turnId,parent_run_id AS parentRunId,depth,agent_name AS agentName,effective_role AS effectiveRole FROM agent_runs WHERE turn_id=? AND kind='main'",
      )
      .get(turnId) as AgentRun | undefined;
    if (existing) return existing;
    const run: AgentRun = {
      id: ulid(),
      turnId,
      parentRunId: null,
      depth: 0,
      agentName: "main",
      effectiveRole: role,
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,state,started_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        turnId,
        0,
        "main",
        "main",
        modelAlias,
        role,
        "running",
        Date.now(),
      );
    return run;
  }
  /** WebUI 试跑不创建 turns/context 行，只留一条可审计的 agent_run。 */
  createDryRun(
    task: string,
    modelAlias: string,
    role: Role = "owner",
  ): AgentRun {
    const turnId = `dryrun:${ulid()}`;
    const run: AgentRun = {
      id: ulid(),
      turnId,
      parentRunId: null,
      depth: 0,
      agentName: LW_WORKER_NAME,
      effectiveRole: role,
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs(id,turn_id,depth,kind,worker_kind,agent_name,model_alias,effective_role,task_input,state,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        turnId,
        0,
        "sub",
        "lw",
        LW_WORKER_NAME,
        modelAlias,
        run.effectiveRole,
        task,
        "running",
        Date.now(),
      );
    return run;
  }

  byId(id: string): AgentRun | null {
    return (
      (this.db
        .prepare(
          "SELECT id,turn_id AS turnId,parent_run_id AS parentRunId,depth,agent_name AS agentName,effective_role AS effectiveRole FROM agent_runs WHERE id=?",
        )
        .get(id) as AgentRun | undefined) ?? null
    );
  }

  /**
   * 派一个 lw-worker。
   *
   * **有效角色照抄父 run**，不再按定义收窄：只有一种 worker，而它是主 agent 的整个执行面 ——
   * 收窄它等于让主 agent 用得到的工具在它手里报权限不足（`docs/04 §3`）。
   */
  spawn(parent: AgentRun, task: string, modelAlias: string): AgentRun {
    /**
     * worker 是叶子。真正的闸在 `toolCallableBy()`：`spawn_worker` 在 `MAIN_ONLY_TOOLS` 里，
     * worker 既拿不到它的目录项也过不了 `admit()`。这一条是兜底，留着的理由是判据要长在源码结构上
     * —— 删掉之后「worker 派不出 worker」就只能靠通读 `policy.ts` 的集合成员来确认。
     *
     * 它同时取代了两样东西：`agent.maxDepth`（层数只剩一层，配它等于配一个只有两个合法取值的数）
     * 与环路检测（旧的「同名祖先 ≥2 即拒」—— 只剩一个 worker 名字时它就等价于 `depth ≥ 2` 一律拒）。
     */
    if (parent.depth > 0) throw new Error("worker 不能再派发 worker");
    /**
     * harness / ACP 的行不占这个名额。`maxWorkersPerTurn` 约束的是本系统自身的 fan-out 成本 ——
     * 每个 lw-worker 都是一次本系统付费的模型调用；外部那两条路烧的是它们自己的额度，各自另有
     * 三道门（owner 且仅私聊、目录白名单、每次审批）加 `agent.acp.maxCostUsd`，从不共用这个数值。
     *
     * 判据是 `worker_kind='lw'` 这一列（迁移 `0018`）。此前是 `NOT (agent_name GLOB 'acp:*' AND
     * model_alias='external')` —— 两个字符串判据，只在没人把子 agent 起名叫 `acp:x` 时成立
     * （那套定义体系已经删掉了，但库里的历史行还在，迁移的回填因此按同一对判据认它们）；
     * 而外部那两条路的行都是执行结束后才一次性插入的，于是它还形成了一个依赖调用顺序的上界
     * （同一轮中排在 ACP 之前的派发不受影响，排在其后的被多算一个，docs/03 §2.7）。
     */
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS value FROM agent_runs WHERE turn_id=? AND worker_kind='lw'",
      )
      .get(parent.turnId) as { value: number };
    if (count.value >= this.maxWorkersPerTurn)
      throw new Error("已达本轮 worker 数量上限");
    const run: AgentRun = {
      id: ulid(),
      turnId: parent.turnId,
      parentRunId: parent.id,
      depth: parent.depth + 1,
      agentName: LW_WORKER_NAME,
      effectiveRole: parent.effectiveRole,
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs(id,turn_id,parent_run_id,depth,kind,worker_kind,agent_name,model_alias,effective_role,task_input,state,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.turnId,
        run.parentRunId,
        run.depth,
        "sub",
        "lw",
        LW_WORKER_NAME,
        modelAlias,
        run.effectiveRole,
        task,
        "running",
        Date.now(),
      );
    return run;
  }

  /**
   * harness 跑完之后补的那一行（`worker_kind='harness'`）。此前 `spawn_harness` 压根不落库，只留
   * 一条 `agent.harness` 日志 —— 于是 WebUI 的 trace 树上外部 harness 整段不存在，而它是三条
   * worker 路径里唯一能改宿主仓库的那条。
   *
   * 执行结束后一次性插入、不留 running 窗口，照 `acp/runs.ts` 的先例：这条路没有中途要更新的字段
   * （steps / tokens 全程为 0），而一个 running 窗口就多一份要靠 `recoverAfterCrash` 收尾的状态。
   *
   * `cost_usd` 恒 0，理由与 ACP 行相同（`docs/04 §6.2`）：harness 烧的是它自己那份 provider 额度，
   * 本系统收不到用量、也没有 tokens × prices 可以重算，写进去只会让它出现在每一个 `SUM(cost_usd)` 里。
   * 与 ACP 不同的是连 `external_cost_usd` 也不写：harness 是 argv 进、stdout 出，一次用量都不上报，
   * 而 NULL 如实表示「对方没报过」。
   */
  recordHarness(entry: {
    /** 与工具壳给这次调用建的工作目录同名 —— 事后能从这一行找回它在磁盘上留下的东西。 */
    id: string;
    turnId: string;
    command: string;
    task: string;
    ok: boolean;
    error?: string | undefined;
    output: string;
    startedAt: number;
    finishedAt: number;
  }): string {
    const id = entry.id;
    const parent = this.db
      .prepare("SELECT id FROM agent_runs WHERE turn_id=? AND kind='main'")
      .pluck()
      .get(entry.turnId) as string | undefined;
    this.db
      .prepare(
        `INSERT INTO agent_runs(id,turn_id,parent_run_id,depth,kind,worker_kind,agent_name,model_alias,effective_role,task_input,
      state,cost_usd,result_summary,error,started_at,finished_at) VALUES (?,?,?,?,'sub','harness',?,'external','owner',?,?,0,?,?,?,?)`,
      )
      .run(
        id,
        entry.turnId,
        parent ?? null,
        parent ? 1 : 0,
        `harness:${entry.command}`,
        entry.task,
        entry.ok ? "done" : "failed",
        entry.output || null,
        entry.error ?? null,
        entry.startedAt,
        entry.finishedAt,
      );
    return id;
  }

  /** `limit` 由调用方给出（`agent.worker.resultMaxChars` 或 `maxResultChars`），此处不揣测。 */
  finish(
    run: AgentRun,
    result: string,
    limit: number,
  ): { summary: string; fullRef: string; truncated: boolean } {
    const summary = [...result].slice(0, limit).join("");
    // 落库的是相对 ref，返回给模型的是 `agentresult://<runId>`：模型侧拿到的是句柄而非路径，
    // 两者始终不是同一个东西（docs/28 · L-OPS-06）。
    const ref = this.results.put(run.id, result);
    this.db
      .prepare(
        "UPDATE agent_runs SET state='done',result_summary=?,result_full_ref=?,finished_at=? WHERE id=? AND state='running'",
      )
      .run(summary, ref, Date.now(), run.id);
    return {
      summary,
      fullRef: `agentresult://${run.id}`,
      truncated: [...summary].length < [...result].length,
    };
  }

  fail(run: AgentRun, error: string): void {
    this.db
      .prepare(
        "UPDATE agent_runs SET state='failed',error=?,finished_at=? WHERE id=? AND state='running'",
      )
      .run(error, Date.now(), run.id);
  }

  ask(run: AgentRun, parent: AgentRun, payload: unknown): string {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO agent_messages(id,turn_id,from_run_id,to_run_id,kind,payload_json,state,created_at) VALUES (?,?,?,?,? ,?,'sent',?)",
      )
      .run(
        id,
        run.turnId,
        run.id,
        parent.id,
        "ask",
        JSON.stringify(payload),
        Date.now(),
      );
    return id;
  }

  answer(
    id: string,
    payload: unknown,
    source: "rule" | "arbiter" | "user" | "timeout",
  ): void {
    const ask = this.db
      .prepare(
        "SELECT turn_id AS turnId,from_run_id AS fromRunId,to_run_id AS toRunId FROM agent_messages WHERE id=? AND kind='ask'",
      )
      .get(id) as
      { turnId: string; fromRunId: string; toRunId: string } | undefined;
    if (!ask) throw new Error("agent_ask_not_found");
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE agent_messages SET state=?,answered_at=? WHERE id=?")
        .run(source === "timeout" ? "timeout" : "answered", Date.now(), id);
      this.db
        .prepare(
          "INSERT INTO agent_messages(id,turn_id,from_run_id,to_run_id,kind,payload_json,state,created_at,answered_at) VALUES (?,?,?,?,? ,?,'answered',?,?)",
        )
        .run(
          ulid(),
          ask.turnId,
          ask.toRunId,
          ask.fromRunId,
          "answer",
          JSON.stringify({ askId: id, payload, source }),
          Date.now(),
          Date.now(),
        );
    })();
  }

  progress(run: AgentRun, payload: unknown): void {
    this.db
      .prepare(
        "INSERT INTO agent_messages(id,turn_id,from_run_id,to_run_id,kind,payload_json,state,created_at) VALUES (?,?,?,?,? ,?,'sent',?)",
      )
      .run(
        ulid(),
        run.turnId,
        run.id,
        run.parentRunId ?? run.id,
        "progress",
        JSON.stringify(payload),
        Date.now(),
      );
    this.db
      .prepare(
        "UPDATE tasks SET progress_json=?,updated_at=? WHERE agent_run_id=? AND state='running'",
      )
      .run(JSON.stringify(payload), Date.now(), run.id);
  }
}
