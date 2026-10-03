import { useCallback, useEffect, useRef, useState } from 'react';
import { clearNotificationHistory, emptyHistory, notificationHistory, notificationOrderKeys, notificationScope, unreadNotifications } from '../lib/notificationHistory.js';
import { playNotificationAlert, prepareNotificationSound } from '../lib/notificationAlerts.js';

export function useNotificationHistory(user, onNewOrders, authReady) {
  const owner = user ? JSON.stringify([user.id, user.group_id, user.role]) : '';
  const [snapshot, setSnapshot] = useState({ owner: '', state: emptyHistory(), error: '' });
  const scopeRef = useRef(null);
  const ownerRef = useRef('');
  const readyRef = useRef(Promise.resolve(null));
  const callbackRef = useRef(onNewOrders);
  useEffect(() => { callbackRef.current = onNewOrders; }, [onNewOrders]);

  const accept = useCallback((result, expectedOwner) => {
    if (!result?.state || ownerRef.current !== expectedOwner) return;
    setSnapshot({ owner: expectedOwner, state: result.state,
      error: result.persistent ? '' : 'このブラウザでは受信履歴を保存できません。画面を閉じると履歴が消えます。' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    ownerRef.current = owner;
    const previousScope = scopeRef.current;
    scopeRef.current = null;
    readyRef.current = (async () => {
      if (previousScope) await notificationHistory.deactivate(previousScope);
      if (!authReady) return null;
      const scope = await notificationScope(user);
      if (cancelled) return null;
      if (!scope) { await notificationHistory.deactivate(); return null; }
      const result = await notificationHistory.activate(scope);
      if (cancelled) { await notificationHistory.deactivate(scope); return null; }
      scopeRef.current = scope;
      accept(result, owner);
      return scope;
    })().catch(() => {
      if (!cancelled) setSnapshot({ owner, state: emptyHistory(), error: '受信履歴を読み込めませんでした。画面を更新してお試しください。' });
      return null;
    });
    return () => { cancelled = true; };
  }, [owner, user, authReady, accept]);

  const refresh = useCallback(async () => {
    const scope = await readyRef.current;
    if (!scope || ownerRef.current !== owner) return;
    try { accept(await notificationHistory.read(scope), owner); } catch {
      setSnapshot((current) => current.owner === owner ? { ...current, error: '受信履歴を更新できませんでした。もう一度開いてください。' } : current);
    }
  }, [owner, accept]);

  useEffect(() => {
    const receive = (event) => {
      if (event.data?.type === 'NOTIFICATION_HISTORY_UPDATED' && event.data.scope === scopeRef.current) void refresh();
      if (event.data?.type === 'NOTIFICATION_HISTORY_CLEARED') {
        void notificationHistory.clear(event.data.revision).then(refresh).catch(() => {
          setSnapshot((current) => ({ ...current, error: '通知履歴を削除できませんでした。アプリを開き直してお試しください。' }));
        });
      }
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('reitaisai-notification-history') : null;
    channel?.addEventListener('message', receive);
    navigator.serviceWorker?.addEventListener('message', receive);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('reitaisai:notification-history-cleared', refresh);
    const prepare = () => { if (scopeRef.current) void prepareNotificationSound(); };
    document.addEventListener('pointerdown', prepare);
    document.addEventListener('keydown', prepare);
    return () => {
      channel?.close();
      navigator.serviceWorker?.removeEventListener('message', receive);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('reitaisai:notification-history-cleared', refresh);
      document.removeEventListener('pointerdown', prepare);
      document.removeEventListener('keydown', prepare);
    };
  }, [refresh]);

  const broadcast = useCallback((scope) => {
    if (typeof BroadcastChannel !== 'function') return;
    const channel = new BroadcastChannel('reitaisai-notification-history');
    channel.postMessage({ type: 'NOTIFICATION_HISTORY_UPDATED', scope });
    channel.close();
  }, []);

  const receiveOrders = useCallback(async (orders, requestOwner, revision) => {
    if (requestOwner !== owner || ownerRef.current !== owner) return;
    const scope = await readyRef.current;
    if (!scope || ownerRef.current !== owner) return;
    try {
      const ids = await notificationOrderKeys(scope, orders);
      if (ownerRef.current !== owner) return;
      // Older/malformed responses cannot advance a reset. Treat a legacy response
      // as revision zero so it is ignored after a newer clear has been observed.
      const observedRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
      const result = await notificationHistory.update(scope, { type: 'orders', ids, revision: observedRevision, now: Date.now(), id: crypto.randomUUID() });
      if (ownerRef.current !== owner || !result.state) return;
      accept(result, owner);
      if (result.cleared) await clearNotificationHistory(observedRevision);
      if (ownerRef.current !== owner) return;
      if (result.newCount) {
        broadcast(scope);
        callbackRef.current?.(result.newCount);
        if (result.alert) playNotificationAlert(result.state.preferences, { visible: document.visibilityState === 'visible' });
      }
    } catch {
      setSnapshot((current) => current.owner === owner ? { ...current, error: '受信履歴を保存できませんでした。注文は取りまとめで確認できます。' } : current);
    }
  }, [owner, accept, broadcast]);

  const write = useCallback(async (action) => {
    const scope = await readyRef.current;
    if (!scope || ownerRef.current !== owner) return false;
    try {
      const result = await notificationHistory.update(scope, { ...action, now: Date.now() });
      if (ownerRef.current !== owner || !result.state) return false;
      accept(result, owner);
      broadcast(scope);
      return action.type !== 'preferences' || result.persistent;
    } catch {
      setSnapshot((current) => current.owner === owner ? { ...current, error: '通知の変更を保存できませんでした。もう一度お試しください。' } : current);
      return false;
    }
  }, [owner, accept, broadcast]);

  const deactivate = useCallback(() => {
    const scope = scopeRef.current;
    ownerRef.current = '';
    scopeRef.current = null;
    if (scope) void notificationHistory.deactivate(scope).catch(() => {});
  }, []);

  const state = snapshot.owner === owner ? snapshot.state : emptyHistory();
  return { entries: state.entries, unreadCount: unreadNotifications(state), preferences: state.preferences,
    error: snapshot.owner === owner ? snapshot.error : '', receiveOrders, refresh, deactivate,
    markRead: (ids) => write({ type: 'read', ids }),
    savePreferences: (preferences) => write({ type: 'preferences', ...preferences }),
  };
}
