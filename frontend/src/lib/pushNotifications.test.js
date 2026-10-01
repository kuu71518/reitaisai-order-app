import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { applicationServerKey, registerPushEvents, subscriptionUsesKey } from './pushNotifications.js';

test('browser subscription detects a rotated application key and rejects malformed configuration', () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, index) => index ? 1 : 4);
  const key = Buffer.from(bytes).toString('base64url');
  assert.deepEqual(applicationServerKey(key), bytes);
  assert.equal(subscriptionUsesKey({ options: { applicationServerKey: bytes.buffer } }, key), true);
  const other = bytes.slice(); other[12] = 2;
  assert.equal(subscriptionUsesKey({ options: { applicationServerKey: other.buffer } }, key), false);
  assert.equal(subscriptionUsesKey(null, key), false);
  assert.throws(() => applicationServerKey('invalid'));
});

test('service worker displays a generic notification even for an empty push and never displays payload data', async () => {
  const handlers = {}; const shown = [];
  registerPushEvents({ addEventListener: (name, handler) => { handlers[name] = handler; },
    registration: { showNotification: async (...args) => { shown.push(args); } } });
  let finished;
  handlers.push({ data: { text: () => 'private content must not be displayed' }, waitUntil: (promise) => { finished = promise; } });
  await finished;
  assert.equal(shown[0][0], '新しい注文があります');
  assert.equal(shown[0][1].tag, 'pending-orders');
  assert.equal(JSON.stringify(shown).includes('private content'), false);
});

for (const open of [true, false]) test(`notification click ${open ? 'focuses the app without losing the cart' : 'opens the manager view'}`, async () => {
  const handlers = {}; const messages = []; const opened = []; let focused = false; let closed = false;
  const client = { url: 'https://app.example.test/', focus: async () => { focused = true; }, postMessage: (message) => messages.push(message) };
  registerPushEvents({ addEventListener: (name, handler) => { handlers[name] = handler; }, location: { origin: 'https://app.example.test' },
    clients: { matchAll: async () => open ? [client] : [], openWindow: async (url) => opened.push(url) } });
  let finished;
  handlers.notificationclick({ notification: { close: () => { closed = true; } }, waitUntil: (promise) => { finished = promise; } });
  await finished;
  assert.equal(closed, true);
  if (open) { assert.equal(focused, true); assert.deepEqual(messages, [{ type: 'OPEN_MANAGER_ORDERS' }]); assert.deepEqual(opened, []); }
  else assert.deepEqual(opened, ['https://app.example.test/?view=manager']);
});
