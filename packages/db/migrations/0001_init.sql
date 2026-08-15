CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','chat')),
  tg_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','trusted','limited','blocked')),
  display_name TEXT, username TEXT, chat_type TEXT, note TEXT,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_principals_kind_tg ON principals(kind, tg_id);
CREATE INDEX IF NOT EXISTS ix_principals_role ON principals(role);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL, message_thread_id INTEGER, tg_message_id INTEGER NOT NULL,
  tg_update_id INTEGER, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  from_kind TEXT NOT NULL CHECK (from_kind IN ('user','bot','system')),
  from_user_id TEXT, from_name TEXT, from_username TEXT, reply_to_tg_message_id INTEGER,
  forward_origin_json TEXT, media_group_id TEXT, kind TEXT NOT NULL, text TEXT,
  entities_json TEXT, raw_json TEXT NOT NULL, tg_date INTEGER NOT NULL, received_at INTEGER NOT NULL,
  triggered INTEGER NOT NULL DEFAULT 0, trigger_reason TEXT, turn_id TEXT, claimed_at INTEGER,
  edited_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_tg ON messages(chat_id, tg_message_id, revision);
CREATE INDEX IF NOT EXISTS ix_messages_chat_date ON messages(chat_id, tg_date DESC);
CREATE INDEX IF NOT EXISTS ix_messages_chat_id_id ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS ix_messages_thread ON messages(chat_id, message_thread_id, id);
CREATE INDEX IF NOT EXISTS ix_messages_user ON messages(from_user_id, tg_date DESC);
CREATE INDEX IF NOT EXISTS ix_messages_turn ON messages(turn_id);
CREATE INDEX IF NOT EXISTS ix_messages_mediagroup ON messages(media_group_id) WHERE media_group_id IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram', detail='full');
CREATE TRIGGER IF NOT EXISTS tg_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS tg_messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS tg_messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id), chat_id TEXT NOT NULL,
  kind TEXT NOT NULL, tg_file_id TEXT NOT NULL, tg_file_unique_id TEXT NOT NULL, file_name TEXT,
  mime TEXT, size_bytes INTEGER, width INTEGER, height INTEGER, duration_sec INTEGER, local_path TEXT,
  download_state TEXT NOT NULL DEFAULT 'pending', download_error TEXT, extracted_text TEXT,
  extract_state TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachments_msg ON attachments(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attachments_unique ON attachments(chat_id, tg_file_unique_id);

CREATE TABLE IF NOT EXISTS contexts (
  key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, thread_id INTEGER,
  scope TEXT NOT NULL CHECK (scope IN ('chat','thread')), next_ordinal INTEGER NOT NULL DEFAULT 1,
  claim_watermark INTEGER NOT NULL DEFAULT 0, token_ratio REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_contexts_chat ON contexts(chat_id);
CREATE TABLE IF NOT EXISTS context_messages (
  key TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT NOT NULL, turn_id TEXT NOT NULL,
  agent_run_id TEXT, role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  origin TEXT NOT NULL CHECK (origin IN ('background','trigger','assistant','tool_call','tool_result','note')),
  prune_level INTEGER NOT NULL DEFAULT 0, prune_applied INTEGER NOT NULL DEFAULT 0,
  parts_json TEXT NOT NULL, text_preview TEXT, speaker TEXT, speaker_user_id TEXT,
  source_message_id INTEGER, source_ts INTEGER, tokens INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (key, ordinal)
);
CREATE INDEX IF NOT EXISTS ix_ctxmsg_turn ON context_messages(key, turn_id, ordinal);
CREATE INDEX IF NOT EXISTS ix_ctxmsg_src ON context_messages(source_message_id);
CREATE TABLE IF NOT EXISTS context_commits (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, seq INTEGER NOT NULL, parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('turn','prune','reset','manual','revert')), turn_id TEXT,
  base_commit_id TEXT, rebased INTEGER NOT NULL DEFAULT 0, rebase_over_json TEXT,
  window_start INTEGER NOT NULL, head_ordinal INTEGER NOT NULL, tokens_total INTEGER NOT NULL DEFAULT 0,
  msg_count INTEGER NOT NULL DEFAULT 0, meta_json TEXT, created_at INTEGER NOT NULL, created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_commits_key_seq ON context_commits(key, seq);
CREATE INDEX IF NOT EXISTS ix_commits_key_created ON context_commits(key, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_commits_turn ON context_commits(turn_id);
CREATE TABLE IF NOT EXISTS refs (
  key TEXT NOT NULL, name TEXT NOT NULL, commit_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, name)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id INTEGER,
  initiator_user_id TEXT NOT NULL, effective_role TEXT NOT NULL, trigger_message_id INTEGER,
  trigger_reason TEXT, base_commit_id TEXT, commit_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','running','committed','failed','cancelled')),
  rebased INTEGER NOT NULL DEFAULT 0, queued_at INTEGER, started_at INTEGER, finished_at INTEGER,
  steps INTEGER NOT NULL DEFAULT 0, model_calls INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  subagents INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, error TEXT, cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_turns_key_started ON turns(key, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_turns_state ON turns(state) WHERE state IN ('queued','running');
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, agent_run_id TEXT, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
  title TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('running','done','failed','cancelled')),
  progress_json TEXT, placeholder_tg_message_id INTEGER, result_summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tasks_chat_state ON tasks(chat_id, state, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, parent_run_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('main','sub')), agent_name TEXT NOT NULL, model_alias TEXT NOT NULL,
  provider_id TEXT, model_id TEXT, effective_role TEXT NOT NULL, task_input TEXT,
  state TEXT NOT NULL CHECK (state IN ('running','done','failed','cancelled')), steps INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, result_summary TEXT, result_full_ref TEXT, error TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_agentruns_turn ON agent_runs(turn_id, started_at);
CREATE INDEX IF NOT EXISTS ix_agentruns_parent ON agent_runs(parent_run_id);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, from_run_id TEXT NOT NULL, to_run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ask','answer','progress','result','error')), payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent','answered','timeout','dropped')),
  created_at INTEGER NOT NULL, answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_agentmsg_turn ON agent_messages(turn_id, created_at);
CREATE INDEX IF NOT EXISTS ix_agentmsg_pending ON agent_messages(to_run_id, state) WHERE state='sent';

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, base_url TEXT, api_key_enc TEXT,
  api_key_hint TEXT, headers_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, health_state TEXT,
  health_checked_at INTEGER, health_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), model_id TEXT NOT NULL,
  display_name TEXT, context_window INTEGER NOT NULL, max_output INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL, price_in REAL, price_out REAL, price_cache_read REAL,
  price_cache_write REAL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_models_provider_model ON models(provider_id, model_id);
CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY, model_ids_json TEXT NOT NULL, settings_json TEXT, description TEXT, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL,
  trace_id TEXT, span_id TEXT, parent_span_id TEXT, chat_id TEXT, user_id TEXT, key TEXT, agent_run_id TEXT,
  summary TEXT NOT NULL, data_json TEXT, file_ref TEXT, duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS ix_log_ts ON log_events(ts DESC);
CREATE INDEX IF NOT EXISTS ix_log_trace ON log_events(trace_id, ts);
CREATE INDEX IF NOT EXISTS ix_log_kind_ts ON log_events(kind, ts DESC);
CREATE INDEX IF NOT EXISTS ix_log_chat_ts ON log_events(chat_id, ts DESC);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, turn_id TEXT, agent_run_id TEXT, span_id TEXT,
  chat_id TEXT, user_id TEXT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, model_alias TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER,
  finish_reason TEXT, ok INTEGER NOT NULL DEFAULT 1, error_kind TEXT
);
CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage_ledger(ts DESC);
CREATE INDEX IF NOT EXISTS ix_usage_chat_ts ON usage_ledger(chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_usage_user_ts ON usage_ledger(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_usage_turn ON usage_ledger(turn_id);
CREATE TABLE IF NOT EXISTS quota_counters (
  scope TEXT NOT NULL CHECK (scope IN ('global','chat','user')), subject TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('day','month')), bucket TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0, reserved_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (scope, subject, window, bucket)
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY, path TEXT NOT NULL, description TEXT NOT NULL, min_role TEXT NOT NULL DEFAULT 'trusted',
  allowed_tools_json TEXT, model_alias TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'local', content_hash TEXT NOT NULL, frontmatter_json TEXT NOT NULL,
  load_error TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  name TEXT PRIMARY KEY, path TEXT NOT NULL, version TEXT, min_role TEXT NOT NULL DEFAULT 'trusted',
  enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT, provides_json TEXT, load_error TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY, transport TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
  command TEXT, args_json TEXT, env_json TEXT, url TEXT, headers_json TEXT, min_role TEXT NOT NULL DEFAULT 'trusted',
  enabled INTEGER NOT NULL DEFAULT 0, tool_allow_json TEXT, tool_deny_json TEXT, timeout_ms INTEGER NOT NULL DEFAULT 30000,
  state TEXT, last_error TEXT, tools_json TEXT, connected_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_docs (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('assist','character','pubmemory','primemory')),
  subject TEXT, path TEXT NOT NULL, bytes INTEGER NOT NULL, tokens INTEGER NOT NULL, content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_scope_subject ON memory_docs(scope, IFNULL(subject,''));
CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES memory_docs(id), ts INTEGER NOT NULL, actor TEXT NOT NULL,
  turn_id TEXT, chat_id TEXT, user_id TEXT, op TEXT NOT NULL, diff TEXT NOT NULL, bytes_after INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_memrev_doc_ts ON memory_revisions(doc_id, ts DESC);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, agent_run_id TEXT, span_id TEXT, chat_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL, risk TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired')), tg_message_id INTEGER,
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, decision_channel TEXT
);
CREATE INDEX IF NOT EXISTS ix_approvals_state ON approvals(state, requested_at);
CREATE TABLE IF NOT EXISTS config_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS config_revisions (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, key TEXT NOT NULL, old_json TEXT, new_json TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ip TEXT, ua TEXT, csrf TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
