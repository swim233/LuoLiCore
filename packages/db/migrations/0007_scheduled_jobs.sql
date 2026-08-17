-- 定时任务（docs/14 §2 Q4 由需求方拍板：做，且定时轮次照常进上下文）。
--
-- 为什么是一张表而不是 app_kv：app_kv 没有前缀扫描入口（装载时要的是「全部活跃任务」）、
-- 没有二级索引（按会话取、按状态取都得全量反序列化），而单键存整个数组会在并发轮次下丢更新
-- —— 两个人同时让 bot 加任务，后写的那份覆盖前一份。config_kv 更不行：里面的每一行都会被
-- loadConfig 当成配置覆盖层解析，非配置键会让下一次启动直接失败（docs/19 · R-CFG-01）。
--
-- cron 与 run_at 二者其一：cron 是周期任务，run_at 是一次性任务（epoch ms，触发后置 done）。
-- timezone 落在行上而不是读全局配置：任务是按「创建时那个时区的每天 8 点」约定的，
-- 事后改 general.timezone 不该把已有任务的含义一起改掉。
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  thread_id   INTEGER,
  created_by  TEXT NOT NULL,
  name        TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('agent','notify')),
  cron        TEXT,
  run_at      INTEGER,
  timezone    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','done','cancelled')),
  run_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_state  TEXT,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((cron IS NULL) + (run_at IS NULL) = 1)
);
CREATE INDEX IF NOT EXISTS ix_sched_key ON scheduled_jobs(key, state);
CREATE INDEX IF NOT EXISTS ix_sched_state ON scheduled_jobs(state) WHERE state = 'active';
-- 同一会话内活跃任务不许重名：模型取消任务时给的是名字（它记不住 ULID），重名会让
-- 「取消喝水提醒」变成一次赌博。结束的行不占用名字，同名任务可以重建。
CREATE UNIQUE INDEX IF NOT EXISTS ux_sched_name ON scheduled_jobs(key, name) WHERE state = 'active';
