import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFixture } from './test-support/database.js';

test('chief migration preserves existing users, orders, sessions, push subscriptions, receipts and audit links', async (t) => {
  const f = await createFixture(t, { lastMigration: '0005_push_subscriptions.sql' });
  const order = f.addOrder({ status: 'cancelled' });
  f.sqlite.prepare('UPDATE orders SET cancelled_by = 1, cancelled_at = ?, cancel_reason = ? WHERE id = ?')
    .run(f.now, 'テスト訂正', order);
  f.sqlite.prepare("INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id) VALUES (1, 'TEST', 'order', ?)").run(order);
  f.sqlite.prepare('INSERT INTO cleared_order_requests VALUES (3, ?, ?)').run('already_cleared_test_request', f.now);
  f.sqlite.prepare('INSERT INTO push_subscriptions VALUES (?, 2, 2, ?, ?, ?, 0)')
    .run('https://fcm.googleapis.com/test-only-capability', 'test-only-key', f.now, f.now);
  const tables = ['users', 'orders', 'auth_sessions', 'push_subscriptions', 'cleared_order_requests', 'audit_logs', 'menu_items', 'oauth_states'];
  const before = Object.fromEntries(tables.map((table) => [table, f.rows(table)]));
  const migration = readFileSync(new URL('../migrations/0006_chief_role.sql', import.meta.url), 'utf8');
  f.sqlite.exec('BEGIN');
  try { f.sqlite.exec(migration); f.sqlite.exec('COMMIT'); } catch (error) { f.sqlite.exec('ROLLBACK'); throw error; }
  for (const table of tables) assert.deepEqual(f.rows(table), before[table], table);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await f.request(1, '/api/auth/me')).status, 200);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  assert.equal((await f.request(4, '/api/auth/me')).status, 200);
  assert.throws(() => f.sqlite.exec("UPDATE users SET role = 'owner' WHERE id = 4"), /CHECK/);
  assert.throws(() => f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 1"), /last_active_admin/);
  assert.throws(() => f.sqlite.exec('DELETE FROM users WHERE id = 1'), /last_active_admin/);
  assert.throws(() => f.sqlite.exec('UPDATE users SET is_active = 0 WHERE id = 1'), /admin_must_be_active|last_active_admin/);
  assert.throws(() => f.sqlite.exec("UPDATE users SET role = 'admin' WHERE id = 3"), /UNIQUE/);
});

test('chief reads all accounting rows but cannot access manager, push, or admin operations', async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const order = f.addOrder();
  f.addOrder({ userId: 4, quantity: 2 });
  const summary = await (await f.request(4, '/api/orders/summary')).json();
  assert.equal(summary.success, true);
  assert.equal(summary.data.length, 5);
  assert.equal(summary.data.reduce((sum, row) => sum + row.total_price, 0), 900);
  assert.equal(summary.data.find((row) => row.user_id === 1).total_price, 0);
  for (const path of ['/api/manager/orders', '/api/admin/users', '/api/admin/stats', '/api/admin/logs', '/api/admin/menu', '/api/admin/order-history/preview', '/api/notifications/config']) {
    assert.equal((await f.request(4, path)).status, 403, path);
  }
  for (const [path, method, body] of [
    [`/api/manager/orders/${order}/quantity`, 'PATCH', { quantity: 2 }],
    ['/api/manager/orders/status', 'PATCH', { order_ids: [order], status: 'ordered' }],
    ['/api/admin/users/3', 'PATCH', { role: 'chief', group_id: 'テスト席A' }],
    ['/api/admin/order-history/clear', 'POST', {}],
    ['/api/notifications/subscriptions', 'POST', {}],
  ]) assert.equal((await f.request(4, path, { method, body })).status, 403, path);
  assert.equal((await f.request(4, '/api/orders', { method: 'POST', body: { menu_item_id: 1, quantity: 1, request_id: 'chief_self_order_request_01' } })).status, 200);
});

test('summary retains outstanding amounts for inactive users and excludes cancelled orders without adding table charges', async (t) => {
  const f = await createFixture(t);
  f.addOrder({ userId: 3, quantity: 2 });
  f.addOrder({ userId: 3, quantity: 10, status: 'cancelled' });
  f.sqlite.exec('UPDATE users SET is_active = 0 WHERE id IN (3, 4)');
  const summary = (await (await f.request(1, '/api/orders/summary')).json()).data;
  assert.equal(summary.length, 4);
  assert.equal(summary.find((row) => row.user_id === 3).total_price, 600);
  assert.equal(summary.some((row) => row.user_id === 4), false);
  assert.equal(summary.reduce((sum, row) => sum + row.total_price, 0), 600);
});

test('admin can assign and revoke chief immediately while the existing login session remains valid', async (t) => {
  const f = await createFixture(t);
  const body = { role: 'chief', group_id: 'テスト席B' };
  assert.equal((await f.request(3, '/api/admin/users/4', { method: 'PATCH', body })).status, 403);
  assert.equal((await f.request(1, '/api/admin/users/4', { method: 'PATCH', body, csrf: false })).status, 403);
  assert.equal((await f.request(1, '/api/admin/users/4', { method: 'PATCH', body })).status, 200);
  assert.equal((await (await f.request(4, '/api/auth/me')).json()).user.role, 'chief');
  assert.equal((await f.request(4, '/api/orders/summary')).status, 200);
  assert.equal((await f.request(1, '/api/admin/users/4', { method: 'PATCH', body: { ...body, role: 'member' } })).status, 200);
  assert.equal((await f.request(4, '/api/orders/summary')).status, 403);
});

test('chief can be created through bulk registration without allowing another admin', async (t) => {
  const f = await createFixture(t);
  f.env.DISCORD_ID_HMAC_KEY = 'test-only-hmac-key-at-least-thirty-two-characters';
  const user = { name: 'テスト主任', group_id: 'テスト席A', role: 'chief', discord_user_id: '123456789012345678' };
  assert.equal((await f.request(1, '/api/admin/users/bulk', { method: 'POST', body: { users: [user] } })).status, 200);
  assert.equal(f.rows('users').at(-1).role, 'chief');
  const metadata = JSON.parse(f.rows('audit_logs').at(-1).metadata_json);
  assert.equal(metadata.role_counts.chief, 1);
  assert.equal((await f.request(1, '/api/admin/users/bulk', { method: 'POST', body: { users: [{ ...user, role: 'admin' }] } })).status, 422);
});
