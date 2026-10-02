import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { app } from '../index.ts';
import { deriveCsrfToken, sha256Base64Url } from '../security.js';

export async function createFixture(t, { lastMigration } = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External traffic is disabled in tests'); });
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    if (lastMigration && file > lastMigration) break;
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const now = Math.floor(Date.now() / 1000);
  const tokens = new Map();
  for (const [id, role, group] of [[1, 'admin', '運営'], [2, 'manager', 'テスト席A'], [3, 'member', 'テスト席A'], [4, 'member', 'テスト席B'], [5, 'manager', 'テスト席B']]) {
    sqlite.prepare('INSERT INTO users (id, name, group_id, role, discord_id_hmac) VALUES (?, ?, ?, ?, ?)')
      .run(id, id === 3 || id === 4 ? '同名のテスト参加者' : `テスト利用者${id}`, group, role, 'v1.' + String(id).padStart(43, '0'));
    const token = `test-only-session-token-with-enough-entropy-for-user-${id}`;
    tokens.set(id, token);
    sqlite.prepare('INSERT INTO auth_sessions (id, token_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, await sha256Base64Url(token), id, now, now, now + 3600, now + 7200);
  }
  sqlite.prepare('INSERT INTO menu_items (id, category, name, size, price) VALUES (?, ?, ?, ?, ?)').run(1, 'テスト', 'テスト料理', '通常', 300);
  sqlite.prepare('INSERT INTO oauth_states (state_hash, created_at, expires_at) VALUES (?, ?, ?)').run('existing-oauth-state', now, now + 600);
  const activity = { beforeBatch: null, pending: [], rollbacks: 0 };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        sql,
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
        async run() {
          const statement = sqlite.prepare(sql);
          if (statement.columns().length) return { success: true, results: statement.all(...values), meta: {} };
          const result = statement.run(...values);
          return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    },
    async batch(statements) {
      activity.beforeBatch?.(statements);
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); activity.rollbacks += 1; throw error; }
    },
  };
  const origin = 'https://app.example.test';
  const env = { APP_ENV: 'local', ALLOWED_ORIGINS: origin, FRONTEND_URL: origin, DB: db };
  const fixture = {
    sqlite, env, now, activity,
    rows: (table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    addOrder({ userId = 3, quantity = 1, status = 'pending', requestId = 'test_request_' + crypto.randomUUID(), source = 'self' } = {}) {
      const result = sqlite.prepare(`INSERT INTO orders
        (user_id, menu_item_id, quantity, status, menu_name_snapshot, menu_size_snapshot, unit_price_snapshot,
         client_request_id, order_source, created_by_user_id, created_at, updated_at)
        VALUES (?, 1, ?, ?, 'テスト料理', '通常', 300, ?, ?, ?, ?, ?)`)
        .run(userId, quantity, status, requestId, source, source === 'admin' ? 1 : userId, now, now);
      return Number(result.lastInsertRowid);
    },
    async request(userId, path, { method = 'GET', body, csrf = true, cookie = true } = {}) {
      const headers = { Origin: origin, 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = `reitaisai_session=${tokens.get(userId)}`;
      if (csrf) headers['X-CSRF-Token'] = await deriveCsrfToken(tokens.get(userId));
      return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env, {
        waitUntil(promise) { activity.pending.push(promise); }, passThroughOnException() {}, props: {},
      });
    },
    async flush() { await Promise.all(activity.pending.splice(0)); },
  };
  t.after(async () => { await fixture.flush(); sqlite.close(); });
  return fixture;
}
