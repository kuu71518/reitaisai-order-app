import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP_BLOCKING_TABLES = Object.freeze([
  'd1_migrations',
  'users',
  'menu_items',
  'orders',
  'auth_sessions',
  'oauth_states',
  'discord_link_requests',
  'audit_logs',
]);

export const EMPTY_CHECK_SQL = [
  'SELECT COUNT(*) AS bootstrap_table_count',
  'FROM sqlite_schema',
  "WHERE type = 'table'",
  `AND name IN (${BOOTSTRAP_BLOCKING_TABLES.map((table) => `'${table}'`).join(', ')});`,
].join(' ');

const API_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

export class ProductionD1EmptyCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionD1EmptyCheckError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new ProductionD1EmptyCheckError(code, message);
}

export function parseProductionD1CheckOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    reject('empty_output', 'Wranglerから検査結果を取得できませんでした。');
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    reject('invalid_json', 'Wranglerの検査結果を安全に解析できませんでした。');
  }

  if (!Array.isArray(payload) || payload.length !== 1) {
    reject('invalid_shape', 'Wranglerの検査結果が想定した形式ではありません。');
  }

  const queryResult = payload[0];
  if (!queryResult || typeof queryResult !== 'object' || queryResult.success !== true) {
    reject('query_failed', '本番D1のテーブル検査に失敗しました。');
  }
  if (!Array.isArray(queryResult.results) || queryResult.results.length !== 1) {
    reject('invalid_shape', 'Wranglerの検査結果が想定した形式ではありません。');
  }

  const count = queryResult.results[0]?.bootstrap_table_count;
  if (!Number.isSafeInteger(count) || count < 0 || count > BOOTSTRAP_BLOCKING_TABLES.length) {
    reject('invalid_count', '本番D1のテーブル数を安全に確認できませんでした。');
  }

  return count;
}

export function assertProductionD1Empty(blockingTableCount) {
  if (blockingTableCount !== 0) {
    reject('not_empty', '本番D1には初回bootstrapを妨げるテーブルが既にあります。migrationを中止しました。');
  }
  return true;
}

function runCli() {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER_BIN,
      'd1',
      'execute',
      'DB',
      '--remote',
      '--env',
      'production',
      '--config',
      'wrangler.deploy.toml',
      '--command',
      EMPTY_CHECK_SQL,
      '--json',
    ],
    {
      cwd: API_DIRECTORY,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    },
  );

  if (result.error || result.status !== 0) {
    console.error('Production D1 empty check failed: Wranglerによるremote検査に失敗しました。');
    process.exitCode = 1;
    return;
  }

  try {
    const blockingTableCount = parseProductionD1CheckOutput(result.stdout);
    assertProductionD1Empty(blockingTableCount);
    console.log('Production D1 empty check OK: checked tables=8, existing tables=0.');
  } catch (error) {
    const message = error instanceof ProductionD1EmptyCheckError
      ? error.message
      : '検査中に予期しないエラーが発生しました。';
    console.error(`Production D1 empty check failed: ${message}`);
    process.exitCode = 1;
  }
}

const modulePath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = process.platform === 'win32'
  ? modulePath.toLowerCase() === invokedPath.toLowerCase()
  : modulePath === invokedPath;

if (isMain) runCli();
