import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Sqlite } from "@luoli/db";

/**
 * 记忆磁盘布局从「全局单份」搬到「按来源分区」（`docs/12-sdk.md` T2.2，A4）。与
 * `0019_sources_and_memory_scope.sql` 配套：那份迁移只改库（`memory_docs.id`/`subject`），
 * 不知道 `memory.dir` 的实际值；磁盘搬迁与 `memory_docs.path` 的改写留在这里，启动期执行。
 *
 * 幂等判据是文件系统而非 `app_kv` 门闸：一项「旧路径存在且新路径不存在」才搬。天然幂等，
 * 也天然能在一次中断后的下次启动里把剩下的部分补完——不需要额外记录「搬到哪了」。
 *
 * `move` 与 `copy` 两类文件的「已完成」判据不同：
 * - `move`（PUBMEMORY.md、每份 PRIMEMORY.md）完成后旧路径应当消失。若旧路径与新路径同时
 *   存在即为异常状态（例如上一次搬迁中途中断、又被人手动放回了旧文件），记一条 warn 且
 *   不覆盖新文件。
 * - `copy`（CHARACTER.md、ASSIST.md）旧路径按设计永远保留作模板（A4）。搬完之后旧路径与
 *   新路径同时存在正是稳态，不算冲突，不产生 warn，否则每次启动都会重复报警。
 *
 * move 类文件额外有第三种状态：**旧路径已不在、新路径已存在，但 `memory_docs.path` 仍指旧
 * 路径**（自愈，健康检查的对象只限 move 类）。这不是 plan 字面判据（「旧存在且新不存在则搬，
 * 否则跳过」）能覆盖的状态，之所以仍要处理：`renameSync` 与 `UPDATE memory_docs SET path=…`
 * 不在同一个原子操作里，进程在两者之间被杀掉就会落在这个状态；而这一类文件（尤其
 * primemory，每用户一行）此后没有任何别的代码路径会去刷新它的 `path` 列——T2.5 的
 * `ensure()` 只刷新三个来源级行（CHARACTER/ASSIST/PUBMEMORY 对应的 copy/pending 逻辑不在这里
 * 处理），primemory 是纯粹的按用户行，永远不在 `ensure()` 的遍历范围里。不修的话这一行的
 * `path` 会永久指向一个已经不存在的文件，`GET /api/prompts/:id` 与 `PromptDocuments.rollback`
 * 从此读不到这个用户的内容，且没有任何后续任务会把它修好。自愈只改库，不碰磁盘——文件已经
 * 在正确的位置，再次搬只会是误覆盖。
 */
export interface MemoryLayoutMigration {
  /** 本次实际搬迁（含移动与复制）的项数。 */
  migrated: number;
  /** 无需处理的项数：旧路径不存在（已搬完，或从未存在过）、copy 类文件已复制过、
   *  或自愈项的 `path` 本就正确。 */
  skipped: number;
  /** move 类文件旧路径与新路径同时存在的项数：未覆盖新文件，需要一条 warn。 */
  conflicts: number;
  /** `conflicts` 中的一个样本 key；不上报的话运维无法定位是哪一份文件。 */
  conflictSample?: string;
  /** move 类文件旧路径已不在、新路径已存在，但 `memory_docs.path` 指错的项数：
   *  只改库不动盘。 */
  healed: number;
}

interface LayoutItem {
  /** `data/memory-premigration.json` 的键，以及日志/警告里报的相对路径。 */
  key: string;
  oldPath: string;
  newPath: string;
  mode: "move" | "copy";
  /** 搬迁后写回 `memory_docs.path` 所用的 id；该 id 由 0019 迁移改好，这里只按约定拼接。 */
  docId: string;
}

function primemoryItems(memoryDir: string, sourceId: string): LayoutItem[] {
  const oldRoot = join(memoryDir, "private");
  const newRoot = join(memoryDir, "sources", sourceId, "private");
  // 用户名单从新旧两棵目录树的并集里找：只扫旧目录会漏掉「旧目录已经空了、新目录已经有
  // 文件、但库里 path 还没跟上」这一自愈场景——那个状态下旧目录树里已经没有这个用户了。
  const userIds = new Set<string>();
  for (const root of [oldRoot, newRoot]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }))
      if (entry.isDirectory()) userIds.add(entry.name);
  }
  const items: LayoutItem[] = [];
  for (const userId of userIds) {
    const oldPath = join(oldRoot, userId, "PRIMEMORY.md");
    const newPath = join(newRoot, userId, "PRIMEMORY.md");
    if (!existsSync(oldPath) && !existsSync(newPath)) continue; // 目录存在但两侧都没有 PRIMEMORY.md
    items.push({
      key: `private/${userId}/PRIMEMORY.md`,
      oldPath,
      newPath,
      mode: "move",
      docId: `primemory:${sourceId}:${userId}`,
    });
  }
  return items;
}

function layoutItems(memoryDir: string, sourceId: string): LayoutItem[] {
  return [
    {
      key: "PUBMEMORY.md",
      oldPath: join(memoryDir, "PUBMEMORY.md"),
      newPath: join(memoryDir, "sources", sourceId, "PUBMEMORY.md"),
      mode: "move",
      docId: `pubmemory:${sourceId}`,
    },
    {
      key: "CHARACTER.md",
      oldPath: join(memoryDir, "CHARACTER.md"),
      newPath: join(memoryDir, "sources", sourceId, "CHARACTER.md"),
      mode: "copy",
      docId: `character:${sourceId}`,
    },
    {
      key: "ASSIST.md",
      oldPath: join(memoryDir, "ASSIST.md"),
      newPath: join(memoryDir, "sources", sourceId, "ASSIST.md"),
      mode: "copy",
      docId: `assist:${sourceId}`,
    },
    ...primemoryItems(memoryDir, sourceId),
  ];
}

export function migrateMemoryLayout(
  db: Sqlite,
  memoryDir: string,
  dataDir: string,
  sourceId = "telegram",
): MemoryLayoutMigration {
  const items = layoutItems(memoryDir, sourceId);

  const pending: LayoutItem[] = [];
  const conflicts: LayoutItem[] = [];
  const healable: LayoutItem[] = [];
  let skipped = 0;
  for (const item of items) {
    const oldExists = existsSync(item.oldPath);
    const newExists = existsSync(item.newPath);
    if (oldExists && !newExists) pending.push(item);
    else if (oldExists && newExists && item.mode === "move")
      conflicts.push(item);
    else if (!oldExists && newExists && item.mode === "move")
      healable.push(item);
    // 其余落在这个分支：copy 类旧新共存的稳态、旧新皆不存在（含从未存在过）——两种都是
    // 「无需处理」，没有理由区分对待。
    else skipped += 1;
  }

  // 前置镜像只记「本次即将搬迁」的旧内容，且只在它还不存在时写一次：写在任何移动/复制之前，
  // 之后无论搬迁是否顺利，这份哈希都能验出旧内容有没有变过——这是「Telegram 回归」最终验收的
  // 判据来源：私聊一轮的 PRIMEMORY/PUBMEMORY 内容须与迁移前逐字节一致（`docs/12 §14.4` T1.1–T1.3
  // 一带记录了这批批一/批二前置任务的落点，本条属批二记忆迁移，不是 SDK 本体的验收项）。
  // 自愈项不产生新内容（文件已经在原地），不计入镜像。
  if (pending.length) {
    const premigrationPath = join(dataDir, "memory-premigration.json");
    if (!existsSync(premigrationPath)) {
      const snapshot: Record<string, string> = {};
      for (const item of pending)
        snapshot[item.key] = createHash("sha256")
          .update(readFileSync(item.oldPath))
          .digest("hex");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        premigrationPath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  }

  // `path<>?` 的守卫让「已经正确」与「本来就没有这一行」都落在 changes===0：前者是自愈循环
  // 用它判断是否真的改了东西（G3：不产生多余写入，`updated_at` 也在 SET 之外，不会被带动）；
  // 后者理论上不该发生（搬迁类文件的 memory_docs 行应当先于磁盘搬迁存在），出现了也只是
  // 静默不计数，不是本函数的职责去补一行。
  const updatePath = db.prepare(
    "UPDATE memory_docs SET path=? WHERE id=? AND path<>?",
  );
  for (const item of pending) {
    mkdirSync(dirname(item.newPath), { recursive: true, mode: 0o700 });
    if (item.mode === "move") renameSync(item.oldPath, item.newPath);
    else copyFileSync(item.oldPath, item.newPath);
    chmodSync(item.newPath, 0o600);
    updatePath.run(item.newPath, item.docId, item.newPath);
  }

  let healed = 0;
  for (const item of healable) {
    const { changes } = updatePath.run(item.newPath, item.docId, item.newPath);
    if (changes > 0) healed += 1;
    else skipped += 1; // path 已经正确：没有任何要做的事
  }

  return {
    migrated: pending.length,
    skipped,
    conflicts: conflicts.length,
    ...(conflicts[0] ? { conflictSample: conflicts[0].key } : {}),
    healed,
  };
}
