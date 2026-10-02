-- Widen the role constraint without dropping users: a table replacement would
-- invoke ON DELETE actions on sessions, push subscriptions, and audit records.
-- Wrangler executes this migration transactionally. All protection triggers
-- and role indexes are restored before that transaction can commit.
DROP TRIGGER prevent_last_active_admin_update;
DROP TRIGGER prevent_last_active_admin_delete;
DROP TRIGGER require_active_admin_insert;
DROP TRIGGER require_active_admin_update;
DROP INDEX idx_users_role_active;
DROP INDEX idx_users_single_admin;

ALTER TABLE users ADD COLUMN role_with_chief TEXT NOT NULL DEFAULT 'member'
    CHECK (role_with_chief IN ('member', 'manager', 'chief', 'admin'));
UPDATE users SET role_with_chief = role;
ALTER TABLE users DROP COLUMN role;
ALTER TABLE users RENAME COLUMN role_with_chief TO role;

CREATE INDEX idx_users_role_active ON users(role, is_active);
CREATE UNIQUE INDEX idx_users_single_admin ON users(role) WHERE role = 'admin';

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

PRAGMA foreign_key_check;
