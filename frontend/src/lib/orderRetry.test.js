import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOrderSubmissionResults, changeCartQuantity } from './orderRetry.js';

const item = { menu_item_id: 1, quantity: 1, request_id: 'test-order-request-1' };
const rejected = (status) => ({ status: 'rejected', reason: { status } });

test('lost response preserves the exact request and locks quantity changes and removal', () => {
  const cart = applyOrderSubmissionResults([item], [item], [rejected(0)]);
  assert.deepEqual(cart, [{ ...item, needsConfirmation: true }]);
  assert.deepEqual(changeCartQuantity(cart, 1, 1), cart);
  assert.deepEqual(changeCartQuantity(cart, 1, -1), cart);
  assert.deepEqual(applyOrderSubmissionResults(cart, cart, [{ status: 'fulfilled' }]), []);
});

test('server failures and malformed successful responses require confirmation', () => {
  for (const status of [500, 502, 200, undefined]) {
    assert.equal(applyOrderSubmissionResults([item], [item], [rejected(status)])[0].needsConfirmation, true);
  }
});

test('first validation rejection can be corrected but a later rejection never unlocks an uncertain order', () => {
  const rejectedCart = applyOrderSubmissionResults([item], [item], [rejected(422)]);
  assert.equal(rejectedCart[0].needsConfirmation, false);
  assert.equal(changeCartQuantity(rejectedCart, 1, 1)[0].quantity, 2);
  const uncertainCart = [{ ...item, needsConfirmation: true }];
  assert.deepEqual(applyOrderSubmissionResults(uncertainCart, uncertainCart, [rejected(404)]), uncertainCart);
});

test('partial success removes only the accepted request and preserves the uncertain request', () => {
  const second = { menu_item_id: 2, quantity: 2, request_id: 'test-order-request-2' };
  const cart = [item, second];
  assert.deepEqual(applyOrderSubmissionResults(cart, cart, [{ status: 'fulfilled' }, rejected(0)]), [
    { ...second, needsConfirmation: true },
  ]);
});

test('outcomes are matched by request ID and leave unrelated cart entries unchanged', () => {
  const nextRequest = { ...item, request_id: 'test-order-request-next' };
  assert.deepEqual(applyOrderSubmissionResults([nextRequest], [item], [{ status: 'fulfilled' }]), [nextRequest]);
});
