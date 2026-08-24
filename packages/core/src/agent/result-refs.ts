import { isAbsolute, relative, resolve, sep } from "node:path";
import { readAppKv, writeAppKv, type Sqlite } from "@luoli/db";

/**
 * 一次性修复：把 `agent_runs.result_full_ref` 里的存量**绝对**路径改写成相对当前结果目录的 ref
 * （`docs/reviews/28 · L-OPS-06`）。新写入侧见 `AgentResultStore.put`。
 *
 * **一次性修复而不是迁移**：迁移文件提交之后不可修改，而这件事要逐行判定，判据还依赖运行时
 * 才知道的 `agentResultsDir`（`LUOLI_DATA_DIR` 或启动 cwd）—— SQL 里压根写不出来。
 * 同一套门闸的先例是 `repair:context-tokens:v1` 与 `repair:ledger-cache-cost:v1`。
 *
 * **只动前缀恰好是当前目录的那些。** 指向另一个根的行原样留下：那正是「库与目录来自两套部署」
 * 的证据，`MaintenanceService.gcFiles()` 的错配保护要靠它拒绝清理，让人先看一眼再决定。
 * 悄悄把它们也改成相对路径等于把证据擦掉，然后 gc 会照着删 —— 那就是这一条缺陷本身。
 */
export const AGENT_RESULT_REF_REPAIR_KEY = "repair:agent-result-refs:v1";

export interface AgentResultRefRepair {
  /** 带 ref 的行数。 */
  scanned: number;
  /** 前缀恰好是当前结果目录、因而改写成相对 ref 的行数。 */
  rewritten: number;
  /** 指向**另一个根**、原样留下的行数（gc 会因此拒绝清理，这是有意的）。 */
  foreign: number;
  /** 已经是相对 ref 的行数：重复跑，或本来就是新写法。 */
  relative: number;
  /** `foreign` 里的一个样本 —— 不报出来的话运维不知道该去查哪个根。 */
  sample?: string;
}

export function repairAgentResultRefs(
  db: Sqlite,
  agentResultsDir: string,
): AgentResultRefRepair | null {
  if (readAppKv<boolean>(db, AGENT_RESULT_REF_REPAIR_KEY)) return null;
  const root = resolve(agentResultsDir);
  const prefix = root.endsWith(sep) ? root : root + sep;
  const rows = db
    .prepare(
      "SELECT id,result_full_ref AS ref FROM agent_runs WHERE result_full_ref IS NOT NULL",
    )
    .all() as Array<{ id: string; ref: string }>;
  const result: AgentResultRefRepair = {
    scanned: rows.length,
    rewritten: 0,
    foreign: 0,
    relative: 0,
  };
  const update = db.prepare(
    "UPDATE agent_runs SET result_full_ref=? WHERE id=?",
  );
  db.transaction(() => {
    for (const row of rows) {
      if (!isAbsolute(row.ref)) {
        result.relative += 1;
        continue;
      }
      if (!row.ref.startsWith(prefix)) {
        result.foreign += 1;
        result.sample ??= row.ref;
        continue;
      }
      update.run(relative(root, row.ref), row.id);
      result.rewritten += 1;
    }
    writeAppKv(db, AGENT_RESULT_REF_REPAIR_KEY, true, "startup");
  })();
  return result;
}
