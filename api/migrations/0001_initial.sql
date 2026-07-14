-- Canonical schema for a new local or staging D1 database.
-- Do not apply this baseline directly to the existing production database.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    group_id TEXT NOT NULL CHECK (length(group_id) BETWEEN 1 AND 80),
    role TEXT NOT NULL CHECK (role IN ('member', 'manager', 'admin')),
    discord_user_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_manual_added INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_added IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_users_discord_user_id
    ON users(discord_user_id)
    WHERE discord_user_id IS NOT NULL;
CREATE INDEX idx_users_group_id ON users(group_id);
CREATE INDEX idx_users_role_active ON users(role, is_active);

CREATE TABLE menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    size TEXT NOT NULL CHECK (length(size) BETWEEN 1 AND 60),
    price INTEGER NOT NULL CHECK (price BETWEEN 0 AND 100000),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (category, name, size)
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ordered', 'cancelled')),
    manager_memo TEXT CHECK (manager_memo IS NULL OR length(manager_memo) <= 200),
    menu_name_snapshot TEXT NOT NULL,
    menu_size_snapshot TEXT NOT NULL,
    unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot BETWEEN 0 AND 100000),
    client_request_id TEXT NOT NULL CHECK (length(client_request_id) BETWEEN 16 AND 80),
    ordered_at INTEGER,
    cancelled_at INTEGER,
    cancelled_by INTEGER,
    cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 200),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE RESTRICT,
    FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (user_id, client_request_id)
);

CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_orders_menu_item_id ON orders(menu_item_id);

CREATE TABLE auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(idle_expires_at, absolute_expires_at);

CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE INDEX idx_oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE discord_link_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT NOT NULL UNIQUE,
    username_snapshot TEXT NOT NULL CHECK (length(username_snapshot) BETWEEN 1 AND 80),
    display_name_snapshot TEXT NOT NULL CHECK (length(display_name_snapshot) BETWEEN 1 AND 80),
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    linked_user_id INTEGER,
    approved_by INTEGER,
    decided_at INTEGER,
    FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_discord_link_requests_status
    ON discord_link_requests(status, expires_at, requested_at);

CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    action_type TEXT NOT NULL CHECK (length(action_type) BETWEEN 1 AND 80),
    target_type TEXT CHECK (target_type IS NULL OR length(target_type) <= 80),
    target_id INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_user_id, created_at DESC);
