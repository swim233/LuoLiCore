import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "@luoli/db";
import { assignDotted, sortOverrideKeys } from "@luoli/shared";
import type { Sqlite } from "./database.js";

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
  const row = db
    .prepare("SELECT value_json FROM app_kv WHERE key=?")
    .pluck()
    .get(key) as string | undefined;
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row) as T;
  } catch {
    return undefined;
  }
}

export function writeAppKv(
  db: Sqlite,
  key: string,
  value: unknown,
  updatedBy: string,
): void {
  db.prepare(
    `INSERT INTO app_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
  ).run(key, JSON.stringify(value), Date.now(), updatedBy);
}

/** 返回删掉的行数：调用方要能区分「清掉了一份别名」和「本来就没有」。 */
export function deleteAppKv(db: Sqlite, key: string): number {
  return db.prepare("DELETE FROM app_kv WHERE key=?").run(key).changes;
}

export const modelAliasKey = (contextKey: string): string =>
  `modelAlias:${contextKey}`;

/**
 * 配置写入的唯一出口：落 `config_kv` + `config_revisions`，并**删掉被这次写入吞掉的后代行**。
 * 覆盖层按点分深度应用（`sortOverrideKeys`：更具体的路径赢），所以写 `tools.overrides` 整块时若
 * 库里还留着此前逐项写下的 `tools.overrides.<name>`，那一项会把整块的对应位置局部否掉 ——
 * 界面上表现为「JSON 里明明写着开着，刷新回来还是关的」。祖先键代表整棵子树，后代行因此作废；
 * 作废也要进变更历史，否则历史会瞒下「你那条逐项覆盖是谁弄掉的」。
 *
 * `revisionValue` 是脱敏口径（`@luoli/core` 的 `revisionJson`）：`config_kv` 存真值，历史只存脱敏后的。
 * 它作为参数传进来而不是写死在这里 —— 「哪些键算密钥」是配置层的策略，不是存储层该知道的事。
 * 写入端不止 WebUI 一个（`install_mcp` 走同一条路），两边必须共用同一份实现，否则密钥会明文
 * 躺进其中一条路径的变更历史里。
 *
 * `prune` 是**显式删除**的键：叶子粒度的写入端（`PUT /api/config/yaml`）不再靠祖先键吞并后代来
 * 实现「这份 YAML 是覆盖层的全量视图」，删掉一个键必须真的让它从库里消失。它和 `stale` 走同一条
 * 删除路径 —— 同一个事务、同样记 `config_revisions`：这个函数是配置写入的唯一出口，另开一条
 * `DELETE` 的代价是那批删除不进变更历史（docs/28 · L-WEB-02）。不在库里的键静静跳过，
 * 不留一条新旧都为空的假 revision。返回值仍只是 `stale`：「被整块吞并的更细覆盖」要交回给运维
 * 点名核对，而 `prune` 是调用方自己算出来的，它本来就知道。
 */
export function writeConfigRows(
  db: Sqlite,
  entries: Array<[string, unknown]>,
  actor: string,
  revisionValue: (key: string, value: unknown) => string,
  prune: readonly string[] = [],
): string[] {
  const now = Date.now();
  const keys = entries.map(([key]) => key);
  const stale = (
    db.prepare("SELECT key FROM config_kv").pluck().all() as string[]
  ).filter((row) => keys.some((key) => row.startsWith(`${key}.`)));
  // 这次要写的键不参与删除：先删再写只会多出一条 `old→null→new` 的假历史。
  const removals = [
    ...new Set([...stale, ...prune.filter((key) => !keys.includes(key))]),
  ];
  const read = db.prepare(
    "SELECT value_json AS value FROM config_kv WHERE key=?",
  );
  const write =
    db.prepare(`INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
  const drop = db.prepare("DELETE FROM config_kv WHERE key=?");
  const revision = db.prepare(
    "INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)",
  );
  /** 旧值同样脱敏：它是从 `config_kv` 里读出来的真值。 */
  const previousJson = (
    key: string,
    previous: { value: string } | undefined,
  ): string | null => {
    if (!previous?.value) return null;
    try {
      return revisionValue(key, JSON.parse(previous.value) as unknown);
    } catch {
      return null;
    }
  };
  db.transaction(() => {
    for (const key of removals) {
      const previous = read.get(key) as { value: string } | undefined;
      if (!previous) continue;
      drop.run(key);
      revision.run(
        randomBytes(16).toString("hex"),
        now,
        actor,
        key,
        previousJson(key, previous),
        null,
      );
    }
    for (const [key, value] of entries) {
      const previous = read.get(key) as { value: string } | undefined;
      write.run(key, JSON.stringify(value), now, actor);
      revision.run(
        randomBytes(16).toString("hex"),
        now,
        actor,
        key,
        previousJson(key, previous),
        revisionValue(key, value),
      );
    }
  })();
  return stale;
}

/**
 * `onRejected` 收到的键是被 `assignDotted` 拒掉的路径（`__proto__` 之类）。它们进不了返回值，
 * 但必须报出来：静默丢弃配置和静默崩溃一样糟，何况能出现在这里就说明写入端漏了一道校验。
 */
export function readPersistedConfig(
  path: string,
  onRejected?: (key: string) => void,
): Record<string, unknown> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return {};
  const db = openDatabase(absolute);
  try {
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_kv'",
      )
      .get();
    if (!hasTable) return {};
    const rows = db
      .prepare("SELECT key,value_json AS valueJson FROM config_kv")
      .all() as Array<{ key: string; valueJson: string }>;
    const root: Record<string, unknown> = {};
    for (const row of sortOverrideKeys(rows)) {
      // 坏 JSON 跳过并上报，而不是让 `JSON.parse` 抛穿整个启动路径：一行手工改坏的覆盖
      // 让进程再也起不来，而补配置用的 WebUI 也跟着没了（同 docs/19 · R-CFG-01 的形态，
      // 那一轮修的是「schema 校验不过」，这一轮是「连 JSON 都不是」，docs/27 · T-06）。
      let value: unknown;
      try {
        value = JSON.parse(row.valueJson, (key, nested: unknown) =>
          key === "__proto__" ? undefined : nested,
        ) as unknown;
      } catch {
        onRejected?.(row.key);
        continue;
      }
      if (!assignDotted(root, row.key, value)) onRejected?.(row.key);
    }
    return root;
  } finally {
    db.close();
  }
}
