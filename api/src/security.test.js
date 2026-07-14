import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanText,
  createVerificationCode,
  deriveCsrfToken,
  hasRole,
  isAllowedOrigin,
  isClientRequestId,
  isDiscordSnowflake,
  isUnsafeMethod,
  normalizeVerificationCode,
  parseAllowedOrigins,
  parsePositiveInteger,
  randomToken,
  sha256Base64Url,
  timingSafeEqual,
} from './security.js';

test('randomToken creates URL-safe high-entropy values', () => {
  const first = randomToken();
  const second = randomToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('session and CSRF digests are stable but separated', async () => {
  const token = 'test-session-token';
  assert.equal(await sha256Base64Url(token), await sha256Base64Url(token));
  assert.notEqual(await sha256Base64Url(token), await deriveCsrfToken(token));
});

test('verification codes are easy to read and normalize safely', () => {
  const code = createVerificationCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(normalizeVerificationCode(`${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`), code);
  assert.equal(normalizeVerificationCode('IIII-0000'), '');
});

test('timingSafeEqual rejects mismatches', () => {
  assert.equal(timingSafeEqual('same-value', 'same-value'), true);
  assert.equal(timingSafeEqual('same-value', 'other-value'), false);
  assert.equal(timingSafeEqual('short', 'longer'), false);
});

test('origin allowlist accepts exact configured origins only', () => {
  const configured = 'https://app.example.test, http://127.0.0.1:5173,https://app.example.test';
  assert.deepEqual(parseAllowedOrigins(configured), ['https://app.example.test', 'http://127.0.0.1:5173']);
  assert.equal(isAllowedOrigin('https://app.example.test', configured), true);
  assert.equal(isAllowedOrigin('https://preview.app.example.test', configured), false);
  assert.equal(isAllowedOrigin('null', configured), false);
});

test('authorization and input helpers reject client-controlled invalid values', () => {
  assert.equal(hasRole('manager', ['manager', 'admin']), true);
  assert.equal(hasRole('member', ['manager', 'admin']), false);
  assert.equal(isUnsafeMethod('PATCH'), true);
  assert.equal(isUnsafeMethod('GET'), false);
  assert.equal(isDiscordSnowflake('123456789012345678'), true);
  assert.equal(isDiscordSnowflake('display-name'), false);
  assert.equal(parsePositiveInteger('20', 20), 20);
  assert.equal(parsePositiveInteger('21', 20), null);
  assert.equal(cleanText('  注文名  ', 20), '注文名');
  assert.equal(cleanText('too long', 3), '');
  assert.equal(isClientRequestId('request_1234567890'), true);
  assert.equal(isClientRequestId('short'), false);
});
