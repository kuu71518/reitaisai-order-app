-- Copy this file to production.local.sql before entering real names.
-- production.local.sql is Git-ignored. Never put Discord Client Secrets here.

-- Exactly one active admin is required for the temporary bootstrap login.
INSERT INTO users (name, group_id, role)
VALUES ('管理者名に置換', '管理', 'admin');

-- Add participants and managers without Discord IDs. After the administrator's
-- first login, register each verified Discord User ID from the admin screen.
-- Never put a raw Discord User ID or its HMAC value in this SQL file.
-- INSERT INTO users (name, group_id, role) VALUES ('参加者名に置換', 'Aグループ', 'member');
-- INSERT INTO users (name, group_id, role) VALUES ('担当者名に置換', 'Aグループ', 'manager');

-- Add the final menu. Re-running an identical row is rejected by the UNIQUE rule.
-- INSERT INTO menu_items (category, name, size, price) VALUES ('料理', 'メニュー名に置換', '通常', 1000);
-- Banquet courses must always set is_admin_only to 1.
-- INSERT INTO menu_items (category, name, size, price, is_admin_only) VALUES ('宴会コース', 'コース名に置換', '1名分', 5000, 1);
