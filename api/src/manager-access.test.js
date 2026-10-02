import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './test-support/database.js';

test('admin manages every group; managers and members cannot retrieve or change the handoff list', async (t) => {
  const f = await createFixture(t);
  const a = f.addOrder(); const b = f.addOrder({ userId: 4 });
  const adminOrders = (await (await f.request(1, '/api/manager/orders')).json()).data;
  assert.deepEqual(adminOrders.map((row) => row.id), [a, b]);
  assert.deepEqual(adminOrders.map((row) => row.group_id), ['テスト席A', 'テスト席B']);
  assert.equal((await f.request(2, '/api/manager/orders')).status, 403);
  assert.equal((await f.request(3, '/api/manager/orders')).status, 403);
  for (const orderId of [a, b]) assert.equal((await f.request(2, `/api/manager/orders/${orderId}/quantity`, { method: 'PATCH', body: { quantity: 2 } })).status, 403);
  assert.equal((await f.request(2, '/api/manager/orders/status', { method: 'PATCH', body: { order_ids: [a], status: 'ordered' } })).status, 403);
  assert.ok(f.rows('orders').every((row) => row.status === 'pending' && row.quantity === 1));
  assert.equal((await f.request(1, `/api/manager/orders/${b}/quantity`, { method: 'PATCH', body: { quantity: 2 } })).status, 200);
  assert.equal((await f.request(1, '/api/manager/orders/status', { method: 'PATCH', body: { order_ids: [a, b], status: 'ordered' } })).status, 200);
  assert.ok(f.rows('orders').every((row) => row.status === 'ordered'));
});

test('admin summary distinguishes same-name participants while manager summary contains only the group total', async (t) => {
  const f = await createFixture(t); f.addOrder(); f.addOrder({ userId: 4, quantity: 2 });
  const admin = (await (await f.request(1, '/api/orders/summary')).json()).data;
  assert.deepEqual(admin.map((row) => [row.user_id, row.group_id, row.total_price]), [[2, 'テスト席A', 0], [3, 'テスト席A', 300], [5, 'テスト席B', 0], [4, 'テスト席B', 600], [1, '運営', 0]]);
  const manager = (await (await f.request(2, '/api/orders/summary')).json()).data;
  assert.deepEqual(manager, [{ group_id: 'テスト席A', total_price: 300 }]);
  assert.equal((await f.request(3, '/api/orders/summary')).status, 403);
});
