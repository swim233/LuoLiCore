-- config_kv 是 loadConfig 的输入源：任何混进来的运行时 KV 都会在下次启动时被 configSchema
-- 判为非法覆盖，让进程起不来（docs/19-review-round4.md · R-CFG-01）。运行时 KV 迁到独立的 app_kv。
CREATE TABLE IF NOT EXISTS app_kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

INSERT OR REPLACE INTO app_kv(key, value_json, updated_at, updated_by)
  SELECT 'modelAlias:' || substr(key, 20), value_json, updated_at, updated_by
  FROM config_kv WHERE key LIKE 'perChat.modelAlias.%';

INSERT OR REPLACE INTO app_kv(key, value_json, updated_at, updated_by)
  SELECT 'plugin:' || substr(key, 8), value_json, updated_at, updated_by
  FROM config_kv WHERE key LIKE 'plugin.%';

DELETE FROM config_kv WHERE key LIKE 'perChat.modelAlias.%' OR key LIKE 'plugin.%';
