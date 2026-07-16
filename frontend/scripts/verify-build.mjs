import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const serviceWorker = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8')
const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8')

assert.match(serviceWorker, /\/registerSW\.js/)
assert.match(serviceWorker, /reitaisai-legacy-sw-migration-v1/)
assert.doesNotMatch(serviceWorker, /(?:\/api\/|order-api\.touhoudaienkai\.com)/)
assert.doesNotMatch(
  serviceWorker,
  /(?:showNotification|notificationclick|addEventListener\([`'"]push)/,
)

assert.match(
  headers,
  /\/sw\.js\s+Cache-Control: no-cache, no-store, must-revalidate/,
)
assert.match(headers, /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/)
