import { useCallback, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import Login from './components/Login';
import Menu from './components/Menu';
import ManagerDashboard from './components/ManagerDashboard';
import Summary from './components/Summary';
import AdminDashboard from './components/AdminDashboard';
import { LoadingState, StatusNotice } from './components/States';
import { useManagerOrders } from './hooks/useManagerOrders';
import { ApiError, apiRequest, clearSessionToken, loadSession } from './lib/api';

const LEGACY_USER_KEY = 'reitaisai_app_user';
const ACTIVE_TAB_KEY = 'reitaisai_active_tab';
const HIDDEN_AT_KEY = 'reitaisai_hidden_at';
const LAST_ACTIVE_KEY = 'reitaisai_last_active';
const LEGACY_NOTIFICATION_KEY = 'reitaisai_notifs';
const INACTIVITY_LIMIT = 5 * 60 * 60 * 1000;
const BACKGROUND_LIMIT = 3 * 60 * 60 * 1000;

const SESSION_STORAGE_KEYS = [
  LEGACY_USER_KEY,
  ACTIVE_TAB_KEY,
  HIDDEN_AT_KEY,
  LAST_ACTIVE_KEY,
  LEGACY_NOTIFICATION_KEY,
];

const BASE_NAV_ITEMS = [{ id: 'menu', icon: '🍽', label: '注文する' }];

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

function readSessionNumber(key) {
  const value = Number(readSessionItem(key));
  return Number.isFinite(value) ? value : 0;
}

function compactUser(user) {
  const allowedRoles = new Set(['member', 'manager', 'admin']);
  if (!user || !user.id || !user.name || !user.group_id || !allowedRoles.has(user.role)) return null;
  return {
    id: user.id,
    name: user.name,
    group_id: user.group_id,
    role: user.role,
  };
}

function getNavItems(user) {
  if (!user) return BASE_NAV_ITEMS;
  if (user.role === 'manager') {
    return [
      ...BASE_NAV_ITEMS,
      { id: 'manager', icon: '📋', label: '注文をまとめる' },
      { id: 'summary', icon: '¥', label: '会計を見る' },
    ];
  }
  if (user.role === 'admin') {
    return [...BASE_NAV_ITEMS, { id: 'admin', icon: '⚙', label: '管理する' }];
  }
  return BASE_NAV_ITEMS;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authState, setAuthState] = useState('loading');
  const [sessionError, setSessionError] = useState('');
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [activeTab, setActiveTab] = useState(() => {
    const storedTab = readSessionItem(ACTIVE_TAB_KEY);
    return storedTab || 'menu';
  });
  const [loginNotice, setLoginNotice] = useState('');
  const [latestToast, setLatestToast] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [privacyCovered, setPrivacyCovered] = useState(false);
  const notifiedOrderIds = useRef(new Set());
  const orderBaselineReady = useRef(false);
  const toastTimer = useRef(null);
  const { mutate: mutateAll } = useSWRConfig();

  const showOrderToast = useCallback((count) => {
    const toast = {
      id: Date.now(),
      title: count > 1 ? `${count}件の新しい注文` : '新しい注文があります',
      body: '担当者画面を開いて内容を確認してください。',
    };

    setLatestToast(toast);
    setUnreadCount((current) => current + count);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setLatestToast((current) => (current?.id === toast.id ? null : current));
    }, 6000);
  }, []);

  const handleManagerOrders = useCallback((orders) => {
    const orderIds = orders.map((order) => order.id);
    if (!orderBaselineReady.current) {
      notifiedOrderIds.current = new Set(orderIds);
      orderBaselineReady.current = true;
      return;
    }

    const newOrders = orders.filter((order) => !notifiedOrderIds.current.has(order.id));
    if (newOrders.length === 0) return;

    newOrders.forEach((order) => notifiedOrderIds.current.add(order.id));
    showOrderToast(newOrders.length);
  }, [showOrderToast]);

  const managerOrders = useManagerOrders(currentUser, handleManagerOrders);

  const clearClientSession = useCallback((notice = '') => {
    removeSessionKeys();
    removeLegacyLocalStorage();
    clearSessionToken();
    setCurrentUser(null);
    setActiveTab('menu');
    setLatestToast(null);
    setUnreadCount(0);
    setPrivacyCovered(false);
    setLoginNotice(notice);
    notifiedOrderIds.current.clear();
    orderBaselineReady.current = false;
    window.clearTimeout(toastTimer.current);
    void mutateAll(() => true, undefined, { revalidate: false });
  }, [mutateAll]);

  const handleLogout = useCallback(async () => {
    if (isLoggingOut || !window.confirm('この端末からログアウトしますか？')) return;
    setIsLoggingOut(true);
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
      clearClientSession('ログアウトしました。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearClientSession('ログインの有効期限が切れました。');
      } else {
        window.alert('ログアウト処理を完了できませんでした。通信状態を確認して、もう一度お試しください。');
      }
    } finally {
      setIsLoggingOut(false);
    }
  }, [clearClientSession, isLoggingOut]);

  useEffect(() => {
    removeLegacyLocalStorage();
    removeSessionItem(LEGACY_USER_KEY);
    let cancelled = false;

    void loadSession()
      .then((user) => {
        if (cancelled) return;
        const safeUser = compactUser(user);
        if (!safeUser) throw new Error('Invalid session user');
        setCurrentUser(safeUser);
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
        if (!cancelled) setAuthState('ready');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleExpired = () => clearClientSession('ログインの有効期限が切れました。もう一度ログインしてください。');
    window.addEventListener('reitaisai:auth-expired', handleExpired);
    return () => window.removeEventListener('reitaisai:auth-expired', handleExpired);
  }, [clearClientSession]);

  useEffect(() => {
    if (currentUser) writeSessionItem(ACTIVE_TAB_KEY, activeTab);
  }, [activeTab, currentUser]);

  useEffect(() => {
    if (!currentUser) return undefined;

    let lastActivityWrite = 0;
    let logoutInFlight = false;
    let logoutRetryTimer = null;
    const updateActivity = () => {
      const now = Date.now();
      if (now - lastActivityWrite < 60_000) return;
      lastActivityWrite = now;
      writeSessionItem(LAST_ACTIVE_KEY, String(now));
    };

    const forceLogout = async () => {
      if (logoutInFlight) return;
      logoutInFlight = true;
      setPrivacyCovered(true);

      try {
        await apiRequest('/api/auth/logout', { method: 'POST' });
        clearClientSession('長時間操作がなかったため、安全のためログアウトしました。');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          clearClientSession('ログインの有効期限が切れました。');
          return;
        }

        logoutRetryTimer = window.setTimeout(() => {
          logoutInFlight = false;
          void forceLogout();
        }, 10_000);
        return;
      }

      logoutInFlight = false;
    };

    const handleVisibilityChange = () => {
      const now = Date.now();
      if (document.visibilityState === 'hidden') {
        setPrivacyCovered(true);
        writeSessionItem(HIDDEN_AT_KEY, String(now));
        return;
      }

      const hiddenAt = readSessionNumber(HIDDEN_AT_KEY);
      const lastActive = readSessionNumber(LAST_ACTIVE_KEY);
      if (
        (hiddenAt > 0 && now - hiddenAt > BACKGROUND_LIMIT)
        || (lastActive > 0 && now - lastActive > INACTIVITY_LIMIT)
      ) {
        void forceLogout();
        return;
      }

      removeSessionItem(HIDDEN_AT_KEY);
      setPrivacyCovered(false);
      updateActivity();
    };

    updateActivity();
    window.addEventListener('touchstart', updateActivity, { passive: true });
    window.addEventListener('pointerdown', updateActivity, { passive: true });
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('scroll', updateActivity, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const interval = window.setInterval(() => {
      const lastActive = readSessionNumber(LAST_ACTIVE_KEY);
      if (lastActive > 0 && Date.now() - lastActive > INACTIVITY_LIMIT) void forceLogout();
    }, 60_000);

    return () => {
      window.removeEventListener('touchstart', updateActivity);
      window.removeEventListener('pointerdown', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('scroll', updateActivity);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(interval);
      window.clearTimeout(logoutRetryTimer);
    };
  }, [clearClientSession, currentUser]);

  if (authState === 'loading') {
    return (
      <div className="login-shell">
        <main className="login-card session-loading-card">
          <LoadingState label="ログイン状態を確認しています" />
        </main>
      </div>
    );
  }

  if (!currentUser) return <Login notice={loginNotice} sessionError={sessionError} />;

  const navItems = getNavItems(currentUser);
  const safeActiveTab = navItems.some((item) => item.id === activeTab) ? activeTab : 'menu';
  const handleNavigate = (tab) => {
    setActiveTab(tab);
    setLatestToast(null);
    if (tab === 'manager') setUnreadCount(0);
  };

  let screen = <Menu currentUser={currentUser} />;
  if (safeActiveTab === 'manager') {
    screen = (
      <ManagerDashboard
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
    screen = <Summary currentUser={currentUser} />;
  } else if (safeActiveTab === 'admin') {
    screen = <AdminDashboard />;
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
          {currentUser.role === 'manager' && (
            <button
              type="button"
              className="icon-text-button"
              onClick={() => handleNavigate('manager')}
              aria-label={unreadCount > 0 ? `新しい注文が${unreadCount}件あります` : '担当者画面を開く'}
            >
              <span aria-hidden="true">🔔</span>
              <span className="desktop-only">新着</span>
              {unreadCount > 0 && <span className="count-badge">{unreadCount}</span>}
            </button>
          )}
          <button type="button" className="logout-button" onClick={handleLogout} disabled={isLoggingOut}>
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
              aria-current={safeActiveTab === item.id ? 'page' : undefined}
            >
              <span className="nav-symbol" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <p className="side-note">操作に迷ったら、画面の赤いボタンを順番に押してください。</p>
      </aside>

      <main className="main-stage" id="main-content">
        <div className="mobile-user-line">
          <span>{currentUser.name}</span>
          <strong>{currentUser.group_id}</strong>
        </div>
        {currentUser.role === 'manager' && safeActiveTab !== 'manager' && (
          <StatusNotice
            tone="warning"
            title="新着注文は担当者画面でも確認できます"
            action={<button type="button" className="small-button" onClick={() => handleNavigate('manager')}>担当者画面を開く</button>}
          >
            通知を使わなくても注文機能は利用できます。
          </StatusNotice>
        )}
        {screen}
      </main>

      <nav className="mobile-nav" aria-label="メインメニュー">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={safeActiveTab === item.id ? 'mobile-nav-item is-active' : 'mobile-nav-item'}
            onClick={() => handleNavigate(item.id)}
            aria-current={safeActiveTab === item.id ? 'page' : undefined}
          >
            <span className="mobile-nav-symbol" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
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
          <button type="button" onClick={() => handleNavigate('manager')}>注文を確認</button>
          <button type="button" className="toast-close" onClick={() => setLatestToast(null)} aria-label="通知を閉じる">×</button>
        </div>
      )}
      </div>

      {privacyCovered && (
        <div className="privacy-cover" role="status" aria-live="polite">
          <img src="/icon-192.png" alt="" />
          <strong>内容を隠しています</strong>
        </div>
      )}
    </>
  );
}
