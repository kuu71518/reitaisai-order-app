import { canReceiveOrderNotifications } from './orderAccess.js';

const DATABASE = 'reitaisai-notification-history';
const STORE = 'notifications';
export const HISTORY_LIMIT = 200;
const MERGE_WINDOW = 10_000;

async function digest(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function notificationScope(user) {
  if (!canReceiveOrderNotifications(user) || !user?.id || !user.group_id) return null;
  // The browser database contains no names, raw user IDs or group names.
  return digest(`notification-v1:${user.id}:${user.role}:${user.group_id}`);
}

export async function notificationOrderKeys(scope, orders) {
  const ids = [...new Set((orders || []).map((order) => order.id).filter((id) => Number.isSafeInteger(id) && id > 0))];
  return Promise.all(ids.map((id) => digest(`${scope}:order:${id}`)));
}

export function emptyHistory() {
  return { initialized: false, observed: [], entries: [], preferences: { sound: true, vibration: true } };
}

export function unreadNotifications(state) {
  return state.entries.filter((entry) => !entry.readAt).length;
}

// This reducer is shared by the page and Service Worker. Keep notification
// contents generic: only receipt time, count, read state and opaque IDs persist.
export function updateHistory(state, action) {
  const next = { ...state, entries: state.entries.map((entry) => ({ ...entry })) };
  let newCount = 0;
  let alert = false;
  if (action.type === 'orders') {
    const ids = [...new Set(action.ids)];
    const previous = new Set(state.observed);
    newCount = state.initialized ? ids.filter((id) => !previous.has(id)).length : 0;
    next.initialized = true;
    next.observed = ids;
    const pendingPush = next.entries.filter((entry) => entry.awaitingOrders);
    if (newCount && pendingPush.length) {
      // An empty Web Push has no order IDs. Associate the next authenticated
      // snapshot with its generic receipt instead of alerting for it twice.
      pendingPush[0].count = newCount;
    } else if (newCount) {
      next.entries.unshift({ id: action.id, receivedAt: action.now, readAt: null, count: newCount, source: 'app', awaitingOrders: false });
      alert = true;
    }
    pendingPush.forEach((entry) => { entry.awaitingOrders = false; });
  } else if (action.type === 'push') {
    const latest = next.entries[0];
    if (latest && action.now >= latest.receivedAt && action.now - latest.receivedAt <= MERGE_WINDOW) {
      latest.source = 'push';
      latest.receivedAt = action.now;
      latest.readAt = null;
      latest.awaitingOrders = true;
    } else {
      next.entries.unshift({ id: action.id, receivedAt: action.now, readAt: null, count: null, source: 'push', awaitingOrders: true });
    }
  } else if (action.type === 'read') {
    next.entries.forEach((entry) => {
      if (!entry.readAt && (action.ids === 'all' || action.ids.includes(entry.id))) entry.readAt = action.now;
    });
  } else if (action.type === 'preferences') {
    next.preferences = { sound: action.sound === true, vibration: action.vibration === true };
  }
  next.entries = next.entries.slice(0, HISTORY_LIMIT);
  return { state: next, newCount, alert };
}

export function createNotificationHistory(indexedDB = globalThis.indexedDB) {
  let databasePromise;
  const memory = new Map();
  async function database() {
    if (!indexedDB) throw new Error('Notification storage is unavailable');
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(new Error('Notification storage is unavailable'));
      request.onblocked = () => reject(new Error('Notification storage is blocked'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = null; };
        resolve(db);
      };
    }).catch((error) => { databasePromise = null; throw error; });
    return databasePromise;
  }

  async function change(scope, operation) {
    const key = `scope:${scope}`;
    const apply = (active, stored) => operation(active, stored || emptyHistory());
    let db;
    try { db = await database(); } catch {
      const result = apply(memory.get('active'), memory.get(key));
      if (result.state) memory.set(key, result.state);
      if ('active' in result) memory.set('active', result.active);
      return { ...result, persistent: false };
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const active = store.get('active');
      const stored = store.get(key);
      let pending = 2;
      let result;
      const ready = () => {
        if (--pending) return;
        result = apply(active.result, stored.result);
        if (result.state) store.put(result.state, key);
        if ('active' in result) store.put(result.active, 'active');
      };
      active.onsuccess = ready;
      stored.onsuccess = ready;
      transaction.oncomplete = () => resolve({ ...result, persistent: true });
      transaction.onerror = transaction.onabort = () => reject(new Error('Notification history could not be saved'));
    });
  }

  return {
    activate: (scope) => change(scope, (_active, state) => ({ active: scope, state })),
    deactivate: (scope = null) => change(scope, (active) => scope === null || active === scope ? { active: null } : {}),
    read: (scope) => change(scope, (_active, state) => ({ state })),
    update: (scope, action) => change(scope, (active, state) => active === scope ? updateHistory(state, action) : {}),
    async receivePush(now = Date.now()) {
      // Read the active account and write its receipt in ONE transaction. A
      // concurrent logout/account switch must not attach it to the next user.
      let db;
      try { db = await database(); } catch {
        const scope = memory.get('active');
        if (!scope) return null;
        const result = await change(scope, (active, state) => active === scope
          ? updateHistory(state, { type: 'push', now, id: globalThis.crypto.randomUUID() }) : {});
        return { ...result, scope };
      }
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const active = store.get('active');
        let result = null;
        active.onsuccess = () => {
          const scope = active.result;
          if (!scope) return;
          const request = store.get(`scope:${scope}`);
          request.onsuccess = () => {
            const updated = updateHistory(request.result || emptyHistory(), { type: 'push', now, id: globalThis.crypto.randomUUID() });
            store.put(updated.state, `scope:${scope}`);
            result = { ...updated, scope, persistent: true };
          };
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(new Error('Notification receipt could not be saved'));
      });
    },
  };
}

export const notificationHistory = createNotificationHistory();
