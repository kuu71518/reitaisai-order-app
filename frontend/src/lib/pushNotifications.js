export function applicationServerKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('通知の設定を読み直してください。');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('通知の設定を読み直してください。');
  return bytes;
}

export function subscriptionUsesKey(subscription, publicKey) {
  const storedKey = subscription?.options?.applicationServerKey;
  if (!storedKey) return false;
  const actual = new Uint8Array(storedKey);
  const expected = applicationServerKey(publicKey);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

export function registerPushEvents(worker) {
  worker.addEventListener('push', (event) => {
    event.waitUntil(worker.registration.showNotification('新しい注文があります', {
      body: 'アプリを開いて新着を確認してください。',
      icon: '/icon-192.png', badge: '/icon-192.png', tag: 'pending-orders', renotify: true,
    }));
  });
  worker.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients.find((client) => new URL(client.url).origin === worker.location.origin);
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'OPEN_MANAGER_ORDERS' });
      } else {
        await worker.clients.openWindow(new URL('/?view=manager', worker.location.origin).href);
      }
    })());
  });
}
