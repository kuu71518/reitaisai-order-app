import { useCallback, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import Login from './components/Login';
import Menu from './components/Menu';
import ManagerDashboard from './components/ManagerDashboard';
import Summary from './components/Summary';
import AdminDashboard from './components/AdminDashboard';
import VenueGuide from './components/VenueGuide';
import NavIcon from './components/NavIcon';
import ConfirmDialog from './components/ConfirmDialog';
import PushNotificationSettings from './components/PushNotificationSettings';
import NotificationHistory from './components/NotificationHistory';
import { LoadingState, StatusNotice } from './components/States';
import { useManagerOrders } from './hooks/useManagerOrders';
import { useNotificationHistory } from './hooks/useNotificationHistory';
import { ApiError, apiRequest, clearSessionToken, loadSession } from './lib/api';
import { canManageOrders, canReceiveOrderNotifications, getNavItems } from './lib/orderAccess';

const LEGACY_USER_KEY = 'reitaisai_app_user';
const ACTIVE_TAB_KEY = 'reitaisai_active_tab';
const HIDDEN_AT_KEY = 'reitaisai_hidden_at';
const LAST_ACTIVE_KEY = 'reitaisai_last_active';
const LEGACY_NOTIFICATION_KEY = 'reitaisai_notifs';
const SESSION_CHECK_TIMEOUT = 15_000;

const SESSION_STORAGE_KEYS = [
  LEGACY_USER_KEY,
  ACTIVE_TAB_KEY,
  HIDDEN_AT_KEY,
  LAST_ACTIVE_KEY,
  LEGACY_NOTIFICATION_KEY,
];

function readSessionItem(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionItem(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable in restricted browser modes.
  }
}

function removeSessionItem(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in restricted browser modes.
  }
}

function removeSessionKeys() {
  SESSION_STORAGE_KEYS.forEach(removeSessionItem);
}

function removeLegacyLocalStorage() {
  try {
    SESSION_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Legacy storage cleanup is best-effort.
  }
}

function compactUser(user) {
  const allowedRoles = new Set(['member', 'manager', 'chief', 'admin']);
  if (!user || !user.id || !user.name || !user.group_id || !allowedRoles.has(user.role)) return null;
  return {
    id: user.id,
    name: user.name,
    group_id: user.group_id,
    role: user.role,
  };
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authState, setAuthState] = useState('loading');
  const [sessionError, setSessionError] = useState('');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [resumeError, setResumeError] = useState('');
  const [isResuming, setIsResuming] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [orderView, setOrderView] = useState('menu');
  const [orderBusy, setOrderBusy] = useState(false);
  const mainRef = useRef(null);
  const [activeTab, setActiveTab] = useState(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'manager') return 'manager';
    const storedTab = readSessionItem(ACTIVE_TAB_KEY);
    return storedTab || 'menu';
  });
  const [loginNotice, setLoginNotice] = useState('');
  const [latestToast, setLatestToast] = useState(null);
  const [historyOpenFor, setHistoryOpenFor] = useState(null);
  const [privacyCovered, setPrivacyCovered] = useState(false);
  const toastTimer = useRef(null);
  const resumeController = useRef(null);
  const sessionGeneration = useRef(0);
  const currentUserRef = useRef(null);
  const { mutate: mutateAll } = useSWRConfig();

  const showOrderToast = useCallback((count) => {
    const toast = {
      id: Date.now(),
      title: count > 1 ? `${count}件の新しい注文` : '新しい注文があります',
      body: canManageOrders(currentUserRef.current) ? '取りまとめを開いて内容を確認してください。' : '担当グループの合計を確認してください。',
    };

    setLatestToast(toast);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setLatestToast((current) => (current?.id === toast.id ? null : current));
    }, 6000);
  }, []);

  const notifications = useNotificationHistory(currentUser, showOrderToast, authState === 'ready');
  const { unreadCount, deactivate: deactivateNotifications } = notifications;
  const managerOrders = useManagerOrders(currentUser, notifications.receiveOrders);

  const clearClientSession = useCallback((notice = '') => {
    sessionGeneration.current += 1;
    resumeController.current?.abort();
    resumeController.current = null;
    removeSessionKeys();
    removeLegacyLocalStorage();
    clearSessionToken();
    deactivateNotifications();
    currentUserRef.current = null;
    setCurrentUser(null);
    setActiveTab('menu');
    setOrderView('menu');
    setOrderBusy(false);
    setShowLogout(false);
    setLogoutError('');
    setLatestToast(null);
    setHistoryOpenFor(null);
    setPrivacyCovered(false);
    setResumeError('');
    setIsResuming(false);
    setLoginNotice(notice);
    window.clearTimeout(toastTimer.current);
    void mutateAll(() => true, undefined, { revalidate: false });
  }, [mutateAll, deactivateNotifications]);

  const handleLogout = useCallback(async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setLogoutError('');
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
      clearClientSession('ログアウトしました。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearClientSession('ログインの有効期限が切れました。');
      } else {
        setLogoutError('ログアウトできませんでした。通信状態を確認して、もう一度お試しください。');
      }
    } finally {
      setIsLoggingOut(false);
    }
  }, [clearClientSession, isLoggingOut]);

  useEffect(() => {
    removeLegacyLocalStorage();
    removeSessionItem(LEGACY_USER_KEY);
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT);

    void loadSession({ signal: controller.signal })
      .then((user) => {
        if (cancelled) return;
        const safeUser = compactUser(user);
        if (!safeUser) throw new Error('Invalid session user');
        currentUserRef.current = safeUser;
        setCurrentUser(safeUser);
        setPrivacyCovered(document.visibilityState === 'hidden');
        setSessionError('');
        setLoginNotice('');
        const url = new URL(window.location.href);
        if (url.searchParams.has('auth')) {
          url.searchParams.delete('auth');
          window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setCurrentUser(null);
        if (!(error instanceof ApiError && error.status === 401)) {
          setSessionError('通信状態を確認して、もう一度お試しください。');
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setAuthState('ready');
      });

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [sessionAttempt]);

  useEffect(() => {
    const handleExpired = () => clearClientSession('ログインの有効期限が切れました。もう一度ログインしてください。');
    window.addEventListener('reitaisai:auth-expired', handleExpired);
    return () => window.removeEventListener('reitaisai:auth-expired', handleExpired);
  }, [clearClientSession]);

  useEffect(() => {
    const openHistory = (event) => {
      if (event.data?.type !== 'OPEN_NOTIFICATION_HISTORY' || !canReceiveOrderNotifications(currentUser) || orderBusy) return;
      setHistoryOpenFor(`${currentUser.id}:${currentUser.group_id}:${currentUser.role}`);
      setLatestToast(null);
    };
    navigator.serviceWorker?.addEventListener('message', openHistory);
    return () => navigator.serviceWorker?.removeEventListener('message', openHistory);
  }, [currentUser, orderBusy]);

  useEffect(() => {
    if (!currentUser || !canReceiveOrderNotifications(currentUser)
      || new URLSearchParams(window.location.search).get('view') !== 'notifications') return;
    void Promise.resolve().then(() => setHistoryOpenFor(`${currentUser.id}:${currentUser.group_id}:${currentUser.role}`));
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) writeSessionItem(ACTIVE_TAB_KEY, activeTab);
  }, [activeTab, currentUser]);

  const resumeSession = useCallback(async () => {
    if (resumeController.current) return;
    const controller = new AbortController();
    const generation = sessionGeneration.current;
    resumeController.current = controller;
    setPrivacyCovered(true);
    setIsResuming(true);
    setResumeError('');
    const timeout = window.setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT);
    try {
      const user = await loadSession({ signal: controller.signal });
      if (generation !== sessionGeneration.current) return;
      const safeUser = compactUser(user);
      if (!safeUser) throw new Error('Invalid session user');
      const previousUser = currentUserRef.current;
      if (previousUser && (previousUser.id !== safeUser.id
        || previousUser.group_id !== safeUser.group_id || previousUser.role !== safeUser.role)) {
        await mutateAll(() => true, undefined, { revalidate: false });
        if (generation !== sessionGeneration.current) return;
        window.clearTimeout(toastTimer.current);
        setLatestToast(null);
        setHistoryOpenFor(null);
        setActiveTab('menu');
        setOrderView('menu');
        setOrderBusy(false);
      }
      currentUserRef.current = safeUser;
      setCurrentUser(safeUser);
      setPrivacyCovered(document.visibilityState === 'hidden');
    } catch (error) {
      if (generation !== sessionGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        clearClientSession('ログインの有効期限が切れたか、利用登録が変更されました。もう一度ログインしてください。');
      } else {
        setResumeError('ログイン状態を確認できませんでした。通信状態を確認して、もう一度お試しください。');
      }
    } finally {
      window.clearTimeout(timeout);
      if (resumeController.current === controller) {
        resumeController.current = null;
        setIsResuming(false);
      }
    }
  }, [clearClientSession, mutateAll]);

  const sessionUserId = currentUser?.id;
  useEffect(() => {
    if (!sessionUserId) return undefined;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') setPrivacyCovered(true);
      else void resumeSession();
    };
    const handleOnline = () => {
      if (document.visibilityState !== 'hidden') void resumeSession();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    return () => {
      sessionGeneration.current += 1;
      resumeController.current?.abort();
      resumeController.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [resumeSession, sessionUserId]);

  useEffect(() => {
    if (!mainRef.current) return;
    mainRef.current.focus({ preventScroll: true });
    mainRef.current.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeTab, orderView]);

  if (authState === 'loading') {
    return (
      <div className="login-shell">
        <main className="login-card session-loading-card">
          <LoadingState label="ログイン状態を確認しています" />
        </main>
      </div>
    );
  }

  if (!currentUser) return <Login notice={loginNotice} sessionError={sessionError} onRetrySession={() => {
    setSessionError('');
    setAuthState('loading');
    setSessionAttempt((attempt) => attempt + 1);
  }} />;

  const navItems = getNavItems(currentUser);
  const userContextKey = `${currentUser.id}:${currentUser.group_id}:${currentUser.role}`;
  const notificationTab = canManageOrders(currentUser) ? 'manager' : 'summary';
  const openNotificationHistory = () => {
    if (orderBusy) return;
    setHistoryOpenFor(userContextKey);
    setLatestToast(null);
    void notifications.refresh();
  };
  const safeActiveTab = navItems.some((item) => item.id === activeTab) ? activeTab
    : activeTab === 'manager' && canReceiveOrderNotifications(currentUser) ? 'summary' : 'menu';
  const handleNavigate = (tab) => {
    if (orderBusy) return;
    if (tab === 'menu') setOrderView('menu');
    setActiveTab(tab);
    setLatestToast(null);
  };
  const handleOrderView = (nextView) => {
    const user = currentUserRef.current;
    if (!user || `${user.id}:${user.group_id}:${user.role}` !== userContextKey) return;
    setOrderView(nextView === 'review' ? 'review' : 'menu');
    setActiveTab(nextView === 'history' ? 'history' : 'menu');
  };
  const handleOrderSubmitting = (submitting) => {
    const user = currentUserRef.current;
    if (!user || `${user.id}:${user.group_id}:${user.role}` !== userContextKey) return;
    setOrderBusy(submitting);
  };

  let screen = null;
  if (safeActiveTab === 'manager') {
    screen = (
      <ManagerDashboard
        key={userContextKey}
        currentUser={currentUser}
        orders={managerOrders.orders}
        ordersError={managerOrders.error}
        isLoading={managerOrders.isLoading}
        isRefreshing={managerOrders.isRefreshing}
        lastUpdated={managerOrders.lastUpdated}
        refreshOrders={managerOrders.refresh}
      />
    );
  } else if (safeActiveTab === 'summary') {
    screen = <Summary key={userContextKey} currentUser={currentUser} />;
  } else if (safeActiveTab === 'admin') {
    screen = <AdminDashboard key={userContextKey} currentUser={currentUser} onOrderHistoryCleared={() => {
      setLatestToast(null);
      window.clearTimeout(toastTimer.current);
      return mutateAll((key) => {
        const url = Array.isArray(key) ? key[0] : key;
        return typeof url === 'string' && (url.startsWith('/api/orders/') || url.startsWith('/api/manager/orders'));
      });
    }} />;
  }

  return (
    <>
      <div
        className="app-shell"
        inert={privacyCovered}
        aria-hidden={privacyCovered || undefined}
      >
      <header className="top-bar">
        <div className="brand-lockup">
          <img src="/icon-192.png" alt="" className="brand-stamp" />
          <div>
            <span className="brand-kicker">例大祭 打ち上げ</span>
            <strong>かんたん注文</strong>
          </div>
        </div>
        <div className="top-actions">
          {canReceiveOrderNotifications(currentUser) && (
            <button
              type="button"
              className="icon-text-button"
              onClick={openNotificationHistory}
              disabled={orderBusy}
              aria-label={`通知の受信履歴を開く：未読${unreadCount}件`}
              aria-haspopup="dialog"
            >
              <span aria-hidden="true">🔔</span>
              <span className="desktop-only">通知</span>
              {unreadCount > 0 && <span className="count-badge">{unreadCount}</span>}
            </button>
          )}
          <button type="button" className="logout-button" onClick={() => setShowLogout(true)} disabled={isLoggingOut || orderBusy}>
            {isLoggingOut ? '処理中…' : 'ログアウト'}
          </button>
        </div>
      </header>

      <aside className="side-rail" aria-label="メインメニュー">
        <div className="user-ticket">
          <span className="user-ticket-label">ログイン中</span>
          <strong>{currentUser.name}</strong>
          <span>{currentUser.group_id}</span>
        </div>
        <nav className="side-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={safeActiveTab === item.id ? 'nav-item is-active' : 'nav-item'}
              onClick={() => handleNavigate(item.id)}
              disabled={orderBusy}
              aria-current={safeActiveTab === item.id ? 'page' : undefined}
            >
              <span className="nav-symbol"><NavIcon name={item.id} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <p className="side-note">注文は席の担当者と主任・管理者へ届きます。担当者・主任・管理者が内容を確認して店員へ伝えます。</p>
      </aside>

      <main className="main-stage" id="main-content" ref={mainRef} tabIndex={-1}>
        <div className="mobile-user-line">
          <div><small>あなたの席</small><strong>{currentUser.group_id}</strong></div>
          <span>{currentUser.name}<small>さん</small></span>
        </div>
        <div className="app-guidance">
          <VenueGuide compact />
          {canReceiveOrderNotifications(currentUser) && <PushNotificationSettings key={userContextKey} currentUser={currentUser}
            alertPreferences={notifications.preferences} onAlertPreferences={notifications.savePreferences} />}
        </div>
        {canReceiveOrderNotifications(currentUser) && unreadCount > 0 && safeActiveTab !== notificationTab && (
          <StatusNotice
            tone="warning"
            title={`未読の通知が${unreadCount}件あります`}
            action={<button type="button" className="small-button" onClick={openNotificationHistory}>受信履歴を見る</button>}
          >
            ベルから受信履歴を開いて確認できます。
          </StatusNotice>
        )}
        <div hidden={!['menu', 'history'].includes(safeActiveTab)}>
          <Menu key={userContextKey} currentUser={currentUser}
            view={safeActiveTab === 'history' ? 'history' : orderView}
            onViewChange={handleOrderView} onSubmittingChange={handleOrderSubmitting} />
        </div>
        {screen}
      </main>

      <nav className="mobile-nav" aria-label="メインメニュー">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={safeActiveTab === item.id ? 'mobile-nav-item is-active' : 'mobile-nav-item'}
            onClick={() => handleNavigate(item.id)}
            disabled={orderBusy}
            aria-current={safeActiveTab === item.id ? 'page' : undefined}
            aria-label={item.id === 'manager' && unreadCount > 0 ? `${item.label}：未読の通知${unreadCount}件` : item.label}
          >
            <span className="mobile-nav-symbol"><NavIcon name={item.id} /></span>
            <span>{item.id === 'manager' ? 'まとめ' : item.label}</span>
            {item.id === 'manager' && unreadCount > 0 && <span className="mobile-nav-badge">{unreadCount}</span>}
          </button>
        ))}
      </nav>

      {latestToast && (
        <div className="order-toast" role="status" aria-live="polite">
          <div>
            <strong>{latestToast.title}</strong>
            <span>{latestToast.body}</span>
          </div>
          <button type="button" onClick={openNotificationHistory}>受信履歴</button>
          <button type="button" className="toast-close" onClick={() => setLatestToast(null)} aria-label="通知を閉じる">×</button>
        </div>
      )}
      </div>

      {canReceiveOrderNotifications(currentUser) && <NotificationHistory key={userContextKey}
        open={!privacyCovered && historyOpenFor === userContextKey} notifications={notifications}
        onClose={() => setHistoryOpenFor(null)} onOpenOrders={() => handleNavigate(notificationTab)} busy={orderBusy} />}

      <ConfirmDialog open={showLogout} title="この端末からログアウトしますか？"
        confirmLabel="ログアウトする" busy={isLoggingOut} onConfirm={handleLogout} onCancel={() => { setShowLogout(false); setLogoutError(''); }}>
        <p>次に使うときはDiscordでログインし直します。共用端末で使い終わったときに選んでください。</p>
        {logoutError && <StatusNotice tone="danger" title={logoutError} />}
      </ConfirmDialog>

      {privacyCovered && (
        <div className="privacy-cover" role="status" aria-live="polite">
          <img src="/icon-192.png" alt="" />
          <strong>{isResuming ? 'ログイン状態を確認しています' : resumeError ? '通信の確認が必要です' : '内容を隠しています'}</strong>
          {resumeError && <div className="session-resume-error">
            <p>{resumeError}</p>
            <button type="button" className="primary-button compact-button" onClick={() => void resumeSession()} disabled={isResuming}>もう一度確認する</button>
          </div>}
        </div>
      )}
    </>
  );
}
