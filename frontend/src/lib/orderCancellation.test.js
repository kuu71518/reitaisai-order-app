import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelOrder, cancellationBody } from './orderCancellation.js';

const order = { id: 3, user_id: 8, group_id: 'A', status: 'pending', cancel_snapshot_token: 's'.repeat(43) };
test('pending cancellation permits owners and all-group chiefs while managers cannot change another person’s order', () => {
  assert.equal(canCancelOrder({ id: 8, role: 'member' }, order), true);
  assert.equal(canCancelOrder({ id: 9, role: 'member', group_id: 'A' }, order), false);
  assert.equal(canCancelOrder({ id: 9, role: 'manager', group_id: 'A' }, order), false);
  assert.equal(canCancelOrder({ id: 8, role: 'manager', group_id: 'A' }, order), true);
  assert.equal(canCancelOrder({ id: 9, role: 'manager', group_id: 'B' }, order), false);
  assert.equal(canCancelOrder({ id: 9, role: 'chief', group_id: 'A' }, order), true);
  assert.equal(canCancelOrder({ id: 9, role: 'chief', group_id: 'B' }, order), true);
  assert.equal(canCancelOrder({ id: 8, role: 'chief', group_id: 'B' }, order), true);
  assert.equal(canCancelOrder({ id: 9, role: 'admin' }, order), true);
});
test('handed-off orders require admin and cancelled/unknown orders have no action', () => {
  for (const role of ['member', 'manager', 'chief']) assert.equal(canCancelOrder({ id: 8, role, group_id: 'A' }, { ...order, status: 'ordered' }), false);
  assert.equal(canCancelOrder({ id: 9, role: 'admin' }, { ...order, status: 'ordered' }), true);
  for (const status of ['cancelled', 'unexpected']) assert.equal(canCancelOrder({ id: 9, role: 'admin' }, { ...order, status }), false);
  assert.equal(canCancelOrder({ id: 8, role: 'unknown' }, order), false);
  assert.equal(canCancelOrder(null, order), false);
});
test('snapshot, required reason and restaurant confirmation are validated before submission', () => {
  assert.equal(cancellationBody(order, ' ', false), null);
  assert.equal(cancellationBody(order, 'a'.repeat(201), false), null);
  assert.equal(cancellationBody({ ...order, cancel_snapshot_token: undefined }, '重複', false), null);
  assert.equal(cancellationBody({ ...order, status: 'ordered' }, '重複', false), null);
  assert.equal(cancellationBody({ ...order, status: 'ordered' }, '重複', 'true'), null);
  assert.deepEqual(cancellationBody(order, ' 重複 ', true), { snapshot_token: order.cancel_snapshot_token, reason: '重複', restaurant_confirmed: false });
  assert.equal(cancellationBody({ ...order, status: 'ordered' }, '重複', true).restaurant_confirmed, true);
});
