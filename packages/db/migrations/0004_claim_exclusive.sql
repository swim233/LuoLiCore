ALTER TABLE messages ADD COLUMN claimed_by_turn TEXT;
CREATE INDEX IF NOT EXISTS ix_messages_unclaimed ON messages(chat_id, message_thread_id, id) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_messages_claim_owner ON messages(claimed_by_turn) WHERE claimed_by_turn IS NOT NULL;
