-- web_fetch / MCP 抓回来的图片。不复用 `attachments`：那张表整体是 Telegram 形状的
-- （`message_id NOT NULL REFERENCES messages(id)`、`tg_file_id NOT NULL`、
-- `UNIQUE(chat_id, tg_file_unique_id)`），网页图这三样一个都没有，只能填假值 —— 而
-- 「摘除比伪造安全」是这个仓库已确立的先例（docs/reviews/16 §5）。
--
-- `local_path` 可空：与 `attachments` 同一个理由，落库与落盘不是一步，中途失败时这一行要留着
-- 好让「这里本来有张图」在界面与归档上看得见。
-- **`local_path` 必须进 `MaintenanceService.gcFiles()` 的 referenced 集合**，否则这些文件会被
-- 当成孤儿删掉（docs/25 §10 删过 76 个真实附件、docs/28 · L-OPS-06 删过 74 份全文）。
CREATE TABLE IF NOT EXISTS web_assets (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  media_type TEXT NOT NULL,
  local_path TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);
-- 按会话取（界面、按 key 清理），以及按时间过期（`media.retentionDays`）。
CREATE INDEX IF NOT EXISTS ix_web_assets_key ON web_assets(key);
CREATE INDEX IF NOT EXISTS ix_web_assets_created ON web_assets(created_at);
