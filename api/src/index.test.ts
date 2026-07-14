import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from './index.ts';
import type { Bindings } from './types.ts';

const allowedOrigin = 'https://app.example.test';
const env = {
  APP_ENV: 'production',
  ALLOWED_ORIGINS: allowedOrigin,
} as Bindings;

test('health endpoint is public and never cacheable', async () => {
  const response = await app.request('/api/health', {}, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { success: true, data: { status: 'ok' } });
});

test('protected endpoints reject a missing session before touching D1', async () => {
  const response = await app.request('/api/menu', {
    headers: { Origin: allowedOrigin },
  }, env);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
});

test('unsafe requests reject a missing or unknown Origin', async () => {
  const missingOrigin = await app.request('/api/orders', { method: 'POST' }, env);
  assert.equal(missingOrigin.status, 403);

  const unknownOrigin = await app.request('/api/orders', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  }, env);
  assert.equal(unknownOrigin.status, 403);
  assert.equal(unknownOrigin.headers.get('Access-Control-Allow-Origin'), null);
});

test('preflight allows only the configured exact Origin', async () => {
  const allowed = await app.request('/api/orders', {
    method: 'OPTIONS',
    headers: { Origin: allowedOrigin },
  }, env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.match(allowed.headers.get('Access-Control-Allow-Headers') || '', /X-CSRF-Token/);

  const denied = await app.request('/api/orders', {
    method: 'OPTIONS',
    headers: { Origin: 'https://preview.app.example.test' },
  }, env);
  assert.equal(denied.status, 403);
});
