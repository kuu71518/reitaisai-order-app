import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { app } from './index.ts';
import { deriveCsrfToken, deriveDiscordIdHmac, sha256Base64Url } from './security.js';

const origin = 'http://127.0.0.1:5173';
const sessionToken = 'bulk-sql-test-session-token-with-enough-entropy';
const hmacKey = 'test-only-bulk-sql-hmac-key-with-32-characters';

function makeUsers(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `架空の参加者${index + 1}`,
    group_id: `テスト班${index % 5 + 1}`,
    role: index % 10 === 0 ? 'manager' : 'member',
    discord_user_id: String(900000000000000000n + BigInt(index)),
  }));
}

// Execute the application's SQL on the actual migrated schema, using only an
// in-memory SQLite database. This adapter models D1 batch transactions; it does
// not substitute for testing the deployed D1 service itself.
async function createFixture(t) {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('External requests are forbidden in bulk SQL tests');
  });
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of [
    '0001_initial.sql',
    '0002_security_constraints.sql',
    '0003_discord_allowlist_and_admin_orders.sql',
  ]) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));

  const now = Math.floor(Date.now() / 1000);
  const adminHmac = await deriveDiscordIdHmac(hmacKey, '900000000000009999');
  sqlite.prepare('INSERT INTO users (id, name, group_id, role, discord_id_hmac) VALUES (?, ?, ?, ?, ?)')
    .run(1, '架空の管理者', '管理テスト班', 'admin', adminHmac);
  sqlite.prepare(`
    INSERT INTO auth_sessions
      (token_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(await sha256Base64Url(sessionToken), 1, now, now, now + 3600, now + 3600);

  const activity = { batches: 0, attemptedUserInserts: 0, completedUserInserts: 0, rollbacks: 0, beforeBatch: null };
  const db = {
    prepare(sql) {
      let values = [];
      return {
        sql,
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
      activity.batches += 1;
      activity.beforeBatch?.();
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          const insertsUsers = statement.sql.includes('INSERT INTO users');
          if (insertsUsers) activity.attemptedUserInserts += 1;
          results.push(await statement.run());
          if (insertsUsers) activity.completedUserInserts += 1;
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        activity.rollbacks += 1;
        throw error;
      }
    },
  };
  const headers = {
    Cookie: `reitaisai_session=${sessionToken}`,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': await deriveCsrfToken(sessionToken),
  };
  const env = { APP_ENV: 'local', ALLOWED_ORIGINS: origin, DISCORD_ID_HMAC_KEY: hmacKey, DB: db };
  return {
    sqlite,
    activity,
    submit: (users) => app.request('/api/admin/users/bulk', {
      method: 'POST', headers, body: JSON.stringify({ users }),
    }, env),
    participants: () => sqlite.prepare("SELECT * FROM users WHERE role != 'admin' ORDER BY id").all(),
    audits: () => sqlite.prepare("SELECT * FROM audit_logs WHERE action_type = 'USER_BULK_CREATE'").all(),
  };
}

for (const count of [2, 100]) {
  test(`bulk SQL inserts all ${count} participants and one audit while retaining only Discord HMACs`, async (t) => {
    const fixture = await createFixture(t);
    const users = makeUsers(count);
    const response = await fixture.submit(users);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: { created_count: count } });
    const participants = fixture.participants();
    assert.equal(participants.length, count);
    for (let index = 0; index < count; index += 1) {
      const stored = participants[index];
      const submitted = users[index];
      assert.equal(stored.name, submitted.name);
      assert.equal(stored.group_id, submitted.group_id);
      assert.equal(stored.role, submitted.role);
      assert.equal(stored.is_manual_added, 1);
      assert.equal(stored.discord_id_hmac, await deriveDiscordIdHmac(hmacKey, submitted.discord_user_id));
    }
    const audits = fixture.audits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, 1);
    const managerCount = users.filter((user) => user.role === 'manager').length;
    assert.deepEqual(JSON.parse(audits[0].metadata_json), {
      created_count: count,
      role_counts: { member: count - managerCount, manager: managerCount },
      group_count: Math.min(count, 5),
    });
    const savedData = JSON.stringify([...participants, ...audits]);
    for (const user of users) assert.equal(savedData.includes(user.discord_user_id), false);
    assert.equal(fixture.activity.batches, 1);
    assert.equal(fixture.activity.completedUserInserts, Math.ceil(count / 25));
    assert.equal(fixture.activity.rollbacks, 0);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
}

test('bulk SQL stops every new row when one Discord account already exists in the database', async (t) => {
  const fixture = await createFixture(t);
  const users = makeUsers(3);
  const existingHmac = await deriveDiscordIdHmac(hmacKey, users[1].discord_user_id);
  fixture.sqlite.prepare('INSERT INTO users (name, group_id, role, discord_id_hmac) VALUES (?, ?, ?, ?)')
    .run('架空の既存参加者', '既存テスト班', 'member', existingHmac);
  const before = fixture.participants();
  const response = await fixture.submit(users);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'BULK_DUPLICATE_EXISTING');
  assert.deepEqual(body.data.rows, [2]);
  assert.deepEqual(fixture.participants(), before);
  assert.equal(fixture.audits().length, 0);
  assert.equal(fixture.activity.batches, 0);
});

test('bulk SQL rolls back earlier chunks when a concurrent duplicate makes the second insert fail', async (t) => {
  const fixture = await createFixture(t);
  const users = makeUsers(30);
  const concurrentHmac = await deriveDiscordIdHmac(hmacKey, users[25].discord_user_id);
  // Simulate another request committing after the duplicate SELECT and before
  // the batch begins. The second chunk then hits the schema's real UNIQUE index.
  fixture.activity.beforeBatch = () => {
    fixture.sqlite.prepare('INSERT INTO users (name, group_id, role, discord_id_hmac) VALUES (?, ?, ?, ?)')
      .run('架空の同時登録者', '同時登録テスト班', 'member', concurrentHmac);
  };
  const response = await fixture.submit(users);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BULK_DUPLICATE_EXISTING');
  assert.equal(fixture.activity.attemptedUserInserts, 2);
  assert.equal(fixture.activity.completedUserInserts, 1);
  assert.equal(fixture.activity.rollbacks, 1);
  const remaining = fixture.participants();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, '架空の同時登録者');
  assert.equal(remaining[0].discord_id_hmac, concurrentHmac);
  assert.equal(fixture.audits().length, 0);
});

test('bulk SQL rolls back all participants when the final audit insert fails', async (t) => {
  const fixture = await createFixture(t);
  fixture.sqlite.exec(`
    CREATE TRIGGER test_reject_bulk_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action_type = 'USER_BULK_CREATE'
    BEGIN
      SELECT RAISE(ABORT, 'test_only_audit_write_failure');
    END;
  `);
  const response = await fixture.submit(makeUsers(30));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).success, false);
  assert.equal(fixture.activity.completedUserInserts, 2);
  assert.equal(fixture.activity.rollbacks, 1);
  assert.equal(fixture.participants().length, 0);
  assert.equal(fixture.audits().length, 0);
  assert.equal(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
});
