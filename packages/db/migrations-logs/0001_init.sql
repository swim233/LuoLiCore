-- logs.db 的迁移序列，与主库那条（packages/db/migrations/）各走各的 __drizzle_migrations。
-- 这个文件里的表由主连接 `ATTACH … AS logs` 挂上来，因此**不要**在这里建任何与主库重名
-- 而语义不同的表：SQLite 按 temp → main → attached 解析表名，重名的那张永远轮不到（docs/10 §3）。

CREATE TABLE IF NOT EXISTS log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  level TEXT NOT NULL, kind TEXT NOT NULL,
  trace_id TEXT, span_id TEXT, parent_span_id TEXT,
  chat_id TEXT, user_id TEXT, key TEXT, agent_run_id TEXT,
  summary TEXT NOT NULL, duration_ms INTEGER,
  -- 载荷（脱敏后）。raw 时是 UTF-8 的 JSON 原文，zstd 时是它的压缩结果。没有大小上限 ——
  -- 原先那条 `bodyMaxBytes` 外溢线存在的唯一理由是「别把主库撑爆」，而这里就是唯一落点。
  data BLOB,
  -- 编码方式逐行记而不是全库一个标志：运维关掉 logs.compress 之后，此前压过的行还得读得出来。
  data_codec TEXT NOT NULL DEFAULT 'raw',
  -- **解压后**的字节数。日志列表要显示「这条载荷多大」，不该为此把每一行都解压一遍。
  data_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_log_ts ON log_events(ts DESC);
CREATE INDEX IF NOT EXISTS ix_log_trace ON log_events(trace_id, ts);
CREATE INDEX IF NOT EXISTS ix_log_kind_ts ON log_events(kind, ts DESC);
CREATE INDEX IF NOT EXISTS ix_log_chat_ts ON log_events(chat_id, ts DESC);
