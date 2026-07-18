import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const serviceWorker = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8')
const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8')
const assetDirectory = new URL('../dist/assets/', import.meta.url)
const scriptFiles = (await readdir(assetDirectory)).filter((file) => file.endsWith('.js'))
const applicationScripts = (
  await Promise.all(scriptFiles.map((file) => readFile(new URL(file, assetDirectory), 'utf8')))
).join('\n')

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
assert.match(headers, /\/\*\s+X-Frame-Options: DENY/)
assert.match(headers, /X-Content-Type-Options: nosniff/)
assert.match(headers, /Referrer-Policy: no-referrer/)
assert.match(headers, /Permissions-Policy: camera=\(\), geolocation=\(\), microphone=\(\)/)
assert.match(
  headers,
  /Content-Security-Policy: base-uri 'self'; frame-ancestors 'none'; object-src 'none'/,
)

assert.match(applicationScripts, /この参加者の利用を停止/)
assert.match(applicationScripts, /管理者は利用停止できません/)
assert.doesNotMatch(applicationScripts, /参加者から削除/)
