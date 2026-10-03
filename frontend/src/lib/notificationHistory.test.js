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

test('an administrator clear removes read and unread receipts in every stored scope while retaining alert preferences and the active account', async () => {
  const history = createNotificationHistory(null);
  await history.activate('manager');
  await history.update('manager', { type: 'push', id: 'old-manager', now: 100_000 });
  await history.update('manager', { type: 'preferences', sound: false, vibration: true });
  await history.activate('chief');
  await history.update('chief', { type: 'push', id: 'old-chief', now: 100_000 });
  await history.update('chief', { type: 'read', ids: 'all', now: 110_000 });
  assert.equal((await history.clear(12)).cleared, true);
  for (const scope of ['manager', 'chief']) {
    const { state } = await history.read(scope);
    assert.deepEqual(state.entries, []);
    assert.deepEqual(state.observed, []);
    assert.equal(unreadNotifications(state), 0);
  }
  assert.deepEqual((await history.read('manager')).state.preferences, { sound: false, vibration: true });
  assert.equal((await history.receivePush(130_000)).scope, 'chief');
});

test('another device observes the server revision on its next poll and still alerts for orders placed after that clear', async () => {
  const history = createNotificationHistory(null);
  await history.activate('manager');
  await history.update('manager', { type: 'orders', ids: ['old'], revision: 0, now: 100_000, id: 'baseline' });
  await history.update('manager', { type: 'push', now: 120_000, id: 'old-receipt' });
  const result = await history.update('manager', { type: 'orders', ids: ['new-after-clear'], revision: 8, now: 150_000, id: 'new-receipt' });
  assert.equal(result.cleared, true);
  assert.equal(result.newCount, 1);
  assert.equal(result.alert, true);
  assert.deepEqual(result.state.entries.map((row) => row.id), ['new-receipt']);
  assert.equal(unreadNotifications(result.state), 1);
});

test('the same or an older clear cannot remove notifications received after a completed reset', async () => {
  const history = createNotificationHistory(null);
  await history.activate('chief');
  await history.update('chief', { type: 'orders', ids: [], revision: 0, now: 100_000, id: 'baseline' });
  await history.clear(10);
  await history.update('chief', { type: 'orders', ids: ['new'], revision: 10, now: 120_000, id: 'new-receipt' });
  assert.equal((await history.clear(10)).cleared, false);
  assert.equal((await history.clear(9)).ignored, true);
  assert.equal((await history.update('chief', { type: 'orders', ids: ['deleted'], revision: 0, now: 140_000, id: 'stale-response' })).ignored, true);
  assert.deepEqual((await history.read('chief')).state.entries.map((row) => row.id), ['new-receipt']);
});

test('a first visit after a previous global clear still establishes a quiet baseline, and invalid revisions cannot clear history', async () => {
  const history = createNotificationHistory(null);
  await history.activate('first-visit');
  const result = await history.update('first-visit', { type: 'orders', ids: ['existing'], revision: 4, now: 100_000, id: 'first' });
  assert.equal(result.newCount, 0);
  for (const revision of [-1, 0, 1.5, '4', null, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(history.clear(revision));
  assert.deepEqual((await history.read('first-visit')).state.observed, ['existing']);
});
