-- SDK 本体的存储层（docs/12-sdk.md，批三 T3.1）。`sources` 表与 `telegram` 种子行已在 0019
-- 建好；这里补齐密钥、会话按来源的两列、SDK 专有会话属性表、记账按来源四件事。
--
-- api_keys：sk- 前缀密钥的存储行。secret_enc 是 Secrets.encrypt() 之后的密文，owner 回显走
-- 单独的解密路径（记 warn），不落这张表。source_id 外键约束在建表时就能挂——这张表现在是空的，
-- 没有存量行需要满足约束。
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  secret_enc TEXT NOT NULL,                  -- Secrets.encrypt(secret 段)
  label TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER, disabled_at INTEGER, last_used_at INTEGER
);
CREATE INDEX ix_api_keys_source ON api_keys(source_id);

-- contexts.source_id：会话所属来源，默认 'telegram' 回填存量行。补一列而非关联表：上下文
-- 引擎按 key 读写，加一张表意味着每处读取都多一次 JOIN。**ADD COLUMN 不能带 REFERENCES**：
-- SQLite 要求待加列若含外键约束，默认值必须是 NULL，这里需要非空默认值 'telegram' 回填存量行，
-- 外键约束只能放弃，合法取值由 SourceRepository（T3.2）经代码路径维护，不由 DB 层拦。
ALTER TABLE contexts ADD COLUMN source_id TEXT NOT NULL DEFAULT 'telegram';
-- contexts.deleted_at：SDK 会话动词 `delete` 的软停用标记（plan 已定结论 17），与 Telegram
-- 侧「彻底删除会话」的硬删（整行清除）是两个动词、两条路径——这一列只服务前者。
ALTER TABLE contexts ADD COLUMN deleted_at INTEGER;
CREATE INDEX ix_contexts_source ON contexts(source_id);

-- sdk_sessions：SDK 专有的会话属性，单列一表而不并进 contexts——`contexts` 是上下文引擎的表，
-- SDK 专有列混进去之后上下文引擎每一处读取都要带着它。`end_user_id` 不落这张表：它是
-- 每请求必填的字段，落点是 messages.from_user_id（服务端加 `<sourceId>:` 前缀），不是会话级属性。
CREATE TABLE sdk_sessions (
  key TEXT PRIMARY KEY REFERENCES contexts(key),
  output_format TEXT NOT NULL DEFAULT 'markdown' CHECK (output_format IN ('plain','markdown')),
  label TEXT, created_at INTEGER NOT NULL
);

-- usage_ledger.source_id：按 chat_id 关联 contexts.source_id 在会话 purge（硬删整行）之后就
-- 断链了，而 plan 已定结论 17 又要求 usage_ledger 的行两种删除动词都不删——按来源聚合记账
-- 若靠 JOIN contexts 算，purge 过的会话产生的历史用量会从统计里消失。加列直接回填来源 id，
-- 记账那一刻就把归属焊死，往后这张表不再依赖 contexts 是否还在。
ALTER TABLE usage_ledger ADD COLUMN source_id TEXT;
-- 存量行迁移前全部来自 Telegram（SDK 尚未上线），统一回填，不留 NULL 需要调用方逐处判断。
UPDATE usage_ledger SET source_id = 'telegram';
CREATE INDEX ix_usage_source_ts ON usage_ledger(source_id, ts DESC);
