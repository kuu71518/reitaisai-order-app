import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { app } from './index.ts';
import { deriveCsrfToken, deriveDiscordIdHmac, sha256Base64Url } from './security.js';

const origin = 'https://app.example.test';
const apiOrigin = 'https://api.example.test';
const hmacKey = 'test-only-discord-hmac-key-with-32-characters';
const discordId = '123456789012345678';
const sessionToken = 'persistent-session-test-token-with-enough-entropy';
const day = 24 * 60 * 60;
const startTime = 1_800_000_000;

// Run the actual session SQL against the repository schema in memory. No D1,
// local database files, real Discord account, or external network is used.
async function createFixture(t, { role = 'member', age = 0, idleExpiry, absoluteExpiry } = {}) {
  t.mock.method(Date, 'now', () => startTime * 1000);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external request in session test');
  });
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of [
    '0001_initial.sql',
    '0002_security_constraints.sql',
    '0003_discord_allowlist_and_admin_orders.sql',
  ]) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));

  const discordHmac = await deriveDiscordIdHmac(hmacKey, discordId);
  sqlite.prepare('INSERT INTO users (id, name, group_id, role, discord_id_hmac) VALUES (?, ?, ?, ?, ?)')
    .run(1, '架空の参加者', 'テスト班', role, discordHmac);
  const tokenHash = await sha256Base64Url(sessionToken);
  sqlite.prepare(`
    INSERT INTO auth_sessions
      (id, token_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, tokenHash, 1, startTime - age, startTime - age,
    idleExpiry ?? startTime - age + 30 * day,
    absoluteExpiry ?? startTime - age + 30 * day);

  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...bindings) { values = bindings; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, results: [], meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const env = {
    APP_ENV: 'production',
    ALLOWED_ORIGINS: origin,
    FRONTEND_URL: origin,
    SESSION_SITE_DOMAIN: 'example.test',
    DISCORD_CLIENT_ID: '123456789012345679',
    DISCORD_CLIENT_SECRET: 'test-only-client-secret',
    DISCORD_REDIRECT_URI: `${apiOrigin}/api/auth/discord/callback`,
    DISCORD_ID_HMAC_KEY: hmacKey,
    DB: db,
  };
  return {
    env,
    sqlite,
    headers: { Cookie: `__Host-reitaisai_session=${sessionToken}` },
    async unsafeHeaders() {
      return {
        Cookie: `__Host-reitaisai_session=${sessionToken}`,
        Origin: origin,
        'X-CSRF-Token': await deriveCsrfToken(sessionToken),
      };
    },
  };
}

test('Discord login creates a persistent host-only secure cookie and a hashed session with a fixed 30-day limit', async (t) => {
  const fixture = await createFixture(t);
  const begin = await app.request(`${apiOrigin}/api/auth/discord/start`, {}, fixture.env);
  assert.equal(begin.status, 302);
  const state = new URL(begin.headers.get('Location')).searchParams.get('state');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      return Response.json({ access_token: 'test-only-access-token', token_type: 'Bearer' });
    }
    if (url === 'https://discord.com/api/v10/users/@me') return Response.json({ id: discordId });
    throw new Error('Unexpected external request in OAuth test');
  });
  const response = await app.request(`${apiOrigin}/api/auth/discord/callback?state=${state}&code=test-code`, {
    headers: { Cookie: `__Host-reitaisai_oauth_state=${state}` },
  }, fixture.env);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('Location')).searchParams.get('auth'), 'success');
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('__Host-reitaisai_session='));
  assert.ok(cookie);
  for (const attribute of ['Max-Age=2592000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(cookie.includes(attribute), `missing ${attribute}`);
  }
  assert.equal(cookie.includes('Domain='), false);
  const issuedToken = cookie.split(';')[0].split('=')[1];
  assert.notEqual(issuedToken, sessionToken);
  const row = fixture.sqlite.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?')
    .get(await sha256Base64Url(issuedToken));
  assert.ok(row);
  assert.equal(row.created_at, startTime);
  assert.equal(row.idle_expires_at, startTime + 30 * day);
  assert.equal(row.absolute_expires_at, startTime + 30 * day);
  assert.equal(JSON.stringify(row).includes(issuedToken), false);
  assert.equal(calls.length, 2);
});

for (const age of [day, 29 * day, 30 * day - 1]) {
  test(`session restores after ${age} seconds without visiting Discord or extending its deadline`, async (t) => {
    const fixture = await createFixture(t, { age });
    const response = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.id, 1);
    assert.equal(body.csrf_token, await deriveCsrfToken(sessionToken));
    assert.equal(body.session_token, undefined);
    const row = fixture.sqlite.prepare('SELECT * FROM auth_sessions WHERE id = 1').get();
    assert.equal(row.created_at, startTime - age);
    assert.equal(row.last_seen_at, startTime);
    assert.equal(row.absolute_expires_at, startTime - age + 30 * day);
    assert.equal(row.idle_expires_at, row.absolute_expires_at);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
}

test('exactly 30 days after authentication, the session is rejected and its browser cookie is cleared', async (t) => {
  const fixture = await createFixture(t, { age: 30 * day });
  const response = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  assert.match(response.headers.get('Set-Cookie'), /__Host-reitaisai_session=.*Max-Age=0/);
  assert.equal(fixture.sqlite.prepare('SELECT last_seen_at FROM auth_sessions WHERE id = 1').get().last_seen_at,
    startTime - 30 * day);
});

test('old sessions retain their original absolute deadline and are not silently upgraded', async (t) => {
  const fixture = await createFixture(t, { age: day, absoluteExpiry: startTime });
  const response = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
  assert.equal(response.status, 401);
  assert.equal(fixture.sqlite.prepare('SELECT absolute_expires_at FROM auth_sessions WHERE id = 1').get().absolute_expires_at,
    startTime);
});

test('an expired idle deadline cannot be revived by the new retention policy', async (t) => {
  const fixture = await createFixture(t, { idleExpiry: startTime });
  const response = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
  assert.equal(response.status, 401);
});

test('explicit logout revokes the persistent session and replaying its old cookie fails', async (t) => {
  const fixture = await createFixture(t, { age: day });
  const response = await app.request('/api/auth/logout', {
    method: 'POST', headers: await fixture.unsafeHeaders(),
  }, fixture.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(fixture.sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id = 1').get().revoked_at, startTime);
  const replay = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
  assert.equal(replay.status, 401);
});

for (const change of [
  'UPDATE users SET is_active = 0 WHERE id = 1',
  'UPDATE users SET discord_id_hmac = NULL WHERE id = 1',
  'UPDATE auth_sessions SET revoked_at = 1 WHERE id = 1',
]) {
  test(`persistent login checks current access: ${change.split(' SET ')[1].split(' WHERE ')[0]}`, async (t) => {
    const fixture = await createFixture(t, { age: day });
    fixture.sqlite.exec(change);
    const response = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  });
}

test('persistent login returns the current group and role from the database', async (t) => {
  const fixture = await createFixture(t, { age: day, role: 'manager' });
  fixture.sqlite.exec("UPDATE users SET role = 'member', group_id = '変更後の班' WHERE id = 1");
  const response = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.user.role, 'member');
  assert.equal(body.user.group_id, '変更後の班');
  const denied = await app.request('/api/admin/users', { headers: fixture.headers }, fixture.env);
  assert.equal(denied.status, 403);
});

test('persistent login still requires CSRF on unsafe requests', async (t) => {
  const fixture = await createFixture(t, { age: day });
  const response = await app.request('/api/auth/logout', {
    method: 'POST', headers: { ...fixture.headers, Origin: origin },
  }, fixture.env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'CSRF_FAILED');
  assert.equal(fixture.sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id = 1').get().revoked_at, null);
});

test('ordinary activity never satisfies the recent administrator authentication requirement', async (t) => {
  const fixture = await createFixture(t, { age: day, role: 'admin' });
  const restored = await app.request('/api/auth/me', { headers: fixture.headers }, fixture.env);
  assert.equal(restored.status, 200);
  const denied = await app.request('/api/admin/users/2', {
    method: 'DELETE', headers: await fixture.unsafeHeaders(),
  }, fixture.env);
  assert.equal(denied.status, 428);
  assert.equal((await denied.json()).code, 'RECENT_LOGIN_REQUIRED');
  const row = fixture.sqlite.prepare('SELECT created_at, last_seen_at FROM auth_sessions WHERE id = 1').get();
  assert.equal(row.created_at, startTime - day);
  assert.equal(row.last_seen_at, startTime);
});
