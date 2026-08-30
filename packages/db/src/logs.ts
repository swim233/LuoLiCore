import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Sqlite } from "./database.js";

/** 附加库的 schema 名。仓库里所有查询都写不带前缀的 `log_events`，靠的就是主库那张同名表
 *  已被 `0017` 删掉之后，SQLite 的 temp → main → attached 解析顺序会落到这里（docs/10 §3）。 */
export const LOG_SCHEMA = "logs";

/**
 * 低于这个大小一律不压。几百字节的 JSON 压完通常更大，而 66 个 kind 里有 64 个平均只有
 * 30–140 字节 —— 真正需要压的只有 `model.call`（均 29 KB）与 `tool.call`（均 7 KB）。
 * 照 `COALESCE_MS` / `PROVIDER_FAILURES_TO_DOWN` 的先例做成代码常量：调它没有运维意义。
 */
const COMPRESS_MIN_BYTES = 1024;

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations-logs", import.meta.url),
);

export interface EncodedLogPayload {
  data: Buffer | null;
  codec: string;
  /** **解压后**的字节数。列表页要显示它，不该为此逐行解压。 */
  bytes: number;
}

/** `data` / `data_codec` / `data_bytes` 三列的唯一写入口径。 */
export function encodeLogPayload(
  value: unknown,
  compress: boolean,
): EncodedLogPayload {
  if (value === undefined) return { data: null, codec: "raw", bytes: 0 };
  const raw = Buffer.from(JSON.stringify(value) ?? "null", "utf8");
  return compress && raw.byteLength >= COMPRESS_MIN_BYTES
    ? { data: zstdCompressSync(raw), codec: "zstd", bytes: raw.byteLength }
    : { data: raw, codec: "raw", bytes: raw.byteLength };
}

/**
 * 读出侧的唯一入口，返回载荷的 JSON 文本。
 *
 * 解不开时**不返回 null**：null 的意思是「这条事件本来就没有载荷」，拿它冒充「有载荷但读不出来」
 * 会让界面说出一句假话。所以回一份自述的 JSON —— 照「摘除比伪造安全」那条先例
 * （`docs/reviews/16 §5`）。同理认不出的 codec 按 UTF-8 原样解，而不是抛：换压缩算法之后旧行
 * 还得读得出来，而在这里抛出会把「有一行坏了」升级成「日志页整页 500」。
 */
export function decodeLogPayload(
  data: Buffer | Uint8Array | string | null | undefined,
  codec?: string | null,
): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data === "string") return data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (codec !== "zstd") return buffer.toString("utf8");
  try {
    return zstdDecompressSync(buffer).toString("utf8");
  } catch (error) {
    return JSON.stringify({
      error: "payload_undecodable",
      codec,
      storedBytes: buffer.byteLength,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 自带迁移循环，不复用 `migrateDatabase`：那个函数在有待执行迁移时会先 `VACUUM INTO` 一份
 * 整库备份，而日志库正是那个「不想每次迁移都复制一遍」的东西 —— 它是可弃数据，备份策略与
 * 主库不同，这也正是它单独成文件的理由（docs/10 §3）。顺带避开了与 `database.ts` 的运行时环。
 */
function applyLogMigrations(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const seen = new Set(
    db.prepare("SELECT name FROM __drizzle_migrations").pluck().all() as string[],
  );
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => /^\d{4}_.+\.sql$/.test(entry))
    .sort()) {
    if (seen.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO __drizzle_migrations(name, applied_at) VALUES (?, ?)",
      ).run(name, Date.now());
    })();
  }
}

/**
 * 建好日志库、迁移它、再挂到主连接上。
 *
 * 迁移走的是**独立句柄**而不是主连接：`__drizzle_migrations` 会写进执行方的 `main`，
 * 从主连接上跑等于把日志库的迁移记录记进主库，两条序列从此互相看不见对方。
 *
 * `auto_vacuum` 必须排在 `journal_mode` **之前** —— 它只在数据库首页尚未落盘时改得动，
 * 而 `journal_mode = WAL` 那一句自己就会落盘。顺序反了的表现是它静静地留在 `NONE`
 * （实测 `pragma('auto_vacuum')` 回 0），保留期删完的空间从此再也还不回去。
 */
export function attachLogDatabase(db: Sqlite, path: string): string {
  const absolute = resolve(path);
  const attached = (db.pragma("database_list") as Array<{ name: string }>).some(
    (row) => row.name === LOG_SCHEMA,
  );
  if (attached) return absolute;
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const seed = new Database(absolute);
  try {
    seed.pragma("auto_vacuum = INCREMENTAL");
    seed.pragma("journal_mode = WAL");
    applyLogMigrations(seed);
    seed.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    seed.close();
  }
  db.prepare(`ATTACH DATABASE ? AS ${LOG_SCHEMA}`).run(absolute);
  // `synchronous` 是**按库**的（`PRAGMA schema.synchronous`），`openDatabase` 里那句只作用于 main。
  db.pragma(`${LOG_SCHEMA}.synchronous = NORMAL`);
  return absolute;
}

export interface LegacyLogImport {
  rows: number;
  blobs: number;
  missingBlobs: number;
}

interface LegacyRow {
  id: number;
  ts: number;
  level: string;
  kind: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  chat_id: string | null;
  user_id: string | null;
  key: string | null;
  agent_run_id: string | null;
  summary: string;
  duration_ms: number | null;
  data_json: string | null;
  file_ref: string | null;
}

/**
 * 把主库里那张旧 `log_events` 搬进附加上来的日志库，顺带把 `logs/<day>/blobs/*.json` 里的载荷
 * 收回行上，然后删掉旧表。**必须跑在 ATTACH 之后、主库迁移之前**：`0017` 会把旧表删掉，
 * 顺序反了就是把存量日志直接删了。
 *
 * 保留原 `id` 并用 `INSERT OR IGNORE`，因此整个过程是幂等的 —— 中途崩了下次接着搬，
 * 已经搬过的行原样跳过。分批提交而不是一整个事务：实测 59799 行里带 blob 的有 780 个、
 * 共 775 MB，一次性攒进 WAL 只会让首次启动多一个说不清的长停顿。
 *
 * 载荷文件读不到时**保留那份 `{fileRef,bytes}` 占位对象**，不假装载荷还在：文件确实已经被
 * 上一版的保留期清掉了，而占位对象自己说得清这件事。
 */
export function importLegacyLogEvents(
  db: Sqlite,
  legacyDir: string,
  compress: boolean,
): LegacyLogImport | null {
  const legacy = db
    .prepare(
      "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='log_events'",
    )
    .get();
  if (!legacy) return null;
  const total = db
    .prepare("SELECT COUNT(*) FROM main.log_events")
    .pluck()
    .get() as number;
  const result: LegacyLogImport = { rows: 0, blobs: 0, missingBlobs: 0 };
  if (total > 0) {
    const read = db.prepare(
      `SELECT id,ts,level,kind,trace_id,span_id,parent_span_id,chat_id,user_id,key,agent_run_id,
       summary,duration_ms,data_json,file_ref FROM main.log_events WHERE id>? ORDER BY id LIMIT 500`,
    );
    const write = db.prepare(
      `INSERT OR IGNORE INTO ${LOG_SCHEMA}.log_events
       (id,ts,level,kind,trace_id,span_id,parent_span_id,chat_id,user_id,key,agent_run_id,summary,duration_ms,data,data_codec,data_bytes)
       VALUES (@id,@ts,@level,@kind,@trace_id,@span_id,@parent_span_id,@chat_id,@user_id,@key,@agent_run_id,@summary,@duration_ms,@data,@codec,@bytes)`,
    );
    let cursor = 0;
    for (;;) {
      const batch = read.all(cursor) as LegacyRow[];
      if (!batch.length) break;
      const encoded = batch.map((row) => {
        const payload = legacyPayload(row, legacyDir, result);
        const { data, codec, bytes } = encodeLogPayload(payload, compress);
        return { ...row, data, codec, bytes };
      });
      db.transaction(() => {
        for (const row of encoded) write.run(row);
      })();
      result.rows += batch.length;
      cursor = batch[batch.length - 1]!.id;
    }
  }
  // 与搬迁分开提交是有意的：这一句失败（或进程死在这里）只会让下次启动重跑一遍幂等的搬迁，
  // 而把 775 MB 的写入和它塞进同一个事务，换来的是一个更长的、同样不原子的窗口 ——
  // WAL 下跨附加库的事务本来就不保证原子提交。
  db.exec("DROP TABLE IF EXISTS main.log_events");
  return result;
}

/** 旧行的载荷：行内那份，或者它指向的 `logs/<day>/blobs/*.json`。 */
function legacyPayload(
  row: LegacyRow,
  legacyDir: string,
  result: LegacyLogImport,
): unknown {
  if (row.data_json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return row.data_json;
  }
  const reference =
    row.file_ref ??
    (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ((parsed as { fileRef?: unknown }).fileRef as string | undefined)
      : undefined);
  if (typeof reference !== "string") return parsed;
  const path = resolve(legacyDir, reference);
  if (!existsSync(path)) {
    result.missingBlobs += 1;
    return parsed;
  }
  try {
    const text = readFileSync(path, "utf8");
    result.blobs += 1;
    return JSON.parse(text) as unknown;
  } catch {
    result.missingBlobs += 1;
    return parsed;
  }
}

/** 保留期删除之后把空页还给文件系统。`auto_vacuum=INCREMENTAL` 下这是一次短操作，
 *  不需要 `VACUUM` 那把整库锁 —— 实测 9814 页删空后收到 3 页。 */
export function reclaimLogDatabase(db: Sqlite): void {
  db.pragma(`${LOG_SCHEMA}.incremental_vacuum`);
}
