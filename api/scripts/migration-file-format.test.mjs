import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(scriptsDirectory, '..', 'migrations');

test('D1 migration files use UTF-8 without BOM and LF line endings', async () => {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  assert.ok(migrationFiles.length > 0, 'migration file not found');

  for (const fileName of migrationFiles) {
    const bytes = await readFile(path.join(migrationsDirectory, fileName));

    assert.equal(
      bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      false,
      `${fileName} has a UTF-8 BOM`,
    );
    assert.equal(
      bytes.includes(0x0d),
      false,
      `${fileName} must use LF line endings for remote D1 migrations`,
    );
    assert.equal(bytes.at(-1), 0x0a, `${fileName} must end with a newline`);
  }
});
