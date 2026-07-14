ALTER TABLE discord_link_requests ADD COLUMN verification_code_hash TEXT;

CREATE UNIQUE INDEX idx_discord_link_requests_linked_user
ON discord_link_requests(linked_user_id)
WHERE linked_user_id IS NOT NULL;

CREATE TRIGGER prevent_last_active_admin_update
BEFORE UPDATE OF role, is_active ON users
WHEN OLD.role = 'admin'
  AND OLD.is_active = 1
  AND (NEW.role != 'admin' OR NEW.is_active != 1)
  AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;

CREATE TRIGGER prevent_last_active_admin_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin'
  AND OLD.is_active = 1
  AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;
