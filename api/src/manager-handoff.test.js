import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './test-support/database.js';

for (const [actor, owner, otherOwner] of [[2, 3, 4], [5, 4, 3]]) {
  test(`manager ${actor} reads and hands off only their assigned group, preserving later arrivals`, async (t) => {
    const f = await createFixture(t);
    const own = f.addOrder({ userId: owner, quantity: 2 });
    const other = f.addOrder({ userId: otherOwner, quantity: 3 });
    const users = f.rows('users');
    const response = await f.request(actor, '/api/manager/orders?group_id=運営&role=admin&all_groups=1');
    assert.equal(response.status, 200);
    const listed = (await response.json()).data;
    assert.deepEqual(listed.map((row) => row.id), [own]);
    assert.equal(listed[0].quantity, 2);
    const later = f.addOrder({ userId: owner });
    const result = await f.request(actor, '/api/manager/orders/status', {
      method: 'PATCH', body: { order_ids: listed.map((row) => row.id), status: 'ordered', group_id: '運営', role: 'admin' },
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.updated_count, 1);
    assert.deepEqual(f.rows('orders').map((row) => [row.id, row.quantity, row.status]), [
      [own, 2, 'ordered'], [other, 3, 'pending'], [later, 1, 'pending'],
    ]);
    assert.deepEqual((await (await f.request(actor, '/api/manager/orders?status=ordered')).json()).data.map((row) => row.id), [own]);
    assert.deepEqual(f.rows('users'), users);
    const audit = f.rows('audit_logs').find((row) => row.action_type === 'ORDER_STATUS_UPDATE');
    assert.equal(audit.actor_user_id, actor);
    assert.equal(JSON.parse(audit.metadata_json).updated_count, 1);
  });
}

test('manager handoff cannot change another group or grant quantity, cash receipt or administrator access', async (t) => {
  const f = await createFixture(t);
  const own = f.addOrder(); const other = f.addOrder({ userId: 4 });
  const before = f.rows('orders');
  assert.equal((await f.request(2, '/api/manager/orders/status?group_id=テスト席B&role=admin', {
    method: 'PATCH', body: { order_ids: [other], status: 'ordered', all_groups: true },
  })).status, 404);
  for (const id of [own, other]) {
    assert.equal((await f.request(2, `/api/manager/orders/${id}/quantity`, {
      method: 'PATCH', body: { quantity: 5 },
    })).status, 403);
  }
  assert.equal((await f.request(2, '/api/accounting/users/3/cash-receipt', {
    method: 'POST', body: { received: true, snapshot_token: 's'.repeat(43) },
  })).status, 403);
  assert.equal((await f.request(2, '/api/admin/users')).status, 403);
  assert.deepEqual(await (await f.request(2, '/api/orders/summary')).json(), {
    success: true, scope: 'assigned_group', data: [{ group_id: 'テスト席A', total_price: 300 }],
  });
  assert.deepEqual(f.rows('orders'), before);
});

test('mixed handoff IDs update only pending orders in the manager group and report the actual count', async (t) => {
  const f = await createFixture(t);
  const own = f.addOrder(); const other = f.addOrder({ userId: 4 });
  const cancelled = f.addOrder({ status: 'cancelled' }); const ordered = f.addOrder({ status: 'ordered' });
  const response = await f.request(2, '/api/manager/orders/status', {
    method: 'PATCH', body: { order_ids: [own, other, cancelled, ordered], status: 'ordered' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.updated_count, 1);
  assert.deepEqual(f.rows('orders').map((row) => row.status), ['ordered', 'pending', 'cancelled', 'ordered']);
});

test('handoff rechecks current manager assignment and loses access after demotion', async (t) => {
  const f = await createFixture(t);
  const a = f.addOrder(); const b = f.addOrder({ userId: 4 });
  f.sqlite.exec("UPDATE users SET group_id = 'テスト席B' WHERE id = 2");
  assert.deepEqual((await (await f.request(2, '/api/manager/orders')).json()).data.map((row) => row.id), [b]);
  assert.equal((await f.request(2, '/api/manager/orders/status', {
    method: 'PATCH', body: { order_ids: [a], status: 'ordered' },
  })).status, 404);
  assert.equal((await f.request(2, '/api/manager/orders/status', {
    method: 'PATCH', body: { order_ids: [b], status: 'ordered' },
  })).status, 200);
  f.sqlite.exec("UPDATE users SET role = 'member' WHERE id = 2");
  assert.equal((await f.request(2, '/api/manager/orders')).status, 403);
  assert.equal((await f.request(2, '/api/manager/orders/status', {
    method: 'PATCH', body: { order_ids: [a], status: 'ordered' },
  })).status, 403);
  assert.equal(f.rows('orders')[0].status, 'pending');
});

test('manager handoff requires authentication, CSRF and valid pending-to-ordered input', async (t) => {
  const f = await createFixture(t); const own = f.addOrder();
  const body = { order_ids: [own], status: 'ordered' };
  assert.equal((await f.request(2, '/api/manager/orders/status', { method: 'PATCH', body, cookie: false })).status, 401);
  assert.equal((await f.request(2, '/api/manager/orders/status', { method: 'PATCH', body, csrf: false })).status, 403);
  assert.equal((await f.request(3, '/api/manager/orders/status', { method: 'PATCH', body })).status, 403);
  for (const invalid of [
    { order_ids: [], status: 'ordered' },
    { order_ids: [own, own], status: 'ordered' },
    { order_ids: ['bad'], status: 'ordered' },
    { order_ids: [own], status: 'cancelled' },
    { order_ids: [own], status: 'pending' },
  ]) {
    assert.equal((await f.request(2, '/api/manager/orders/status', { method: 'PATCH', body: invalid })).status, 422);
  }
  assert.equal(f.rows('orders')[0].status, 'pending');
});
