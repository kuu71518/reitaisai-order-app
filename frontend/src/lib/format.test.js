import assert from 'node:assert/strict';
import test from 'node:test';
import { formatYen, getOrderStatus, orderTotal, toDate, toNumber } from './format.js';

test('数値ではない値を会計へ混ぜない', () => {
  assert.equal(toNumber('1200'), 1200);
  assert.equal(toNumber('不明'), 0);
  assert.equal(toNumber(undefined), 0);
});

test('円表示を整数へ丸め、3桁区切りにする', () => {
  assert.equal(formatYen(1234.6), '¥1,235');
  assert.equal(formatYen('invalid'), '¥0');
});

test('秒・ミリ秒・UTC文字列を同じ日時として解釈する', () => {
  const expected = 1_700_000_000_000;
  assert.equal(toDate(1_700_000_000)?.getTime(), expected);
  assert.equal(toDate(expected)?.getTime(), expected);
  assert.equal(toDate('2023-11-14 22:13:20')?.getTime(), expected);
  assert.equal(toDate('not-a-date'), null);
});

test('注文状態を利用者向け表示へ変換する', () => {
  assert.deepEqual(getOrderStatus('ordered'), { label: '注文済み', tone: 'success' });
  assert.deepEqual(getOrderStatus('cancelled'), { label: '取消済み', tone: 'muted' });
  assert.deepEqual(getOrderStatus('unknown'), { label: '担当者が確認中', tone: 'warning' });
});

test('注文合計は単価の旧・新フィールドに対応する', () => {
  assert.equal(orderTotal({ price: 620, quantity: 2 }), 1240);
  assert.equal(orderTotal({ unit_price: 480, quantity: 3 }), 1440);
  assert.equal(orderTotal(null), 0);
});
