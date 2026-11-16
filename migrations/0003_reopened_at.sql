-- When an abandoned session was resumed by the customer; Lark is told the session is Open again
ALTER TABLE sessions ADD COLUMN reopened_at TEXT;
