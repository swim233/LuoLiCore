# 核心用 SQLite 存会话，消息以 JSON 存整条

会话、消息、段与摘要都由核心存取，延续 ADR-0002：分段、压缩、摘要这些逻辑与平台无关，CLI 与 Telegram 共用一份。前端只给出数据库路径，并把平台的 id（群 id、消息 id）作为不解读的附加信息交给核心。前端自己的平台状态（Chat SDK 的订阅、加锁、去重）不在这里。

存储用 Node 自带的 `node:sqlite`，单个文件 `data/luoli.db`，不加依赖。单机常驻进程，SQLite 足够。

```sql
CREATE TABLE conversations (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL,              -- 'cli' | 'telegram'
  platform_conversation_id TEXT,                       -- 平台里的会话 id（Telegram 的 chat id）；CLI 为空
  title                    TEXT,                       -- 群名；私聊为对方名字
  next_seq                 INTEGER NOT NULL DEFAULT 1, -- 下一条消息的序号；回复开始时预留
  created_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX conversations_platform
  ON conversations(platform, platform_conversation_id) WHERE platform_conversation_id IS NOT NULL;

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  seq                 INTEGER NOT NULL,   -- 会话内的顺序
  role                TEXT NOT NULL,      -- 'user' | 'assistant'
  author_id           TEXT,               -- 发言人 id；助手的消息为空
  platform_message_id TEXT,               -- 平台里的消息 id；编辑时靠它找到这条消息
  created_at          TEXT NOT NULL,      -- 消息本身的时间（用户消息取平台上的发送时间）
  ui_message          TEXT NOT NULL       -- 整条消息的 JSON；上面几列是它的副本，用于查询
);
CREATE UNIQUE INDEX messages_order    ON messages(conversation_id, seq);
CREATE UNIQUE INDEX messages_platform ON messages(conversation_id, platform_message_id)
  WHERE platform_message_id IS NOT NULL;

CREATE TABLE segments (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id),
  start_seq          INTEGER NOT NULL,   -- 本段从这个序号的消息开始
  start_reason       TEXT NOT NULL,      -- 'first' | 'idle' | 'compress'
  conversation_title TEXT,               -- 段开始时会话标题的快照；一段内不变
  prior_summary      TEXT,               -- 本段开始之前全部内容的滚动摘要；第一段为空
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX segments_order ON segments(conversation_id, start_seq);
```

- 消息一条一行，整条 `UIMessage` 存在 `ui_message` 里（ADR-0001）。查询要用的几列是它的副本，写入时一起写，读取以 JSON 为准。消息结构以后加工具调用、图片，不用改表。
- 段是连续的序号区间，从本段的 `start_seq` 到下一段的 `start_seq` 之前。切段只插入一行，不改消息。滚动摘要存在下一段的 `prior_summary` 上，因为它是与下一段一起发给模型的。摘要写好之前不插入新段，中途崩溃只是下次重做。
- 回复开始生成时从 `next_seq` 预留序号，所以回复排在它看到的最后一条消息之后。回复失败或没有输出时序号空着，序号只用于排序。
- 图片存为 `data/files/<内容哈希>.<扩展名>`，消息里以 `luoli-file:` 开头的地址引用，发请求时换成图片数据。同一张图只存一份。不建文件表、成员表：名字随每条消息存快照。
- 原文永久保留。开 WAL 模式，表结构版本记在 `PRAGMA user_version`。

## Considered Options

- 各前端自己存消息、核心只接收拼好的历史：每个前端都要重写分段与摘要。
- better-sqlite3：更成熟，但要加依赖并允许原生编译。
- Postgres：外部服务，多实例部署时才需要。
- 消息完全拆成表和列：消息结构一变就要改表。
- 图片存进数据库，或只记 Telegram 的文件 id：前者让数据库变大；后者每次请求都要重新下载，且下载地址含 bot token，不能交给模型服务。
- 消息只存用户 id、按最新名字显示：有人改名会改写整段历史，缓存失效。

## Consequences

- 改名的人在模型看来可能是两个人，靠标签里不变的 `uid` 区分。
- `data/` 整个目录不进仓库，备份时一起拷走。
