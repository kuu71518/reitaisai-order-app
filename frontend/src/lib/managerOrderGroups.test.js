import assert from 'node:assert/strict';
import test from 'node:test';
import { groupOrdersForHandoff } from './managerOrderGroups.js';

const row = (changes) => ({ id: 1, user_id: 10, user_name: 'テスト参加者', group_id: 'テストA', menu_name: 'テストのお茶', size: '通常', quantity: 1, ...changes });

test('one product heading contains separate size totals without combining tables', () => {
  const tables = groupOrdersForHandoff([
    row({ id: 1, quantity: 3 }), row({ id: 2, size: 'バカ', quantity: 2 }),
    row({ id: 3, group_id: 'テストB', quantity: 4 }), row({ id: 4, quantity: 2 }),
  ]);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables.map((table) => [table.groupId, table.orderCount, table.products.length]), [['テストA', 3, 1], ['テストB', 1, 1]]);
  assert.deepEqual(tables[0].products[0].variants.map(({ size, total }) => [size, total]), [['通常', 5], ['バカ', 2]]);
  assert.equal(tables[1].products[0].variants[0].total, 4);
});

test('repeated orders by the same person aggregate visually but keep original edit rows and IDs', () => {
  const orders = [row({ id: 1, quantity: 1 }), row({ id: 2, quantity: 18 })];
  const person = groupOrdersForHandoff(orders)[0].products[0].variants[0].people[0];
  assert.equal(person.total, 19);
  assert.deepEqual(person.orders.map((order) => order.id), [1, 2]);
  assert.strictEqual(person.orders[0], orders[0]);
  assert.strictEqual(person.orders[1], orders[1]);
  assert.deepEqual(orders.map((order) => order.quantity), [1, 18]);
});

test('same-name participants remain separate and absent user IDs never merge by name', () => {
  const people = groupOrdersForHandoff([
    row({ id: 1 }), row({ id: 2, user_id: 11 }),
    row({ id: 3, user_id: undefined }), row({ id: 4, user_id: undefined }),
  ])[0].products[0].variants[0].people;
  assert.equal(people.length, 4);
  assert.equal(new Set(people.map((person) => person.key)).size, 4);
});

test('a quantity draft changes only its order totals and marks only that product as unsaved', () => {
  const orders = [row({ id: 1 }), row({ id: 2, size: 'バカ', quantity: 3 }), row({ id: 3, menu_name: '別の商品', quantity: 2 })];
  const products = groupOrdersForHandoff(orders, { 1: 5, 99: 20 })[0].products;
  assert.deepEqual(products.map((product) => product.hasDraft), [true, false]);
  assert.deepEqual(products[0].variants.map((variant) => variant.total), [5, 3]);
  assert.equal(products[0].variants[0].people[0].total, 5);
  assert.equal(orders[0].quantity, 1);
});

test('empty orders return no tables and groups with punctuation do not collide', () => {
  assert.deepEqual(groupOrdersForHandoff([]), []);
  const tables = groupOrdersForHandoff([row({ group_id: 'A|B', menu_name: 'C' }), row({ id: 2, group_id: 'A', menu_name: 'B|C' })]);
  assert.equal(tables.length, 2);
  assert.notEqual(tables[0].products[0].key, tables[1].products[0].key);
});
