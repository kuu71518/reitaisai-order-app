import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationHistory, emptyHistory, HISTORY_LIMIT, notificationOrderKeys, notificationScope, unreadNotifications, updateHistory } from './notificationHistory.js';

const apply = (state, action) => updateHistory(state, { now: 100_000, id: 'receipt-1', ...action });

test('first poll creates a baseline; new receipts and unread/read state survive serialized reload', () => {
  const first = apply(emptyHistory(), { type: 'orders', ids: ['old-order'] });
  assert.equal(first.newCount, 0);
  assert.equal(first.state.entries.length, 0);
  const newOrders = apply(first.state, { type: 'orders', ids: ['old-order', 'new-order', 'new-order'] });
  assert.equal(newOrders.newCount, 1);
  assert.equal(unreadNotifications(newOrders.state), 1);
  const reloaded = JSON.parse(JSON.stringify(newOrders.state));
  assert.equal(apply(reloaded, { type: 'orders', ids: ['old-order', 'new-order'] }).newCount, 0);
  const read = apply(reloaded, { type: 'read', ids: ['receipt-1'] });
  assert.equal(unreadNotifications(read.state), 0);
  assert.equal(unreadNotifications(reloaded), 1, 'reading must not mutate a prior snapshot');
  assert.equal(unreadNotifications(JSON.parse(JSON.stringify(read.state))), 0);
});

test('a closed-app push is recorded before any poll, and resuming does not create a duplicate receipt or sound', () => {
  const baseline = apply(emptyHistory(), { type: 'orders', ids: ['old'] }).state;
  const push = apply(baseline, { type: 'push', id: 'push-1' }).state;
  assert.equal(unreadNotifications(push), 1);
  const resumed = apply(push, { type: 'orders', ids: ['old', 'new-1', 'new-2'] });
  assert.equal(resumed.state.entries.length, 1);
  assert.equal(resumed.state.entries[0].count, 2);
  assert.equal(resumed.alert, false);
  const subsequent = apply(resumed.state, { type: 'orders', ids: ['old', 'new-1', 'new-2', 'new-3'], now: 150_000, id: 'app-2' });
  assert.equal(subsequent.state.entries.length, 2);
  assert.equal(subsequent.alert, true);
});

test('a push arriving just after an in-app alert merges its generic receipt without retaining payload data', () => {
  const baseline = apply(emptyHistory(), { type: 'orders', ids: [] }).state;
  const app = apply(baseline, { type: 'orders', ids: ['new'], id: 'app' }).state;
  const read = apply(app, { type: 'read', ids: 'all' }).state;
  const push = apply(read, { type: 'push', now: 105_000, id: 'push', payload: 'private-name' }).state;
  assert.equal(push.entries.length, 1);
  assert.equal(unreadNotifications(push), 1);
  assert.equal(push.entries[0].source, 'push');
  assert.equal(JSON.stringify(push).includes('private-name'), false);
});

test('marking one notification never marks a later arrival; mark-all keeps already-read timestamps', () => {
  let state = apply(emptyHistory(), { type: 'push', id: 'a' }).state;
  state = apply(state, { type: 'push', id: 'b', now: 120_000 }).state;
  state = apply(state, { type: 'read', ids: ['a'], now: 130_000 }).state;
  assert.equal(unreadNotifications(state), 1);
  state = apply(state, { type: 'read', ids: 'all', now: 140_000 }).state;
  assert.equal(unreadNotifications(state), 0);
  assert.equal(state.entries.find((entry) => entry.id === 'a').readAt, 130_000);
});

test('marking the displayed batch as read preserves a notification received after the click', () => {
  let state = apply(emptyHistory(), { type: 'push', id: 'displayed' }).state;
  const displayedIds = state.entries.map((entry) => entry.id);
  state = apply(state, { type: 'push', id: 'arrived-later', now: 120_000 }).state;
  state = apply(state, { type: 'read', ids: displayedIds, now: 130_000 }).state;
  assert.equal(unreadNotifications(state), 1);
  assert.equal(state.entries[0].id, 'arrived-later');
  assert.equal(state.entries[0].readAt, null);
});

test('history is bounded and successive push receipts remain ordered', () => {
  let state = emptyHistory();
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) state = apply(state, { type: 'push', id: String(i), now: 100_000 + i * 20_000 }).state;
  assert.equal(state.entries.length, HISTORY_LIMIT);
  assert.equal(state.entries[0].id, String(HISTORY_LIMIT + 9));
  assert.equal(state.entries.at(-1).id, '10');
});

test('account, role and assigned group get independent opaque scopes; members cannot have notification history', async () => {
  const user = { id: 12, role: 'manager', group_id: 'dummy-group', name: 'Private name' };
  const scope = await notificationScope(user);
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(scope, await notificationScope({ ...user, name: 'Renamed' }));
  for (const other of [{ ...user, id: 13 }, { ...user, role: 'chief' }, { ...user, group_id: 'other' }]) {
    assert.notEqual(scope, await notificationScope(other));
  }
  assert.equal(await notificationScope({ ...user, role: 'member' }), null);
  const keys = await notificationOrderKeys(scope, [{ id: 1, name: 'Never store' }, { id: 1 }, { id: -1 }, { id: '2' }]);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
});

test('even without IndexedDB, account isolation and logout guards hold and persistence failure is explicit', async () => {
  const history = createNotificationHistory(null);
  await history.activate('account-a');
  await history.update('account-a', { type: 'push', id: 'a', now: 100_000 });
  const first = await history.read('account-a');
  assert.equal(first.persistent, false);
  assert.equal(unreadNotifications(first.state), 1);
  await history.activate('account-b');
  assert.equal(unreadNotifications((await history.read('account-b')).state), 0);
  assert.equal((await history.update('account-a', { type: 'read', ids: 'all', now: 110_000 })).state, undefined);
  await history.deactivate('account-a');
  assert.equal((await history.receivePush(130_000)).scope, 'account-b', 'late logout of an old account must not affect the new account');
  await history.deactivate('account-b');
  assert.equal(await history.receivePush(150_000), null);
  assert.equal(unreadNotifications((await history.read('account-a')).state), 1);
});

test('authentication as a member or guest can clear a previous browser account binding without removing its history', async () => {
  const history = createNotificationHistory(null);
  await history.activate('prior-chief');
  await history.update('prior-chief', { type: 'push', id: 'old', now: 100_000 });
  await history.deactivate();
  assert.equal(await history.receivePush(120_000), null);
  assert.equal(unreadNotifications((await history.read('prior-chief')).state), 1);
});
