import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerLegacyServiceWorkerMigration } from './lib/legacyServiceWorkerMigration.js'

registerLegacyServiceWorkerMigration()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting())
  }
})
