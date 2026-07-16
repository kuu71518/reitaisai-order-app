-- Replace plaintext Discord linking with a keyed, non-reversible allowlist value.
-- This migration intentionally invalidates every existing login session.
PRAGMA defer_foreign_keys = true;

DELETE FROM auth_sessions;
DELETE FROM oauth_states;

DROP INDEX idx_users_discord_user_id;
ALTER TABLE users DROP COLUMN discord_user_id;
DROP TABLE discord_link_requests;

ALTER TABLE users ADD COLUMN discord_id_hmac TEXT
    CHECK (
        discord_id_hmac IS NULL
        OR (length(discord_id_hmac) = 46 AND discord_id_hmac LIKE 'v1.%')
    );

CREATE UNIQUE INDEX idx_users_discord_id_hmac
    ON users(discord_id_hmac)
    WHERE discord_id_hmac IS NOT NULL;

-- A fresh database has no users yet. An existing database must already have
-- exactly one active administrator; stop instead of guessing which account wins.
CREATE TABLE migration_0003_admin_guard (
    user_count INTEGER NOT NULL,
    admin_count INTEGER NOT NULL,
    active_admin_count INTEGER NOT NULL,
    CHECK (
        (user_count = 0 AND admin_count = 0 AND active_admin_count = 0)
        OR (user_count > 0 AND admin_count = 1 AND active_admin_count = 1)
    )
);

INSERT INTO migration_0003_admin_guard (user_count, admin_count, active_admin_count)
SELECT
    COUNT(*),
    COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN role = 'admin' AND is_active = 1 THEN 1 ELSE 0 END), 0)
FROM users;

DROP TABLE migration_0003_admin_guard;

-- Only the bootstrap-created administrator may ever have the admin role.
CREATE UNIQUE INDEX idx_users_single_admin
    ON users(role)
    WHERE role = 'admin';

CREATE TRIGGER require_active_admin_insert
BEFORE INSERT ON users
WHEN NEW.role = 'admin' AND NEW.is_active != 1
BEGIN
    SELECT RAISE(ABORT, 'admin_must_be_active');
END;

CREATE TRIGGER require_active_admin_update
BEFORE UPDATE OF role, is_active ON users
WHEN NEW.role = 'admin' AND NEW.is_active != 1
BEGIN
    SELECT RAISE(ABORT, 'admin_must_be_active');
END;

ALTER TABLE menu_items ADD COLUMN is_admin_only INTEGER NOT NULL DEFAULT 0
    CHECK (is_admin_only IN (0, 1));

UPDATE menu_items
SET is_admin_only = 1, updated_at = unixepoch()
WHERE category = '宴会コース';

-- Keep direct SQL/fixture inserts from accidentally exposing banquet courses.
CREATE TRIGGER force_banquet_menu_admin_only_after_insert
AFTER INSERT ON menu_items
WHEN NEW.category = '宴会コース' AND NEW.is_admin_only != 1
BEGIN
    UPDATE menu_items
    SET is_admin_only = 1, updated_at = unixepoch()
    WHERE id = NEW.id;
END;

CREATE TRIGGER force_banquet_menu_admin_only_after_category_update
AFTER UPDATE OF category ON menu_items
WHEN NEW.category = '宴会コース' AND NEW.is_admin_only != 1
BEGIN
    UPDATE menu_items
    SET is_admin_only = 1, updated_at = unixepoch()
    WHERE id = NEW.id;
END;

ALTER TABLE orders ADD COLUMN order_source TEXT NOT NULL DEFAULT 'self'
    CHECK (order_source IN ('self', 'admin'));

ALTER TABLE orders ADD COLUMN created_by_user_id INTEGER
    REFERENCES users(id) ON DELETE SET NULL;

UPDATE orders
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;

CREATE INDEX idx_orders_created_by_user_id ON orders(created_by_user_id);

PRAGMA foreign_key_check;
