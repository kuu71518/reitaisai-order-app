import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from './index.ts';
import { deriveCsrfToken } from './security.js';

const origin = 'http://127.0.0.1:5173';
const sessionToken = 'local-test-session-token-with-enough-entropy-12345';
const menu = [
  { id: 1, category: '飲み物', name: '架空のお茶', size: '通常', price: 300, is_admin_only: 0 },
  { id: 2, category: '宴会コース', name: '架空のコース', size: '1名分', price: 5000, is_admin_only: 0 },
];

function createDb(role) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async first() {
          if (sql.includes('FROM auth_sessions')) {
            return {
              session_id: 1,
              created_at: Math.floor(Date.now() / 1000),
              last_seen_at: Math.floor(Date.now() / 1000),
              id: role === 'admin' ? 1 : 2,
              name: role === 'admin' ? '管理テスト' : '参加テスト',
              group_id: 'Aグループ',
              role,
            };
          }
          if (sql.includes('FROM menu_items')) {
            const requestedId = Number(bindings[0]);
            const canSeeAdminOnly = Number(bindings[1]) === 1;
            const categoryIsProtected = sql.includes("category != '宴会コース'");
            return menu.find((item) => item.id === requestedId && (
              canSeeAdminOnly
              || (item.is_admin_only === 0 && (!categoryIsProtected || item.category !== '宴会コース'))
            )) || null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM menu_items')) {
            const canSeeAdminOnly = Number(bindings[0]) === 1;
            const categoryIsProtected = sql.includes("category != '宴会コース'");
            return {
              results: menu.filter((item) => canSeeAdminOnly || (
                item.is_admin_only === 0 && (!categoryIsProtected || item.category !== '宴会コース')
              )),
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('UPDATE orders') && !sql.includes("order_source = 'admin'")) {
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch() {
      return [];
    },
  };
}

function envForRole(role) {
  return {
    APP_ENV: 'local',
    ALLOWED_ORIGINS: origin,
    DB: createDb(role),
  };
}

function sessionHeaders(extra = {}) {
  return {
    Cookie: `reitaisai_session=${sessionToken}`,
    ...extra,
  };
}

test('menu endpoint returns banquet courses only to the administrator', async () => {
  const memberResponse = await app.request('/api/menu', {
    headers: sessionHeaders(),
  }, envForRole('member'));
  assert.equal(memberResponse.status, 200);
  assert.deepEqual((await memberResponse.json()).data.map((item) => item.id), [1]);

  const adminResponse = await app.request('/api/menu', {
    headers: sessionHeaders(),
  }, envForRole('admin'));
  assert.equal(adminResponse.status, 200);
  assert.deepEqual((await adminResponse.json()).data.map((item) => item.id), [1, 2]);
});

test('a member cannot order a hidden banquet course by sending its ID directly', async () => {
  const csrfToken = await deriveCsrfToken(sessionToken);
  const response = await app.request('/api/orders', {
    method: 'POST',
    headers: sessionHeaders({
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    }),
    body: JSON.stringify({
      menu_item_id: 2,
      quantity: 1,
      request_id: 'member_request_1234567890',
    }),
  }, envForRole('member'));
  assert.equal(response.status, 404);
});

test('a member cannot add an order to another user', async () => {
  const csrfToken = await deriveCsrfToken(sessionToken);
  const response = await app.request('/api/admin/users/3/orders', {
    method: 'POST',
    headers: sessionHeaders({
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    }),
    body: JSON.stringify({
      menu_item_id: 1,
      quantity: 1,
      request_id: 'member_admin_request_123456',
    }),
  }, envForRole('member'));
  assert.equal(response.status, 403);
});

test('an administrator can cancel only an administrator-added order', async () => {
  const csrfToken = await deriveCsrfToken(sessionToken);
  const response = await app.request('/api/admin/orders/42/cancel', {
    method: 'POST',
    headers: sessionHeaders({
      Origin: origin,
      'X-CSRF-Token': csrfToken,
    }),
  }, envForRole('admin'));
  assert.equal(response.status, 200);
});
