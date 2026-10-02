import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './test-support/database.js';

async function token(f, id, status = 'pending') {
  const body = await (await f.request(1, `/api/manager/orders?status=${status}`)).json();
  return body.data.find((row) => row.id === id).cancel_snapshot_token;
}
const request = (f, actor, id, snapshot, patch = {}, options = {}) => f.request(actor, `/api/orders/${id}/cancel`, {
  method: 'POST', body: { snapshot_token: snapshot, reason: '入力間違いのため', ...patch }, ...options,
});

for (const [actor, owner] of [[3, 3], [2, 2], [1, 4], [4, 4], [4, 3]]) {
  test(`pending cancellation: actor ${actor} can cancel user ${owner} within their scope, with atomic audit and retained history`, async (t) => {
    const f = await createFixture(t);
    if (actor === 4) f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
    const id = f.addOrder({ userId: owner, quantity: 2 });
    const snapshot = await token(f, id);
    const response = await request(f, actor, id, snapshot);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { cancelled: true, duplicate: false });
    const order = f.rows('orders')[0];
    assert.equal(order.status, 'cancelled');
    assert.equal(order.quantity, 2);
    assert.equal(order.cancelled_by, actor);
    assert.equal(order.cancel_reason, '入力間違いのため');
    assert.equal(f.rows('audit_logs').filter((row) => row.action_type === 'ORDER_CANCEL').length, 1);
    const repeated = await request(f, actor, id, snapshot);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).data.duplicate, true);
    assert.equal(f.rows('audit_logs').filter((row) => row.action_type === 'ORDER_CANCEL').length, 1);
    const summary = (await (await f.request(1, '/api/orders/summary')).json()).data;
    assert.equal(summary.find((row) => row.user_id === owner).total_price, 0);
    const history = (await (await f.request(owner, '/api/orders/mine')).json()).data;
    assert.equal(history[0].user_id, owner);
    assert.equal(history[0].status, 'cancelled');
    assert.equal(history[0].cancel_snapshot, undefined);
    assert.match(history[0].cancel_snapshot_token, /^[A-Za-z0-9_-]{43}$/);
  });
}

test('unrelated member and any manager cannot cancel another person’s order', async (t) => {
  const f = await createFixture(t);
  const id = f.addOrder(); const snapshot = await token(f, id);
  for (const actor of [2, 4, 5]) assert.equal((await request(f, actor, id, snapshot)).status, 404);
  const second = f.addOrder({ userId: 4 });
  assert.equal((await request(f, 3, second, await token(f, second))).status, 404);
  assert.ok(f.rows('orders').every((order) => order.status === 'pending'));
});

test('ordered cancellation requires an admin, an explicit restaurant confirmation and a reason, including the legacy admin route', async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const id = f.addOrder({ status: 'ordered', source: 'admin' });
  const snapshot = await token(f, id, 'ordered');
  for (const actor of [3, 4]) assert.equal((await request(f, actor, id, snapshot, { restaurant_confirmed: true })).status, 403);
  assert.equal((await request(f, 2, id, snapshot, { restaurant_confirmed: true })).status, 404);
  for (const patch of [{}, { restaurant_confirmed: 'true' }, { restaurant_confirmed: true, reason: '' }]) {
    assert.equal((await request(f, 1, id, snapshot, patch)).status, 422);
  }
  assert.equal((await f.request(1, `/api/admin/orders/${id}/cancel`, { method: 'POST', body: {} })).status, 422);
  const response = await request(f, 1, id, snapshot, { restaurant_confirmed: true });
  assert.equal(response.status, 200);
  const audit = f.rows('audit_logs').at(-1);
  assert.deepEqual(JSON.parse(audit.metadata_json), { previous_status: 'ordered', reason: '入力間違いのため', restaurant_confirmed: true });
});

test('cancellation validates CSRF, authentication, reason, snapshot and malformed identifiers before mutation', async (t) => {
  const f = await createFixture(t); const id = f.addOrder(); const snapshot = await token(f, id);
  assert.equal((await request(f, 3, id, snapshot, {}, { csrf: false })).status, 403);
  assert.equal((await request(f, 3, id, snapshot, {}, { cookie: false })).status, 401);
  assert.equal((await request(f, 3, id, snapshot, { reason: 'x'.repeat(201) })).status, 422);
  assert.equal((await request(f, 3, id, 'bad')).status, 422);
  assert.equal((await request(f, 3, 'bad', snapshot)).status, 422);
  assert.equal((await request(f, 3, 999, snapshot)).status, 404);
  assert.equal(f.rows('orders')[0].status, 'pending');
});

test('a stale snapshot detects a same-second quantity edit and a pending to ordered handoff', async (t) => {
  const f = await createFixture(t); const id = f.addOrder();
  const oldSnapshot = await token(f, id);
  f.sqlite.prepare('UPDATE orders SET quantity = 2 WHERE id = ?').run(id);
  assert.equal((await request(f, 3, id, oldSnapshot)).status, 409);
  const pendingSnapshot = await token(f, id);
  f.sqlite.prepare("UPDATE orders SET status = 'ordered' WHERE id = ?").run(id);
  const response = await request(f, 1, id, pendingSnapshot, { restaurant_confirmed: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'ORDER_CHANGED');
  assert.equal(f.rows('orders')[0].status, 'ordered');
  assert.equal(f.rows('audit_logs').length, 0);
});

for (const change of ['quantity', 'handoff', 'actor-role', 'group']) {
  test(`cancellation checks ${change} again inside the write transaction`, async (t) => {
    const f = await createFixture(t);
    f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
    const id = f.addOrder(); const snapshot = await token(f, id);
    f.activity.beforeBatch = () => {
      f.activity.beforeBatch = null;
      if (change === 'quantity') f.sqlite.prepare('UPDATE orders SET quantity = 2 WHERE id = ?').run(id);
      if (change === 'handoff') f.sqlite.prepare("UPDATE orders SET status = 'ordered' WHERE id = ?").run(id);
      if (change === 'actor-role') f.sqlite.exec("UPDATE users SET role = 'manager' WHERE id = 4");
      if (change === 'group') f.sqlite.exec("UPDATE users SET group_id = '別のテスト席' WHERE id = 3");
    };
    assert.equal((await request(f, 4, id, snapshot)).status, 409);
    assert.equal(f.rows('orders')[0].status, change === 'handoff' ? 'ordered' : 'pending');
    assert.equal(f.rows('audit_logs').length, 0);
  });
}

test('chief cancellation rechecks demotion inside the write transaction before changing another group order', async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const id = f.addOrder(); const snapshot = await token(f, id);
  f.activity.beforeBatch = () => {
    f.activity.beforeBatch = null;
    f.sqlite.exec("UPDATE users SET role = 'manager' WHERE id = 4");
  };
  assert.equal((await request(f, 4, id, snapshot)).status, 409);
  assert.equal(f.rows('orders')[0].status, 'pending');
  assert.equal(f.rows('audit_logs').length, 0);
});

test('failed audit rolls back the cancellation', async (t) => {
  const f = await createFixture(t); const id = f.addOrder(); const snapshot = await token(f, id);
  f.sqlite.exec("CREATE TRIGGER fail_cancel_audit BEFORE INSERT ON audit_logs WHEN NEW.action_type = 'ORDER_CANCEL' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await request(f, 3, id, snapshot)).status, 500);
  assert.equal(f.rows('orders')[0].status, 'pending');
  assert.equal(f.rows('orders')[0].cancelled_by, null);
  assert.equal(f.activity.rollbacks, 1);
});
