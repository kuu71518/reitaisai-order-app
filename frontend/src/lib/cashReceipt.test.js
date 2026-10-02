import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageCashReceipts, cashReceiptBody, cashReceiptState, isCashReceiptConfirmed } from './cashReceipt.js';

const person = {
  user_id: 9, total_price: 1200,
  cash_received: false, cash_recorded_total: null, cash_amount_changed: false,
  cash_receipt_snapshot_token: 's'.repeat(43),
};

test('only administrators and chiefs may change cash receipt records', () => {
  for (const role of ['admin', 'chief']) assert.equal(canManageCashReceipts({ role }), true);
  for (const role of ['member', 'manager', 'unknown', '']) assert.equal(canManageCashReceipts({ role }), false);
  assert.equal(canManageCashReceipts(null), false);
});

test('receipt requests send only the target state and observed snapshot token', () => {
  const body = cashReceiptBody(person, true);
  assert.deepEqual(body, { received: true, snapshot_token: person.cash_receipt_snapshot_token });
  assert.deepEqual(cashReceiptBody(person, false), { received: false, snapshot_token: person.cash_receipt_snapshot_token });
  assert.equal(Object.hasOwn(body, 'amount'), false);
  assert.equal(Object.hasOwn(body, 'total_price'), false);
});

test('invalid IDs, non-boolean states and absent or malformed tokens cannot be submitted', () => {
  for (const user_id of [0, -1, 'unknown', 1.5]) assert.equal(cashReceiptBody({ ...person, user_id }, true), null);
  for (const received of [1, 'true', null]) assert.equal(cashReceiptBody(person, received), null);
  for (const token of [null, '', 'x'.repeat(42), '/'.repeat(43)]) {
    assert.equal(cashReceiptBody({ ...person, cash_receipt_snapshot_token: token }, true), null);
  }
  assert.equal(cashReceiptBody(null, true), null);
});

test('unreceived records do not claim a recorded amount and legitimate zero remains zero', () => {
  assert.deepEqual(cashReceiptState(person), { received: false, changed: false, recordedTotal: null });
  assert.deepEqual(cashReceiptState({ cash_received: true, cash_recorded_total: 0, cash_amount_changed: false }),
    { received: true, changed: false, recordedTotal: 0 });
  assert.equal(cashReceiptState({ cash_received: true, cash_recorded_total: null }).recordedTotal, null);
});

test('changed amount is displayed independently of recorded amount and does not add the charge', () => {
  const changed = { ...person, cash_received: true, cash_recorded_total: 1000, cash_amount_changed: true };
  assert.deepEqual(cashReceiptState(changed), { received: true, changed: true, recordedTotal: 1000 });
  assert.deepEqual(cashReceiptBody(changed, true), { received: true, snapshot_token: person.cash_receipt_snapshot_token });
  assert.equal(changed.total_price, 1200);
});

test('retry payload remains bound to the observed token even when a fresh summary arrives', () => {
  const body = cashReceiptBody(person, true);
  const updated = { ...person, cash_receipt_snapshot_token: 't'.repeat(43) };
  assert.equal(body.snapshot_token, 's'.repeat(43));
  assert.notDeepEqual(body, cashReceiptBody(updated, true));
});

test('only an exact successful receipt state is confirmed, including duplicate responses', () => {
  const received = cashReceiptBody(person, true);
  const cleared = cashReceiptBody(person, false);
  assert.equal(isCashReceiptConfirmed(received, { data: { received: true, duplicate: true } }), true);
  assert.equal(isCashReceiptConfirmed(cleared, { data: { received: false, duplicate: false } }), true);
  for (const response of [null, {}, { data: {} }, { data: { received: 'true' } }, { data: { received: false } }]) {
    assert.equal(isCashReceiptConfirmed(received, response), false);
  }
});
