import { createHash } from "node:crypto";
import type { Sqlite } from "./database.js";

export type CustomToolRuntime = "bash" | "python";
export type CustomToolScope = "chat" | "global";

export interface CustomTool {
  name: string;
  description: string;
  /** 参数的 JSON Schema（object 型）。注册时经 `jsonSchemaToZod` 转为 zod 后交给模型。 */
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
 * 只覆盖参与执行语义的列。描述与 minRole 不参与哈希：修改描述不应使本轮正在执行的调用失败，
 * 而 minRole 的变化由 `admit()` 每次重新判定，无需依赖哈希兜底。
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
 * `upsert` 的返回值带 `reset`：调用方需要向模型区分「新建」「仅修改描述」「修改正文因而被重置为未启用」
 * 三种情形。模型定义完一个工具却在下一轮找不到它时，必须能知道是被闸拦下的。
 *
 * 执行前的漂移检查走 `get()` 而非「只取已启用项哈希」的窄方法：后者会把「已停用」与「定义已变更」
 * 合并为同一信号，模型收到「定义已变更」后去核查、发现定义未变、于是原样重试。
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
   * 当前定义集的廉价指纹，`CustomToolManager.syncIfChanged` 据此决定是否重扫。
   *
   * 行数不可省略：删除一行不会推高 `MAX(updated_at)`，只看时间戳时删除操作永远同步不到。
   */
  fingerprint(): string {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS at FROM custom_tools",
      )
      .get() as { n: number; at: number };
    return `${row.n}:${row.at}`;
  }

  /** 正文 / 参数 / runtime / 超时发生变更时重置为未启用，并清除复审时间戳。 */
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

  /** 启停由运维执行。启用时写入 `reviewed_at`，该时间戳的含义就是「有人复核过这段正文」。 */
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
