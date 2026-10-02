import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './test-support/database.js';

async function person(f, userId = 3, actor = 1) {
  const response = await f.request(actor, '/api/orders/summary');
  assert.equal(response.status, 200);
  return (await response.json()).data.find((row) => row.user_id === userId);
}
const record = (f, userId, snapshot, received = true, actor = 1, options = {}) => f.request(actor,
  `/api/accounting/users/${userId}/cash-receipt`, {
    method: 'POST', body: { received, snapshot_token: snapshot }, ...options,
  });
const audits = (f) => f.rows('audit_logs').filter((row) => row.action_type.startsWith('CASH_RECEIPT_'));

for (const actor of [1, 4]) test(`admin/chief ${actor} can record and undo receipt for any group with exact-retry idempotency`, async (t) => {
  const f = await createFixture(t);
  f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  f.addOrder({ quantity: 2 });
  const first = await person(f);
  assert.equal(first.total_price, 600);
  assert.equal(first.cash_received, false);
  assert.equal(first.cash_receipt_revision, 0);
  assert.equal(first.cash_recorded_total, null);
  assert.equal(first.cash_amount_changed, false);
  assert.equal(first.last_request_token, undefined);
  assert.equal(first.cash_snapshot, undefined);
  const response = await record(f, 3, first.cash_receipt_snapshot_token, true, actor);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { received: true, duplicate: false });
  const after = await person(f);
  assert.equal(after.cash_received, true);
  assert.equal(after.cash_recorded_total, 600);
  assert.equal(after.cash_receipt_revision, 1);
  assert.equal(typeof after.cash_received_at, 'number');
  assert.notEqual(after.cash_receipt_snapshot_token, first.cash_receipt_snapshot_token);
  const repeat = await record(f, 3, first.cash_receipt_snapshot_token, true, actor);
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).data.duplicate, true);
  assert.equal(audits(f).length, 1);
  assert.equal((await record(f, 3, after.cash_receipt_snapshot_token, false, actor)).status, 200);
  const cleared = await person(f);
  assert.equal(cleared.cash_received, false);
  assert.equal(cleared.cash_recorded_total, null);
  assert.equal(cleared.cash_received_at, null);
  assert.equal(cleared.cash_receipt_revision, 2);
  assert.equal((await (await record(f, 3, after.cash_receipt_snapshot_token, false, actor)).json()).data.duplicate, true);
  assert.equal(audits(f).length, 2);
  assert.equal(audits(f)[1].action_type, 'CASH_RECEIPT_CLEAR');
  assert.deepEqual(JSON.parse(audits(f)[1].metadata_json), { order_total: 600, previous_received: true, previous_recorded_total: 600, revision: 2 });
});

test('zero-yen participants can be marked received without adding the table charge', async (t) => {
  const f = await createFixture(t);
  assert.equal((await record(f, 3, (await person(f)).cash_receipt_snapshot_token)).status, 200);
  const after = await person(f);
  assert.equal(after.total_price, 0);
  assert.equal(after.cash_recorded_total, 0);
  assert.equal(after.cash_received, true);
});

test('managers receive only the group total without receipt data, while members cannot see or change accounting', async (t) => {
  const f = await createFixture(t); f.addOrder();
  const token = (await person(f)).cash_receipt_snapshot_token;
  assert.equal((await record(f, 3, token)).status, 200);
  assert.deepEqual((await (await f.request(2, '/api/orders/summary')).json()).data, [{ group_id: 'テスト席A', total_price: 300 }]);
  for (const actor of [2, 3, 5]) assert.equal((await record(f, 3, token, false, actor)).status, 403);
  assert.equal((await f.request(3, '/api/orders/summary')).status, 403);
  assert.equal(audits(f).length, 1);
});

test('receipt updates require authentication, CSRF, a boolean status and the snapshot', async (t) => {
  const f = await createFixture(t); const token = (await person(f)).cash_receipt_snapshot_token;
  assert.equal((await record(f, 3, token, true, 1, { cookie: false })).status, 401);
  assert.equal((await record(f, 3, token, true, 1, { csrf: false })).status, 403);
  for (const invalid of [null, 1, 'true']) assert.equal((await record(f, 3, token, invalid)).status, 422);
  assert.equal((await record(f, 3, 'bad')).status, 422);
  assert.equal((await record(f, 'bad', token)).status, 422);
  assert.equal((await record(f, 999, token)).status, 404);
  assert.equal(f.rows('cash_receipts').length, 0);
});

test('additional orders and cancellations flag changed totals until the operator confirms the current amount', async (t) => {
  const f = await createFixture(t); f.addOrder();
  const first = await person(f);
  await record(f, 3, first.cash_receipt_snapshot_token);
  f.addOrder({ quantity: 2 });
  const changed = await person(f);
  assert.equal(changed.cash_received, true);
  assert.equal(changed.cash_recorded_total, 300);
  assert.equal(changed.total_price, 900);
  assert.equal(changed.cash_amount_changed, true);
  const repeat = await record(f, 3, first.cash_receipt_snapshot_token);
  assert.equal((await repeat.json()).data.duplicate, true);
  assert.equal((await person(f)).cash_recorded_total, 300);
  assert.equal((await record(f, 3, changed.cash_receipt_snapshot_token)).status, 200);
  assert.equal((await person(f)).cash_amount_changed, false);
  assert.equal((await person(f)).cash_recorded_total, 900);
  f.sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE quantity = 2");
  const cancelled = await person(f);
  assert.equal(cancelled.total_price, 300);
  assert.equal(cancelled.cash_amount_changed, true);
});

test('stale cash revisions are rejected instead of reversing a newer operator action', async (t) => {
  const f = await createFixture(t); f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
  const before = await person(f);
  await record(f, 3, before.cash_receipt_snapshot_token);
  const received = await person(f);
  assert.equal((await record(f, 3, before.cash_receipt_snapshot_token, true, 4)).status, 409);
  await record(f, 3, received.cash_receipt_snapshot_token, false, 4);
  const stale = await record(f, 3, before.cash_receipt_snapshot_token, true);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'CASH_RECEIPT_CHANGED');
  assert.equal((await person(f)).cash_received, false);
  assert.equal(audits(f).length, 2);
});

for (const change of ['total', 'revision', 'role', 'access', 'group']) {
  test(`cash write rechecks ${change} inside its transaction`, async (t) => {
    const f = await createFixture(t); f.sqlite.exec("UPDATE users SET role = 'chief' WHERE id = 4");
    f.addOrder(); const before = await person(f);
    f.activity.beforeBatch = () => {
      f.activity.beforeBatch = null;
      if (change === 'total') f.addOrder();
      if (change === 'revision') f.sqlite.prepare('INSERT INTO cash_receipts VALUES (3,0,NULL,NULL,1,?,1,?)').run(f.now, 'a'.repeat(43));
      if (change === 'role') f.sqlite.exec("UPDATE users SET role = 'member' WHERE id = 4");
      if (change === 'access') f.sqlite.exec('UPDATE users SET discord_id_hmac = NULL WHERE id = 4');
      if (change === 'group') f.sqlite.exec("UPDATE users SET group_id = 'テスト変更席' WHERE id = 3");
    };
    assert.equal((await record(f, 3, before.cash_receipt_snapshot_token, true, 4)).status, 409);
    assert.equal(audits(f).length, 0);
    assert.equal((await person(f)).cash_received, false);
  });
}

test('failed receipt audit rolls back the cash check', async (t) => {
  const f = await createFixture(t); const before = await person(f);
  f.sqlite.exec("CREATE TRIGGER fail_cash_audit BEFORE INSERT ON audit_logs WHEN NEW.action_type = 'CASH_RECEIPT_SET' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await record(f, 3, before.cash_receipt_snapshot_token)).status, 500);
  assert.equal(f.rows('cash_receipts').length, 0);
  assert.equal(f.activity.rollbacks, 1);
});

test('clearing only order history preserves receipts and exposes changed totals even for an inactive participant', async (t) => {
  const f = await createFixture(t); f.addOrder();
  await record(f, 3, (await person(f)).cash_receipt_snapshot_token);
  const receipt = f.rows('cash_receipts');
  f.sqlite.exec('UPDATE users SET is_active = 0 WHERE id = 3');
  const preview = (await (await f.request(1, '/api/admin/order-history/preview')).json()).data;
  assert.equal((await f.request(1, '/api/admin/order-history/clear', { method: 'POST', body: {
    backup_confirmed: true, confirmation: '注文履歴だけを削除', snapshot_token: preview.snapshot_token,
  } })).status, 200);
  assert.deepEqual(f.rows('cash_receipts'), receipt);
  const after = await person(f);
  assert.equal(after.total_price, 0);
  assert.equal(after.cash_recorded_total, 300);
  assert.equal(after.cash_amount_changed, true);
});

test('full event reset clears all cash receipts including the preserved administrator’s receipt', async (t) => {
  const f = await createFixture(t); f.addOrder();
  await record(f, 3, (await person(f)).cash_receipt_snapshot_token);
  await record(f, 1, (await person(f, 1)).cash_receipt_snapshot_token);
  const preview = (await (await f.request(1, '/api/admin/data-reset/preview')).json()).data;
  assert.equal((await f.request(1, '/api/admin/data-reset', { method: 'POST', body: {
    backup_confirmed: true, confirmation: '開催データをリセット',
    expected_user_count: preview.user_count, expected_order_count: preview.order_count, expected_other_session_count: preview.other_session_count,
    expected_cash_receipt_snapshot_token: preview.cash_receipt_snapshot_token,
  } })).status, 200);
  assert.equal(f.rows('cash_receipts').length, 0);
  assert.equal(f.rows('users').length, 1);
  assert.equal(f.rows('users')[0].role, 'admin');
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(audits(f).length, 2);
});

for (const concurrent of [false, true]) test(`event reset rejects changed receipt revision ${concurrent ? 'inside the write transaction' : 'after the preview'}`, async (t) => {
  const f = await createFixture(t); f.addOrder();
  await record(f, 3, (await person(f)).cash_receipt_snapshot_token);
  const preview = (await (await f.request(1, '/api/admin/data-reset/preview')).json()).data;
  assert.equal(preview.cash_receipt_count, 1);
  assert.equal(preview.cash_snapshot, undefined);
  assert.match(preview.cash_receipt_snapshot_token, /^[A-Za-z0-9_-]{43}$/);
  const change = () => f.sqlite.exec('UPDATE cash_receipts SET revision = revision + 1');
  if (concurrent) f.activity.beforeBatch = (statements) => {
    if (!statements[0]?.sql.includes('INSERT INTO oauth_states')) return;
    f.activity.beforeBatch = null; change();
  };
  else change();
  const response = await f.request(1, '/api/admin/data-reset', { method: 'POST', body: {
    backup_confirmed: true, confirmation: '開催データをリセット',
    expected_user_count: preview.user_count, expected_order_count: preview.order_count,
    expected_other_session_count: preview.other_session_count,
    expected_cash_receipt_snapshot_token: preview.cash_receipt_snapshot_token,
  } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'RESET_PREVIEW_STALE');
  assert.equal(f.rows('users').length, 5);
  assert.equal(f.rows('orders').length, 1);
  assert.equal(f.rows('cash_receipts').length, 1);
  assert.equal(f.rows('audit_logs').some((row) => row.action_type === 'EVENT_DATA_RESET'), false);
});

test('event reset requires the cash preview token even when there are no receipts', async (t) => {
  const f = await createFixture(t);
  const preview = (await (await f.request(1, '/api/admin/data-reset/preview')).json()).data;
  const response = await f.request(1, '/api/admin/data-reset', { method: 'POST', body: {
    backup_confirmed: true, confirmation: '開催データをリセット',
    expected_user_count: preview.user_count, expected_order_count: preview.order_count,
    expected_other_session_count: preview.other_session_count,
  } });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'RESET_CASH_SNAPSHOT_INVALID');
  assert.equal(f.rows('users').length, 5);
});

test('an old zero-yen admin receipt request cannot recreate its record after a full event reset', async (t) => {
  const f = await createFixture(t);
  const initial = await person(f, 1);
  await record(f, 1, initial.cash_receipt_snapshot_token);
  const preview = (await (await f.request(1, '/api/admin/data-reset/preview')).json()).data;
  assert.equal((await f.request(1, '/api/admin/data-reset', { method: 'POST', body: {
    backup_confirmed: true, confirmation: '開催データをリセット',
    expected_user_count: preview.user_count, expected_order_count: preview.order_count,
    expected_other_session_count: preview.other_session_count,
    expected_cash_receipt_snapshot_token: preview.cash_receipt_snapshot_token,
  } })).status, 200);
  const afterReset = await person(f, 1);
  assert.equal(afterReset.total_price, 0);
  assert.notEqual(afterReset.cash_receipt_snapshot_token, initial.cash_receipt_snapshot_token);
  assert.equal((await record(f, 1, initial.cash_receipt_snapshot_token)).status, 409);
  assert.equal(f.rows('cash_receipts').length, 0);
  assert.equal((await record(f, 1, afterReset.cash_receipt_snapshot_token)).status, 200);
});
