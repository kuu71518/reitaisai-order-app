import assert from 'node:assert/strict';
import test from 'node:test';
import { BULK_USER_HEADERS, MAX_BULK_USERS, maskDiscordUserId, parseBulkUsers } from './bulkUsers.js';

const header = BULK_USER_HEADERS.join('\t');

test('Excelのタブ区切りをCRLF・空行・前後空白から正規化する', () => {
  const result = parseBulkUsers(`\r\n ${header} \r\n 霊夢 \t Aグループ \t 一般参加者 \t 1234567890123456 \r\n\r\n魔理沙\tBグループ\tmanager\t12345678901234567\r\n`);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [
    { sourceLine: 3, name: '霊夢', group_id: 'Aグループ', role: 'member', discord_user_id: '1234567890123456' },
    { sourceLine: 5, name: '魔理沙', group_id: 'Bグループ', role: 'manager', discord_user_id: '12345678901234567' },
  ]);
});

test('ヘッダーは必須で、4列の順番も固定する', () => {
  const result = parseBulkUsers('霊夢\tAグループ\t一般参加者\t1234567890123456');

  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0].message, /^1行目：/);
  assert.match(result.errors[0].message, /先頭行/);
});

test('日本語とAPI用の一般参加者・担当者権限を受け付ける', () => {
  const result = parseBulkUsers(`${header}\n霊夢\tA\tmember\t1234567890123456\n魔理沙\tA\t担当者\t1234567890123457`);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map((row) => row.role), ['member', 'manager']);
});

test('不正な列・権限・IDは行番号付きで示し、ID全文をエラーに含めない', () => {
  const secretId = '123456789012345';
  const result = parseBulkUsers(`${header}\n霊夢\tA\tadmin\t${secretId}\n魔理沙\tA\t一般参加者`);
  const messages = result.errors.map((error) => error.message).join('\n');

  assert.match(messages, /2行目：/);
  assert.match(messages, /3行目：/);
  assert.doesNotMatch(messages, new RegExp(secretId));
});

test('入力内のDiscordユーザーID重複を行番号で検出する', () => {
  const result = parseBulkUsers(`${header}\n霊夢\tA\t一般参加者\t1234567890123456\n魔理沙\tA\t担当者\t1234567890123456`);

  assert.equal(result.rows.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].message, '3行目：DiscordユーザーIDが2行目と重複しています。');
});

test('一括追加は1人以上100人以下に制限する', () => {
  const noRows = parseBulkUsers(header);
  const tooManyRows = Array.from({ length: MAX_BULK_USERS + 1 }, (_, index) => (
    `参加者${index}\tA\t一般参加者\t${String(10 ** 15 + index).padStart(16, '1')}`
  ));
  const tooMany = parseBulkUsers([header, ...tooManyRows].join('\n'));

  assert.match(noRows.errors[0].message, /1人以上/);
  assert.match(tooMany.errors[0].message, /100人まで/);
});

test('確認画面に表示するDiscordユーザーIDは末尾4桁だけにする', () => {
  assert.equal(maskDiscordUserId('123456789012345678'), '末尾5678');
});
