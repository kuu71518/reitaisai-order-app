import test from 'node:test';
import assert from 'node:assert/strict';
import { accountingGroups, accountingTotal } from './accounting.js';

test('accounting includes zero-order participants and never adds table charge to totals', () => {
  const people = [
    { user_id: 1, name: '同名', group_id: 'A', total_price: 0 },
    { user_id: 2, name: '同名', group_id: 'A', total_price: 528 },
    { user_id: 3, name: '別席', group_id: 'B', total_price: 352 },
  ];
  assert.equal(accountingTotal(people), 880);
  assert.deepEqual(accountingGroups(people), [{ name: 'A', people: 2, total: 528 }, { name: 'B', people: 1, total: 352 }]);
  assert.equal(accountingTotal([]), 0);
});
