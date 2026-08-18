# 03 · 数据模型

技术选型：**单 SQLite 库 + `chat_id`/`key` 分区 + FTS5(trigram)**（D7）。**不用 ORM**：仓储层是 better-sqlite3 的手写 SQL（D20 记了为什么改），迁移是手写的顺序编号 SQL 文件。

## 1. 通用约定

- 主键：业务对象用 `TEXT`（ULID，字典序≈时间序）；高频追加表（`messages`、`log_events`、`usage_ledger`）用 `INTEGER PRIMARY KEY AUTOINCREMENT` 以获得紧凑 rowid 和 FTS 关联。
- 时间：统一 `INTEGER` 毫秒 Unix 时间戳（UTC）。展示层按 `general.timezone` 转换。
- JSON：`TEXT` 存储，列名后缀 `_json`。读写必须过 zod 校验。
- 布尔：`INTEGER` 0/1。
- 金额：`REAL`，单位 USD（`cost_usd`）。定价单位统一为「USD / 1M tokens」。
- **禁止外键级联删除**。所有删除走软删除或显式清理任务，避免误删审计数据。

### 1.1 SQLite 运行参数（连接建立后立即执行）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store   = MEMORY;
PRAGMA mmap_size    = 268435456;   -- 256MB
PRAGMA cache_size   = -32000;      -- 32MB
```

### 1.2 隔离强制机制（D7 的关键落地）

单库方案的风险是「忘了加 `WHERE chat_id`」。用三重防护：

1. **Repository 层类型强制**：所有按会话隔离的表只暴露 `ScopedRepo`，构造时必须传 `chatId`/`key`：
   ```ts
   const repo = archive.scope(chatId);      // 唯一入口
   repo.recent(50);                        // 内部自动拼 where
   // archive.recent(...) 不存在 —— 编译期就无法绕过
   ```
2. **跨会话查询白名单**：仅 4 个方法允许跨 chat（`adminSearchAll`、`usageReport`、`listChats`、`logQuery`），命名统一以 `admin`/`report` 前缀，且必须显式传入 `{ actor: Role.owner }`。
3. **测试守卫**：`packages/db` 有一个单测遍历所有导出方法，断言非白名单方法的 SQL 文本包含 `chat_id = ?` 或 `key = ?`（AC-DB-003）。

---

## 2. DDL

### 2.1 主体与权限

```sql
CREATE TABLE principals (
  id           TEXT PRIMARY KEY,          -- 'user:8899001' | 'chat:-1001234567'
  kind         TEXT NOT NULL CHECK (kind IN ('user','chat')),
  tg_id        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','trusted','limited','blocked')),
  display_name TEXT,
  username     TEXT,
  chat_type    TEXT,                      -- private|group|supergroup|channel（kind='chat' 时）
  note         TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT                       -- 'webui'|'command:<userId>'|'bootstrap'
);
CREATE UNIQUE INDEX ux_principals_kind_tg ON principals(kind, tg_id);
CREATE INDEX ix_principals_role ON principals(role);
```

未登记主体的默认角色来自配置 `access.defaultUserRole` / `access.defaultChatRole`（默认均为 `blocked`）。首次见到的主体会以默认角色**自动插入一行**（`updated_by='bootstrap'`），方便在 WebUI 里直接改。

### 2.2 原始消息归档

```sql
CREATE TABLE messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id            TEXT    NOT NULL,
  message_thread_id  INTEGER,                       -- 论坛 topic；始终记录（D8）
  tg_message_id      INTEGER NOT NULL,
  tg_update_id       INTEGER,
  direction          TEXT    NOT NULL CHECK (direction IN ('in','out')),
  from_kind          TEXT    NOT NULL CHECK (from_kind IN ('user','bot','system')),
  from_user_id       TEXT,
  from_name          TEXT,
  from_username      TEXT,
  reply_to_tg_message_id INTEGER,                   -- 触发消息与被回复消息两条路径都写（[08 §7.4](./08-telegram-adapter.md)）
  forward_origin_json TEXT,
  media_group_id     TEXT,
  kind               TEXT    NOT NULL,              -- text|photo|document|voice|video|video_note|
                                                    -- sticker|animation|audio|location|poll|other
  text               TEXT,                           -- 正文或 caption（FTS 索引此列）
  entities_json      TEXT,
  raw_json           TEXT    NOT NULL,              -- 完整 Telegram Update.message
  tg_date            INTEGER NOT NULL,              -- Telegram 声称的时间（秒→毫秒）
  received_at        INTEGER NOT NULL,
  triggered          INTEGER NOT NULL DEFAULT 0,
  trigger_reason     TEXT,                           -- mention|reply|command|wakeword|private
  turn_id            TEXT,                           -- 触发消息 / bot 出站消息所属 turn
  media_parts_json   TEXT,                           -- 多模态 part（图片/文件），随消息一起回填 · 迁移 0002
  claimed_at         INTEGER,                        -- 已折入上下文的时间（背景消息认领）
  claimed_by_turn    TEXT,                           -- 当前持有认领的 turn；提交/中止/崩溃恢复时清空 · 迁移 0004
  edited_at          INTEGER,
  revision           INTEGER NOT NULL DEFAULT 0,
  deleted_at         INTEGER
);
CREATE UNIQUE INDEX ux_messages_tg ON messages(chat_id, tg_message_id, revision);
CREATE INDEX ix_messages_chat_date  ON messages(chat_id, tg_date DESC);
CREATE INDEX ix_messages_chat_id_id ON messages(chat_id, id);         -- 认领区间扫描
CREATE INDEX ix_messages_thread     ON messages(chat_id, message_thread_id, id);
CREATE INDEX ix_messages_unclaimed  ON messages(chat_id, message_thread_id, id) WHERE claimed_at IS NULL;
CREATE INDEX ix_messages_claim_owner ON messages(claimed_by_turn) WHERE claimed_by_turn IS NOT NULL;
CREATE INDEX ix_messages_user       ON messages(from_user_id, tg_date DESC);
CREATE INDEX ix_messages_turn       ON messages(turn_id);
CREATE INDEX ix_messages_mediagroup ON messages(media_group_id) WHERE media_group_id IS NOT NULL;
```

**编辑消息**：Telegram 的 `edited_message` 不覆盖原行；写入 `revision = revision+1` 的新行，旧行保留（`edited_at` 打在旧行上）。`UNIQUE(chat_id, tg_message_id, revision)` 保证可共存。上下文只引用最初被认领的那个 revision（`source_message_id` 指向具体行），**已提交的上下文不会因编辑而变化**。

**删除消息**：Bot API 不推送删除事件 ⇒ 无法感知。`deleted_at` 仅用于 owner 在 WebUI 手动标记/清理。写入文档以免误解。

**引用注入写入的行**：被回复的消息若不在库里，会由适配层用 update 自带的副本补写一行
（`triggered=0`、`claimed_at` 非空而 `claimed_by_turn` 为空 = 已消费但不属于任何在途轮次）。
它的 `id` 大于触发消息的 `id`，`claimed_at` 是它不被下一轮重复认领的唯一屏障（[08 §7.4](./08-telegram-adapter.md)）。

### 2.3 全文检索（中文）

```sql
-- trigram tokenizer：SQLite >= 3.34，对 CJK 子串匹配有效（unicode61 对中文近乎不可用）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = 'messages',
  content_rowid = 'id',
  tokenize = "trigram",
  detail = 'full'
);

CREATE TRIGGER tg_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER tg_messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER tg_messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
```

检索查询（**必须**带 chat 过滤）：
```sql
SELECT m.* FROM messages_fts f
  JOIN messages m ON m.id = f.rowid
 WHERE messages_fts MATCH :q
   AND m.chat_id = :chatId
   AND (:threadId IS NULL OR m.message_thread_id = :threadId)
   AND m.deleted_at IS NULL
 ORDER BY bm25(messages_fts) ASC, m.tg_date DESC
 LIMIT :limit OFFSET :offset;
```

- trigram 对 <3 字符的查询无效 ⇒ 查询串长度 <3 时回退 `LIKE '%q%'`（带 chat 过滤，limit 严格）。
- `search_messages` 工具还支持 `from_user`、`after`/`before`、`kind` 过滤（走 `messages` 索引而非 FTS）。
- 备选：jieba 预分词写入影子列。**第一版不做**，写入 [14](./14-open-questions.md)。

### 2.4 附件

```sql
CREATE TABLE attachments (
  id             TEXT PRIMARY KEY,
  message_id     INTEGER NOT NULL REFERENCES messages(id),
  chat_id        TEXT    NOT NULL,
  kind           TEXT    NOT NULL,        -- photo|document|voice|video|audio|sticker|animation
  tg_file_id     TEXT    NOT NULL,
  tg_file_unique_id TEXT NOT NULL,
  file_name      TEXT,
  mime           TEXT,
  size_bytes     INTEGER,
  width INTEGER, height INTEGER, duration_sec INTEGER,
  local_path     TEXT,                    -- data/files/<chatId>/<unique>.<ext>；null=未下载
  download_state TEXT NOT NULL DEFAULT 'pending', -- pending|ok|skipped|failed|expired（expired = 文件按 media.retentionDays 清掉了，行还在）
  download_error TEXT,
  extracted_text TEXT,                    -- pdf/txt/code 抽取结果（截断至 extract.maxChars）
  extract_state  TEXT,                    -- ok|too_large|unsupported|failed
  created_at     INTEGER NOT NULL
);
CREATE INDEX ix_attachments_msg ON attachments(message_id);
CREATE UNIQUE INDEX ux_attachments_unique ON attachments(chat_id, tg_file_unique_id);
```

### 2.5 上下文层（核心）

```sql
CREATE TABLE contexts (
  key              TEXT PRIMARY KEY,      -- 'chat:-1001234' | 'chat:-1001234:88'
  chat_id          TEXT NOT NULL,
  thread_id        INTEGER,
  scope            TEXT NOT NULL CHECK (scope IN ('chat','thread')),
  next_ordinal     INTEGER NOT NULL DEFAULT 1,   -- 下一个待分配 ordinal（仅 commit 时递增）
  claim_watermark  INTEGER NOT NULL DEFAULT 0,   -- 已折入上下文的最大 messages.id
  token_ratio      REAL    NOT NULL DEFAULT 1.0, -- 估算校准系数（EMA）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_contexts_chat ON contexts(chat_id);

CREATE TABLE context_messages (
  key                 TEXT    NOT NULL,
  ordinal             INTEGER NOT NULL,
  id                  TEXT    NOT NULL,
  turn_id             TEXT    NOT NULL,
  agent_run_id        TEXT,
  role                TEXT    NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  -- ⚠️ CHECK 里的 'system' 只是历史列定义（迁移一旦提交不可修改）。**写入端与读出端都不允许它**：
  -- AI SDK v7 的 standardizePrompt 直接拒收 messages 里的 system 消息，而 parts 是持久化的
  -- ——写坏一条，该会话在 /new 之前每轮都失败（[02 §9 红线 16]；docs/20 · W-CTX-01）。
  -- 系统旁白一律 role='user' + origin='note'；迁移 0006 已把库里的存量改回 'user'。
  origin              TEXT    NOT NULL CHECK (origin IN
                        ('background','trigger','assistant','tool_call','tool_result','note')),
  prune_level         INTEGER NOT NULL DEFAULT 0,   -- 0 永不省略 / 1 tool_result / 2 reasoning·tool_call
  prune_applied       INTEGER NOT NULL DEFAULT 0,   -- 已就地降级（materialize 时替换内容）
  parts_json          TEXT    NOT NULL,             -- AI SDK ModelMessage.content（parts 数组）
  text_preview        TEXT,                          -- 供 WebUI 列表与调试
  speaker             TEXT,                          -- 渲染前缀用的显示名
  speaker_user_id     TEXT,
  source_message_id   INTEGER,                       -- → messages.id
  source_ts           INTEGER,                       -- 原始消息时间（用于渲染时间前缀）
  tokens              INTEGER NOT NULL DEFAULT 0,
  meta_json           TEXT,                          -- { rebased, unseenOrdinals, truncated, ... }
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (key, ordinal)
);
CREATE INDEX ix_ctxmsg_turn ON context_messages(key, turn_id, ordinal);
CREATE INDEX ix_ctxmsg_src  ON context_messages(source_message_id);

CREATE TABLE context_commits (
  id               TEXT PRIMARY KEY,
  key              TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  parent_id        TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('turn','prune','reset','manual','revert')),
  turn_id          TEXT,
  base_commit_id   TEXT,                  -- 该 turn 快照来源（≠parent_id 即发生 rebase）
  rebased          INTEGER NOT NULL DEFAULT 0,
  rebase_over_json TEXT,                  -- 被插队的 commit id 数组
  window_start     INTEGER NOT NULL,
  head_ordinal     INTEGER NOT NULL,
  tokens_total     INTEGER NOT NULL DEFAULT 0,
  msg_count        INTEGER NOT NULL DEFAULT 0,
  meta_json        TEXT,
  created_at       INTEGER NOT NULL,
  created_by       TEXT                   -- 'system'|'webui'|'command:<userId>'
);
CREATE UNIQUE INDEX ux_commits_key_seq ON context_commits(key, seq);
CREATE INDEX ix_commits_key_created ON context_commits(key, created_at DESC);
CREATE INDEX ix_commits_turn ON context_commits(turn_id);

CREATE TABLE refs (
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,               -- 'done'（未来可扩展 'staging' 等）
  commit_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, name)
);
```

### 2.6 轮次与任务

```sql
CREATE TABLE turns (
  id                 TEXT PRIMARY KEY,
  key                TEXT NOT NULL,
  chat_id            TEXT NOT NULL,
  thread_id          INTEGER,
  initiator_user_id  TEXT NOT NULL,
  effective_role     TEXT NOT NULL,
  trigger_message_id INTEGER,
  trigger_reason     TEXT,
  base_commit_id     TEXT,
  commit_id          TEXT,
  state              TEXT NOT NULL CHECK (state IN
                       ('queued','running','committed','failed','cancelled')),
  rebased            INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER, started_at INTEGER, finished_at INTEGER,
  steps              INTEGER NOT NULL DEFAULT 0,
  model_calls        INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  subagents          INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  error              TEXT,
  cancel_reason      TEXT
);
CREATE INDEX ix_turns_key_started ON turns(key, started_at DESC);
CREATE INDEX ix_turns_state ON turns(state) WHERE state IN ('queued','running');

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT NOT NULL,
  agent_run_id  TEXT,
  chat_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('running','done','failed','cancelled')),
  progress_json TEXT,                     -- { phase, done, total, note, updatedAt }
  placeholder_tg_message_id INTEGER,      -- 用于 editMessageText 进度更新
  result_summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX ix_tasks_chat_state ON tasks(chat_id, state, created_at DESC);
```

### 2.7 Agent 运行与通信

```sql
CREATE TABLE agent_runs (
  id               TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL,
  parent_run_id    TEXT,
  depth            INTEGER NOT NULL DEFAULT 0,
  kind             TEXT NOT NULL CHECK (kind IN ('main','sub')),
  agent_name       TEXT NOT NULL,          -- 'main' | 'researcher' | ...
  model_alias      TEXT NOT NULL,
  provider_id      TEXT, model_id TEXT,
  effective_role   TEXT NOT NULL,          -- 继承自派发者，永不提权
  task_input       TEXT,
  state            TEXT NOT NULL CHECK (state IN ('running','done','failed','cancelled')),
  steps INTEGER DEFAULT 0, tool_calls INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_summary TEXT, result_full_ref TEXT,   -- 全文落盘路径（避免撑爆 DB）
  error TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX ix_agentruns_turn ON agent_runs(turn_id, started_at);
CREATE INDEX ix_agentruns_parent ON agent_runs(parent_run_id);

CREATE TABLE agent_messages (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT NOT NULL,
  from_run_id   TEXT NOT NULL,
  to_run_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ask','answer','progress','result','error')),
  payload_json  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent','answered','timeout','dropped')),
  created_at    INTEGER NOT NULL,
  answered_at   INTEGER
);
CREATE INDEX ix_agentmsg_turn ON agent_messages(turn_id, created_at);
CREATE INDEX ix_agentmsg_pending ON agent_messages(to_run_id, state) WHERE state='sent';
```

### 2.8 Provider 与模型

```sql
CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- 'anthropic-main' | 'openrouter' | ...
  kind        TEXT NOT NULL,               -- anthropic|openai|google|openai-compatible|gateway|custom
  base_url    TEXT,
  api_key_enc TEXT,                        -- AES-256-GCM(base64)；明文永不出库、永不回传前端
  api_key_hint TEXT,                       -- 'sk-...a1b2'（仅末 4 位）
  headers_json TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  health_state TEXT, health_checked_at INTEGER, health_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE models (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  model_id        TEXT NOT NULL,           -- provider 侧真实 id，如 'claude-opus-5'
  display_name    TEXT,
  context_window  INTEGER NOT NULL,
  max_output      INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL,         -- 能力与元数据快照，见下方说明；由 models.dev 目录填充
  price_in         REAL, price_out REAL,   -- USD / 1M tokens
  price_cache_read REAL, price_cache_write REAL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_models_provider_model ON models(provider_id, model_id);
-- capabilities_json 的形状（导入与「补齐元数据」两条路径写入，见 04 §5.5）：
-- {
--   "vision": true, "tools": true, "reasoning": true, "structuredOutput": true,
--   "temperature": true, "attachment": true,
--   "reasoningControl": "effort" | "toggle" | "budget_tokens" | null,
--   "reasoningEfforts": ["low","medium","high"],          -- reasoningControl=effort 时才非空
--   "modalities": { "input": ["text","image","pdf"], "output": ["text"] },
--   "knowledge": "2025-07-31", "releaseDate": "2025-09-29",
--   "catalog": { "source": "models.dev", "match": "provider|official|third-party|none",
--                "providerId": "anthropic", "modelId": "claude-opus-5", "normalized": false,
--                "priceRange": { "min": 0.2, "max": 0.4, "providers": 2 } | null,
--                "priceSource": "provider|official|manual" | null, "fetchedAt": 1739000000000 }
-- }
-- 运行时不读这一列（vision 自动切别名尚未实现），它服务于 WebUI 的展示与人工判断。
-- priceSource=manual 由 `PATCH /api/models/:id` 改动任一价格字段时写入：手填过的价不能再挂官方价徽标。

-- 别名 → 有序 fallback 链
CREATE TABLE model_aliases (
  alias          TEXT PRIMARY KEY,         -- main|high|low|vision|title|embed|<自定义>
  model_ids_json TEXT NOT NULL,            -- ["mdl_01","mdl_07"]  按顺序 fallback
  settings_json  TEXT,                     -- 采样参数白名单，见 04 §5.2.1；非白名单键写入即拒
  description    TEXT,
  updated_at     INTEGER NOT NULL
);
```

### 2.9 日志、记账、配额

```sql
CREATE TABLE log_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  level         TEXT NOT NULL,             -- debug|info|warn|error
  kind          TEXT NOT NULL,             -- 见 10 文档的事件枚举
  trace_id      TEXT,                      -- = turn_id
  span_id       TEXT, parent_span_id TEXT,
  chat_id TEXT, user_id TEXT, key TEXT,
  agent_run_id  TEXT,
  summary       TEXT NOT NULL,
  data_json     TEXT,                      -- 摘要字段（脱敏后）
  file_ref      TEXT,                      -- 大 payload 落盘位置 logs/<date>/<kind>.jsonl#<offset>
  duration_ms   INTEGER
);
CREATE INDEX ix_log_ts ON log_events(ts DESC);
CREATE INDEX ix_log_trace ON log_events(trace_id, ts);
CREATE INDEX ix_log_kind_ts ON log_events(kind, ts DESC);
CREATE INDEX ix_log_chat_ts ON log_events(chat_id, ts DESC);

CREATE TABLE usage_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  turn_id       TEXT, agent_run_id TEXT, span_id TEXT,
  chat_id       TEXT, user_id TEXT,
  provider_id   TEXT NOT NULL, model_id TEXT NOT NULL, model_alias TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  finish_reason TEXT,
  ok            INTEGER NOT NULL DEFAULT 1,
  error_kind    TEXT
);
CREATE INDEX ix_usage_ts ON usage_ledger(ts DESC);
CREATE INDEX ix_usage_chat_ts ON usage_ledger(chat_id, ts DESC);
CREATE INDEX ix_usage_user_ts ON usage_ledger(user_id, ts DESC);
CREATE INDEX ix_usage_turn ON usage_ledger(turn_id);

CREATE TABLE quota_counters (
  scope    TEXT NOT NULL CHECK (scope IN ('global','chat','user')),
  subject  TEXT NOT NULL,                  -- 'global' | chatId | userId
  window   TEXT NOT NULL CHECK (window IN ('day','month')),
  bucket   TEXT NOT NULL,                  -- '2026-08-15' | '2026-08'
  cost_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,    -- 预留（见 10 §5.3）
  turns    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject, window, bucket)
);
```

### 2.10 扩展与记忆

```sql
CREATE TABLE skills (
  name        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  description TEXT NOT NULL,
  min_role    TEXT NOT NULL DEFAULT 'trusted',
  allowed_tools_json TEXT,
  model_alias TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL DEFAULT 'local',  -- local|plugin
  content_hash TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  load_error  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE plugins (
  name        TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  version     TEXT,
  min_role    TEXT NOT NULL DEFAULT 'trusted',
  enabled     INTEGER NOT NULL DEFAULT 0,     -- 默认关闭，须 owner 显式启用
  config_json TEXT,
  provides_json TEXT,                          -- { tools:[], hooks:[], commands:[] }
  load_error  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE mcp_servers (
  name        TEXT PRIMARY KEY,
  transport   TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
  command TEXT, args_json TEXT, env_json TEXT,   -- stdio
  url TEXT, headers_json TEXT,                    -- http/sse
  min_role    TEXT NOT NULL DEFAULT 'trusted',
  enabled     INTEGER NOT NULL DEFAULT 0,
  tool_allow_json TEXT, tool_deny_json TEXT,
  timeout_ms  INTEGER NOT NULL DEFAULT 30000,
  state       TEXT, last_error TEXT, tools_json TEXT, connected_at INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE memory_docs (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('assist','character','pubmemory','primemory')),
  subject      TEXT,                     -- primemory: userId；character 可 per-chat 覆盖: chatId
  path         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  tokens       INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_memory_scope_subject ON memory_docs(scope, IFNULL(subject,''));

CREATE TABLE memory_revisions (
  id        TEXT PRIMARY KEY,
  doc_id    TEXT NOT NULL REFERENCES memory_docs(id),
  ts        INTEGER NOT NULL,
  actor     TEXT NOT NULL,               -- model|owner|system
  turn_id   TEXT, chat_id TEXT, user_id TEXT,
  op        TEXT NOT NULL,               -- append|replace_section|remove|compact|manual
  diff      TEXT NOT NULL,               -- unified diff
  bytes_after INTEGER NOT NULL
);
CREATE INDEX ix_memrev_doc_ts ON memory_revisions(doc_id, ts DESC);
```

### 2.11 审批、配置、会话

```sql
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  turn_id      TEXT NOT NULL, agent_run_id TEXT, span_id TEXT,
  chat_id      TEXT NOT NULL, requester_user_id TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  input_json   TEXT NOT NULL,
  risk         TEXT NOT NULL,            -- low|medium|high
  state        TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired')),
  tg_message_id INTEGER,
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_by TEXT, decided_at INTEGER, decision_channel TEXT   -- telegram|webui|system
  -- 有裁决通道时才写 pending 行：判据是 `EventBus.channelCount > 0`，而 WebUI 的 SSE 订阅是目前
  -- 唯一带 `{channel:true}` 标记的订阅者。命中规则的调用落成 pending 后等裁决 / TTL / 轮次取消
  -- （docs/24 · R-APPR-01）。一个裁决通道都没有时不写 pending，当场 state='denied',
  -- decided_by='system', decision_channel='system' —— 让模型立刻知道审批不可用，而不是干等满
  -- approval.ttlMs（[05 §6]）。Telegram inline keyboard 尚未实现，发起人在等待期间收不到提示。
);
CREATE INDEX ix_approvals_state ON approvals(state, requested_at);

CREATE TABLE config_kv (
  key        TEXT PRIMARY KEY,           -- 点分路径 'context.limit.tokens'
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- 运行时 KV。与 config_kv 严格分开：config_kv 的每一行都会被 loadConfig 当成配置覆盖层解析，
-- 混进去的非配置键会在下次启动时被 schema 判为非法路径（迁移 0005）。
CREATE TABLE app_kv (
  key        TEXT PRIMARY KEY,           -- 'modelAlias:chat:-100…'、'plugin:<name>.<key>'
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE config_revisions (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL,
  key TEXT NOT NULL, old_json TEXT, new_json TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,           -- 随机 32B
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT, ua TEXT, csrf TEXT NOT NULL
);

CREATE TABLE processed_updates (        -- update_id 去重（重启后仍有效）
  update_id INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL
);
```

### 2.12 定时任务

> [14 §2 Q4](./14-open-questions.md) 已拍板；轮次语义见 [02 §10](./02-context-engine.md#10-定时轮次的上下文归属)（迁移 0007）。

```sql
-- 为什么是一张表而不是 app_kv：装载时要的是「全部活跃任务」，而 app_kv 没有前缀扫描入口、
-- 没有二级索引；单键存整个数组则会在并发轮次下丢更新（两个人同时让 bot 加任务，后写覆盖前写）。
CREATE TABLE scheduled_jobs (
  id          TEXT PRIMARY KEY,          -- ULID
  key         TEXT NOT NULL,             -- context key，会话隔离边界
  chat_id     TEXT NOT NULL,
  thread_id   INTEGER,
  created_by  TEXT NOT NULL,             -- 创建者 tg user id；每次触发按它重算有效角色
  name        TEXT NOT NULL,             -- 同会话内活跃唯一：取消时给的是名字
  mode        TEXT NOT NULL CHECK (mode IN ('agent','notify')),
  cron        TEXT,                      -- 与 run_at 二者其一
  run_at      INTEGER,                   -- 一次性任务的绝对时间（epoch ms）
  timezone    TEXT NOT NULL,             -- 落在行上：事后改 general.timezone 不该改变已有任务的含义
  payload     TEXT NOT NULL,             -- agent=任务描述；notify=原文
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','done','cancelled')),
  run_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER, last_state TEXT, last_error TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((cron IS NULL) + (run_at IS NULL) = 1)
);
CREATE INDEX ix_sched_key ON scheduled_jobs(key, state);
CREATE INDEX ix_sched_state ON scheduled_jobs(state) WHERE state = 'active';
CREATE UNIQUE INDEX ux_sched_name ON scheduled_jobs(key, name) WHERE state = 'active';
```

### 2.13 自撰写工具

> [14 §2 Q13](./14-open-questions.md) 拍板；语义见 [07 §6](./07-skills-plugins-mcp.md)（迁移 0008）。

```sql
-- 一条记录 = 一段参数化的 bash / python 脚本，注册进 ToolRegistry 时 source='custom'。
-- 为什么是一张表：装载要的是「全部已启用的」，app_kv 没有前缀扫描也没有二级索引，单键存整个
-- 数组会在并发轮次下丢更新；config_kv 更不行——每一行都会被 loadConfig 当成配置覆盖层解析。
CREATE TABLE custom_tools (
  name            TEXT PRIMARY KEY,      -- 不含 custom_ 前缀；注册名是 custom_<name>
  description     TEXT NOT NULL,         -- ≤200 字符、单行：它进每一轮的 TOOL CATALOG
  params_json     TEXT NOT NULL,         -- object 型 JSON Schema，注册时经 jsonSchemaToZod 转 zod
  runtime         TEXT NOT NULL CHECK (runtime IN ('bash','python')),
  body            TEXT NOT NULL,
  min_role        TEXT NOT NULL DEFAULT 'owner' CHECK (min_role IN ('trusted','owner')),
  scope           TEXT NOT NULL DEFAULT 'chat' CHECK (scope IN ('chat','global')),
  owner_chat_id   TEXT,                  -- scope='chat' 时必填，见下面的 CHECK
  timeout_ms      INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 0,   -- 落库即禁用；owner 在 WebUI 点开
  definition_hash TEXT NOT NULL,         -- 覆盖 runtime/timeout/params/body；执行前比对，防轮内改写
  created_by      TEXT NOT NULL,
  created_turn    TEXT,
  reviewed_at     INTEGER,               -- 「有人看过这段正文」的时间戳，改正文时清空
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((scope = 'chat') = (owner_chat_id IS NOT NULL))
);
CREATE INDEX ix_custom_tools_enabled ON custom_tools(enabled) WHERE enabled = 1;
```

**`enabled` 与 `reviewed_at` 是两件事。** 前者是「现在跑不跑」，后者是「有没有人读过这段模型
写下的正文」—— 界面靠这一对把「未审阅」和「审过之后被关掉」分开显示。

**`messages.tg_message_id ≥ 2_000_000_000` 是合成消息的保留段。** 定时轮次的触发消息没有真实
Telegram 消息号，从这个高位段按会话取 `MAX+1`。别在这个区间里写别的东西 —— 撞号时
`append` 的 `INSERT OR IGNORE` 会静静返回既有行，而那正是「一条真实用户消息凭空消失」的成因
（[02 §10.2](./02-context-engine.md#102-合成触发消息的-id-分配)）。

---

## 3. 迁移策略

- 文件名 `NNNN_描述.sql`（如 `0001_init.sql`），只增不改。
- 启动时自动执行未应用的迁移（账本表 `__drizzle_migrations`，名字是早期 Drizzle 方案留下的），失败则**拒绝启动**并打印待手动处理的 SQL。
- 破坏性变更（改列类型、删列）走「新表 + 拷贝 + 改名」，且必须在 `docs/migrations/` 附回滚说明。
- 每次迁移前自动备份：`data/backup/luoli-<ts>-pre-<NNNN>.db`（`VACUUM INTO`），保留最近 `db.backupKeep`（默认 5）份。

## 4. 保留与清理（后台定时任务）

| 数据 | 默认保留 | 清理方式 |
|---|---|---|
| `messages` / `attachments`（**行**） | 永久 | 不清理（owner 可在 WebUI 按 chat 手动清）。[14 §2 Q9-b](./14-open-questions.md) 拍板：纯文本每万条才 5–15MB，不值得为它冒删错的风险。**行永久不代表文件永久** —— 见下面 `media.dir` 那行 |
| `context_messages` | 永久 | 不清理（裁剪只移窗口） |
| `log_events` | `logs.retentionDays` = 30 | 按 ts 删除 + `logs/` 目录同期归档删除 |
| `logs/*.jsonl` | 同上 | 超期文件删除；可选先 gzip |
| `usage_ledger` | `maintenance.retention.usageDays` = 400 | 按 ts 直接删。**`usage_daily` 聚合表没有实现**，所以超期就是没有了 —— 要长期账目请在保留期内导出（docs/27 · R-05） |
| `quota_counters` | `maintenance.retention.quotaCounterDays` = 400 | 按 `updated_at` 删过期账期的行；当前账期每轮都在更新，落不进保留期之外 |
| `config_revisions` | `maintenance.retention.configRevisionDays` = 180 | 按 ts 删。删的是审计记录，不影响当前配置（`config_kv` 不动） |
| `memory_revisions` | `maintenance.retention.memoryRevisionDays` = 180 | 按 ts 删。删掉之后回滚不到比它更早的版本 |
| `turns` / `tasks` | 永久 | **刻意不给保留期**：它们是 trace 的骨架（`/api/turns/:id/detail` 靠 turn 行把日志、用量与上下文串起来），删掉等于历史轮次凭空消失。[14 §2 Q9-c](./14-open-questions.md) 已确认永久保留，不再是未决问题 |
| `processed_updates` | 7 天 | 定期删 |
| `sessions` | 过期即删 | 每小时 |
| `approvals` | 90 天 | pending 超 `expires_at` 标 `expired` |
| `scheduled_jobs` | `schedule.retentionDays` = 30 | 只删**已结束**（`done` / `cancelled`）且 `updated_at` 超期的行。**活跃任务永不清** —— 清掉一条还在排的任务，表现是「bot 突然不再提醒了」而库里毫无痕迹 |
| `media.dir`（默认 `./data/files`）下的媒体**文件** | `media.retentionDays` = 90 | 按 `attachments.created_at` 删磁盘上的文件，**`attachments` 行与元数据保留**（[14 §2 Q9-a](./14-open-questions.md)）：历史消息里的「[图片]」还在、上下文与检索结果都不塌，只是点不开（T16）。`0 = 不清`。**真正占盘的是这一项** —— `gcFiles()` 只扫孤儿（没有任何 DB 行指向的文件），扫不到有行指着的正常媒体。删完把 `local_path` 置空并把 `download_state` 写成 `'expired'` —— 光置空会和「下载失败」（`'failed'`）混成一种状态，运维查起来分不出是过期删的还是当初就没下来 |
| `data/cache/models.dev.json` | 永久 | 纯派生数据，删掉即可（下次拉取模型时自动重下）。年龄记在 `app_kv` 的 `catalog:models.dev`，超 `provider.catalog.ttlHours` 时用 ETag 条件请求续期 |

清理任务在 `general.maintenanceCron`（默认每日 04:00 本地时间）执行，并在完成后 `PRAGMA wal_checkpoint(TRUNCATE)` + 每周一次 `VACUUM`。

**`maintenance.retention.*` 的每一项 0 = 不清**（缺省同样不清）。默认沉默地删数据比不删危险得多 ——
而这四张表此前一条保留策略都没有：读端点都有 LIMIT，所以症状不是慢查询而是**库文件只涨不落**，
且 `VACUUM` 帮不上（数据还在，docs/27 · R-05）。
