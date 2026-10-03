import { canReceiveOrderNotifications } from './orderAccess.js';

const DATABASE = 'reitaisai-notification-history';
const STORE = 'notifications';
const CLEAR_REVISION = 'clear-revision';
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

function clearedHistory(state) {
  return { ...emptyHistory(), initialized: state.initialized || state.entries.length > 0,
    preferences: { ...state.preferences } };
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

  async function change(scope, operation, revision = null) {
    const key = `scope:${scope}`;
    const apply = (active, stored, latestRevision) => {
      if (revision !== null && revision < latestRevision) return { ignored: true };
      const cleared = revision !== null && revision > latestRevision;
      const state = stored || emptyHistory();
      return { ...operation(active, cleared ? clearedHistory(state) : state), cleared };
    };
    let db;
    try { db = await database(); } catch {
      const result = apply(memory.get('active'), memory.get(key), memory.get(CLEAR_REVISION) || 0);
      if (result.cleared) {
        for (const [storedKey, state] of memory) {
          if (storedKey.startsWith('scope:')) memory.set(storedKey, clearedHistory(state));
        }
        memory.set(CLEAR_REVISION, revision);
      }
      if (result.state) memory.set(key, result.state);
      if ('active' in result) memory.set('active', result.active);
      return { ...result, persistent: false };
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const active = store.get('active');
      const stored = store.get(key);
      const latestRevision = store.get(CLEAR_REVISION);
      let pending = 3;
      let result;
      const ready = () => {
        if (--pending) return;
        result = apply(active.result, stored.result, latestRevision.result || 0);
        if (result.cleared) {
          store.put(revision, CLEAR_REVISION);
          // Reset every account/role scope in this browser in the same transaction,
          // including accounts that are not currently open. Keep alert preferences.
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            if (typeof item.key === 'string' && item.key.startsWith('scope:')) {
              item.update(item.key === key && result.state ? result.state : clearedHistory(item.value));
            }
            item.continue();
          };
        }
        if (result.state) store.put(result.state, key);
        if ('active' in result) store.put(result.active, 'active');
      };
      active.onsuccess = ready;
      stored.onsuccess = ready;
      latestRevision.onsuccess = ready;
      transaction.oncomplete = () => resolve({ ...result, persistent: true });
      transaction.onerror = transaction.onabort = () => reject(new Error('Notification history could not be saved'));
    });
  }

  return {
    activate: (scope) => change(scope, (_active, state) => ({ active: scope, state })),
    deactivate: (scope = null) => change(scope, (active) => scope === null || active === scope ? { active: null } : {}),
    read: (scope) => change(scope, (_active, state) => ({ state })),
    update: (scope, action) => change(scope, (active, state) => active === scope ? updateHistory(state, action) : {},
      action.type === 'orders' && Number.isSafeInteger(action.revision) && action.revision >= 0 ? action.revision : null),
    clear(revision) {
      if (!Number.isSafeInteger(revision) || revision <= 0) return Promise.reject(new Error('Invalid notification clear revision'));
      return change(null, () => ({}), revision);
    },
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

export async function clearNotificationHistory(revision) {
  const result = await notificationHistory.clear(revision);
  if (result.ignored) return result;
  // Same-document events reach the deleting administrator immediately. Other
  // tabs share IndexedDB and receive the revision through BroadcastChannel.
  globalThis.dispatchEvent?.(new CustomEvent('reitaisai:notification-history-cleared', { detail: { revision } }));
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('reitaisai-notification-history');
    channel.postMessage({ type: 'NOTIFICATION_HISTORY_CLEARED', revision });
    channel.close();
  }
  return result;
}
