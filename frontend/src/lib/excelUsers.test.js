import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { EXCEL_USERS_HEADERS, MAX_EXCEL_FILE_BYTES, parseExcelUsers, validateExcelUserFile } from './excelUsers.js';
import { readExcelUsers, unpackExcelForValidation } from './excelUsersFile.js';

const GROUPS = ['Aグループ', 'あグループ'];
const row = (index = 0, fields = {}) => [
  fields.name ?? `テスト参加者${index + 1}`,
  fields.id ?? String(800000000000000000n + BigInt(index)),
  fields.group ?? 'Aグループ',
  fields.role ?? '一般参加者',
];
const parse = (...rows) => parseExcelUsers([EXCEL_USERS_HEADERS, ...rows], GROUPS);

test('Excelの行ごとにグループと権限を適用し、IDの文字列を変更しない', () => {
  const result = parse(row(0), row(1, { group: 'あグループ', role: '担当者' }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map(({ sourceLine, sourceKind, group_id, role, discord_user_id }) =>
    ({ sourceLine, sourceKind, group_id, role, discord_user_id })), [
    { sourceLine: 2, sourceKind: 'excel', group_id: 'Aグループ', role: 'member', discord_user_id: '800000000000000000' },
    { sourceLine: 3, sourceKind: 'excel', group_id: 'あグループ', role: 'manager', discord_user_id: '800000000000000001' },
  ]);
});

test('完全な空行は行単位で無視し、途中の部分空欄は全件を停止する', () => {
  const good = parse([], row(0), [null, '', ' ', undefined], row(1));
  assert.deepEqual(good.rows.map((item) => item.sourceLine), [3, 5]);
  const bad = parse(row(0), row(1, { name: '' }), row(2));
  assert.deepEqual(bad.rows, []);
  assert.match(bad.errors[0].message, /^Excel 3行目：/);
});

test('数値として保存されたDiscord IDと日時・真偽値・指数表記を拒否する', () => {
  for (const id of [800000000000000000, new Date('2026-01-01'), true, '8.00000000000000001E+17']) {
    const result = parse(row(0, { id }));
    assert.equal(result.rows.length, 0);
    assert.ok(result.errors.some((item) => item.field === 'discordUserIds'));
    assert.ok(result.errors.every((item) => !item.message.includes(String(id))));
  }
});

test('IDの桁数は既存登録と同じ16〜22桁で、文字列の前後空白だけを除く', () => {
  assert.equal(parse(row(0, { id: ' 1234567890123456 ' })).rows[0].discord_user_id, '1234567890123456');
  assert.equal(parse(row(0, { id: '1234567890123456789012' })).rows.length, 1);
  for (const id of ['123456789012345', '12345678901234567890123']) assert.equal(parse(row(0, { id })).rows.length, 0);
});

test('未登録グループと管理者権限・英語のrole指定を拒否する', () => {
  for (const fields of [{ group: '不存在グループ' }, { role: '管理者' }, { role: 'admin' }, { role: 'member' }]) {
    const result = parse(row(0), row(1, fields));
    assert.deepEqual(result.rows, []);
    assert.match(result.errors[0].message, /^Excel 3行目：/);
  }
});

test('重複IDは元のExcel行を示し、生IDをエラーに含めず全件を停止する', () => {
  const result = parse(row(0), [], row(0));
  assert.deepEqual(result.rows, []);
  assert.match(result.errors[0].message, /Excel 4行目：.*2行目と重複/);
  assert.ok(!result.errors[0].message.includes(row()[1]));
});

test('見出し、余計な列、名前の文字数や改行を検証する', () => {
  assert.equal(parseExcelUsers([['名前', ...EXCEL_USERS_HEADERS.slice(1)], row()], GROUPS).rows.length, 0);
  assert.equal(parse([...row(), '余計な値']).rows.length, 0);
  for (const name of ['あ'.repeat(81), 'テスト\n参加者', 'テスト\t参加者']) {
    assert.equal(parse(row(0, { name })).rows.length, 0);
  }
});

test('2〜101行目の最大100人のみを許可し、102行目以降を黙って切り捨てない', () => {
  const rows = Array.from({ length: 100 }, (_, index) => row(index));
  assert.equal(parse(...rows).rows.length, 100);
  assert.equal(parse(...rows, row(100)).rows.length, 0);
  assert.match(parse(...rows, row(100)).errors[0].message, /Excel 102行目/);
  assert.equal(parse().rows.length, 0);
  assert.equal(parse().errors.length, 1);
});

test('xlsx以外、空ファイル、1MB超を読み込む前に拒否する', async () => {
  assert.equal(validateExcelUserFile({ name: 'list.xlsx', size: MAX_EXCEL_FILE_BYTES }), null);
  for (const file of [{ name: 'list.xls', size: 12 }, { name: 'list.xlsm', size: 12 }, { name: 'list.xlsx', size: 0 }, { name: 'list.xlsx', size: MAX_EXCEL_FILE_BYTES + 1 }]) {
    assert.ok(validateExcelUserFile(file));
    const result = await readExcelUsers({ ...file, arrayBuffer: () => { throw new Error('must not read'); } }, GROUPS);
    assert.equal(result.rows.length, 0);
  }
});

test('ZIPの通常ファイルは読み取れても、巨大な展開量や過剰な内部ファイルは止める', () => {
  const normal = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') });
  assert.equal(new TextDecoder().decode(unpackExcelForValidation(normal).get('xl/workbook.xml')), '<workbook/>');
  const huge = zipSync({ 'xl/sharedStrings.xml': new Uint8Array(2 * 1024 * 1024 + 1) });
  assert.throws(() => unpackExcelForValidation(huge), /大きすぎ/);
  const lots = zipSync(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`entry${index}`, new Uint8Array()])));
  assert.throws(() => unpackExcelForValidation(lots), /複雑すぎ/);
});

test('壊れたExcelの内部エラーやセル値を画面へ転載しない', async () => {
  const buffer = new TextEncoder().encode('invalid private cell content').buffer;
  const result = await readExcelUsers({ name: 'list.xlsx', size: buffer.byteLength, arrayBuffer: async () => buffer }, GROUPS);
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.doesNotMatch(result.errors[0].message, /private cell content/);
});
