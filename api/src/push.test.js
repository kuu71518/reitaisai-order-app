import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedPushEndpoint, getPushConfig, notifyOrder, vapidAuthorization } from './push.ts';
import { createFixture } from './test-support/database.js';

async function configure(f) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  f.env.WEB_PUSH_PUBLIC_KEY = Buffer.from(pub).toString('base64url');
  f.env.WEB_PUSH_PRIVATE_KEY = privateJwk.d;
  return pair;
}
function addSubscription(f, userId, suffix = userId) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-device-${suffix}`;
  f.sqlite.prepare('INSERT INTO push_subscriptions VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(endpoint, userId, userId, f.env.WEB_PUSH_PUBLIC_KEY, f.now, f.now);
  return endpoint;
}

test('push endpoint allowlist blocks arbitrary hosts, redirects via URL syntax, credentials, local IPs and ports', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/v2/test',
    'https://web.push.apple.com/test', 'https://wns2-test.notify.windows.com/w/?token=test']) assert.equal(allowedPushEndpoint(endpoint), true);
  for (const endpoint of [null, 'http://fcm.googleapis.com/fcm/send/test', 'https://attacker.test/push',
    'https://fcm.googleapis.com.attacker.test/push', 'https://fcm.googleapis.com@attacker.test/push',
    'https://attacker@fcm.googleapis.com/push', 'https://fcm.googleapis.com:8080/push',
    'https://127.0.0.1/push', 'https://[::1]/push', 'https://fcm.googleapis.com/push#secret']) assert.equal(allowedPushEndpoint(endpoint), false);
});

test('VAPID signs a verifiable ES256 JWT for the push origin with a bounded expiration', async (t) => {
  const f = await createFixture(t); const pair = await configure(f);
  const config = getPushConfig(f.env);
  const authorization = await vapidAuthorization(config, 'https://fcm.googleapis.com/fcm/send/test', f.now);
  const token = authorization.match(/^vapid t=([^,]+), k=/)[1];
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: f.now + 3600, sub: f.env.FRONTEND_URL });
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)), true);
  assert.equal(getPushConfig({ ...f.env, WEB_PUSH_PRIVATE_KEY: 'invalid' }), null);
});

test('notification registration requires manager/admin, CSRF, valid endpoint/key; binds only the authenticated session', async (t) => {
  const f = await createFixture(t); await configure(f);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-register';
  const body = { endpoint, public_key: f.env.WEB_PUSH_PUBLIC_KEY, user_id: 5, session_id: 5 };
  for (const userId of [1, 2]) assert.equal((await f.request(userId, '/api/notifications/config')).status, 200);
  assert.equal((await f.request(3, '/api/notifications/config')).status, 403);
  assert.equal((await f.request(3, '/api/notifications/subscriptions', { method: 'POST', body })).status, 403);
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body, csrf: false })).status, 403);
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body: { ...body, endpoint: 'https://attacker.test/push' } })).status, 422);
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body: { ...body, public_key: 'old-key' } })).status, 422);
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body })).status, 200);
  assert.equal(f.rows('push_subscriptions')[0].user_id, 1);
  assert.equal(f.rows('push_subscriptions')[0].session_id, 1);
  assert.equal((await f.request(2, '/api/notifications/subscriptions', { method: 'DELETE', body: { endpoint } })).status, 200);
  assert.equal(f.rows('push_subscriptions').length, 1);
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'DELETE', body: { endpoint } })).status, 200);
  assert.equal(f.rows('push_subscriptions').length, 0);
});

test('notification registrations are capped at five active devices and can refresh an existing device', async (t) => {
  const f = await createFixture(t); await configure(f);
  for (let index = 0; index < 5; index += 1) addSubscription(f, 1, index);
  const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-new', public_key: f.env.WEB_PUSH_PUBLIC_KEY };
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body })).status, 409);
  body.endpoint = 'https://fcm.googleapis.com/fcm/send/test-device-0';
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body })).status, 200);
});

test('expired keys do not block device registration after key rotation', async (t) => {
  const f = await createFixture(t); await configure(f);
  for (let index = 0; index < 5; index += 1) addSubscription(f, 1, index);
  await configure(f);
  const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/new-key-device', public_key: f.env.WEB_PUSH_PUBLIC_KEY };
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body })).status, 200);
  assert.equal(f.rows('push_subscriptions').filter((row) => row.application_server_key === body.public_key).length, 1);
});

test('notification configuration fails closed until valid keys are configured', async (t) => {
  const f = await createFixture(t);
  assert.deepEqual((await (await f.request(1, '/api/notifications/config')).json()).data, { configured: false, public_key: null });
  assert.equal((await f.request(1, '/api/notifications/subscriptions', { method: 'POST', body: {} })).status, 503);
  await notifyOrder(f.env, f.addOrder());
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('concurrent arrivals share one generic notification per device within five seconds', async (t) => {
  const f = await createFixture(t); await configure(f); addSubscription(f, 1);
  const first = f.addOrder(); const second = f.addOrder();
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  await Promise.all([notifyOrder(f.env, first), notifyOrder(f.env, second)]);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  f.sqlite.exec('UPDATE push_subscriptions SET last_sent_at = last_sent_at - 6');
  await notifyOrder(f.env, f.addOrder());
  assert.equal(globalThis.fetch.mock.callCount(), 2);
});

test('orders notify the admin and same-group manager only, with no payload or participant information', async (t) => {
  const f = await createFixture(t); await configure(f);
  const admin = addSubscription(f, 1); const manager = addSubscription(f, 2);
  addSubscription(f, 3); addSubscription(f, 5);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent.push({ url, options }); return new Response(null, { status: 201 }); });
  const response = await f.request(3, '/api/orders', { method: 'POST', body: { menu_item_id: 1, quantity: 1, request_id: 'push_test_request_123456' } });
  assert.equal(response.status, 200); await f.flush();
  assert.deepEqual(sent.map((item) => item.url).sort(), [admin, manager].sort());
  for (const { options } of sent) {
    assert.equal(options.body, undefined); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.TTL, '300'); assert.equal(options.headers.Topic, 'pending-orders');
  }
  assert.equal((await f.request(3, '/api/orders', { method: 'POST', body: { menu_item_id: 1, quantity: 1, request_id: 'push_test_request_123456' } })).status, 200);
  await f.flush(); assert.equal(sent.length, 2);
});

for (const invalidation of ['logout', 'expired', 'disabled', 'demoted', 'moved', 'old-key', 'order-cleared']) {
  test(`push delivery rechecks ${invalidation} and sends nothing to ineligible recipients`, async (t) => {
    const f = await createFixture(t); await configure(f); addSubscription(f, 2);
    const id = f.addOrder();
    if (invalidation === 'logout') await f.request(2, '/api/auth/logout', { method: 'POST' });
    if (invalidation === 'expired') f.sqlite.prepare('UPDATE auth_sessions SET absolute_expires_at = ? WHERE id = 2').run(f.now - 1);
    if (invalidation === 'disabled') f.sqlite.exec('UPDATE users SET is_active = 0 WHERE id = 2');
    if (invalidation === 'demoted') f.sqlite.exec("UPDATE users SET role = 'member' WHERE id = 2");
    if (invalidation === 'moved') f.sqlite.exec("UPDATE users SET group_id = '別の席' WHERE id = 2");
    if (invalidation === 'old-key') f.sqlite.exec("UPDATE push_subscriptions SET application_server_key = 'old-key'");
    if (invalidation === 'order-cleared') f.sqlite.exec('DELETE FROM orders');
    await notifyOrder(f.env, id);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
}

for (const status of [404, 410]) test(`expired push endpoint ${status} is removed`, async (t) => {
  const f = await createFixture(t); await configure(f); addSubscription(f, 1); const id = f.addOrder();
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
  await notifyOrder(f.env, id); assert.equal(f.rows('push_subscriptions').length, 0);
});

test('push service failure never rejects, deletes or duplicates the accepted order and logs no endpoint', async (t) => {
  const f = await createFixture(t); await configure(f); addSubscription(f, 1);
  const logs = []; t.mock.method(console, 'error', (message) => logs.push(message));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('https://private-push-endpoint.test/secret'); });
  const response = await f.request(3, '/api/orders', { method: 'POST', body: { menu_item_id: 1, quantity: 1, request_id: 'push_failure_request_123456' } });
  assert.equal(response.status, 200); await f.flush();
  assert.equal(f.rows('orders').length, 1); assert.equal(f.rows('push_subscriptions').length, 1);
  assert.deepEqual(logs, ['{"event":"order_push_delivery_failed"}']);
});
