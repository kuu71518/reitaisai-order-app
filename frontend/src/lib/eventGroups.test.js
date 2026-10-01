import test from 'node:test';
import assert from 'node:assert/strict';
import { assignableGroups, EVENT_GROUPS } from './eventGroups.js';
import { parseExcelUsers, EXCEL_USERS_HEADERS } from './excelUsers.js';

test('参加者の登録前でも、確定した両方の席へExcelから追加できる', () => {
  const result = parseExcelUsers([
    EXCEL_USERS_HEADERS,
    ['テスト参加者1', '900000000000000001', EVENT_GROUPS[0], '一般参加者'],
    ['テスト参加者2', '900000000000000002', EVENT_GROUPS[1], '一般参加者'],
  ], assignableGroups([{ role: 'admin', group_id: '運営' }]));
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 2);
});

test('既存席の参加者を編集でき、新しい席名の追加で既存データを書き換えない', () => {
  const users = [{ role: 'member', group_id: '既存席' }, { role: 'manager', group_id: EVENT_GROUPS[0] }];
  const original = structuredClone(users);
  assert.deepEqual(assignableGroups(users), [...EVENT_GROUPS, '既存席']);
  assert.deepEqual(users, original);
});
