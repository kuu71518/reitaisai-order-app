import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './test-support/database.js';
import { ORDER_HISTORY_CONFIRMATION } from './order-history.ts';

async function confirmation(fixture) {
  const response = await fixture.request(1, '/api/admin/order-history/preview');
  assert.equal(response.status, 200);
  return { backup_confirmed: true, confirmation: ORDER_HISTORY_CONFIRMATION, snapshot_token: (await response.json()).data.snapshot_token };
}
const clear = (fixture, body, userId = 1, options = {}) => fixture.request(userId, '/api/admin/order-history/clear', { method: 'POST', body, ...options });

test('history clear removes every order state and advances notification revision while preserving participants, roles, menu, sessions, push registrations and audits', async (t) => {
  const f = await createFixture(t);
  f.addOrder(); f.addOrder({ userId: 4, status: 'ordered' }); f.addOrder({ status: 'cancelled' });
  f.sqlite.prepare("INSERT INTO audit_logs (actor_user_id, action_type) VALUES (3, 'ORDER_CREATE')").run();
  f.sqlite.prepare('INSERT INTO push_subscriptions VALUES (?, 1, 1, ?, ?, ?, 0)').run('https://fcm.googleapis.com/fcm/send/test-admin', 'test-key', f.now, f.now);
  const tables = ['users', 'menu_items', 'auth_sessions', 'oauth_states', 'push_subscriptions'];
  const before = Object.fromEntries(tables.map((table) => [table, f.rows(table)]));
  const audits = f.rows('audit_logs');
  const response = await clear(f, await confirmation(f));
  assert.equal(response.status, 200);
  const cleared = (await response.json()).data;
  assert.equal(cleared.deleted_order_count, 3);
  assert.equal(cleared.notification_history_revision, f.rows('audit_logs').at(-1).id);
  assert.deepEqual(f.rows('orders'), []);
  for (const table of tables) assert.deepEqual(f.rows(table), before[table], table);
  assert.deepEqual(f.rows('audit_logs').slice(0, -1), audits);
  assert.equal(f.rows('audit_logs').at(-1).action_type, 'ORDER_HISTORY_CLEAR');
  assert.deepEqual(JSON.parse(f.rows('audit_logs').at(-1).metadata_json), { deleted_order_count: 3, pending_count: 1, ordered_count: 1, cancelled_count: 1, notification_history_cleared: true });
  assert.equal(f.rows('cleared_order_requests').length, 3);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('history preview returns counts and a digest, not order details or request identifiers', async (t) => {
  const f = await createFixture(t);
  f.addOrder({ requestId: 'private_request_marker_123456' });
  f.addOrder({ status: 'ordered' });
  const response = await f.request(1, '/api/admin/order-history/preview');
  const body = await response.json();
  assert.equal(body.data.order_count, 2);
  assert.equal(body.data.pending_count, 1);
  assert.equal(body.data.ordered_count, 1);
  assert.equal(body.data.preserved_user_count, 5);
  assert.match(body.data.snapshot_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(body).includes('private_request_marker'), false);
  assert.equal(JSON.stringify(body).includes('テスト料理'), false);
});

for (const userId of [2, 3]) test(`user ${userId} cannot preview or clear order history`, async (t) => {
  const f = await createFixture(t); f.addOrder();
  assert.equal((await f.request(userId, '/api/admin/order-history/preview')).status, 403);
  assert.equal((await clear(f, await confirmation(f), userId)).status, 403);
  assert.equal(f.rows('orders').length, 1);
});

test('history clear requires CSRF, backup confirmation, exact phrase, preview, and a recent admin login', async (t) => {
  const f = await createFixture(t); f.addOrder();
  const body = await confirmation(f);
  assert.equal((await clear(f, body, 1, { csrf: false })).status, 403);
  assert.equal((await clear(f, body, 1, { cookie: false })).status, 401);
  for (const patch of [{ backup_confirmed: false }, { confirmation: '開催データをリセット' }, { snapshot_token: null }]) {
    assert.equal((await clear(f, { ...body, ...patch })).status, 422);
  }
  f.sqlite.prepare('UPDATE auth_sessions SET created_at = ? WHERE id = 1').run(f.now - 301);
  assert.equal((await clear(f, body)).status, 428);
  assert.equal(f.rows('orders').length, 1);
  assert.equal(f.rows('cleared_order_requests').length, 0);
});

for (const race of ['insert', 'quantity', 'status']) test(`history clear rejects ${race} after preview, even with unchanged timestamps`, async (t) => {
  const f = await createFixture(t); const id = f.addOrder();
  const body = await confirmation(f);
  if (race === 'insert') f.addOrder();
  if (race === 'quantity') f.sqlite.prepare('UPDATE orders SET quantity = 2 WHERE id = ?').run(id);
  if (race === 'status') f.sqlite.prepare("UPDATE orders SET status = 'ordered' WHERE id = ?").run(id);
  const before = f.rows('orders');
  assert.equal((await clear(f, body)).status, 409);
  assert.deepEqual(f.rows('orders'), before);
});

test('atomic guard rejects a new order arriving after the server recheck', async (t) => {
  const f = await createFixture(t); f.addOrder();
  const body = await confirmation(f);
  f.activity.beforeBatch = () => { f.activity.beforeBatch = null; f.addOrder(); };
  assert.equal((await clear(f, body)).status, 409);
  assert.equal(f.rows('orders').length, 2);
  assert.equal(f.rows('cleared_order_requests').length, 0);
  assert.equal(f.rows('oauth_states').length, 1);
  assert.equal(f.rows('audit_logs').length, 0);
});

test('audit failure rolls back deletion and retry markers together', async (t) => {
  const f = await createFixture(t); f.addOrder();
  f.sqlite.exec("CREATE TRIGGER fail_clear_audit BEFORE INSERT ON audit_logs WHEN NEW.action_type = 'ORDER_HISTORY_CLEAR' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
  assert.equal((await clear(f, await confirmation(f))).status, 500);
  assert.equal(f.rows('orders').length, 1);
  assert.equal(f.rows('cleared_order_requests').length, 0);
  assert.equal(f.rows('oauth_states').length, 1);
  assert.equal(f.activity.rollbacks, 1);
});

test('repeating a clear request cannot delete subsequent orders or create a second clear audit', async (t) => {
  const f = await createFixture(t); f.addOrder();
  const body = await confirmation(f);
  assert.equal((await clear(f, body)).status, 200);
  f.addOrder();
  assert.equal((await clear(f, body)).status, 409);
  assert.equal(f.rows('orders').length, 1);
  assert.equal(f.rows('audit_logs').filter((row) => row.action_type === 'ORDER_HISTORY_CLEAR').length, 1);
});

test('zero-order clear resets notifications once and refuses a duplicate with the same preview token', async (t) => {
  const f = await createFixture(t);
  const body = await confirmation(f);
  const before = f.rows('users');
  const response = await clear(f, body);
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.deleted_order_count, 0);
  assert(data.notification_history_revision > 0);
  assert.equal((await clear(f, body)).status, 409);
  assert.deepEqual(f.rows('users'), before);
  assert.equal(f.rows('audit_logs').length, 1);
  assert.equal(f.rows('cleared_order_requests').length, 0);
});

test('every notification role receives the same global revision on both polling routes; legacy clears do not advance it', async (t) => {
  const f = await createFixture(t);
  f.sqlite.prepare("UPDATE users SET role = 'chief' WHERE id = 5").run();
  f.sqlite.prepare("INSERT INTO audit_logs (actor_user_id, action_type, metadata_json) VALUES (1, 'ORDER_HISTORY_CLEAR', '{}')").run();
  for (const path of ['/api/notifications/orders', '/api/manager/orders']) {
    const body = await (await f.request(2, path)).json();
    assert.equal(body.notification_history_revision, 0);
    assert.equal((await f.request(3, path)).status, 403);
  }
  f.addOrder();
  const response = await clear(f, await confirmation(f));
  const revision = (await response.json()).data.notification_history_revision;
  for (const userId of [1, 2, 5]) for (const path of ['/api/notifications/orders', '/api/manager/orders']) {
    const body = await (await f.request(userId, path)).json();
    assert.equal(body.notification_history_revision, revision);
    assert.deepEqual(body.data, []);
    assert.equal(JSON.stringify(body).includes('metadata_json'), false);
  }
});

test('a failed audit does not advance the notification revision or consume the empty-history preview', async (t) => {
  const f = await createFixture(t);
  const body = await confirmation(f);
  f.sqlite.exec("CREATE TRIGGER fail_notification_clear BEFORE INSERT ON audit_logs WHEN NEW.action_type = 'ORDER_HISTORY_CLEAR' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await clear(f, body)).status, 500);
  assert.equal((await (await f.request(2, '/api/notifications/orders')).json()).notification_history_revision, 0);
  f.sqlite.exec('DROP TRIGGER fail_notification_clear');
  assert.equal((await clear(f, body)).status, 200);
});

test('a fresh zero-order preview can request another reset, and a concurrent reset invalidates the atomic guard', async (t) => {
  const f = await createFixture(t);
  const body = await confirmation(f);
  f.activity.beforeBatch = () => {
    f.activity.beforeBatch = null;
    f.sqlite.prepare("INSERT INTO audit_logs (actor_user_id, action_type, metadata_json) VALUES (1, 'ORDER_HISTORY_CLEAR', '{\"notification_history_cleared\":true}')").run();
  };
  assert.equal((await clear(f, body)).status, 409);
  const second = await clear(f, await confirmation(f));
  assert.equal(second.status, 200);
  assert.equal(f.rows('audit_logs').length, 2);
});

for (const source of ['self', 'admin']) test(`a delayed ${source} order retry cannot resurrect cleared history; a new request still works`, async (t) => {
  const f = await createFixture(t);
  const requestId = 'original_request_1234567890';
  f.addOrder({ requestId, source });
  assert.equal((await clear(f, await confirmation(f))).status, 200);
  const path = source === 'self' ? '/api/orders' : '/api/admin/users/3/orders';
  const userId = source === 'self' ? 3 : 1;
  const response = await f.request(userId, path, { method: 'POST', body: { menu_item_id: 1, quantity: 1, request_id: requestId } });
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, 'ORDER_HISTORY_CLEARED');
  assert.equal(f.rows('orders').length, 0);
  const fresh = await f.request(userId, path, { method: 'POST', body: { menu_item_id: 1, quantity: 1, request_id: requestId + '_new' } });
  assert.equal(fresh.status, 200);
  assert.equal(f.rows('orders').length, 1);
});
