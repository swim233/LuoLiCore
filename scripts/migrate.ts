import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase, migrateDatabase, closeDatabase } from "@luoli/db";
import { loadConfig } from "@luoli/core";

const config = await loadConfig({ requireOwner: false });
await mkdir("data", { recursive: true, mode: 0o700 });
const db = openDatabase(config.db.path);
// 第三个参数不能省。省掉拿到的默认值是从主库路径派生的 `<db.path>-logs`，而进程读的是
// `logs.dbPath`（默认 `./data/logs.db`）—— 这条路上会把主库里的存量 `log_events` 搬进日志库
// 再删掉源表，落错文件就是把历史日志搬进一个没人读的 `luoli.db-logs`，且不可逆。
// 这三项与 `apps/bot/src/main.ts` 里那份必须一致，否则「先 db:migrate 再启动」与「直接启动」
// 会得到两个不同的日志库。
migrateDatabase(db, undefined, {
  path: config.logs.dbPath,
  legacyDir: resolve("logs"),
  compress: config.logs.compress,
});
closeDatabase(db);
process.stdout.write(`Migrated ${config.db.path}\n`);
