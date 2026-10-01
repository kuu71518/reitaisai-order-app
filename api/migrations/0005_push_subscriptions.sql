-- Notification endpoints are private capability URLs. Never export them in logs.
CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY CHECK (length(endpoint) BETWEEN 20 AND 2048),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
    application_server_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX idx_push_subscriptions_session ON push_subscriptions(session_id);
