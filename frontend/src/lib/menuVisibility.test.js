import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleMenuItemsForRole } from './menuVisibility.js';

const menu = [
  { id: 1, category: '飲み物', name: 'お茶', is_admin_only: 0 },
  { id: 2, category: '宴会コース', name: '架空テストコース', is_admin_only: 1 },
];

test('members and managers never render admin-only banquet courses', () => {
  assert.deepEqual(visibleMenuItemsForRole(menu, 'member').map((item) => item.id), [1]);
  assert.deepEqual(visibleMenuItemsForRole(menu, 'manager').map((item) => item.id), [1]);
});

test('administrators can render banquet courses', () => {
  assert.deepEqual(visibleMenuItemsForRole(menu, 'admin').map((item) => item.id), [1, 2]);
});
