import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '@luoli/db';
import { assignDotted, sortOverrideKeys } from '@luoli/shared';
import type { Sqlite } from './database.js';

/**
 * 运行时 KV。与 `config_kv` 严格分开：`config_kv` 的每一行都会被 `loadConfig` 当成配置覆盖层解析，
 * 放进去的非配置键会让下次启动直接失败（docs/19-review-round4.md · R-CFG-01）。
 */
/**
 * 坏 JSON 当「没有这一行」。`app_kv` 存的都是可选状态（会话模型别名、插件存储），而读它的地方
 * （`/model`、每轮的别名解析）都不在 try 里 —— 一行手工改坏的 JSON 会让那个会话每轮都抛
 * （docs/27 · T-06）。「库里可能有坏 JSON」不是假想：`app.ts` 对 `capabilities_json` 就专门 catch 了。
 */
export function readAppKv<T = unknown>(db: Sqlite, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM app_kv WHERE key=?').pluck().get(key) as string | undefined;
  if (row === undefined) return undefined;
  try { return JSON.parse(row) as T; } catch { return undefined; }
}

export function writeAppKv(db: Sqlite, key: string, value: unknown, updatedBy: string): void {
  db.prepare(`INSERT INTO app_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(key, JSON.stringify(value), Date.now(), updatedBy);
}

/** 返回删掉的行数：调用方要能区分「清掉了一份别名」和「本来就没有」。 */
export function deleteAppKv(db: Sqlite, key: string): number {
  return db.prepare('DELETE FROM app_kv WHERE key=?').run(key).changes;
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
    for (const row of sortOverrideKeys(rows)) {
      // 坏 JSON 跳过并上报，而不是让 `JSON.parse` 抛穿整个启动路径：一行手工改坏的覆盖
      // 让进程再也起不来，而补配置用的 WebUI 也跟着没了（同 docs/19 · R-CFG-01 的形态，
      // 那一轮修的是「schema 校验不过」，这一轮是「连 JSON 都不是」，docs/27 · T-06）。
      let value: unknown;
      try { value = JSON.parse(row.valueJson, (key, nested: unknown) => key === '__proto__' ? undefined : nested) as unknown; }
      catch { onRejected?.(row.key); continue; }
      if (!assignDotted(root, row.key, value)) onRejected?.(row.key);
    }
    return root;
  } finally {
    db.close();
  }
}
