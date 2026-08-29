import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "@luoli/db";
import { assignDotted, sortOverrideKeys } from "@luoli/shared";
import type { Sqlite } from "./database.js";

/**
 * 运行时 KV，与 `config_kv` 严格分离：`config_kv` 的每一行都会被 `loadConfig` 解析为配置覆盖层，
 * 写入非配置键会导致下次启动失败（docs/19-review-round4.md · R-CFG-01）。
 */
/**
 * 无法解析的 JSON 按「该行不存在」处理。`app_kv` 存放的都是可选状态（会话模型别名、插件存储），
 * 而读取方（`/model`、每轮的别名解析）都不在 try 块内，一行损坏的 JSON 会使该会话每轮抛异常
 * （docs/27 · T-06）。库中存在损坏 JSON 并非假设：`app.ts` 对 `capabilities_json` 已专门 catch。
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

/** 返回删除的行数：调用方需要区分「清除了一份别名」与「原本就不存在」。 */
export function deleteAppKv(db: Sqlite, key: string): number {
  return db.prepare("DELETE FROM app_kv WHERE key=?").run(key).changes;
}

export const modelAliasKey = (contextKey: string): string =>
  `modelAlias:${contextKey}`;

/**
 * 配置写入的唯一出口：写入 `config_kv` 与 `config_revisions`，并删除被本次写入吞并的后代行。
 * 覆盖层按点分深度应用（`sortOverrideKeys`，更具体的路径优先），因此写入 `tools.overrides` 整块时，
 * 若库中仍留有此前逐项写入的 `tools.overrides.<name>`，该项会局部覆盖整块的对应位置，
 * 界面表现为「JSON 中写着启用，刷新后仍为禁用」。祖先键代表整棵子树，后代行因此作废；
 * 作废同样要记入变更历史，否则历史无法说明逐项覆盖是被谁清除的。
 *
 * `revisionValue` 是脱敏口径（`@luoli/core` 的 `revisionJson`）：`config_kv` 存真值，历史只存脱敏值。
 * 它由参数传入而非写死于此：「哪些键属于密钥」是配置层的策略，不应由存储层判断。
 * 写入端不止 WebUI（`install_mcp` 走同一条路），两侧必须共用同一实现，否则密钥会明文写入其中一条
 * 路径的变更历史。
 *
 * `prune` 是显式删除的键：叶子粒度的写入端（`PUT /api/config/yaml`）不再依赖祖先键吞并后代来实现
 * 「该 YAML 是覆盖层的全量视图」，删除一个键必须真的使其从库中消失。它与 `stale` 走同一删除路径，
 * 同一事务、同样记 `config_revisions`：本函数是配置写入的唯一出口，另开一条 `DELETE` 的代价是那批
 * 删除不进变更历史（docs/28 · L-WEB-02）。不在库中的键直接跳过，不产生新旧值均为空的空 revision。
 * 返回值仍只含 `stale`：被整块吞并的更细覆盖需要交回运维逐条核对，而 `prune` 由调用方自行算出，
 * 调用方本就知情。
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
  // 本次要写入的键不参与删除：先删后写只会多出一条 `old→null→new` 的无效历史。
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
  /** 旧值同样需要脱敏：它是从 `config_kv` 读出的真值。 */
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
 * `onRejected` 收到的是被 `assignDotted` 拒绝的路径（如 `__proto__`）。它们不进入返回值，但必须上报：
 * 静默丢弃配置与静默崩溃同样有害，且这类键出现在这里本身说明写入端漏了一道校验。
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
      // 无法解析的 JSON 跳过并上报，而不是让 `JSON.parse` 抛穿整个启动路径：一行损坏的覆盖会使
      // 进程无法启动，同时用于修复配置的 WebUI 也随之不可用（与 docs/19 · R-CFG-01 同形态，
      // 那一轮修的是 schema 校验失败，这一轮是内容根本不是合法 JSON，docs/27 · T-06）。
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
