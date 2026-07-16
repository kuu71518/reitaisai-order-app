import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_SEED_PATH = new URL('../fixtures/production.local.sql', import.meta.url);

const PLACEHOLDER_PATTERNS = [
  /置換/u,
  /\bplaceholder\b/iu,
  /\breplace[-_ ]?(?:me|with)\b/iu,
  /\b(?:todo|tbd)\b/iu,
  /\byour[-_][a-z0-9_-]+\b/iu,
  /\{\{[^}\r\n]+\}\}/u,
  /<[^>\r\n]+>/u,
];

const KNOWN_EXAMPLE_VALUES = [
  '管理者名に置換',
  '参加者名に置換',
  '担当者名に置換',
  'メニュー名に置換',
  '運営テスト',
  '担当テスト',
  '参加テスト',
  'テスト用ソフトドリンク',
  'テスト用フード',
];

export class ProductionSeedValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionSeedValidationError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new ProductionSeedValidationError(code, message);
}

function stripComments(text) {
  let output = '';
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      output += char;
      if (char === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }

    if (char === '-' && next === '-') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      if (index >= text.length) reject('invalid_sql', 'SQLコメントが閉じられていません。');
      index += 1;
      output += ' ';
      continue;
    }

    output += char;
  }

  if (quote) reject('invalid_sql', 'SQL文字列が閉じられていません。');
  return output;
}

function splitStatements(text) {
  const statements = [];
  let start = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (char === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') quote = char;
    else if (char === ';') {
      const statement = text.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const remainder = text.slice(start).trim();
  if (remainder) statements.push(remainder);
  return statements;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (char === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }

    if (depth < 0) reject('invalid_sql', 'SQLの括弧が対応していません。');
  }

  if (quote || depth !== 0) reject('invalid_sql', 'SQLの値を安全に解析できません。');
  parts.push(text.slice(start).trim());
  return parts;
}

function parseTuples(text) {
  const rows = [];
  let index = 0;

  while (index < text.length) {
    while (/\s/u.test(text[index] ?? '')) index += 1;
    if (text[index] !== '(') reject('unsupported_insert', 'VALUES形式のINSERTだけを使用してください。');

    const start = ++index;
    let depth = 1;
    let quote = null;

    while (index < text.length && depth > 0) {
      const char = text[index];
      const next = text[index + 1];
      if (quote) {
        if (char === quote) {
          if (next === quote) index += 1;
          else quote = null;
        }
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }

    if (depth !== 0 || quote) reject('invalid_sql', 'SQLの値を安全に解析できません。');
    rows.push(splitTopLevel(text.slice(start, index - 1)));

    while (/\s/u.test(text[index] ?? '')) index += 1;
    if (index === text.length) break;
    if (text[index] !== ',') reject('unsupported_insert', 'VALUESの後に未対応のSQLがあります。');
    index += 1;
  }

  return rows;
}

function parseInsert(statement) {
  const match = statement.match(
    /^INSERT\s+INTO\s+["`\[]?([a-z_][a-z0-9_]*)["`\]]?\s*\(([^)]*)\)\s*VALUES\s+([\s\S]+)$/iu,
  );
  if (!match) return null;

  const columns = match[2].split(',').map((column) => column.trim().replace(/^["`\[]|["`\]]$/gu, '').toLowerCase());
  if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/u.test(column))) {
    reject('unsupported_insert', '列名を安全に解析できません。');
  }
  if (new Set(columns).size !== columns.length) reject('invalid_sql', 'INSERTに重複した列名があります。');

  const rows = parseTuples(match[3]);
  if (rows.some((row) => row.length !== columns.length)) reject('invalid_sql', '列数と値の数が一致しません。');
  return { table: match[1].toLowerCase(), columns, rows };
}

function parseLiteral(token) {
  const value = token.trim();
  if (/^NULL$/iu.test(value)) return null;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  reject('unsupported_value', '管理者設定に式や未対応の値は使用できません。');
}

export function validateProductionSeed(text) {
  if (typeof text !== 'string' || !text.trim()) reject('empty', '本番seedファイルが空です。');
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) {
    reject('placeholder', 'プレースホルダーまたは未置換の記述が残っています。');
  }
  if (KNOWN_EXAMPLE_VALUES.some((value) => text.includes(value))) {
    reject('example_value', 'サンプル用の既知値が残っています。');
  }

  const statements = splitStatements(stripComments(text));
  let adminCount = 0;
  let activeAdminCount = 0;
  let menuItemCount = 0;

  for (const statement of statements) {
    const insert = parseInsert(statement);
    if (!insert) reject('unsupported_statement', 'users/menu_itemsへのVALUES形式のINSERTだけを使用してください。');
    if (!['users', 'menu_items'].includes(insert.table)) {
      reject('unsupported_table', '本番seedで許可されていないテーブル操作があります。');
    }

    if (insert.table === 'menu_items') {
      const categoryIndex = insert.columns.indexOf('category');
      const adminOnlyIndex = insert.columns.indexOf('is_admin_only');
      if (categoryIndex < 0) reject('missing_category', 'menu_items INSERTにはcategory列が必要です。');
      for (const row of insert.rows) {
        const category = parseLiteral(row[categoryIndex]);
        if (category === '宴会コース') {
          const isAdminOnly = adminOnlyIndex < 0 ? null : parseLiteral(row[adminOnlyIndex]);
          if (isAdminOnly !== 1) {
            reject('banquet_visibility', '宴会コースはis_admin_only列へ1を指定してください。');
          }
        }
      }
      menuItemCount += insert.rows.length;
      continue;
    }

    const roleIndex = insert.columns.indexOf('role');
    const activeIndex = insert.columns.indexOf('is_active');
    if (roleIndex < 0) reject('missing_role', 'users INSERTにはrole列が必要です。');

    for (const row of insert.rows) {
      const role = parseLiteral(row[roleIndex]);
      const isActive = activeIndex < 0 ? 1 : parseLiteral(row[activeIndex]);
      if (role === 'admin') {
        adminCount += 1;
        if (isActive === 1) activeAdminCount += 1;
      }
    }
  }

  if (adminCount !== 1 || activeAdminCount !== 1) {
    reject('admin_count', '有効な初期adminアカウントはちょうど1人にしてください。');
  }
  if (menuItemCount < 1) reject('menu_count', 'menu_itemsのINSERTを1件以上用意してください。');

  return { adminCount, activeAdminCount, menuItemCount };
}

function run() {
  let text;
  try {
    text = readFileSync(PRODUCTION_SEED_PATH, 'utf8');
  } catch {
    console.error('Production seed check failed: api/fixtures/production.local.sql がありません。');
    process.exitCode = 1;
    return;
  }

  try {
    const result = validateProductionSeed(text);
    console.log(`Production seed check OK: active admin=${result.activeAdminCount}, menu items=${result.menuItemCount}.`);
  } catch (error) {
    const message = error instanceof ProductionSeedValidationError ? error.message : '検証中に予期しないエラーが発生しました。';
    console.error(`Production seed check failed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run();
