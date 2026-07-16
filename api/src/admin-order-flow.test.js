import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from './index.ts';
import { deriveCsrfToken } from './security.js';

const origin = 'http://127.0.0.1:5173';
const sessionToken = 'admin-flow-session-token-with-enough-entropy-12345';

function createAdminDb(state) {
  return {
    prepare(sql) {
      let bindings = [];
      const statement = {
        sql,
        bind(...values) {
          bindings = values;
          return this;
        },
        async first() {
          if (sql.includes('FROM auth_sessions')) {
            return {
              session_id: 1,
              last_seen_at: Math.floor(Date.now() / 1000),
              id: 1,
              name: '管理テスト',
              group_id: '管理',
              role: 'admin',
            };
          }
          if (sql.includes("role != 'admin'") && sql.includes('FROM users')) {
            return Number(bindings[0]) === 2 ? { id: 2 } : null;
          }
          if (sql.includes('FROM menu_items')) {
            return Number(bindings[0]) === 10
              ? { id: 10, name: '架空の事前コース', category: '宴会コース', size: '1名分', price: 5000, is_admin_only: 1 }
              : null;
          }
          if (sql.includes('SELECT id, status FROM orders')) return state.order || null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO orders')) {
            state.orderInsert = { sql, bindings: [...bindings] };
            state.order = { id: 77, status: bindings[3] };
            state.orderSource = 'admin';
            return { meta: { changes: 1, last_row_id: 77 } };
          }
          if (sql.includes('UPDATE orders') && sql.includes("order_source = 'admin'")) {
            const changes = state.orderSource === 'admin' ? 1 : 0;
            if (changes === 1) state.orderStatus = 'cancelled';
            return { meta: { changes } };
          }
          if (sql.includes('SET discord_id_hmac = NULL')) {
            state.allowlistCleared = true;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE auth_sessions') && sql.includes('user_id = ?')) {
            state.sessionRevoked = true;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

function createEnv(state) {
  return {
    APP_ENV: 'local',
    ALLOWED_ORIGINS: origin,
    DB: createAdminDb(state),
  };
}

async function adminHeaders() {
  return {
    Cookie: `reitaisai_session=${sessionToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': await deriveCsrfToken(sessionToken),
  };
}

test('an administrator-added banquet order is immediately ordered with provenance', async () => {
  const state = {};
  const response = await app.request('/api/admin/users/2/orders', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({
      menu_item_id: 10,
      quantity: 2,
      request_id: 'admin_order_flow_1234567890',
    }),
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'ordered');
  assert.equal(state.orderInsert.bindings[0], 2);
  assert.equal(state.orderInsert.bindings[3], 'ordered');
  assert.equal(state.orderInsert.bindings[9], 1);
  assert.match(state.orderInsert.sql, /order_source, created_by_user_id/u);
  assert.match(state.orderInsert.sql, /'admin'/u);
});

test('the correction endpoint refuses a self-created order', async () => {
  const state = { orderSource: 'self' };
  const response = await app.request('/api/admin/orders/77/cancel', {
    method: 'POST',
    headers: await adminHeaders(),
  }, createEnv(state));

  assert.equal(response.status, 404);
  assert.notEqual(state.orderStatus, 'cancelled');
});

test('revoking a participant login also revokes active sessions', async () => {
  const state = {};
  const response = await app.request('/api/admin/users/2/discord-access/revoke', {
    method: 'POST',
    headers: await adminHeaders(),
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.equal(state.allowlistCleared, true);
  assert.equal(state.sessionRevoked, true);
});

test('the administrator login cannot be revoked through the participant endpoint', async () => {
  const state = {};
  const response = await app.request('/api/admin/users/1/discord-access/revoke', {
    method: 'POST',
    headers: await adminHeaders(),
  }, createEnv(state));

  assert.equal(response.status, 404);
  assert.notEqual(state.sessionRevoked, true);
});
