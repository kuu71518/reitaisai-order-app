-- usersテーブル
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_id TEXT NOT NULL,
    role TEXT NOT NULL,
    passcode TEXT NOT NULL,
    created_at INTEGER DEFAULT (cast(strftime('%s','now') as int))
);

-- menu_itemsテーブル
CREATE TABLE menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    size TEXT NOT NULL,
    price INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- ordersテーブル
CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    manager_memo TEXT,
    ordered_at INTEGER,
    created_at INTEGER DEFAULT (cast(strftime('%s','now') as int)),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_users_group_id ON users(group_id);