import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '@luoli/db';
import { assignDotted } from '@luoli/shared';
import type { Sqlite } from './database.js';

/**
 * 运行时 KV。与 `config_kv` 严格分开：`config_kv` 的每一行都会被 `loadConfig` 当成配置覆盖层解析，
 * 放进去的非配置键会让下次启动直接失败（docs/19-review-round4.md · R-CFG-01）。
 */
export function readAppKv<T = unknown>(db: Sqlite, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key=?').pluck().get(key) as string | undefined;
  return row === undefined ? undefined : JSON.parse(row) as T;
}

export function writeAppKv(db: Sqlite, key: string, value: unknown, updatedBy: string): void {
  db.prepare(`INSERT INTO app_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(key, JSON.stringify(value), Date.now(), updatedBy);
}

export const modelAliasKey = (contextKey: string): string => `modelAlias:${contextKey}`;

/**
 * `onRejected` 收到的键是被 `assignDotted` 拒掉的路径（`__proto__` 之类）。它们进不了返回值，
 * 但必须报出来：静默丢弃配置和静默崩溃一样糟，何况能出现在这里就说明写入端漏了一道校验。
 */
export function readPersistedConfig(path: string, onRejected?: (key: string) => void): Record<string, unknown> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return {};
  const db = openDatabase(absolute);
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_kv'").get();
    if (!hasTable) return {};
    const rows = db.prepare('SELECT key,value_json AS valueJson FROM config_kv').all() as Array<{ key: string; valueJson: string }>;
    const root: Record<string, unknown> = {};
    for (const row of rows) if (!assignDotted(root, row.key, JSON.parse(row.valueJson) as unknown)) onRejected?.(row.key);
    return root;
  } finally {
    db.close();
  }
}
