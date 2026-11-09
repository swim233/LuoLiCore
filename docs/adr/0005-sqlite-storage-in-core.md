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
  role                TEXT NOT NULL,      -- 'user' | 'assistant'；事件也是 'user'
  author_id           TEXT,               -- 发言人 id；助手的消息、事件为空
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

-- 表结构版本 2 加入
CREATE TABLE model_calls (
  id                INTEGER PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  purpose           TEXT NOT NULL,     -- 'reply' | 'summary'
  summary_reason    TEXT,              -- 摘要：'idle' | 'compress'；回复为空
  reply_id          TEXT,              -- 回复 id：与写入历史的助手消息 id、日志里的 replyId 相同；摘要为空
  model             TEXT NOT NULL,     -- 模型 id
  started_at        TEXT NOT NULL,     -- 开始时间（ISO，UTC，与其他表一致）
  duration_ms       INTEGER NOT NULL,  -- 从开始到结束
  first_output_ms   INTEGER,           -- 从开始到第一段输出（文字、推理或工具调用）；没有输出时为空
  attempts          INTEGER NOT NULL,  -- HTTP 请求次数：各步的请求，含重试与拒收图片后的恢复
  outcome           TEXT NOT NULL,     -- 'completed' | 'empty' | 'aborted' | 'cancelled' | 'failed'
  finish_reason     TEXT,              -- 最后一步的 'stop'、'length' 等；没有正常结束时为空
  input_tokens      INTEGER,           -- token 四列都是各步之和
  cache_read_tokens INTEGER,           -- 服务端报了才有
  output_tokens     INTEGER,           -- 含推理
  reasoning_tokens  INTEGER,           -- 服务端报了才有
  error             TEXT,              -- 失败时的错误类型与状态码，如 'APICallError 429'；不含正文
  steps             INTEGER,           -- 表结构版本 3 加入：步数；之前的行为空
  tool_calls        INTEGER            -- 表结构版本 3 加入：工具调用次数；之前的行为空
);
CREATE INDEX model_calls_time         ON model_calls(started_at);
CREATE INDEX model_calls_conversation ON model_calls(conversation_id, started_at);

-- 表结构版本 3 加入
CREATE TABLE tool_calls (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  reply_id        TEXT NOT NULL,     -- 所在回复的 id，与 model_calls.reply_id 相同
  tool            TEXT NOT NULL,     -- 工具名（模型调了不存在的工具时，是模型给的名字）
  step            INTEGER NOT NULL,  -- 第几步，从 1 开始
  started_at      TEXT NOT NULL,     -- 开始时间（ISO，UTC）
  duration_ms     INTEGER NOT NULL,  -- 超时时算到超时为止
  outcome         TEXT NOT NULL,     -- 'completed' | 'failed' | 'timeout' | 'aborted'
  error           TEXT,              -- 失败时的错误类型，如 'InvalidToolInputError'；不含正文
  output_chars    INTEGER,           -- 结果转成文字后的长度（带图片时只算文字部分）；没有结果时为空
  tool_call_id    TEXT               -- 表结构版本 4 加入：模型给的调用 id，与助手消息里工具调用的 id 相同；之前的行为空
);
CREATE INDEX tool_calls_time ON tool_calls(started_at);
CREATE INDEX tool_calls_tool ON tool_calls(tool, started_at);

-- 表结构版本 5 加入
CREATE TABLE tasks (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT, -- 不重用；给模型看的是 't' 加它，如 t7
  conversation_id            TEXT NOT NULL REFERENCES conversations(id), -- 任务所在的会话，到点时在这里开口
  action                     TEXT NOT NULL,     -- 做什么：洛璃建任务时写的一句话
  schedule                   TEXT NOT NULL,     -- 什么时候到点，整条 JSON，见下文
  source_author_id           TEXT,              -- 谁让建的：发言人 id；平台不提供时为空
  source_author_name         TEXT NOT NULL,     -- 谁让建的：发言人当时的显示名
  source_message_id          TEXT NOT NULL,     -- 来源消息：让建任务的那条消息在 messages 里的 id
  source_platform_message_id TEXT,              -- 来源消息在平台上的 id；到点的回复引用它；没有时为空
  status                     TEXT NOT NULL,     -- 'active' | 'done' | 'cancelled'
  next_due_at                TEXT,              -- 下次到点（ISO，UTC）；进行中的任务才有
  last_due_at                TEXT,              -- 上次到点（ISO，UTC）；还没到过点时为空
  due_count                  INTEGER NOT NULL DEFAULT 0, -- 到点了几次
  created_at                 TEXT NOT NULL,     -- 建立时间（ISO，UTC）
  ended_at                   TEXT               -- 完成或取消的时间（ISO，UTC）；进行中为空
);
CREATE INDEX tasks_due          ON tasks(status, next_due_at); -- 要到点的、最近的到点
CREATE INDEX tasks_conversation ON tasks(conversation_id, status);
```

- 消息一条一行，整条 `UIMessage` 存在 `ui_message` 里（ADR-0001）。查询要用的几列是它的副本，写入时一起写，读取以 JSON 为准。消息结构以后加工具调用、图片，不用改表。
- 段是连续的序号区间，从本段的 `start_seq` 到下一段的 `start_seq` 之前。切段只插入一行，不改消息。滚动摘要存在下一段的 `prior_summary` 上，因为它是与下一段一起发给模型的。摘要写好之前不插入新段，中途崩溃只是下次重做。
- 回复开始生成时从 `next_seq` 预留序号，所以回复排在它看到的最后一条消息之后。回复失败或没有输出时序号空着，序号只用于排序。
- 图片存为 `data/files/<内容哈希>.<扩展名>`，消息里以 `luoli-file:` 开头的地址引用，发请求时换成图片数据。同一张图只存一份。不建文件表、成员表：名字随每条消息存快照。
- 模型调用一次一行：一次回复或一次摘要，期间的重试都合在这一行，成功、失败、中止都记。只追加，用来统计 token、缓存命中与失败率；不记金额，要算钱时按当时的单价现算。正常完成的回复的用量仍随助手消息存一份。常用查询在 `docs/queries/usage.sql`。
- 工具调用一次一行（ADR-0006），挂在所在回复下，用来统计每个工具的次数、失败与超时、耗时，以及结果长度（据此调整历史呈现）。模型传错参数、调了不存在的工具也记一行（结果 `failed`）。不存参数和结果：它们是对话内容，完整的在助手消息里。调用 id 不是对话内容，记下它，面板才能把耗时对上消息里的那次调用；以前的行没有，只能按第几步、工具名和先后对，同一时刻开始的同名调用可能对反。
- 事件（ADR-0010）按用户消息存在 messages 里：`author_id`、`platform_message_id` 为空，`ui_message` 的 metadata 带 `event`（类型与任务 id）。不另建表，它和消息一起排序号、进段、进摘要。要把事件除开时（如未读数只算人发的），按 `ui_message` 里的 `metadata.event` 判断，不另存一列：只在数已读位置之后的几条时用到，不值得升表结构。
- 任务一个一行（ADR-0010），核心只存取：不调度、不检查限额与平台、不计算下次到点，这些在洛璃服务里。取消、完成的任务不删。
  - `schedule` 整条存 JSON，和消息的做法一样：时间有几种形状（一次性的 `{ kind: 'once', at }`；周期的 `daily`、`weekdays`、`weekly`（加 `weekday`，1 是周一，7 是周日）、`monthly`（加 `day`，1–31），都带 `time`（`HH:mm`，按服务器所在时区），可以带截止时刻 `until`），SQL 不按其中任何一项筛选，只有服务算下次到点时读它。第八阶段的监视是另一种 `kind`（监视器加参数），时间这一列不用改；监视任务没有下次到点，`next_due_at` 为空，定时器取不到它。监视任务的「处理方式」（触发回复、只写历史、洛璃自己决定）到时放进这段 JSON，或者追加一列（一次只加列的迁移）。
  - 要查的、会改的拆成列：状态、下次到点、上次到点、到点次数、结束时间。定时器只按「进行中 + 下次到点」查（`tasks_due`），面板与工具按会话查。
  - 来源是建任务那次回复的触发者：发言人的 id 与名字（快照，和消息里的名字一样）、核心的消息 id 与平台消息 id。
  - 时间都是 ISO 的 UTC，写入时统一成 `toISOString` 的写法（含 `schedule` 里的 `at`、`until`）：到点按字符串比较，写法不一会比错。`schedule` 里的 `time` 是墙上时间，不换。
- 原文永久保留。开 WAL 模式，表结构版本记在 `PRAGMA user_version`。
- 每次发给模型的请求原文不在这个库里，存在单独的 `data/requests.db`（ADR-0008）。

## Considered Options

- 各前端自己存消息、核心只接收拼好的历史：每个前端都要重写分段与摘要。
- better-sqlite3：更成熟，但要加依赖并允许原生编译。
- Postgres：外部服务，多实例部署时才需要。
- 消息完全拆成表和列：消息结构一变就要改表。
- 图片存进数据库，或只记 Telegram 的文件 id：前者让数据库变大；后者每次请求都要重新下载，且下载地址含 bot token，不能交给模型服务。
- 消息只存用户 id、按最新名字显示：有人改名会改写整段历史，缓存失效。
- 用量只看日志：日志会被清理，也不便统计；只存在消息 metadata 里：摘要与失败的调用没有地方放。
- 模型调用按 HTTP 请求一行：失败的请求服务端多半不返回用量，每次请求的细节日志里已有。按步一行同理：一次回复算一次模型调用，费用一眼可见。
- 工具调用只记日志、不建表：日志会被清理，统计每个工具的成功率与耗时不方便。
- 任务的时间拆成列（种类、时刻、星期几、几号、截止）：多一种形状就要加列，监视任务的参数更放不下。
- 整个任务存 JSON、查询的列存副本：状态、下次到点这些常改的项，每次都要连同 JSON 一起改。

## Consequences

- 改名的人在模型看来可能是两个人，靠标签里不变的 `uid` 区分。
- `data/` 整个目录不进仓库，备份时一起拷走。
