import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, getErrorMessage } from '../lib/api';
import { applicationServerKey, subscriptionUsesKey } from '../lib/pushNotifications';
import { canManageAllGroups } from '../lib/orderAccess';
import { playNotificationAlert, prepareNotificationSound } from '../lib/notificationAlerts';

const PREFERENCE_KEY = 'reitaisai_push_notifications';
function optedOut() {
  try { return window.localStorage.getItem(PREFERENCE_KEY) === 'off'; } catch { return false; }
}
function savePreference(value) {
  try { window.localStorage.setItem(PREFERENCE_KEY, value); } catch { /* Browser subscription remains the primary setting. */ }
}

export default function PushNotificationSettings({ currentUser, alertPreferences, onAlertPreferences }) {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [alertBusy, setAlertBusy] = useState(false);
  const alive = useRef(false);
  const inFlight = useRef(false);
  const supportsPush = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  const iosNeedsInstall = (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
    && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone;

  const bindSubscription = useCallback(async (subscription, publicKey) => {
    if (!alive.current) throw new Error('画面が変わりました。');
    await apiRequest('/api/notifications/subscriptions', {
      method: 'POST', body: { endpoint: subscription.endpoint, public_key: publicKey },
    });
  }, []);

  const sync = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      if (iosNeedsInstall) { if (alive.current) setStatus('install'); return; }
      if (!supportsPush) { if (alive.current) setStatus('unsupported'); return; }
      const payload = await apiRequest('/api/notifications/config');
      if (!alive.current) return;
      setConfig(payload.data);
      if (!payload.data?.configured) { setStatus('unconfigured'); return; }
      applicationServerKey(payload.data.public_key);
      if (Notification.permission === 'denied') { setStatus('denied'); return; }
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (Notification.permission === 'granted' && subscription
        && !optedOut() && subscriptionUsesKey(subscription, payload.data.public_key)) {
        await bindSubscription(subscription, payload.data.public_key);
        if (alive.current) setStatus('on');
      } else if (alive.current) setStatus('off');
    } catch (error) {
      if (alive.current) { setStatus('error'); setMessage(getErrorMessage(error, '通知設定を確認できませんでした。')); }
    } finally { inFlight.current = false; }
  }, [bindSubscription, iosNeedsInstall, supportsPush]);

  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(() => { if (alive.current) return sync(); });
    const onVisible = () => { if (document.visibilityState === 'visible') void sync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [sync]);

  const enable = async () => {
    if (inFlight.current || !config?.configured) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    let createdSubscription = null;
    try {
      // Request permission directly from this click, before any network wait (iOS).
      const permission = await Notification.requestPermission();
      if (!alive.current) return;
      if (permission !== 'granted') { setStatus(permission === 'denied' ? 'denied' : 'off'); return; }
      const registration = await navigator.serviceWorker.getRegistration('/');
      if (!registration?.active) throw new Error('画面の準備中です。少し待ってから、もう一度お試しください。');
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !subscriptionUsesKey(subscription, config.public_key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(config.public_key) });
        createdSubscription = subscription;
      }
      await bindSubscription(subscription, config.public_key);
      savePreference('on');
      if (alive.current) { setStatus('on'); setMessage('この端末で、アプリを閉じている間も新しい注文の通知を受け取ります。'); }
    } catch (error) {
      if (createdSubscription) await createdSubscription.unsubscribe().catch(() => false);
      if (alive.current) { setStatus('error'); setMessage(getErrorMessage(error, '通知を有効にできませんでした。画面を更新してお試しください。')); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };

  const disable = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await apiRequest('/api/notifications/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
      savePreference('off');
      if (subscription) await subscription.unsubscribe().catch(() => false);
      if (alive.current) { setStatus('off'); setMessage('この端末へのプッシュ通知を停止しました。アプリ内の新着通知は引き続き表示します。'); }
    } catch (error) {
      if (alive.current) setMessage(getErrorMessage(error, '通知を停止できませんでした。もう一度お試しください。'));
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };

  const updateAlerts = async (preferences) => {
    if (alertBusy) return;
    setAlertBusy(true);
    // Unlock sound from the actual tap before waiting for browser storage.
    const prepared = preferences.sound ? await prepareNotificationSound() : false;
    const saved = await onAlertPreferences(preferences);
    if (alive.current) {
      setAlertMessage(saved ? preferences.sound && !prepared
        ? '通知音を再生できませんでした。「音・振動を確認」から再度お試しください。' : 'アプリ内の音・振動の設定を保存しました。'
        : '音・振動の設定を保存できませんでした。');
      setAlertBusy(false);
    }
  };
  const testAlerts = async () => {
    await prepareNotificationSound();
    const result = playNotificationAlert(alertPreferences);
    if (alive.current) setAlertMessage(`通知音：${!alertPreferences.sound ? 'オフ' : result.sound ? '再生を開始しました' : 'このブラウザでは再生できません'}。振動：${!alertPreferences.vibration ? 'オフ' : result.vibration ? '振動を要求しました' : 'この端末・ブラウザでは利用できません'}。`);
  };

  const labels = {
    loading: '通知設定を確認しています', on: 'プッシュ通知：オン', off: 'プッシュ通知：オフ',
    install: 'iPhone・iPadで通知を受け取るには', unsupported: 'このブラウザはプッシュ通知に対応していません',
    unconfigured: 'プッシュ通知は準備中です', denied: '端末の設定で通知がブロックされています', error: '通知設定を確認してください',
  };
  const compactLabels = {
    loading: '通知：確認中', on: '通知：オン', off: '通知：オフ', install: '通知の設定',
    unsupported: '通知：対応外', unconfigured: '通知：準備中', denied: '通知：ブロック', error: '通知の確認',
  };
  return <details className="push-settings">
    <summary aria-label={labels[status]}>
      <span className="push-label-full">{labels[status]}</span>
      <span className="push-label-compact" aria-hidden="true">{compactLabels[status]}</span>
    </summary>
    <div>
      <p>{canManageAllGroups(currentUser) ? '全グループの注文を通知します。' : '担当するグループの注文を通知します。'} 通知には参加者名や注文内容を表示しません。</p>
      {status === 'install' && <p>Safariの「共有」から「ホーム画面に追加」を選び、追加したアプリを開いて通知をオンにしてください（iOS・iPadOS 16.4以降）。</p>}
      {status === 'denied' && <p>端末・ブラウザの設定でこのアプリの通知を許可し、画面に戻って設定を確認してください。</p>}
      {['unsupported', 'unconfigured'].includes(status) && <p>アプリを開いている間の新着通知は利用できます。</p>}
      {message && <p role="status">{message}</p>}
      {status === 'on' ? <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => void disable()}>この端末の通知を止める</button>
        : config?.configured && ['off', 'error'].includes(status) ? <button type="button" className="primary-button compact-button" disabled={busy} onClick={() => void enable()}>{busy ? '設定しています…' : 'この端末で通知を受け取る'}</button> : null}
      {['error', 'denied'].includes(status) && <button type="button" className="secondary-button compact-button" onClick={() => void sync()} disabled={busy}>通知設定を再確認</button>}
      <fieldset className="notification-alert-settings">
        <legend>アプリを開いている間の音・振動</legend>
        <label><input type="checkbox" checked={alertPreferences.sound} disabled={alertBusy}
          onChange={(event) => void updateAlerts({ ...alertPreferences, sound: event.target.checked })} />通知音</label>
        <label><input type="checkbox" checked={alertPreferences.vibration} disabled={alertBusy}
          onChange={(event) => void updateAlerts({ ...alertPreferences, vibration: event.target.checked })} />バイブレーション（対応端末）</label>
        <button type="button" className="secondary-button compact-button" disabled={alertBusy} onClick={() => void testAlerts()}>音・振動を確認</button>
        {alertMessage && <p role="status">{alertMessage}</p>}
      </fieldset>
      <p>画面ロック中も受け取るにはプッシュ通知をオンにし、端末の通知設定で「ロック画面」「サウンド」「バイブレーション」を許可してください。ロック中の音・振動は端末側の設定に従います。</p>
      <p className="muted">ログアウト中は通知を停止します。端末の通知許可・通信状態・集中モードの設定によっては通知が届かないことがあります。</p>
    </div>
  </details>;
}
