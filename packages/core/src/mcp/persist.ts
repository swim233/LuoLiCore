import type { Sqlite } from '@luoli/db';
import { writeConfigRows } from '@luoli/db';
import { revisionJson } from '../config/redact.js';
import { configSchema, type Config } from '../config/schema.js';

export interface McpPersistPorts {
  db: Sqlite;
  config(): Readonly<Config>;
  /** 写完之后把新配置盖回 `ConfigStore`。缺席也不致命 —— `config.changed` 的重载会补上，只是慢一拍。 */
  apply?(next: Readonly<Config>, keys: string[]): void;
  emit(keys: string[]): void;
}

/**
 * `mcp.servers` 的唯一写入路径，`POST/PATCH/DELETE /api/mcp` 与 `install_mcp` 工具共用。
 *
 * 抄两份的必然结果是 WebUI 建得出来的 server 工具建不出来、或者反过来 —— `createScheduledJob`
 * 当初就是为同一个理由抽出去的。整份配置重新过一遍 `configSchema`：模型给的这条记录要和运维
 * 手填的那条受同一套校验，`transport` 判别联合、名字正则、URL 形状一个都不能少。
 */
export function persistMcpServers(ports: McpPersistPorts, servers: unknown[], actor: string):
{ ok: true; servers: Readonly<Config['mcp']['servers']> } | { ok: false; details: Array<{ path: string; message: string }> } {
  const current = ports.config();
  const parsed = configSchema.safeParse({ ...current, mcp: { ...current.mcp, servers } });
  if (!parsed.success) return { ok: false, details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
  const key = 'mcp.servers';
  writeConfigRows(ports.db, [[key, parsed.data.mcp.servers]], actor, revisionJson);
  ports.apply?.(parsed.data, [key]);
  ports.emit([key]);
  return { ok: true, servers: parsed.data.mcp.servers };
}
