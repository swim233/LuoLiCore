import { createHash } from "node:crypto";
import type { Sqlite } from "./database.js";

export type CustomToolRuntime = "bash" | "python";
export type CustomToolScope = "chat" | "global";

export interface CustomTool {
  name: string;
  description: string;
  /** 参数的 JSON Schema（object 型）。注册时经 `jsonSchemaToZod` 转成 zod 交给模型。 */
  paramsJson: string;
  runtime: CustomToolRuntime;
  body: string;
  minRole: "trusted" | "owner";
  scope: CustomToolScope;
  ownerChatId: string | null;
  timeoutMs: number | null;
  enabled: number;
  definitionHash: string;
  createdBy: string;
  createdTurn: string | null;
  reviewedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewCustomTool {
  name: string;
  description: string;
  paramsJson: string;
  runtime: CustomToolRuntime;
  body: string;
  minRole: "trusted" | "owner";
  scope: CustomToolScope;
  ownerChatId: string | null;
  timeoutMs: number | null;
  createdBy: string;
  createdTurn: string | null;
}

const COLUMNS = `name,description,params_json AS paramsJson,runtime,body,min_role AS minRole,scope,owner_chat_id AS ownerChatId,
  timeout_ms AS timeoutMs,enabled,definition_hash AS definitionHash,created_by AS createdBy,created_turn AS createdTurn,
  reviewed_at AS reviewedAt,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt`;

/**
 * 只覆盖**参与执行语义**的那几列。描述与 minRole 不进哈希：改描述不该让本轮正在跑的调用失败，
 * 而 minRole 的变化由 `admit()` 每次重新判，不需要靠哈希兜。
 */
export function customToolHash(
  input: Pick<NewCustomTool, "paramsJson" | "runtime" | "body" | "timeoutMs">,
): string {
  return createHash("sha256")
    .update(
      [input.runtime, input.timeoutMs ?? "", input.paramsJson, input.body].join(
        "\0",
      ),
    )
    .digest("hex");
}

/**
 * `custom_tools` 的唯一访问入口（裸 SQL 不出 `packages/db`，docs/00 §2.1 D-01）。
 *
 * `upsert` 的返回值带 `reset`：调用方要能把「新建」「只改了描述」「改了正文所以被打回未启用」
 * 三种情形分开告诉模型 —— 模型定义完一个工具却在下一轮找不到它时，得知道是被闸挡住了。
 *
 * 执行前的漂移检查走 `get()` 而不是一个「只取已启用的哈希」的窄方法：那样的话「被停用」与
 * 「定义变了」会挤成同一个信号，模型收到「定义变了」去查、看见定义原封不动、然后原样重试。
 */
export class CustomToolRepository {
  constructor(private readonly db: Sqlite) {}

  get(name: string): CustomTool | null {
    return (
      (this.db
        .prepare(`SELECT ${COLUMNS} FROM custom_tools WHERE name=?`)
        .get(name) as CustomTool | undefined) ?? null
    );
  }

  list(): CustomTool[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM custom_tools ORDER BY name`)
      .all() as CustomTool[];
  }

  listEnabled(): CustomTool[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM custom_tools WHERE enabled=1 ORDER BY name`,
      )
      .all() as CustomTool[];
  }

  count(): number {
    return this.db
      .prepare("SELECT COUNT(*) FROM custom_tools")
      .pluck()
      .get() as number;
  }

  /**
   * 「现在这一份定义集是什么样」的廉价指纹，`CustomToolManager.syncIfChanged` 用它决定要不要重扫。
   *
   * **条数不能省**：删掉一行不会推高 `MAX(updated_at)`，只看时间戳的话一次删除永远同步不过去。
   */
  fingerprint(): string {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS at FROM custom_tools",
      )
      .get() as { n: number; at: number };
    return `${row.n}:${row.at}`;
  }

  /** 改了正文 / 参数 / runtime / 超时就打回未启用，并清掉复审时间戳。 */
  upsert(input: NewCustomTool): {
    tool: CustomTool;
    created: boolean;
    reset: boolean;
  } {
    const now = Date.now();
    const hash = customToolHash(input);
    const existing = this.get(input.name);
    const reset =
      existing !== null &&
      existing.definitionHash !== hash &&
      existing.enabled === 1;
    this.db
      .prepare(
        `INSERT INTO custom_tools(name,description,params_json,runtime,body,min_role,scope,owner_chat_id,timeout_ms,
        enabled,definition_hash,created_by,created_turn,reviewed_at,last_error,created_at,updated_at)
      VALUES (@name,@description,@paramsJson,@runtime,@body,@minRole,@scope,@ownerChatId,@timeoutMs,0,@hash,@createdBy,@createdTurn,NULL,NULL,@now,@now)
      ON CONFLICT(name) DO UPDATE SET description=excluded.description,params_json=excluded.params_json,runtime=excluded.runtime,
        body=excluded.body,min_role=excluded.min_role,scope=excluded.scope,owner_chat_id=excluded.owner_chat_id,
        timeout_ms=excluded.timeout_ms,last_error=NULL,updated_at=excluded.updated_at,
        enabled=CASE WHEN custom_tools.definition_hash=excluded.definition_hash THEN custom_tools.enabled ELSE 0 END,
        reviewed_at=CASE WHEN custom_tools.definition_hash=excluded.definition_hash THEN custom_tools.reviewed_at ELSE NULL END,
        definition_hash=excluded.definition_hash`,
      )
      .run({ ...input, hash, now });
    return { tool: this.get(input.name)!, created: existing === null, reset };
  }

  /** 启停由运维走。启用顺手盖 `reviewed_at` —— 「有人看过这段正文」就是这个时间戳的全部含义。 */
  setEnabled(name: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare(
          "UPDATE custom_tools SET enabled=?,reviewed_at=CASE WHEN ? THEN ? ELSE reviewed_at END,updated_at=? WHERE name=?",
        )
        .run(enabled ? 1 : 0, enabled ? 1 : 0, Date.now(), Date.now(), name)
        .changes === 1
    );
  }

  markError(name: string, error: string | null): void {
    this.db
      .prepare("UPDATE custom_tools SET last_error=?,updated_at=? WHERE name=?")
      .run(error, Date.now(), name);
  }

  remove(name: string): boolean {
    return (
      this.db.prepare("DELETE FROM custom_tools WHERE name=?").run(name)
        .changes === 1
    );
  }
}
