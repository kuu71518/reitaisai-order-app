-- Copy this file to production.local.sql before entering real names.
-- production.local.sql is Git-ignored. Never put Discord Client Secrets here.

-- Exactly one unlinked active admin is required for the first bootstrap login.
INSERT INTO users (name, group_id, role)
VALUES ('管理者名に置換', '管理', 'admin');

-- Add participants and managers without Discord IDs. The first login links them
-- through the in-person verification-code flow.
-- INSERT INTO users (name, group_id, role) VALUES ('参加者名に置換', 'Aグループ', 'member');
-- INSERT INTO users (name, group_id, role) VALUES ('担当者名に置換', 'Aグループ', 'manager');

-- Add the final menu. Re-running an identical row is rejected by the UNIQUE rule.
-- INSERT INTO menu_items (category, name, size, price) VALUES ('料理', 'メニュー名に置換', '通常', 1000);
