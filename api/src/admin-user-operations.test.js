import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from './index.ts';
import { deriveCsrfToken } from './security.js';

const origin = 'http://127.0.0.1:5173';
const sessionToken = 'admin-user-operations-session-token-1234567890';
const hmacKey = 'test-only-discord-hmac-key-with-32-characters';

function result(changes = 0, results = [], lastRowId = 0) {
  return { success: true, results, meta: { changes, last_row_id: lastRowId } };
}

function createState(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionCreatedAt: now,
    currentRole: 'admin',
    users: [
      { id: 1, name: '管理テスト', group_id: '管理', role: 'admin', is_active: 1, discord_id_hmac: 'admin-hmac' },
    ],
    orders: [],
    sessions: [{ id: 1, user_id: 1, revoked_at: null }],
    oauthStates: new Set(),
    menuItems: [{ id: 1 }, { id: 2 }],
    auditLogs: [],
    batchCalls: [],
    addSessionBeforeResetBatch: false,
    lastChanges: 0,
    ...overrides,
  };
}

function createDb(state) {
  function guardExists(guardHash) {
    return state.oauthStates.has(guardHash);
  }

  function execute(sql, bindings) {
    if (sql.includes("COUNT(*) AS count FROM users WHERE role != 'admin'")) {
      return result(0, [{ count: state.users.filter((user) => user.role !== 'admin').length }]);
    }
    if (sql.includes('COUNT(*) AS count FROM orders')) return result(0, [{ count: state.orders.length }]);
    if (sql.includes('COUNT(*) AS count FROM auth_sessions WHERE id != ?')) {
      return result(0, [{ count: state.sessions.filter((session) => session.id !== Number(bindings[0])).length }]);
    }
    if (sql.includes('COUNT(*) AS count FROM menu_items')) return result(0, [{ count: state.menuItems.length }]);
    if (sql.includes('COUNT(*) AS count FROM audit_logs')) return result(0, [{ count: state.auditLogs.length }]);

    if (sql.includes('INSERT INTO users') && sql.includes('is_manual_added')) {
      const rowCount = bindings.length / 4;
      let lastId = 0;
      for (let index = 0; index < rowCount; index += 1) {
        const offset = index * 4;
        lastId = Math.max(...state.users.map((user) => user.id), 0) + 1;
        state.users.push({
          id: lastId,
          name: bindings[offset],
          group_id: bindings[offset + 1],
          role: bindings[offset + 2],
          discord_id_hmac: bindings[offset + 3],
          is_active: 1,
        });
      }
      state.lastChanges = rowCount;
      return result(rowCount, [], lastId);
    }
    if (sql.includes("'USER_BULK_CREATE'")) {
      state.auditLogs.push({ action_type: 'USER_BULK_CREATE', metadata_json: bindings[1] });
      state.lastChanges = 1;
      return result(1);
    }
    if (sql.includes('SET is_active = 0, discord_id_hmac = NULL')) {
      const target = state.users.find((user) => user.id === Number(bindings[1]) && user.is_active === 1 && user.role !== 'admin');
      if (target) {
        target.is_active = 0;
        target.discord_id_hmac = null;
        state.lastChanges = 1;
        return result(1);
      }
      state.lastChanges = 0;
      return result(0);
    }
    if (sql.includes("'USER_DEACTIVATE'")) {
      if (state.lastChanges === 1) {
        state.auditLogs.push({ action_type: 'USER_DEACTIVATE', target_id: Number(bindings[1]) });
        state.lastChanges = 1;
        return result(1);
      }
      state.lastChanges = 0;
      return result(0);
    }
    if (sql.includes('UPDATE auth_sessions') && sql.includes('WHERE user_id = ?')) {
      let changes = 0;
      state.sessions.forEach((session) => {
        if (session.user_id === Number(bindings[1]) && session.revoked_at === null) {
          session.revoked_at = Number(bindings[0]);
          changes += 1;
        }
      });
      state.lastChanges = changes;
      return result(changes);
    }

    if (sql.includes('INSERT INTO oauth_states') && sql.includes('SELECT ?, ?, ?, NULL')) {
      const userCount = state.users.filter((user) => user.role !== 'admin').length;
      const orderCount = state.orders.length;
      const otherSessionCount = state.sessions.filter((session) => session.id !== Number(bindings[5])).length;
      const changes = userCount === Number(bindings[3])
        && orderCount === Number(bindings[4])
        && otherSessionCount === Number(bindings[6])
        ? 1
        : 0;
      if (changes === 1) state.oauthStates.add(bindings[0]);
      state.lastChanges = changes;
      return result(changes);
    }
    if (sql.includes('DELETE FROM orders') && sql.includes('oauth_states')) {
      const changes = guardExists(bindings[0]) ? state.orders.length : 0;
      if (guardExists(bindings[0])) state.orders = [];
      state.lastChanges = changes;
      return result(changes);
    }
    if (sql.includes('DELETE FROM auth_sessions') && sql.includes('oauth_states')) {
      const currentSessionId = Number(bindings[0]);
      const guardHash = bindings[1];
      const removed = guardExists(guardHash)
        ? state.sessions.filter((session) => session.id !== currentSessionId).length
        : 0;
      if (guardExists(guardHash)) state.sessions = state.sessions.filter((session) => session.id === currentSessionId);
      state.lastChanges = removed;
      return result(removed);
    }
    if (sql.includes('DELETE FROM users') && sql.includes("role != 'admin'")) {
      const guardHash = bindings[0];
      const removed = guardExists(guardHash) ? state.users.filter((user) => user.role !== 'admin').length : 0;
      if (guardExists(guardHash)) state.users = state.users.filter((user) => user.role === 'admin');
      state.lastChanges = removed;
      return result(removed);
    }
    if (sql.includes('DELETE FROM oauth_states') && sql.includes('state_hash != ?')) {
      const guardHash = bindings[0];
      const removed = guardExists(bindings[1]) ? [...state.oauthStates].filter((value) => value !== guardHash).length : 0;
      if (guardExists(bindings[1])) state.oauthStates = new Set([guardHash]);
      state.lastChanges = removed;
      return result(removed);
    }
    if (sql.includes("'EVENT_DATA_RESET'")) {
      if (guardExists(bindings[2])) {
        state.auditLogs.push({ action_type: 'EVENT_DATA_RESET', metadata_json: bindings[1] });
        state.lastChanges = 1;
        return result(1);
      }
      state.lastChanges = 0;
      return result(0);
    }
    if (sql.includes('DELETE FROM oauth_states WHERE state_hash = ?')) {
      const changes = state.oauthStates.delete(bindings[0]) ? 1 : 0;
      state.lastChanges = changes;
      return result(changes);
    }
    return result(1);
  }

  return {
    prepare(sql) {
      let bindings = [];
      return {
        sql,
        get bindings() {
          return bindings;
        },
        bind(...values) {
          bindings = values;
          return this;
        },
        async first() {
          if (sql.includes('FROM auth_sessions')) {
            return {
              session_id: 1,
              created_at: state.sessionCreatedAt,
              last_seen_at: Math.floor(Date.now() / 1000),
              id: state.currentRole === 'admin' ? 1 : 2,
              name: state.currentRole === 'admin' ? '管理テスト' : '参加テスト',
              group_id: state.currentRole === 'admin' ? '管理' : 'Aグループ',
              role: state.currentRole,
            };
          }
          if (sql.includes('SELECT id, role FROM users WHERE id = ? AND is_active = 1')) {
            const user = state.users.find((item) => item.id === Number(bindings[0]) && item.is_active === 1);
            return user ? { id: user.id, role: user.role } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('SELECT discord_id_hmac') && sql.includes('FROM users')) {
            return {
              results: state.users
                .filter((user) => user.discord_id_hmac && bindings.includes(user.discord_id_hmac))
                .map((user) => ({ discord_id_hmac: user.discord_id_hmac })),
            };
          }
          return { results: [] };
        },
        async run() {
          return execute(sql, bindings);
        },
      };
    },
    async batch(statements) {
      if (state.addSessionBeforeResetBatch && statements[0]?.sql.includes('INSERT INTO oauth_states')) {
        const id = Math.max(...state.sessions.map((session) => session.id), 0) + 1;
        state.sessions.push({ id, user_id: 1, revoked_at: null });
        state.addSessionBeforeResetBatch = false;
      }
      state.batchCalls.push(statements.map((statement) => ({
        sql: statement.sql,
        bindings: [...statement.bindings],
      })));
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function createEnv(state) {
  return {
    APP_ENV: 'local',
    ALLOWED_ORIGINS: origin,
    DISCORD_ID_HMAC_KEY: hmacKey,
    DB: createDb(state),
  };
}

async function unsafeHeaders() {
  return {
    Cookie: `reitaisai_session=${sessionToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': await deriveCsrfToken(sessionToken),
  };
}

test('bulk user creation validates every row without echoing submitted values', async () => {
  const state = createState();
  const privateValue = 'not-a-discord-id';
  const response = await app.request('/api/admin/users/bulk', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({
      users: [
        { name: '', group_id: '', role: 'admin', discord_user_id: privateValue },
        { name: '有効名', group_id: 'A', role: 'member', discord_user_id: 'invalid' },
      ],
    }),
  }, createEnv(state));

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, 'BULK_VALIDATION_FAILED');
  assert.deepEqual(body.data.errors.map((error) => error.row), [1, 2]);
  assert.equal(JSON.stringify(body).includes(privateValue), false);
  assert.equal(state.batchCalls.length, 0);
});

test('bulk user creation rejects duplicate Discord accounts inside one request', async () => {
  const state = createState();
  const duplicateId = '123456789012345678';
  const response = await app.request('/api/admin/users/bulk', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({ users: [
      { name: '参加A', group_id: 'A', role: 'member', discord_user_id: duplicateId },
      { name: '参加B', group_id: 'B', role: 'manager', discord_user_id: duplicateId },
    ] }),
  }, createEnv(state));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BULK_DUPLICATE_IN_REQUEST');
  assert.equal(state.users.length, 1);
});

test('bulk user creation is unavailable to a manager', async () => {
  const state = createState({ currentRole: 'manager' });
  const response = await app.request('/api/admin/users/bulk', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({ users: [
      { name: '参加A', group_id: 'A', role: 'member', discord_user_id: '123456789012345678' },
    ] }),
  }, createEnv(state));

  assert.equal(response.status, 403);
  assert.equal(state.batchCalls.length, 0);
});

for (const role of ['manager', 'member']) {
  test(`${role} cannot use participant deactivation or data reset endpoints`, async () => {
    const state = createState({ currentRole: role });
    const headers = await unsafeHeaders();
    const requests = [
      app.request('/api/admin/users/2', {
        method: 'DELETE',
        headers,
      }, createEnv(state)),
      app.request('/api/admin/data-reset/preview', {
        headers,
      }, createEnv(state)),
      app.request('/api/admin/data-reset', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          backup_confirmed: true,
          confirmation: '開催データをリセット',
          expected_user_count: 0,
          expected_order_count: 0,
          expected_other_session_count: 0,
        }),
      }, createEnv(state)),
    ];

    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'FORBIDDEN');
    }
    assert.equal(state.batchCalls.length, 0);
  });
}

test('administrator destructive endpoints reject a missing CSRF token', async () => {
  const state = createState();
  const headers = {
    Cookie: `reitaisai_session=${sessionToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const [deactivateResponse, resetResponse] = await Promise.all([
    app.request('/api/admin/users/2', {
      method: 'DELETE',
      headers,
    }, createEnv(state)),
    app.request('/api/admin/data-reset', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        backup_confirmed: true,
        confirmation: '開催データをリセット',
        expected_user_count: 0,
        expected_order_count: 0,
        expected_other_session_count: 0,
      }),
    }, createEnv(state)),
  ]);

  for (const response of [deactivateResponse, resetResponse]) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CSRF_FAILED');
  }
  assert.equal(state.batchCalls.length, 0);
});

test('bulk user creation writes every user and its audit in one batch without retaining raw Discord IDs', async () => {
  const state = createState();
  const firstId = '123456789012345678';
  const secondId = '223456789012345678';
  const response = await app.request('/api/admin/users/bulk', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({ users: [
      { name: '参加A', group_id: 'A', role: 'member', discord_user_id: firstId },
      { name: '参加B', group_id: 'B', role: 'manager', discord_user_id: secondId },
    ] }),
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { created_count: 2 } });
  assert.equal(state.batchCalls.at(-1).length, 2);
  assert.equal(state.auditLogs.at(-1).action_type, 'USER_BULK_CREATE');
  assert.equal(state.users[1].discord_id_hmac.startsWith('v1.'), true);
  assert.equal(JSON.stringify(state).includes(firstId), false);
  assert.equal(JSON.stringify(state).includes(secondId), false);
});

test('bulk user creation keeps 100 users within four 100-bind inserts plus one audit', async () => {
  const state = createState();
  const users = Array.from({ length: 100 }, (_, index) => ({
    name: `参加${index + 1}`,
    group_id: `G${(index % 5) + 1}`,
    role: index % 10 === 0 ? 'manager' : 'member',
    discord_user_id: String(900000000000000000n + BigInt(index)),
  }));
  const response = await app.request('/api/admin/users/bulk', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({ users }),
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { created_count: 100 } });
  const batch = state.batchCalls.at(-1);
  assert.equal(batch.length, 5);
  const insertStatements = batch.slice(0, 4);
  assert.equal(insertStatements.every((statement) => statement.bindings.length <= 100), true);
  assert.deepEqual(insertStatements.map((statement) => statement.bindings.length), [100, 100, 100, 100]);
  assert.match(batch[4].sql, /USER_BULK_CREATE/u);
  assert.equal(state.users.length, 101);
});

test('deactivation requires a login from the last five minutes', async () => {
  const state = createState({
    sessionCreatedAt: Math.floor(Date.now() / 1000) - 301,
    users: [
      { id: 1, name: '管理', group_id: '管理', role: 'admin', is_active: 1, discord_id_hmac: 'admin-hmac' },
      { id: 2, name: '参加', group_id: 'A', role: 'member', is_active: 1, discord_id_hmac: 'member-hmac' },
    ],
  });
  const response = await app.request('/api/admin/users/2', {
    method: 'DELETE',
    headers: await unsafeHeaders(),
  }, createEnv(state));

  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'RECENT_LOGIN_REQUIRED');
  assert.equal(state.users[1].is_active, 1);
});

test('deactivation preserves the participant profile and orders while revoking access in one batch', async () => {
  const state = createState({
    users: [
      { id: 1, name: '管理', group_id: '管理', role: 'admin', is_active: 1, discord_id_hmac: 'admin-hmac' },
      { id: 2, name: '参加', group_id: 'A', role: 'member', is_active: 1, discord_id_hmac: 'member-hmac' },
    ],
    orders: [{ id: 10, user_id: 2 }],
    sessions: [{ id: 1, user_id: 1, revoked_at: null }, { id: 2, user_id: 2, revoked_at: null }],
  });
  const response = await app.request('/api/admin/users/2', {
    method: 'DELETE',
    headers: await unsafeHeaders(),
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { deactivated: true } });
  assert.equal(state.batchCalls.at(-1).length, 3);
  assert.equal(state.users[1].name, '参加');
  assert.equal(state.users[1].group_id, 'A');
  assert.equal(state.users[1].is_active, 0);
  assert.equal(state.users[1].discord_id_hmac, null);
  assert.equal(state.orders.length, 1);
  assert.notEqual(state.sessions[1].revoked_at, null);
  assert.equal(state.auditLogs.at(-1).action_type, 'USER_DEACTIVATE');
});

test('the administrator cannot be deactivated', async () => {
  const state = createState();
  const response = await app.request('/api/admin/users/1', {
    method: 'DELETE',
    headers: await unsafeHeaders(),
  }, createEnv(state));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'ADMIN_DEACTIVATION_FORBIDDEN');
  assert.equal(state.users[0].is_active, 1);
  assert.equal(state.batchCalls.length, 0);
});

test('reset preview counts deleted and preserved records separately', async () => {
  const state = createState({
    users: [
      { id: 1, role: 'admin', is_active: 1 },
      { id: 2, role: 'member', is_active: 1 },
      { id: 3, role: 'manager', is_active: 0 },
    ],
    orders: [{ id: 1 }, { id: 2 }],
    sessions: [{ id: 1, user_id: 1 }, { id: 2, user_id: 2 }],
    menuItems: [{ id: 1 }, { id: 2 }, { id: 3 }],
    auditLogs: [{ id: 1 }],
  });
  const response = await app.request('/api/admin/data-reset/preview', {
    headers: { Cookie: `reitaisai_session=${sessionToken}` },
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    user_count: 2,
    order_count: 2,
    other_session_count: 1,
    preserved_menu_count: 3,
    preserved_audit_count: 1,
  });
});

test('reset refuses stale preview counts without deleting data', async () => {
  const state = createState({
    users: [{ id: 1, role: 'admin', is_active: 1 }, { id: 2, role: 'member', is_active: 1 }],
    orders: [{ id: 1 }],
  });
  const response = await app.request('/api/admin/data-reset', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({
      backup_confirmed: true,
      confirmation: '開催データをリセット',
      expected_user_count: 1,
      expected_order_count: 0,
      expected_other_session_count: 0,
    }),
  }, createEnv(state));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'RESET_PREVIEW_STALE');
  assert.equal(state.users.length, 2);
  assert.equal(state.orders.length, 1);
});

test('reset stops without deleting data when another session appears after preview', async () => {
  const state = createState({
    users: [
      { id: 1, role: 'admin', is_active: 1 },
      { id: 2, role: 'member', is_active: 1 },
    ],
    orders: [{ id: 1 }],
    sessions: [{ id: 1, user_id: 1 }, { id: 2, user_id: 2 }],
    addSessionBeforeResetBatch: true,
  });
  const response = await app.request('/api/admin/data-reset', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({
      backup_confirmed: true,
      confirmation: '開催データをリセット',
      expected_user_count: 1,
      expected_order_count: 1,
      expected_other_session_count: 1,
    }),
  }, createEnv(state));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'RESET_PREVIEW_STALE');
  assert.equal(state.users.length, 2);
  assert.equal(state.orders.length, 1);
  assert.equal(state.sessions.length, 3);
  assert.equal(state.auditLogs.some((log) => log.action_type === 'EVENT_DATA_RESET'), false);
});

test('reset requires a login from the last five minutes', async () => {
  const state = createState({ sessionCreatedAt: Math.floor(Date.now() / 1000) - 301 });
  const response = await app.request('/api/admin/data-reset', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({
      backup_confirmed: true,
      confirmation: '開催データをリセット',
      expected_user_count: 0,
      expected_order_count: 0,
      expected_other_session_count: 0,
    }),
  }, createEnv(state));

  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'RECENT_LOGIN_REQUIRED');
  assert.equal(state.batchCalls.length, 0);
});

test('reset atomically deletes event data while preserving the administrator, current session, menu, and audit', async () => {
  const state = createState({
    users: [
      { id: 1, name: '管理', group_id: '管理', role: 'admin', is_active: 1, discord_id_hmac: 'admin-hmac' },
      { id: 2, name: '参加', group_id: 'A', role: 'member', is_active: 1, discord_id_hmac: 'member-hmac' },
      { id: 3, name: '停止済', group_id: 'B', role: 'manager', is_active: 0, discord_id_hmac: null },
    ],
    orders: [{ id: 1, user_id: 2 }, { id: 2, user_id: 3 }],
    sessions: [{ id: 1, user_id: 1 }, { id: 2, user_id: 2 }],
    oauthStates: new Set(['old-oauth-state']),
    menuItems: [{ id: 1 }, { id: 2 }],
    auditLogs: [{ action_type: 'AUTH_LOGIN' }],
  });
  const response = await app.request('/api/admin/data-reset', {
    method: 'POST',
    headers: await unsafeHeaders(),
    body: JSON.stringify({
      backup_confirmed: true,
      confirmation: '開催データをリセット',
      expected_user_count: 2,
      expected_order_count: 2,
      expected_other_session_count: 1,
    }),
  }, createEnv(state));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    data: { deleted_user_count: 2, deleted_order_count: 2, deleted_session_count: 1 },
  });
  assert.deepEqual(state.users.map((user) => user.role), ['admin']);
  assert.equal(state.users[0].discord_id_hmac, 'admin-hmac');
  assert.deepEqual(state.sessions.map((session) => session.id), [1]);
  assert.equal(state.orders.length, 0);
  assert.equal(state.oauthStates.size, 0);
  assert.equal(state.menuItems.length, 2);
  assert.deepEqual(state.auditLogs.map((log) => log.action_type), ['AUTH_LOGIN', 'EVENT_DATA_RESET']);
  assert.deepEqual(JSON.parse(state.auditLogs.at(-1).metadata_json), {
    deleted_user_count: 2,
    deleted_order_count: 2,
    deleted_session_count: 1,
  });
  assert.equal(state.batchCalls.at(-1).length, 7);
});
