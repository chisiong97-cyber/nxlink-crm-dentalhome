-- Abandon on customer inactivity (not session age) and keep watching abandoned sessions for a late verdict
ALTER TABLE sessions ADD COLUMN last_customer_msg_at TEXT;
ALTER TABLE sessions ADD COLUMN transcript_checked_at TEXT;

UPDATE sessions SET last_customer_msg_at = first_customer_msg_at WHERE last_customer_msg_at IS NULL;

CREATE INDEX idx_sessions_status_last_msg ON sessions (session_status, last_customer_msg_at);
