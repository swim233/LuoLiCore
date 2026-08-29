import { ulid } from "ulid";
import type { Role } from "@luoli/shared";
import { minRole, roleRank } from "@luoli/shared";
import type { Sqlite } from "@luoli/db";
import type { AgentResultStore } from "../prompt/documents.js";

export interface AgentDefinition {
  name: string;
  description: string;
  modelAlias: string;
  maxSteps: number;
  minRole: Role;
  tools: string[];
  resultMaxChars: number;
  instructions: string;
  injectMemory?: boolean;
}

export interface AgentRun {
  id: string;
  turnId: string;
  parentRunId: string | null;
  depth: number;
  agentName: string;
  effectiveRole: Role;
}

export class AgentManager {
  readonly #definitions = new Map<string, AgentDefinition>();

  constructor(
    private readonly db: Sqlite,
    private readonly results: AgentResultStore,
    definitions: AgentDefinition[],
    private readonly maxDepth: number,
    private readonly maxSubagentsPerTurn: number,
  ) {
    for (const definition of definitions)
      this.#definitions.set(definition.name, definition);
  }

  /** 定义只在构造时读取一次；WebUI 修改 agent 后若不重建这张表，运维看到的是保存成功但派发的仍是旧定义。 */
  replaceDefinitions(definitions: readonly AgentDefinition[]): void {
    this.#definitions.clear();
    for (const definition of definitions)
      this.#definitions.set(definition.name, definition);
  }

  available(role: Role): AgentDefinition[] {
    return [...this.#definitions.values()].filter(
      (definition) => roleRank(role) >= roleRank(definition.minRole),
    );
  }
  definition(name: string): AgentDefinition | null {
    return this.#definitions.get(name) ?? null;
  }

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
    name: string,
    task: string,
    role: Role = "owner",
  ): { run: AgentRun; definition: AgentDefinition } {
    const definition = this.#definitions.get(name);
    if (!definition) throw new Error(`未知子 agent: ${name}`);
    if (roleRank(role) < roleRank(definition.minRole))
      throw new Error("当前用户权限不足以试跑该子 agent");
    const turnId = `dryrun:${ulid()}`;
    const run: AgentRun = {
      id: ulid(),
      turnId,
      parentRunId: null,
      depth: 0,
      agentName: name,
      effectiveRole: minRole(role, definition.minRole),
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,task_input,state,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        turnId,
        0,
        "sub",
        name,
        definition.modelAlias,
        run.effectiveRole,
        task,
        "running",
        Date.now(),
      );
    return { run, definition };
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

  spawn(
    parent: AgentRun,
    name: string,
    task: string,
    modelAlias?: string,
  ): { run: AgentRun; definition: AgentDefinition } {
    const definition = this.#definitions.get(name);
    if (!definition) throw new Error(`未知子 agent: ${name}`);
    if (parent.depth + 1 > this.maxDepth)
      throw new Error("已达子 agent 深度上限");
    if (roleRank(parent.effectiveRole) < roleRank(definition.minRole))
      throw new Error("当前用户权限不足以派发该子 agent");
    /**
     * ACP 行（M13，`packages/core/src/acp/runs.ts`）不占用这个名额。`maxSubagentsPerTurn` 约束的是
     * 本系统自身的 fan-out 成本，每个子 agent 都是一次本系统付费的模型调用；而 `spawn_acp`
     * 有自己的三道门（owner 且仅私聊、目录白名单、每次审批）加目录互斥加 `agent.acp.maxCostUsd`，
     * 从不共用这个数值。旧口径（只数行、不看 `agent_name`）的问题不止于多占一个名额：那一行是
     * 执行结束后才一次性插入的，因此它只能限制同一轮中排在其后的 `spawn_agent`，形成一个依赖
     * 调用顺序的上界，比占用与不占用两种一致做法都更糟（docs/03 §2.7）。
     *
     * 前缀与别名两者同时命中才排除：`agent.agents[].name` 是裸 `z.string()`（`agents/<name>.md`
     * 那条路的正则能挡住冒号，DB 与 WebUI 那条挡不住），运维确实可以建一个名为 `acp:x` 的子 agent，
     * 只有它同时把 `modelAlias` 也写成 `external` 才会被漏计。用 `GLOB` 而非 `LIKE`：后者在 SQLite 中
     * 对 ASCII 大小写不敏感，会把 `ACP:x` 一并排除。
     */
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS value FROM agent_runs WHERE turn_id=? AND kind='sub' AND NOT (agent_name GLOB 'acp:*' AND model_alias='external')",
      )
      .get(parent.turnId) as { value: number };
    if (count.value >= this.maxSubagentsPerTurn)
      throw new Error("已达本轮子 agent 数量上限");
    const ancestors = this.ancestors(parent);
    if (ancestors.filter((entry) => entry.agentName === name).length >= 2)
      throw new Error("检测到子 agent 环路");
    const run: AgentRun = {
      id: ulid(),
      turnId: parent.turnId,
      parentRunId: parent.id,
      depth: parent.depth + 1,
      agentName: name,
      effectiveRole: minRole(parent.effectiveRole, definition.minRole),
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs(id,turn_id,parent_run_id,depth,kind,agent_name,model_alias,effective_role,task_input,state,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.turnId,
        run.parentRunId,
        run.depth,
        "sub",
        name,
        modelAlias ?? definition.modelAlias,
        run.effectiveRole,
        task,
        "running",
        Date.now(),
      );
    return { run, definition };
  }

  finish(
    run: AgentRun,
    result: string,
  ): { summary: string; fullRef: string; truncated: boolean } {
    const definition = this.#definitions.get(run.agentName);
    const limit = definition?.resultMaxChars ?? 4000;
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

  private ancestors(run: AgentRun): AgentRun[] {
    const values: AgentRun[] = [run];
    let parent = run.parentRunId;
    while (parent) {
      const row = this.db
        .prepare(
          "SELECT id,turn_id AS turnId,parent_run_id AS parentRunId,depth,agent_name AS agentName,effective_role AS effectiveRole FROM agent_runs WHERE id=?",
        )
        .get(parent) as AgentRun | undefined;
      if (!row) break;
      values.push(row);
      parent = row.parentRunId;
    }
    return values;
  }
}
