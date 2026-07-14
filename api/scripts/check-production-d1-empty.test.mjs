import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOTSTRAP_BLOCKING_TABLES,
  EMPTY_CHECK_SQL,
  ProductionD1EmptyCheckError,
  assertProductionD1Empty,
  parseProductionD1CheckOutput,
} from './check-production-d1-empty.mjs';

function outputWithCount(count) {
  return JSON.stringify([
    {
      results: [{ bootstrap_table_count: count }],
      success: true,
      meta: { duration: 0.1 },
    },
  ]);
}

function expectCode(callback, code) {
  assert.throws(
    callback,
    (error) => error instanceof ProductionD1EmptyCheckError && error.code === code,
  );
}

test('query checks the seven application tables and d1_migrations', () => {
  assert.equal(BOOTSTRAP_BLOCKING_TABLES.length, 8);
  assert.ok(BOOTSTRAP_BLOCKING_TABLES.includes('d1_migrations'));
  for (const table of BOOTSTRAP_BLOCKING_TABLES) assert.match(EMPTY_CHECK_SQL, new RegExp(`'${table}'`, 'u'));
  assert.match(EMPTY_CHECK_SQL, /FROM sqlite_schema/u);
});

test('parses Wrangler JSON and accepts an empty production D1', () => {
  const count = parseProductionD1CheckOutput(outputWithCount(0));
  assert.equal(count, 0);
  assert.equal(assertProductionD1Empty(count), true);
});

test('blocks migration when any of the eight bootstrap-blocking tables already exists', () => {
  const count = parseProductionD1CheckOutput(outputWithCount(1));
  expectCode(() => assertProductionD1Empty(count), 'not_empty');
});

test('rejects malformed or unsuccessful Wrangler output', () => {
  expectCode(() => parseProductionD1CheckOutput(''), 'empty_output');
  expectCode(() => parseProductionD1CheckOutput('not json'), 'invalid_json');
  expectCode(() => parseProductionD1CheckOutput('{}'), 'invalid_shape');
  expectCode(
    () => parseProductionD1CheckOutput(JSON.stringify([{ results: [], success: false }])),
    'query_failed',
  );
  expectCode(
    () => parseProductionD1CheckOutput(JSON.stringify([{ results: [], success: true }])),
    'invalid_shape',
  );
});

test('rejects missing, string, negative, and out-of-range counts', () => {
  for (const count of [undefined, '0', -1, BOOTSTRAP_BLOCKING_TABLES.length + 1]) {
    expectCode(() => parseProductionD1CheckOutput(outputWithCount(count)), 'invalid_count');
  }
});

test('parser errors never echo remote output values', () => {
  const privateValue = '非公開のD1識別情報';
  const output = JSON.stringify([{ results: [{ unexpected: privateValue }], success: true }]);
  assert.throws(
    () => parseProductionD1CheckOutput(output),
    (error) => !error.message.includes(privateValue),
  );
});
