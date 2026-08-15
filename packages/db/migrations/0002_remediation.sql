CREATE INDEX IF NOT EXISTS ix_agentmsg_answer ON agent_messages(turn_id,kind,created_at);
