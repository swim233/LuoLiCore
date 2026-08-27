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

`web_fetch` / MCP 工具抓回来的图片走**另一张表**。不复用 `attachments`：那张表整体是 Telegram
形状的（`message_id NOT NULL REFERENCES messages(id)`、`tg_file_id NOT NULL`、
`UNIQUE(chat_id, tg_file_unique_id)`），网页图这三样一个都没有，只能填假值 —— 而「摘除比伪造
安全」是已确立的先例（`docs/reviews/16 §5`）。引用形式是 `webasset://<id>`，与 `attachment://<id>`
在读出侧走同一个 `hydrateAttachment`、同一条「文件丢了换占位文本、绝不抛」的兜底。

```sql
CREATE TABLE web_assets (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,        -- 上下文 key（chat:<id> / thread:<id>:<tid>）
  url         TEXT NOT NULL,        -- 取自哪（截至 2048 字符）
  media_type  TEXT NOT NULL,        -- 归一化之后恒为 image/jpeg
  local_path  TEXT,                 -- media.dir/web/<key>/<sha256-32>.jpg；null=文件已不在
  bytes       INTEGER,              -- 归一化**之后**的字节数，不是下载下来那份
  width INTEGER, height INTEGER,    -- 归一化之后的尺寸
  created_at  INTEGER NOT NULL
);
CREATE INDEX ix_web_assets_key ON web_assets(key);
CREATE INDEX ix_web_assets_created ON web_assets(created_at);
```

文件名取内容哈希：同一张图在一个会话里被取两次时盘上只留一份，但**库里仍是两行**（`id` 是注入
用的引用，一行一次注入，共享的只是那份字节）。文件落在 `media.dir` 之下是刻意的 —— 跟着同一个
目录走，`gcFiles()` 那道「库与目录来自两套部署」的 fail-closed 守卫才继续适用（`docs/25 §10`）。

**一份字节被多行共享，所以过期清理不能「见行删文件」**：`local_path` 相同的两行里旧那行到期时，
先删文件就把还在保留期内那行的图一起弄没了（表现不是报错，是那张图提前变成
「[图片已不可用：附件文件已丢失]」）。顺序必须是**先删行、再删没有任何行指着的文件**。
`gcFiles()` 天然没有这个问题 —— 它的 `referenced` 是并集。

> **改这张表时两处必须一起改**：`MaintenanceService.gcFiles()` 的 `referenced` 集合
> （`media.dir` 下现在有 `attachments` 与 `web_assets` **两张**表在引用文件，漏一张的表现不是
> 报错、是那张表的文件被静默当孤儿删掉 —— 这个坑本仓踩过两次），以及 `cleanup()` 里
> `media.retentionDays` 的过期清理。

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
  -- 按 kind 各有形状：prune 记 { reason, from, to, levels[], hardTruncated }；manual 记
  -- { targetCommitId }；reset 记 { archiveFloor, advancedClaims } —— archiveFloor 是清空那一刻
  -- 归档里最大的 messages.id，`context.recallBarrier` 拿它当归档检索的下限（02 §7.1）。
  -- 无条件写：开关是运行时的，而这张表不可变，事后打开开关补不回旧 reset 的水位
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
  cost_usd REAL NOT NULL DEFAULT 0,            -- **ACP 那种行恒为 0**，见下面两列
  -- 外部编码 agent（M13 · `spawn_acp`）自己报的花费与用量（迁移 0014）。**两列都可空：
  -- NULL = 它一次 usage_update 都没报过**，与「它报了 0」是两件事 —— 后者是一个它给出的数字。
  -- 为什么另开两列而不是写 cost_usd：那个数不是我们的钱。它是外部 agent 自己那份 provider 账单的
  -- 累计值，口径由它定、我们无法核对、也没有 tokens × prices 可以重算；写进 cost_usd 就等于让它
  -- 出现在每一个 SUM(cost_usd) 里，摆在我们自己的成本旁边就是邀请人把两者相加。所以 ACP 行的
  -- cost_usd 恒 0，结构上把外部数字挡在每一个聚合之外。
  -- 同理这两列**不进** usage_ledger（那张表的行有 provider 身份，provider_id / model_id 必填、
  -- 用量页按它分桶，塞一条 provider_id='omp' 等于凭空造一个我们不拥有的 provider）、也不进
  -- quota_counters / turns.cost_usd（配额的分母是本系统的 key，掺进外部花费后那个比例看起来权威、
  -- 实际无意义）。落库 ≠ 记账接上了，唯一的闸仍然是 agent.acp.maxCostUsd（04 §6.2）。
  external_cost_usd REAL,
  external_usage_json TEXT,                    -- 自描述载荷（source / agent / model 都在里面）：
                                               -- 读的人要能看出这些数字的出处不是本系统
  result_summary TEXT, result_full_ref TEXT,   -- 全文落盘路径（避免撑爆 DB）：存**相对**结果目录
                                               -- （<LUOLI_DATA_DIR|cwd>/data/agent-results）的 ref，
                                               -- 与 attachments.local_path 同一套。存绝对路径的话
                                               -- 换个 cwd 起一次进程，库里记旧根、文件在新根，
                                               -- gcFiles() 把新根下的全文当孤儿删空（28 · L-OPS-06）。
                                               -- 存量绝对路径行由启动期一次性归一化处理，指向别的
                                               -- 根的原样留下 —— 那是 gc 拒绝清理的依据
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

**迁移 0014 是附加式的，一个 CHECK 都没碰。** `kind` 上那条 `CHECK (kind IN ('main','sub'))` 要给
ACP 加一档就得整表重建，而 `agent_runs` 是 trace 的骨架表（§4：`turns` / `tasks` 永久保留，靠这张表
把子 run 串起来）—— 重建期间那些 id 引用全在半空中。所以 **ACP 行照旧记 `kind='sub'`**，认它靠
`agent_name='acp:<name>'` + `model_alias='external'` 这一对，而不是一个新的 kind。

**ACP 行不占本轮的子 agent 名额。** `AgentManager.spawn()` 判 `agent.maxSubagentsPerTurn`（默认 10）
的那条 COUNT 把它们排掉：
`… WHERE turn_id=? AND kind='sub' AND NOT (agent_name GLOB 'acp:*' AND model_alias='external')`。

**为什么排除是对的：** 那个数管的是**本系统自己的 fan-out 成本** —— 每个子 agent 都是一次我们
付钱的模型调用，护栏防的是模型一步派出一片；而 ACP 那条路有它自己的三道门（owner + 仅私聊、
目录白名单、每次审批，[05 §3.5.1](./05-tools-and-permissions.md)）加目录互斥加
`agent.acp.maxCostUsd`，从来不共用这个数。**旧口径（数行、不看 `agent_name`）的问题不只是
「多占一个」**：那一行是**跑完之后**才一次性插入的（没有 `state='running'` 那一段），所以它只压得住
同一轮里排在它**后面**的 `spawn_agent` —— 一个依赖调用顺序的上界，比「占」与「不占」两种一致的
选择都更坏（同样两次 ACP 调用 + 两次 `spawn_agent`，换个顺序就是两个不同的额度）。

判据取 `acp:` 前缀与 `model_alias='external'` **两个都中**才排除。`agent.agents[].name` 是裸
`z.string()`，没有正则：`agents/<name>.md` 那条路挡得住冒号（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），
DB / WebUI 那条挡不住，所以运维真能建一个叫 `acp:x` 的子 agent —— 要它**同时**把 `modelAlias`
写成 `external` 才会被漏数。用 `GLOB` 而不是 `LIKE`：后者在 SQLite 里 ASCII 大小写不敏感，
会把 `ACP:x` 一起排掉。

**这是 `agent_runs` 上唯一一处按行聚合的地方**，其余读法结构上碰不到 ACP 行：深度是
`parent.depth + 1`、环路检测（`ancestors()`）沿 `parent_run_id` 往上走，而没有任何 run 以 ACP 行
为父；`agent.maxConcurrentSubagents` 的闸是进程内计数、不查库；`recoverAfterCrash` 只改
`state='running'` 的行，而 ACP 行落库即终态；§4 的结果全文过期只挑 `result_full_ref IS NOT NULL`，
而 ACP 行那一列恒 NULL（它只有 `result_summary`）。

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
  -- 连续失败次数（0009）。周期探测与真实调用的请求超时共用它，到 3 次才写 health_state='down'
  -- （docs/04 §5.3）。成功一次归零。落库而不是进程内计数：否则重启等于把「上游还黑着」清零。
  health_fail_count INTEGER NOT NULL DEFAULT 0,
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
--                "priceSource": "provider|official|manual" | null, "fetchedAt": 1739000000000 },
--   "manual": { "vision": false }                        -- 可选；owner 人工标过的能力位，见下
-- }
-- 运行时**只读 `vision` 这一个字段**：`ModelRegistry.supportsVision(alias)` 解析别名链首那一行，
-- 含图轮次据此在 `prepareStep` 自动切 `vision`（04 §5.2）。其余字段服务于 WebUI 的展示与人工判断。
-- priceSource=manual 由 `PATCH /api/models/:id` 改动任一价格字段时写入：手填过的价不能再挂官方价徽标。
-- `manual` 是**人工标记**：目录按模型名匹配，中转站照抄官方模型名却不转发图片时抄来的
-- `vision:true` 会让含图轮次不切别名。`PATCH /api/models/:id` 的 `capabilities` 把生效值写顶层
-- （运行时与徽标都读那里，不必各自再懂一层优先级），同时把意图记进 `manual` —— 「补齐元数据」
-- 拿目录那份整块覆盖能力位，不留下意图的话一次补齐就把标记静默撤销了。**`manual` 的键只能来自
-- 运行时真的会读的那几个**（现在只有 `vision`），白名单外的键端点直接 400：让人以为标了
-- 「不支持工具」就不会发工具目录，比不给这个选项糟（09 §4、21 §10）。

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
  source      TEXT NOT NULL DEFAULT 'local',  -- bundled|package|local
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
  -- state: up | down | needs_auth | disabled。'pending' 只是 `GET /api/mcp` 的兜底显示值，
  -- 从不落库。**needs_auth 与 down 分开**：前者要人去点一次授权，后者要人去看命令行/网络
  -- （docs/07 §4.5）。这一列没有 CHECK 约束，所以加值不需要迁移。
  state       TEXT, last_error TEXT, tools_json TEXT, connected_at INTEGER,
  updated_at  INTEGER NOT NULL
);

-- 需要登录的 MCP server 的凭据（migrations/0011，语义见 docs/07 §4.5）。
-- **凭据不在 `mcp.servers` 配置里**：`config_kv` 的每一行都会被 loadConfig 当配置覆盖层解析，
-- 配置还要进 `config_revisions` 与 `/api/config/export`，而按键名判密的那条正则
-- （/key|secret|token|password/i）匹配不到 `Authorization` —— 一个只用 bearer header 的 server，
-- 它的 token 此前明文进了 revision、也从配置导出里原样出来。
CREATE TABLE mcp_auth (
  server         TEXT PRIMARY KEY,
  mode           TEXT NOT NULL CHECK (mode IN ('bearer','oauth')),
  secret_enc     TEXT,        -- bearer: token；oauth: 整块 OAuthTokens JSON。Secrets 加密
  client_enc     TEXT,        -- oauth: 动态注册（RFC 7591）拿到的 client_information
  verifier_enc   TEXT,        -- oauth: 进行中那一次授权的 PKCE code_verifier，换完就清
  discovery_json TEXT,        -- oauth: 授权服务器发现结果缓存（不含密，故不加密）
  scope          TEXT,
  hint           TEXT,        -- bearer token 的末 4 位，照 providers.api_key_hint 的做法
  expires_at     INTEGER,     -- access token 到期时刻（毫秒）。null = 不过期或对方没说
  authorized_at  INTEGER,
  -- 每次写凭据 +1，并且**进 McpManager 的连接指纹**：指纹原本只含 transport/command/env/
  -- url/headers，token 搬进这张表之后轮换一次 token 不再改变指纹，于是旧连接被缓存命中、
  -- 拿着已作废的 token 一直用，而界面上那台 server 还显示「已连接」。
  version        INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);
```

> `mcp_auth` **一行都不含明文**。读出侧只有 `McpAuthRepository` 一个入口，它的 `get()` / `list()`
> 交回的公开视图里没有任何密文列（`{ mode, scope, hint, expiresAt, authorizedAt, authorized,
> version }`），`GET /api/mcp` 直接用那一份。`reconcile()` 顺手 prune 掉配置里已经没有的 server
> 的行；判据是**整份 `servers`** 而不是「本次要连的那些」——停用一台 server 不该把它的 token
> 一起丢掉。

> `skills` 是盘上那批 `SKILL.md` 的**读模型，不是真相**：真相是文件，每次
> `SkillLoader.scan()` 都能整张重建。所以 `scan()` 末尾会
> `DELETE FROM skills WHERE name NOT IN (盘上这一批)` —— 在这之前 `persist()` 只 upsert，
> 盘上删掉一个目录那一行会永远留在表里、永远显示在扩展页（`GET /api/skills` 读的就是这张表）。
> **`skills.dir` 读不到（`ENOENT`）时不清理**：目录临时不在时清空整张表比留着陈行糟得多。
>
> `source` 从 `local` / `plugin` 改成 `bundled` / `package` / `local`
> （[07 §2.1](./07-skills-plugins-mcp.md)）。这一列此前是死的 —— schema 有、`persist()` 从不写、
> WebUI 从不读，于是所有行都是默认值 `local`。plugin 不贡献 skill，那个取值从来没有过写入方。

```sql
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
  decided_by TEXT, decided_at INTEGER, decision_channel TEXT
  -- decision_channel: telegram|webui|system|acp
  -- **这一列是通道，不是主体**（两者取值域不同，无 CHECK 约束所以只能靠这行字）。写入侧曾把
  -- decided_by 原样抄进这一列，于是 acp 那一档两列同值 —— 审批卡那一格渲染的正是
  -- `decided_by · decision_channel`，同一个字符串印两遍；按通道分桶的查询还会多出一个取值域外的
  -- 桶（docs/21 · G-UI-04）。`recordDecided()` 的入参因此把 channel 与 decidedBy 拆成两项。
  -- decided_by 有四种格式，无 CHECK 约束：`user:<tgId>`（Telegram 点的按钮，见 [05 §6.1]）、
  -- 字面量 `owner`（WebUI 的 POST /api/approvals/:id/decide —— 那一面只有一个 owner 身份，A15）、
  -- `system`（TTL 到期 / 轮次取消 / 回执发不出去 / 启动扫描）、`acp:always`（M13 的
  -- `DatabaseApprovalBroker.recordDecided()`：ACP 那条路上会话内的 allow_always / reject_always
  -- 记忆命中了，这一次没有任何人被问）。**没问人也要落一行**：不落的话「批了一次之后它接着改了
  -- 40 个文件」在审计里只剩最初那一条，而 always 恰恰是最需要被数出来的一档。这些行**出生即已
  -- 裁决** —— requested_at == decided_at、decision_channel 为 acp、state 直接是
  -- approved/denied，从不经过 pending，所以 TTL 与下面 tg_message_id 那套待办机器一样都碰不到
  -- 它们（没有回执、没有按钮、没有可过期的东西）。**回执正文一律说 decision_channel
  -- 而不是这一列**：一串 Telegram id 对群里其他人什么都不是，还顺手把 owner 的 id 抖出去。
  -- WebUI 的审批卡走服务端的 `decidedByLabel()` → `principalLabel()` 反查显示名（docs/21 · G-API-24），
  -- 格式的解析只有 `parsePrincipal` 那一份 —— 前端不许自己拆 `user:` 前缀。
  -- tool_name **不必是一个注册过的工具**：ACP 逐条审批那条路恒为字面量 `acp_permission`，不按
  -- toolCall.kind 拆成 `acp:edit` 这类名字 —— `approval.rules` 只对「名字 + JSON.stringify(input)」
  -- 求值，而这条路的 input 里已经有 kind / paths / outsideJail / toolCallId，`"kind":"execute"`
  -- 本身就够精准；多编一批工具名换来的是 WebUI 工具页上一批点不进去的行，与 `tools.overrides`
  -- 里一批运维改了也没用的键（那张表只认注册过的工具）。规格见 [05 §3.5.3]。
  -- 有裁决通道时才写 pending 行，判据是**两条通道**都没有才当场拒：WebUI 的 SSE
  -- （`EventBus.channelCount > 0`，`{channel:true}` 标记的订阅者）**或** Telegram 的 inline keyboard
  -- 对**这个会话**可用（`PendingPrompts.available(chatId)`，见 [05 §6]）。命中规则的调用落成 pending
  -- 后等裁决 / TTL / 轮次取消（docs/24 · R-APPR-01）。两条都没有时不写 pending，当场 state='denied',
  -- decided_by='system', decision_channel='system' —— 让模型立刻知道审批不可用，而不是干等满
  -- approval.ttlMs（[05 §6]）。
  -- tg_message_id: 发起人回执那条消息的编号，**是「屏幕上还有一排点不动的按钮」的待办队列，不是
  -- 历史记录**：投递落地时写，裁决落定**且那次收尾编辑真回来了**才清，启动时把剩下的逐条收尾
  -- （撤键盘 + 把正文换成结局）再整列清空（`DatabaseApprovalBroker.staleKeyboards()`）。
  -- 所以稳态下它几乎总是 NULL。**清列的前提是收尾已落地** —— 编辑没回来就等于这条还没办完，
  -- 抢在前面清的表现是消息被删 / 网络抖 / 429 各来一次，那排按钮就永久没人收。
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
  -- 「这一轮没什么可说时允许不投递」（02 §10.5，迁移 0013）。**默认 0**：一个到点什么都不说的
  -- 任务和一个坏掉的任务在用户眼里长得一样，这份沉默必须是有人明确要过的。落在行上而不是配置里
  -- ——「每天查更新」要静默而「每天早报」绝不能，一个全局开关表达不了。
  allow_silent  INTEGER NOT NULL DEFAULT 0,
  -- 连续静默次数：markRun 里就地一句 CASE 算（silent 则 +1，其余任何状态归零），到代码常量
  -- SILENT_STREAK_WARN 之后 schedule.silent 日志升 warn。不做读-改-写：那在多实例下就是丢更新
  -- （01 §3.1）。这是唯一能发现「这条任务已经变成一台只烧钱不说话的定时器」的机制。
  silent_streak INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((cron IS NULL) + (run_at IS NULL) = 1)
);
CREATE INDEX ix_sched_key ON scheduled_jobs(key, state);
CREATE INDEX ix_sched_state ON scheduled_jobs(state) WHERE state = 'active';
CREATE UNIQUE INDEX ux_sched_name ON scheduled_jobs(key, name) WHERE state = 'active';
```

**`last_state` 上没有 CHECK，是有意的。** 它的取值权威在 `ScheduledRunState` 联合类型上
（`committed` / `failed` / `skipped` / `missed` / `cancelled` / `silent`，最后一个由迁移 0013 那一轮加入）。
给它补一条 CHECK 要整表重建，而表上挂着**部分**唯一索引 `ux_sched_name` —— 重建期间那道
「同会话内活跃任务不重名」的约束是断的，换来的只是一个 TS 侧已经挡住的枚举。

**`ux_sched_name` 是部分唯一索引，所以预检挡不住并发。** `duplicate_name` 的判断
（建任务与改任务共用，[05 §3.8](./05-tools-and-permissions.md)）与真正的写入之间有窗口，
两条路都要在外面包一层 `SQLITE_CONSTRAINT` → `duplicate_name` 的翻译，
而不是只做预检就当稳了。

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

### 2.14 会话级持久容器

> 语义见 [05 §5.5](./05-tools-and-permissions.md)（迁移 0010）。只在 `sandbox.persistent.enabled` 下有行。

```sql
-- 一行 = 一个会话常驻的沙箱容器。**这张表不是真相的唯一副本**：docker 那边同样有
-- luoli.managed=1 标签，两边每个 reapCron tick 对一次账（DB 有行容器没了 → 删行；
-- 有标签的容器 DB 里没有 → 孤儿 rm -f）。进程重启后先对账而不是全杀，24h 的 TTL 要扛得住重启。
CREATE TABLE sandbox_containers (
  chat_id         TEXT PRIMARY KEY,      -- 按 chatId 而非 contextKey：workspace 就是按 chatId 分的
  name            TEXT NOT NULL UNIQUE,  -- luoli-box-<sanitized chatId>，docker 容器名
  container_id    TEXT,
  image           TEXT NOT NULL,
  spec_hash       TEXT NOT NULL,         -- image/memory/cpus/pids/network 的指纹；与配置不符即重建
  has_setsid      INTEGER NOT NULL DEFAULT 1,  -- 镜像里有没有 setsid，决定取消能不能杀整个进程组
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,      -- 滑动到期：每次执行推到 now + idleTtlMs
  hard_expires_at INTEGER,               -- 绝对上限；NULL = maxLifetimeMs 为 0，不设
  pinned          INTEGER NOT NULL DEFAULT 0,  -- 只豁免 expires_at，**不豁免** hard_expires_at
  exec_count      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX ix_sandbox_containers_expires ON sandbox_containers(expires_at);
```

**`pinned` 豁免的是滑动那一档而不是绝对上限** —— 豁免了绝对上限，它就不是上限了。

**`spec_hash` 存在的理由是「改了配置却不生效」。** 容器一旦跑起来，`--memory` / `--network` /
image 都改不动了；没有这一列，运维在 WebUI 换了镜像之后所有已存在的容器会一直用旧的，
而界面上显示的是新的。

---

## 3. 迁移策略

- 文件名 `NNNN_描述.sql`（如 `0001_init.sql`），只增不改。
- 启动时自动执行未应用的迁移（账本表 `__drizzle_migrations`，名字是早期 Drizzle 方案留下的），失败则**拒绝启动**并打印待手动处理的 SQL。
- 破坏性变更（改列类型、删列）走「新表 + 拷贝 + 改名」，且必须在 `docs/migrations/` 附回滚说明。
- 每次迁移前自动备份：`data/backup/luoli-<ts>-pre-<NNNN>.db`（`VACUUM INTO`），保留最近 `db.backupKeep`（默认 5）份。
  **备份文件必须 `chmodSync(path, 0o600)`**，`backup/` 目录 0700：`VACUUM INTO` 建出来的文件走
  SQLite 自己的 `0666 & ~umask`，常见 umask 下就是 0644 —— 一份全局可读的整库快照
  （`AC-SEC-011`，[29 · `M-SEC-01`](./29-manual-acceptance-log.md)）。目录那道 0700 只挡住同机其他
  用户遍历，而**权限位跟着文件走**：备份被复制 / 打包 / 同步出去之后就只剩文件自己那一位。
  两个生产者（迁移前这一次、`MaintenanceService.backup()`）都要补，只补一处等于没补。

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
| `agent_runs` / `agent_messages`（**行**） | 永久 | 同上：子 run 与 ask/answer 是那条 trace 的另一半，`turns` 留着而它们被清掉的话，「这一轮里哪个子 agent 干了什么」凭空消失。**但行永久不代表全文永久** —— `result_full_ref` 指向的文件按 `logs.retentionDays` 过期：删文件、把该列置空、`result_summary` 留着（摘要是历史轮次已经引述过的东西，删了会让那些引述变成悬空，`docs/22 · I-09`）。ACP 那种行结构上落不进这一路，它的 `result_full_ref` 恒 NULL（只有 `result_summary`）|
| `processed_updates` | 7 天 | 定期删 |
| `sessions` | 过期即删 | 每小时 |
| `approvals` | 90 天 | pending 超 `expires_at` 标 `expired` |
| `scheduled_jobs` | `schedule.retentionDays` = 30 | 只删**已结束**（`done` / `cancelled`）且 `updated_at` 超期的行。**自动清理永远不碰活跃任务** —— 清掉一条还在排的任务，表现是「bot 突然不再提醒了」而库里毫无痕迹。**但有一条手工硬删通道**：`POST /api/schedules/:id/purge`（[09 §4](./09-webui.md)）删的是整行，**active 的也删得掉**，先 `runner.unregister` 再落库。它与「停掉」（`DELETE`，软取消成 `cancelled`、行还在）是两个动词，也正因为它会把上面那句「毫无痕迹」变成现实，那一路**必须留一条 warn `schedule.purged`**：日后「bot 怎么不提醒了」在库里就只剩这一行凭据 |
| `media.dir`（默认 `./data/files`）下的媒体**文件** | `media.retentionDays` = 90 | 按 `attachments.created_at` 删磁盘上的文件，**`attachments` 行与元数据保留**（[14 §2 Q9-a](./14-open-questions.md)）：历史消息里的「[图片]」还在、上下文与检索结果都不塌，只是点不开（T16）。`0 = 不清`。**真正占盘的是这一项** —— `gcFiles()` 只扫孤儿（没有任何 DB 行指向的文件），扫不到有行指着的正常媒体。删完把 `local_path` 置空并把 `download_state` 写成 `'expired'` —— 光置空会和「下载失败」（`'failed'`）混成一种状态，运维查起来分不出是过期删的还是当初就没下来 |
| `web_assets`（**行 + 文件**） | `media.retentionDays` = 90 | 与上面那一项同一个保留期、同一处执行，但**行也一起删**。`attachments` 留行是因为历史消息里那条「[图片]」要保住 mime / 尺寸 / 已提取正文；网页图那条 `webasset://` part 自己就带着「这张图取自哪」的文本，行没了读出侧照旧交回占位文本（`hydrateAttachment` 的 `missing` 分支），留一堆 `local_path=NULL` 的行只是让 `gcFiles` 与过期清理都得多绕一次 |
| `data/cache/models.dev.json` | 永久 | 纯派生数据，删掉即可（下次拉取模型时自动重下）。年龄记在 `app_kv` 的 `catalog:models.dev`，超 `provider.catalog.ttlHours` 时用 ETag 条件请求续期 |
| `sandbox_containers` | 跟着容器走 | **不由 `maintenanceCron` 管**，走自己的 `sandbox.persistent.reapCron`（默认每 5 分钟）：容器被销毁时删行，同一个 tick 里与 docker 双向对账。行本身不占空间，它只是 docker 状态的索引 |
| `data/workspace/<chatId>` | **永久，且至今无人清理** | **没有实现任何回收**。`MaintenanceService` 一行都没管它，唯一的可见性是 `GET /api/health` 的 `workspaceBytes`。容器到期被回收**不动这里的文件**（那正是 `container_reset` 默认不清文件的同一条取舍：容器是环境，workspace 是数据）。要清只能人工，或用 `container_reset` 的 `wipeWorkspace` 单会话清 |

清理任务在 `general.maintenanceCron`（默认每日 04:00 本地时间）执行，并在完成后 `PRAGMA wal_checkpoint(TRUNCATE)` + 每周一次 `VACUUM`。

**`maintenance.retention.*` 的每一项 0 = 不清**（缺省同样不清）。默认沉默地删数据比不删危险得多 ——
而这四张表此前一条保留策略都没有：读端点都有 LIMIT，所以症状不是慢查询而是**库文件只涨不落**，
且 `VACUUM` 帮不上（数据还在，docs/27 · R-05）。
