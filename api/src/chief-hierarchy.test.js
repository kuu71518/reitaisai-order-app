import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './test-support/database.js';

test('chief can collect, edit and hand off orders from every group without administrator settings', async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const a = f.addOrder();
  const b = f.addOrder({ userId: 5, quantity: 2 });
  const response = await f.request(4, '/api/manager/orders');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((row) => row.id), [a, b]);
  assert.equal((await f.request(4, `/api/manager/orders/${a}/quantity`, {
    method: 'PATCH', body: { quantity: 3 }, csrf: false,
  })).status, 403);
  assert.equal((await f.request(4, `/api/manager/orders/${a}/quantity`, {
    method: 'PATCH', body: { quantity: 3 },
  })).status, 200);
  assert.equal((await f.request(4, '/api/manager/orders/status', {
    method: 'PATCH', body: { order_ids: [a, b], status: 'ordered' },
  })).status, 200);
  assert.deepEqual(f.rows('orders').map((row) => [row.quantity, row.status]), [[3, 'ordered'], [2, 'ordered']]);
  assert.equal((await f.request(4, '/api/manager/orders?status=ordered')).status, 200);
  assert.equal((await f.request(4, '/api/notifications/config')).status, 200);
  for (const path of ['/api/admin/users', '/api/admin/stats', '/api/admin/logs', '/api/admin/menu', '/api/admin/order-history/preview']) {
    assert.equal((await f.request(4, path)).status, 403, path);
  }
  const users = f.rows('users');
  assert.equal((await f.request(4, '/api/admin/users/3', {
    method: 'PATCH', body: { role: 'chief', group_id: 'テスト席B' },
  })).status, 403);
  assert.deepEqual(f.rows('users'), users);
});

test('manager accounting returns only the assigned group total, with no individual or cash receipt data', async (t) => {
  const f = await createFixture(t);
  f.addOrder({ quantity: 2 });
  f.addOrder({ userId: 2, quantity: 3, status: 'ordered' });
  f.addOrder({ quantity: 10, status: 'cancelled' });
  f.addOrder({ userId: 4, quantity: 8 });
  f.sqlite.exec('UPDATE users SET is_active = 0 WHERE id = 3');
  const users = f.rows('users');
  const response = await f.request(2, '/api/orders/summary?group_id=テスト席B&role=admin&all_groups=1');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, scope: 'assigned_group', data: [{ group_id: 'テスト席A', total_price: 1500 }] });
  assert.deepEqual(f.rows('users'), users);
  assert.equal((await f.request(3, '/api/orders/summary')).status, 401);
});

test('a manager with no orders sees zero for their own group and cannot retrieve participant details', async (t) => {
  const f = await createFixture(t);
  f.addOrder({ userId: 4 });
  const response = await f.request(2, '/api/orders/summary');
  assert.deepEqual((await response.json()).data, [{ group_id: 'テスト席A', total_price: 0 }]);
  assert.equal((await f.request(2, '/api/admin/users')).status, 403);
  assert.equal((await f.request(2, '/api/accounting/users/3/cash-receipt', {
    method: 'POST', body: { received: true, snapshot_token: 's'.repeat(43) },
  })).status, 403);
});

test('chief demotion narrows handoff, accounting and notifications to the assigned group', async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const otherGroup = f.addOrder();
  const ownGroup = f.addOrder({ userId: 5 });
  assert.equal((await f.request(4, '/api/manager/orders')).status, 200);
  assert.equal((await (await f.request(4, '/api/orders/summary')).json()).scope, 'all_groups');
  f.sqlite.exec("UPDATE users SET role = 'manager' WHERE id = 4");
  assert.deepEqual((await (await f.request(4, '/api/manager/orders')).json()).data.map((row) => row.id), [ownGroup]);
  assert.equal((await f.request(4, '/api/manager/orders/status', {
    method: 'PATCH', body: { order_ids: [otherGroup], status: 'ordered' },
  })).status, 404);
  assert.deepEqual((await (await f.request(4, '/api/notifications/orders')).json()).data, [{ id: ownGroup }]);
  assert.deepEqual(await (await f.request(4, '/api/orders/summary')).json(), { success: true, scope: 'assigned_group', data: [{ group_id: 'テスト席B', total_price: 300 }] });
  assert.equal((await f.request(4, `/api/manager/orders/${otherGroup}/quantity`, {
    method: 'PATCH', body: { quantity: 2 },
  })).status, 403);
  f.sqlite.exec("UPDATE users SET role = 'member' WHERE id = 4");
  for (const path of ['/api/manager/orders', '/api/orders/summary', '/api/notifications/config', '/api/notifications/orders']) {
    assert.equal((await f.request(4, path)).status, 403, path);
  }
});

test('notification polling returns pending IDs only, scopes managers to their group and chiefs/admins to every group', async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const a = f.addOrder(); const b = f.addOrder({ userId: 5 });
  f.addOrder({ status: 'ordered' }); f.addOrder({ status: 'cancelled' });
  for (const actor of [1, 4]) {
    assert.deepEqual((await (await f.request(actor, '/api/notifications/orders')).json()).data, [{ id: a }, { id: b }]);
  }
  assert.deepEqual((await (await f.request(2, '/api/notifications/orders?group_id=テスト席B&all_groups=1')).json()).data, [{ id: a }]);
  assert.equal((await f.request(3, '/api/notifications/orders')).status, 403);
  assert.equal((await f.request(2, '/api/notifications/orders', { cookie: false })).status, 401);
});
