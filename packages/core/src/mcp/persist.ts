import type { Sqlite } from "@luoli/db";
import { writeConfigRows } from "@luoli/db";
import { revisionJson } from "../config/redact.js";
import { configSchema, type Config } from "../config/schema.js";

export interface McpPersistPorts {
  db: Sqlite;
  config(): Readonly<Config>;
  /** 写入后把新配置回写 `ConfigStore`。缺失不致命，`config.changed` 的重载会补上，只是延迟一拍。
   *  但随后自行调用 `reconcile()` 的调用方必须提供：`emit` 的订阅者异步生效，不 apply
   *  时紧随其后的那次 reconcile 读到的仍是旧 servers。 */
  apply?(next: Readonly<Config>, keys: string[]): void;
  /** 广播 `config.changed`。自行 `await mcp.reconcile()` 的调用方需要在载荷中带上
   *  `reconciled: ['mcp']`（见 `ConfigChangedEvent`），否则订阅者会再执行一次，两次重叠的
   *  reconcile 会各 spawn 一个 stdio 子进程（docs/28 · L-EXT-03）。`install_mcp` 不执行 reconcile，
   *  因此不带该标记。 */
  emit(keys: string[]): void;
}

/**
 * `mcp.servers` 的唯一写入路径，`POST/PATCH/DELETE /api/mcp` 与 `install_mcp` 工具共用。
 *
 * 写成两份的必然结果是 WebUI 能创建的 server 工具创建不出来，或反之；`createScheduledJob`
 * 当初正是出于同一理由抽出。整份配置重新经过 `configSchema`：模型给出的记录与运维
 * 手填的记录受同一套校验，`transport` 判别联合、名称正则、URL 形状缺一不可。
 */
export function persistMcpServers(
  ports: McpPersistPorts,
  servers: unknown[],
  actor: string,
):
  | { ok: true; servers: Readonly<Config["mcp"]["servers"]> }
  | { ok: false; details: Array<{ path: string; message: string }> } {
  const current = ports.config();
  const parsed = configSchema.safeParse({
    ...current,
    mcp: { ...current.mcp, servers },
  });
  if (!parsed.success)
    return {
      ok: false,
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  const key = "mcp.servers";
  writeConfigRows(
    ports.db,
    [[key, parsed.data.mcp.servers]],
    actor,
    revisionJson,
  );
  ports.apply?.(parsed.data, [key]);
  ports.emit([key]);
  return { ok: true, servers: parsed.data.mcp.servers };
}
