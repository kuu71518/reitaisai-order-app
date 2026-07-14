import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEGACY_MIGRATION_CACHE,
  LEGACY_MIGRATION_STATE,
  LEGACY_PRECACHE_MARKER,
  registerLegacyServiceWorkerMigration,
} from './legacyServiceWorkerMigration.js'

const ORIGIN = 'https://uchiage.touhoudaienkai.com'
const LEGACY_PRECACHE_MARKER_URL = `${ORIGIN}${LEGACY_PRECACHE_MARKER}`
const LEGACY_MIGRATION_STATE_URL = `${ORIGIN}${LEGACY_MIGRATION_STATE}`

function createCacheStorage({ hasLegacyMarker }) {
  let hasMigrationState = false
  const calls = []
  const cacheStorage = {
    async match(request, options) {
      calls.push(['cacheMatch', request, options])
      if (request === LEGACY_PRECACHE_MARKER_URL) {
        return hasLegacyMarker ? {} : undefined
      }
      if (request === LEGACY_MIGRATION_STATE_URL) {
        return hasMigrationState ? {} : undefined
      }
      return undefined
    },
    async open(name) {
      calls.push(['cacheOpen', name])
      return {
        async put(request, response) {
          calls.push(['cachePut', request, response.status])
          hasMigrationState = true
        },
      }
    },
    async delete(name) {
      calls.push(['cacheDelete', name])
      hasMigrationState = false
      return true
    },
  }

  return { cacheStorage, calls }
}

function createHarness({ cacheStorage, calls }) {
  const listeners = new Map()
  const windowClients = [
    {
      url: 'https://uchiage.touhoudaienkai.com/',
      navigate(url) {
        calls.push(['navigate', url])
        // A real navigation cannot complete until the activate event finishes.
        return new Promise(() => {})
      },
    },
  ]
  const serviceWorker = {
    location: { origin: ORIGIN },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    async skipWaiting() {
      calls.push(['skipWaiting'])
    },
    clients: {
      async claim() {
        calls.push(['claim'])
      },
      async matchAll(options) {
        calls.push(['matchAll', options])
        return windowClients
      },
    },
  }
  registerLegacyServiceWorkerMigration({ serviceWorker, cacheStorage })

  async function dispatch(type) {
    const promises = []
    listeners.get(type)({ waitUntil: (promise) => promises.push(promise) })
    await Promise.all(promises)
  }

  return { calls, dispatch }
}

test('旧precachingを検出したときだけ待機を飛ばして画面を再読込する', async () => {
  const sharedCache = createCacheStorage({ hasLegacyMarker: true })
  const installingWorker = createHarness(sharedCache)

  await installingWorker.dispatch('install')

  // Service Workerがinstall後に停止しても、永続化した移行状態を別globalで引き継ぐ。
  const activatingWorker = createHarness(sharedCache)
  await activatingWorker.dispatch('activate')
  await activatingWorker.dispatch('activate')

  assert.deepEqual(sharedCache.calls, [
    ['cacheMatch', LEGACY_PRECACHE_MARKER_URL, { ignoreSearch: true }],
    ['cacheOpen', LEGACY_MIGRATION_CACHE],
    ['cachePut', LEGACY_MIGRATION_STATE_URL, 200],
    ['skipWaiting'],
    ['cacheMatch', LEGACY_MIGRATION_STATE_URL, { cacheName: LEGACY_MIGRATION_CACHE }],
    ['claim'],
    ['matchAll', { type: 'window', includeUncontrolled: true }],
    ['cacheDelete', LEGACY_MIGRATION_CACHE],
    ['navigate', 'https://uchiage.touhoudaienkai.com/'],
    ['cacheMatch', LEGACY_MIGRATION_STATE_URL, { cacheName: LEGACY_MIGRATION_CACHE }],
  ])
})

test('新画面の通常更新では利用中の画面を自動再読込しない', async () => {
  const sharedCache = createCacheStorage({ hasLegacyMarker: false })
  const harness = createHarness(sharedCache)

  await harness.dispatch('install')
  await harness.dispatch('activate')

  assert.deepEqual(sharedCache.calls, [
    ['cacheMatch', LEGACY_PRECACHE_MARKER_URL, { ignoreSearch: true }],
    ['cacheMatch', LEGACY_MIGRATION_STATE_URL, { cacheName: LEGACY_MIGRATION_CACHE }],
  ])
})
