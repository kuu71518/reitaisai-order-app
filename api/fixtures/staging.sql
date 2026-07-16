-- Fictional staging data only. Never add real participant data to this file.
INSERT INTO users (name, group_id, role, is_manual_added)
SELECT '運営テスト', '管理', 'admin', 0
WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

INSERT INTO users (name, group_id, role, is_manual_added)
SELECT '担当テスト', 'Aグループ', 'manager', 0
WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = '担当テスト' AND group_id = 'Aグループ');

INSERT INTO users (name, group_id, role, is_manual_added)
SELECT '参加テスト', 'Aグループ', 'member', 0
WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = '参加テスト' AND group_id = 'Aグループ');

INSERT OR IGNORE INTO menu_items (category, name, size, price) VALUES
('テスト', 'テスト用ソフトドリンク', '普通', 300),
('テスト', 'テスト用フード', '普通', 500),
('宴会コース', 'テスト用事前コース', '1名分', 5000);
