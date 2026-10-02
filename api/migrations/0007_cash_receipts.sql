-- Records only the operator's received/not-received check and the order total
-- they saw. This is not an actual cash amount or a table-charge calculation.
CREATE TABLE cash_receipts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    received INTEGER NOT NULL CHECK (received IN (0, 1)),
    recorded_order_total INTEGER CHECK (recorded_order_total >= 0),
    received_at INTEGER,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at INTEGER NOT NULL,
    last_actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_request_token TEXT NOT NULL CHECK (length(last_request_token) = 43),
    CHECK (
        (received = 1 AND recorded_order_total IS NOT NULL AND received_at IS NOT NULL)
        OR (received = 0 AND recorded_order_total IS NULL AND received_at IS NULL)
    )
);

CREATE INDEX idx_cash_receipts_actor ON cash_receipts(last_actor_user_id);
