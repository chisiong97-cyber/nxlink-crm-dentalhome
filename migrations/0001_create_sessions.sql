-- One row per NxLink AI Conversation session. Transcripts are not stored;
-- the dev console fetches them live from NxLink when needed.
CREATE TABLE sessions (
    session_id            TEXT PRIMARY KEY,            -- NxLink conversation id, e.g. '3563115'
    flow_name             TEXT,                        -- NxLink auto_flow_name
    channel               TEXT,                        -- Website | WA | FB | IG
    nxlink_status         INTEGER,                     -- last seen NxLink status: 1 open, 2 closed
    session_status        TEXT NOT NULL DEFAULT 'open', -- open | ended | abandoned
    lead_status           TEXT NOT NULL DEFAULT 'Cold', -- Cold | Warm | Hot
    started_at            TEXT,                        -- NxLink created_at (ISO 8601, UTC)
    first_customer_msg_at TEXT,                        -- first customer reply; triggers Lark webhook 1
    first_message         TEXT,
    ended_at              TEXT,

    -- NxLink verdict, filled in when the session ends / is tagged
    customer_name         TEXT,
    phone_number          TEXT,
    preferred_branch      TEXT,
    preferred_date        TEXT,
    preferred_treatment   TEXT,
    summary               TEXT,
    sentiment             TEXT,
    next_steps            TEXT,
    tags                  TEXT,                        -- JSON array of NxLink tag names

    -- Lark delivery tracking
    lark_created_at       TEXT,                        -- webhook 1 (Lead Created) succeeded
    lark_updated_at       TEXT,                        -- webhook 2 (Lead Updated) succeeded
    lark_attempts         INTEGER NOT NULL DEFAULT 0,
    lark_error            TEXT,

    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Cron work queues: sessions still open, and ended sessions not yet delivered to Lark
CREATE INDEX idx_sessions_status_delivery ON sessions (session_status, lark_updated_at);
-- Dev console listing (newest first) and retention cleanup
CREATE INDEX idx_sessions_started_at ON sessions (started_at);

-- Small key/value state for the sync itself (e.g. last session seen, for catch-up paging).
-- Kept in D1 rather than KV because it changes every run and KV free allows 1k writes/day.
CREATE TABLE sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
