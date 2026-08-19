-- 会话级持久容器（docs/03 §2.14，语义见 docs/05 §5.5）。
-- 这张表**不是真相的唯一副本**：docker 那边同样有 luoli.managed=1 标签，两边每个
-- sandbox.persistent.reapCron tick 对一次账。行本身不占空间，它只是 docker 状态的索引 +
-- 那些 docker 存不下的东西（滑动到期时刻、钉住、spec 指纹）——label 建完就改不了了。
CREATE TABLE IF NOT EXISTS sandbox_containers (
  chat_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  container_id    TEXT,
  image           TEXT NOT NULL,
  spec_hash       TEXT NOT NULL,
  has_setsid      INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  hard_expires_at INTEGER,
  pinned          INTEGER NOT NULL DEFAULT 0,
  exec_count      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS ix_sandbox_containers_expires ON sandbox_containers(expires_at);
