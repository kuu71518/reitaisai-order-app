-- Retain only the request identifiers needed to reject a delayed retry after
-- an administrator clears order history. No menu, quantity, price, or name is kept.
CREATE TABLE cleared_order_requests (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL CHECK (length(client_request_id) BETWEEN 16 AND 80),
    cleared_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, client_request_id)
);

-- This also protects against a retry arriving concurrently with history clearing.
CREATE TRIGGER prevent_cleared_order_replay
BEFORE INSERT ON orders
WHEN EXISTS (
    SELECT 1 FROM cleared_order_requests
    WHERE user_id = NEW.user_id AND client_request_id = NEW.client_request_id
)
BEGIN
    SELECT RAISE(IGNORE);
END;
