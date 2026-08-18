-- 模型自撰写的工具（docs/07 §6）。一条记录 = 一段参数化的 bash / python 脚本，注册进
-- ToolRegistry 时 source='custom'。
--
-- 为什么是一张表而不是 app_kv：装载时要的是「全部已启用的」，app_kv 没有前缀扫描也没有二级
-- 索引；而单键存整个数组会在并发轮次下丢更新 —— 两个会话同时定义工具，后写的覆盖前一份。
-- config_kv 更不行：里面每一行都会被 loadConfig 当成配置覆盖层解析（docs/19 · R-CFG-01）。
--
-- enabled 默认 0，与 plugins 同一个理由：模型能创建，但不能让自己创建的东西生效。改了 body 或
-- params 也要重新置 0（在仓储的 upsert 里做），否则「先定义无害的、拿到启用、再改成恶意的」
-- 这条路直接走通。
--
-- definition_hash 覆盖参与执行语义的那几列。注册发生在轮次开始、执行发生在若干步之后，中间
-- 这段时间里定义可能被改掉（WebUI 改的，或者模型自己改的）—— 执行前拿它跟库里比一次，
-- 不一致就拒掉，否则模型看到的是旧 schema、跑的是新正文。
--
-- scope='chat' 时 owner_chat_id 必填：一个在 owner 私聊里写下的脚本不该自动变成任意群里
-- trusted 成员的可调用项（registerExternal 的默认 scope 是 global，而 scope 至今不参与任何判定）。
CREATE TABLE IF NOT EXISTS custom_tools (
  name            TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  runtime         TEXT NOT NULL CHECK (runtime IN ('bash','python')),
  body            TEXT NOT NULL,
  min_role        TEXT NOT NULL DEFAULT 'owner' CHECK (min_role IN ('trusted','owner')),
  scope           TEXT NOT NULL DEFAULT 'chat' CHECK (scope IN ('chat','global')),
  owner_chat_id   TEXT,
  timeout_ms      INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 0,
  definition_hash TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_turn    TEXT,
  reviewed_at     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((scope = 'chat') = (owner_chat_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_custom_tools_enabled ON custom_tools(enabled) WHERE enabled = 1;
