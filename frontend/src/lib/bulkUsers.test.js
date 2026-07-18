import assert from 'node:assert/strict';
import test from 'node:test';
import { countBulkUserLines, MAX_BULK_USERS, maskDiscordUserId, parseBulkUsers } from './bulkUsers.js';

test('二つの一覧を同じ順番で組み合わせ、共通グループと権限を適用する', () => {
  const result = parseBulkUsers({
    names: '\uFEFF 霊夢 \r\n 魔理沙 \r\n',
    discordUserIds: ' 1234567890123456 \r\n 12345678901234567 \r\n',
    groupId: ' Aグループ ',
    role: 'manager',
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [
    { sourceLine: 1, name: '霊夢', group_id: 'Aグループ', role: 'manager', discord_user_id: '1234567890123456' },
    { sourceLine: 2, name: '魔理沙', group_id: 'Aグループ', role: 'manager', discord_user_id: '12345678901234567' },
  ]);
});

test('名前とDiscordユーザーIDの人数が違う場合は一件も組み合わせない', () => {
  const result = parseBulkUsers({
    names: '霊夢\n魔理沙\n咲夜',
    discordUserIds: '1234567890123456\n1234567890123457',
    groupId: 'Aグループ',
    role: 'member',
  });

  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /参加者名は3人、DiscordユーザーIDは2人/);
});

test('先頭・途中の空行を残して行ずれを防ぎ、末尾の改行だけ無視する', () => {
  const result = parseBulkUsers({
    names: '\n霊夢\n\n魔理沙\n',
    discordUserIds: '\n1234567890123456\n1234567890123457\n1234567890123458\n',
    groupId: 'Aグループ',
    role: 'member',
  });

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.sourceLine), [2, 4]);
  const nameErrors = result.errors.filter((error) => error.field === 'names');
  assert.deepEqual(nameErrors.map((error) => error.line), [1, 3]);
  assert.match(nameErrors[0].message, /^1人目：/);
  assert.match(nameErrors[1].message, /^3人目：/);
  assert.equal(countBulkUserLines('Aさん\nBさん\n'), 2);
});

test('共通グループと権限も送信前に再検証する', () => {
  const base = {
    names: '霊夢',
    discordUserIds: '1234567890123456',
  };
  const noGroup = parseBulkUsers({ ...base, groupId: '', role: 'member' });
  const adminRole = parseBulkUsers({ ...base, groupId: 'Aグループ', role: 'admin' });

  assert.equal(noGroup.rows.length, 0);
  assert.match(noGroup.errors[0].message, /グループを選んで/);
  assert.equal(adminRole.rows.length, 0);
  assert.match(adminRole.errors[0].message, /一般参加者.*担当者/);
});

test('不正な名前・表貼り付け・IDは何人目かを示し、ID全文をエラーに含めない', () => {
  const secretId = '123456789012345';
  const result = parseBulkUsers({
    names: `霊夢\tAグループ\n魔理沙`,
    discordUserIds: `${secretId}\nユーザー名`,
    groupId: 'Aグループ',
    role: 'member',
  });
  const messages = result.errors.map((error) => error.message).join('\n');

  assert.match(messages, /1人目：/);
  assert.match(messages, /2人目：/);
  assert.doesNotMatch(messages, new RegExp(secretId));
});

test('入力内のDiscordユーザーID重複を何人目かで検出する', () => {
  const result = parseBulkUsers({
    names: '霊夢\n魔理沙',
    discordUserIds: '1234567890123456\n1234567890123456',
    groupId: 'Aグループ',
    role: 'member',
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].message, '2人目：DiscordユーザーIDが1人目と重複しています。');
});

test('一括追加は1人以上100人以下に制限する', () => {
  const noRows = parseBulkUsers();
  const validNames = Array.from({ length: MAX_BULK_USERS }, (_, index) => `参加者${index + 1}`);
  const validDiscordUserIds = Array.from(
    { length: MAX_BULK_USERS },
    (_, index) => String(9000000000000000n + BigInt(index)),
  );
  const maximum = parseBulkUsers({
    names: validNames.join('\n'),
    discordUserIds: validDiscordUserIds.join('\n'),
    groupId: 'Aグループ',
    role: 'member',
  });
  const tooManyNames = Array.from({ length: MAX_BULK_USERS + 1 }, (_, index) => `参加者${index + 1}`);
  const tooManyDiscordUserIds = Array.from(
    { length: MAX_BULK_USERS + 1 },
    (_, index) => String(9000000000000000n + BigInt(index)),
  );
  const tooMany = parseBulkUsers({
    names: tooManyNames.join('\n'),
    discordUserIds: tooManyDiscordUserIds.join('\n'),
    groupId: 'Aグループ',
    role: 'member',
  });

  assert.match(noRows.errors[0].message, /参加者名とDiscordユーザーID/);
  assert.equal(maximum.errors.length, 0);
  assert.equal(maximum.rows.length, MAX_BULK_USERS);
  assert.match(tooMany.errors[0].message, /100人まで/);
});

test('確認画面に表示するDiscordユーザーIDは末尾4桁だけにする', () => {
  assert.equal(maskDiscordUserId('123456789012345678'), '末尾5678');
});
