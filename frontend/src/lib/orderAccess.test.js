import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageOrders, collectOrderNotifications, getNavItems, groupPendingOrders } from './orderAccess.js';

test('admin gets manager navigation and polling eligibility plus the admin screen', () => {
  assert.equal(canManageOrders({ role: 'admin' }), true);
  assert.equal(canManageOrders({ role: 'manager' }), true);
  assert.deepEqual(getNavItems({ role: 'admin' }).map((item) => item.id), ['menu', 'history', 'manager', 'summary', 'admin']);
  assert.deepEqual(getNavItems({ role: 'manager' }).map((item) => item.id), ['menu', 'history', 'manager', 'summary']);
  for (const user of [null, { role: 'member' }, { role: 'unknown' }]) {
    assert.equal(canManageOrders(user), false);
    assert.deepEqual(getNavItems(user).map((item) => item.id), ['menu', 'history']);
  }
});
test('new-order notifications ignore the initial baseline and repeated polls but count newly arrived orders once', () => {
  const baseline = collectOrderNotifications(null, [{ id: 1 }]);
  assert.equal(baseline.newCount, 0);
  const next = collectOrderNotifications(baseline.ids, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(next.newCount, 2);
  assert.equal(collectOrderNotifications(next.ids, [{ id: 2 }, { id: 3 }]).newCount, 0);
  assert.equal(collectOrderNotifications(next.ids, [{ id: 4 }, { id: 4 }]).newCount, 1);
});
test('same product at different tables is grouped separately and quantity drafts affect only the matching order', () => {
  const orders = [{ id: 1, group_id: 'A', menu_name: 'お茶', size: '通常', quantity: 1 },
    { id: 2, group_id: 'B', menu_name: 'お茶', size: '通常', quantity: 2 },
    { id: 3, group_id: 'A', menu_name: 'お茶', size: '通常', quantity: 3 }];
  const groups = groupPendingOrders(orders, { 1: 5 });
  assert.deepEqual(groups.map((group) => [group.groupId, group.total, group.items.map((row) => row.id)]), [['A', 8, [1, 3]], ['B', 2, [2]]]);
});
