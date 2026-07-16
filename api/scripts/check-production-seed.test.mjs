import assert from 'node:assert/strict';
import test from 'node:test';

import { ProductionSeedValidationError, validateProductionSeed } from './check-production-seed.mjs';

const VALID_SEED = `
INSERT INTO users (name, group_id, role) VALUES
  ('本番管理', '管理', 'admin'),
  ('一般参加', 'Aグループ', 'member');
INSERT INTO menu_items (category, name, size, price) VALUES
  ('料理', '唐揚げ', '通常', 800);
`;

function expectCode(sql, code) {
  assert.throws(
    () => validateProductionSeed(sql),
    (error) => error instanceof ProductionSeedValidationError && error.code === code,
  );
}

test('accepts one active admin and at least one menu item', () => {
  assert.deepEqual(validateProductionSeed(VALID_SEED), { adminCount: 1, activeAdminCount: 1, menuItemCount: 1 });
});

test('rejects an additional inactive administrator account', () => {
  const sql = VALID_SEED.replace(
    "('一般参加', 'Aグループ', 'member')",
    "('旧管理', '管理', 'admin', 0)",
  ).replace('(name, group_id, role)', '(name, group_id, role, is_active)')
    .replace("('本番管理', '管理', 'admin'),", "('本番管理', '管理', 'admin', 1),");
  expectCode(sql, 'admin_count');
});

test('rejects placeholders even when left in a comment', () => {
  expectCode(`${VALID_SEED}\n-- 参加者名に置換`, 'placeholder');
});

test('rejects known staging example values', () => {
  expectCode(VALID_SEED.replace('本番管理', '運営テスト'), 'example_value');
});

test('rejects zero or multiple active admins', () => {
  expectCode(VALID_SEED.replace("'admin'", "'member'"), 'admin_count');
  expectCode(
    VALID_SEED.replace("('一般参加', 'Aグループ', 'member')", "('第二管理', '管理', 'admin')"),
    'admin_count',
  );
});

test('rejects a seed without menu rows', () => {
  expectCode(VALID_SEED.replace(/INSERT INTO menu_items[\s\S]+;/u, ''), 'menu_count');
});

test('requires banquet courses to be marked administrator-only', () => {
  const banquetWithoutFlag = VALID_SEED.replace("('料理', '唐揚げ', '通常', 800)", "('宴会コース', '事前コース', '1名分', 5000)");
  expectCode(banquetWithoutFlag, 'banquet_visibility');

  const banquetWithFlag = banquetWithoutFlag
    .replace('(category, name, size, price)', '(category, name, size, price, is_admin_only)')
    .replace("('宴会コース', '事前コース', '1名分', 5000)", "('宴会コース', '事前コース', '1名分', 5000, 1)");
  assert.equal(validateProductionSeed(banquetWithFlag).menuItemCount, 1);
});

test('rejects statements whose effects cannot be checked statically', () => {
  expectCode(`${VALID_SEED}\nUPDATE users SET role = 'admin';`, 'unsupported_statement');
  expectCode(VALID_SEED.replace('INSERT INTO users', 'INSERT OR IGNORE INTO users'), 'unsupported_statement');
});

test('validation errors never include fixture values', () => {
  const privateValue = '非公開参加者氏名';
  assert.throws(
    () => validateProductionSeed(VALID_SEED.replace("'admin'", "upper('${privateValue}')")),
    (error) => !error.message.includes(privateValue),
  );
});
