// The retired app generated this file with VitePWA's automatic registration.
// The current app uses injectRegister: false, so the marker is unique to legacy caches.
export const LEGACY_PRECACHE_MARKER = '/registerSW.js'
export const LEGACY_MIGRATION_CACHE = 'reitaisai-legacy-sw-migration-v1'
export const LEGACY_MIGRATION_STATE = '/.reitaisai-legacy-sw-migration'

export function registerLegacyServiceWorkerMigration({
  serviceWorker = self,
  cacheStorage = caches,
} = {}) {
  const legacyMarkerUrl = new URL(
    LEGACY_PRECACHE_MARKER,
    serviceWorker.location.origin,
  ).href
  const migrationStateUrl = new URL(
    LEGACY_MIGRATION_STATE,
    serviceWorker.location.origin,
  ).href

  serviceWorker.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      const legacyMarker = await cacheStorage.match(legacyMarkerUrl, {
        ignoreSearch: true,
      })

      if (!legacyMarker) return

      const migrationCache = await cacheStorage.open(LEGACY_MIGRATION_CACHE)
      await migrationCache.put(migrationStateUrl, new Response('pending'))
      await serviceWorker.skipWaiting()
    })())
  })

  serviceWorker.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const migrationState = await cacheStorage.match(migrationStateUrl, {
        cacheName: LEGACY_MIGRATION_CACHE,
      })
      if (!migrationState) return

      await serviceWorker.clients.claim()
      const windowClients = await serviceWorker.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      await cacheStorage.delete(LEGACY_MIGRATION_CACHE)

      await Promise.allSettled(
        windowClients.map((client) => client.navigate(client.url)),
      )
    })())
  })
}
