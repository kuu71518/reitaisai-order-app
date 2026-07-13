import React, { useState, useEffect, useRef } from 'react';
import Login from './components/Login';
import Menu from './components/Menu';
import ManagerDashboard from './components/ManagerDashboard';
import Summary from './components/Summary';
import AdminDashboard from './components/AdminDashboard';

const API_URL = import.meta.env.VITE_API_URL;

const PUBLIC_VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// 自動ログアウトの制限時間設定（ミリ秒）
const INACTIVITY_LIMIT = 5 * 60 * 60 * 1000; // 5時間（何も操作しなかったらログアウト）
const BACKGROUND_LIMIT = 3 * 60 * 60 * 1000; // 3時間（ホーム画面等で裏にいってから経過したらログアウト）

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function App() {
  // 🌟 初回読み込み時の強制ログアウトチェック
  const [currentUser, setCurrentUser] = useState(() => {
    const savedUser = localStorage.getItem('reitaisai_app_user');
    if (!savedUser) return null;

    const now = Date.now();
    const hiddenAt = parseInt(localStorage.getItem('reitaisai_hidden_at') || '0', 10);
    const lastActive = parseInt(localStorage.getItem('reitaisai_last_active') || '0', 10);

    // 起動時に制限時間を超えていたらデータを消してログイン画面へ
    if (hiddenAt > 0 && (now - hiddenAt > BACKGROUND_LIMIT)) {
      localStorage.removeItem('reitaisai_app_user');
      return null;
    }
    if (lastActive > 0 && (now - lastActive > INACTIVITY_LIMIT)) {
      localStorage.removeItem('reitaisai_app_user');
      return null;
    }
    return JSON.parse(savedUser);
  });

  const [activeTab, setActiveTab] = useState(() => {
    return localStorage.getItem('reitaisai_active_tab') || 'menu';
  });

  const [notifications, setNotifications] = useState(() => {
    const savedNotifs = localStorage.getItem('reitaisai_notifs');
    return savedNotifs ? JSON.parse(savedNotifs) : [];
  });

  const notifiedOrderIds = useRef(new Set(notifications.map(n => n.orderId)));
  const [showNotifCenter, setShowNotifCenter] = useState(false);
  const [latestToast, setLatestToast] = useState(null);
  const [isSystemReady, setIsSystemReady] = useState(false);
  const wakeLockRef = useRef(null);

  // 🌟 追加：アプリ起動中の「裏画面移行」と「無操作」を監視するシステム
  useEffect(() => {
    if (!currentUser) return;

    const handleForceLogout = () => {
      localStorage.removeItem('reitaisai_app_user');
      localStorage.removeItem('reitaisai_hidden_at');
      localStorage.removeItem('reitaisai_last_active');
      setCurrentUser(null);
      alert('長期間操作が行われなかったため、安全のために自動ログアウトしました。');
    };

    const updateActivity = () => {
      localStorage.setItem('reitaisai_last_active', Date.now().toString());
    };

    // 画面タップやスクロールで「現在アクティブ」とみなす（処理が重くならないよう1分に1回だけ記録）
    let isThrottled = false;
    const throttledUpdate = () => {
      if (!isThrottled) {
        updateActivity();
        isThrottled = true;
        setTimeout(() => isThrottled = false, 60000);
      }
    };

    window.addEventListener('touchstart', throttledUpdate, { passive: true });
    window.addEventListener('click', throttledUpdate, { passive: true });
    window.addEventListener('scroll', throttledUpdate, { passive: true });

    updateActivity(); // 初期セット

    // 画面が閉じられた（裏に行った）か、戻ってきたかを監視
    const handleVisibilityChange = () => {
      const now = Date.now();
      if (document.visibilityState === 'hidden') {
        // 裏に行った時間を記録
        localStorage.setItem('reitaisai_hidden_at', now.toString());
      } else if (document.visibilityState === 'visible') {
        // 戻ってきたときに時間を計算
        const hiddenAt = parseInt(localStorage.getItem('reitaisai_hidden_at') || '0', 10);
        const lastActive = parseInt(localStorage.getItem('reitaisai_last_active') || '0', 10);

        if (hiddenAt > 0 && (now - hiddenAt > BACKGROUND_LIMIT)) {
          handleForceLogout();
        } else if (lastActive > 0 && (now - lastActive > INACTIVITY_LIMIT)) {
          handleForceLogout();
        } else {
          // セーフなら裏画面記録をリセット
          localStorage.removeItem('reitaisai_hidden_at');
          updateActivity();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // アプリをフォアグラウンドで開きっぱなしで放置された場合、1分ごとにチェック
    const interval = setInterval(() => {
      const lastActive = parseInt(localStorage.getItem('reitaisai_last_active') || '0', 10);
      if (lastActive > 0 && (Date.now() - lastActive > INACTIVITY_LIMIT)) {
        handleForceLogout();
      }
    }, 60000);

    return () => {
      window.removeEventListener('touchstart', throttledUpdate);
      window.removeEventListener('click', throttledUpdate);
      window.removeEventListener('scroll', throttledUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(interval);
    };
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('reitaisai_notifs', JSON.stringify(notifications));
  }, [notifications]);

  useEffect(() => {
    if (currentUser) localStorage.setItem('reitaisai_app_user', JSON.stringify(currentUser));
    else localStorage.removeItem('reitaisai_app_user');
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('reitaisai_active_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      setIsSystemReady(true);
    }
  }, []);

  const enableStandbyMode = async () => {
    try {
      if ('wakeLock' in navigator) wakeLockRef.current = await navigator.wakeLock.request('screen');
    } catch (err) { console.log('WakeLock error:', err); }

    if ('serviceWorker' in navigator && 'PushManager' in window) {
      try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          if (!PUBLIC_VAPID_KEY) {
            throw new Error('VITE_VAPID_PUBLIC_KEY is not configured');
          }
          const registration = await navigator.serviceWorker.register('/sw.js');
          const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
          });
          await fetch(`${API_URL}/api/notifications/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: currentUser.group_id, subscription: subscription })
          });
          console.log('✅ 準備完了！');
        }
      } catch (error) { console.error('Push設定エラー:', error); }
    }
    setIsSystemReady(true);
  };

  const testNotification = () => {
    if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
    if ('serviceWorker' in navigator && Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then(registration => {
        registration.showNotification('✅ テスト成功', {
          body: 'この通知が出れば、ロック画面にも正しく表示されます！',
          icon: '/icon.png',
          vibrate: [200, 100, 200],
          requireInteraction: true
        });
      });
    } else {
      alert('通知が許可されていません！スマホの設定を確認してください。');
    }
  };

  // 🕵️ 新着監視
  useEffect(() => {
    if (!currentUser || currentUser.role !== 'manager') return;

    const checkNewOrders = async () => {
      try {
        const res = await fetch(`${API_URL}/api/orders?status=pending&group_id=${currentUser.group_id}`);
        const json = await res.json();
        if (json.success && json.data.length > 0) {
          json.data.forEach(order => {
            if (!notifiedOrderIds.current.has(order.id)) {
              notifiedOrderIds.current.add(order.id);
              
              if ("vibrate" in navigator) navigator.vibrate([200, 100, 200, 100, 200]);

              if ('serviceWorker' in navigator && Notification.permission === 'granted') {
                navigator.serviceWorker.ready.then(registration => {
                  registration.showNotification('🆕 新着オーダー', {
                    body: `${order.user_name} さん: ${order.menu_name} (${order.size})`,
                    icon: '/icon.png',
                    badge: '/icon.png',
                    vibrate: [200, 100, 200, 100, 200],
                    requireInteraction: true,
                    tag: `order-${order.id}`
                  });
                });
              }

              const newNotif = {
                id: Date.now() + order.id,
                orderId: order.id,
                title: '🆕 新着注文',
                body: `${order.user_name} さんが「${order.menu_name} (${order.size})」を注文しました`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isRead: false
              };
              setNotifications(prev => [newNotif, ...prev]);
              setLatestToast(newNotif);
              
              setTimeout(() => setLatestToast(null), 5000);
            }
          });
        }
      } catch (e) {
        console.error("通知チェックエラー:", e);
      }
    };

    const interval = setInterval(checkNewOrders, 5000);
    return () => clearInterval(interval);
  }, [currentUser]);

  const handleLogout = () => {
    if (window.confirm('ログアウトしますか？')) {
      localStorage.removeItem('reitaisai_app_user');
      localStorage.removeItem('reitaisai_active_tab');
      localStorage.removeItem('reitaisai_notifs');
      localStorage.removeItem('reitaisai_hidden_at');
      localStorage.removeItem('reitaisai_last_active');
      setCurrentUser(null);
      setActiveTab('menu');
      if (wakeLockRef.current) wakeLockRef.current.release();
    }
  };

  const markAllAsRead = () => setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
  const removeNotification = (id) => setNotifications(prev => prev.filter(n => n.id !== id));

  if (!currentUser) return <Login onLogin={setCurrentUser} />;

  return (
    <div className="flex h-screen bg-gray-50 font-sans overflow-hidden">
      
      <aside className="hidden md:flex flex-col w-64 bg-white border-r border-gray-200 shadow-sm z-20">
        <div className="p-6 bg-red-600 text-white">
          <h1 className="text-lg font-black leading-tight">例大祭打ち上げ<br/>オーダーシステム</h1>
          <div className="mt-4 pt-4 border-t border-red-500/50">
            <p className="text-sm font-bold">{currentUser.name}</p>
            <p className="text-xs opacity-90">{currentUser.group_id}グループ</p>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          <button onClick={() => setActiveTab('menu')} className={`w-full block text-left px-4 py-3 font-bold rounded-lg ${activeTab === 'menu' ? 'text-red-600 bg-red-50' : 'text-gray-600 hover:bg-gray-100'}`}>🍽️ メニュー・注文</button>
          {currentUser.role === 'manager' && (
            <>
              <button onClick={() => setActiveTab('manager')} className={`w-full block text-left px-4 py-3 font-bold rounded-lg ${activeTab === 'manager' ? 'text-red-600 bg-red-50' : 'text-gray-600 hover:bg-gray-100'}`}>📋 担当者管理</button>
              <button onClick={() => setActiveTab('summary')} className={`w-full block text-left px-4 py-3 font-bold rounded-lg ${activeTab === 'summary' ? 'text-red-600 bg-red-50' : 'text-gray-600 hover:bg-gray-100'}`}>💰 会計</button>
            </>
          )}
          {currentUser.role === 'admin' && (
            <button onClick={() => setActiveTab('admin')} className={`w-full block text-left px-4 py-3 font-bold rounded-lg ${activeTab === 'admin' ? 'text-red-600 bg-red-50' : 'text-gray-600 hover:bg-gray-100'}`}>⚙️ システム管理</button>
          )}
        </nav>
        <div className="p-4 border-t border-gray-200">
          <button onClick={handleLogout} className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-lg transition-colors">ログアウト</button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col h-screen overflow-hidden relative">
        <header className="bg-red-600 text-white p-4 shadow-md flex justify-between items-center sticky top-0 z-50">
          <div className="md:hidden">
            <h1 className="text-sm font-bold">例大祭打ち上げオーダー</h1>
            <p className="text-xs opacity-90">{currentUser.name}</p>
          </div>
          <div className="hidden md:block"></div>
          
          <div className="flex items-center space-x-4">
            {currentUser.role === 'manager' && (
              <button 
                onClick={() => setShowNotifCenter(!showNotifCenter)}
                className="relative p-2 rounded-full hover:bg-red-700 transition-colors"
              >
                <span className="text-xl">🔔</span>
                {notifications.filter(n => !n.isRead).length > 0 && (
                  <span className="absolute top-0 right-0 bg-yellow-400 text-red-900 text-[10px] font-black px-1.5 py-0.5 rounded-full border-2 border-red-600 animate-bounce">
                    {notifications.filter(n => !n.isRead).length}
                  </span>
                )}
              </button>
            )}
            <button onClick={handleLogout} className="bg-red-700 hover:bg-red-800 px-3 py-1 rounded text-sm font-medium md:hidden">ログアウト</button>
          </div>
        </header>

        {currentUser.role === 'manager' && (
          <div className="flex z-40 bg-gray-800 text-white text-xs font-bold shadow-md">
            {!isSystemReady && (
              <button onClick={enableStandbyMode} className="flex-1 p-3 bg-yellow-500 text-yellow-900 flex items-center justify-center animate-pulse">
                <span className="mr-1">⚠️</span> スタンバイON
              </button>
            )}
            <button onClick={testNotification} className="flex-1 p-3 bg-blue-600 hover:bg-blue-700 flex items-center justify-center border-l border-gray-700">
              <span className="mr-1">🔔</span> 通知テスト
            </button>
          </div>
        )}

        {latestToast && (
          <div className="fixed top-24 left-0 right-0 z-[100] px-4 flex justify-center pointer-events-none animate-bounce">
            <div className="bg-gray-900 text-white shadow-2xl rounded-2xl p-4 w-full max-w-sm flex justify-between items-center border border-gray-700 pointer-events-auto">
              <div className="flex-1 min-w-0 pr-2">
                <p className="text-[10px] font-black text-yellow-400 uppercase tracking-widest">{latestToast.title}</p>
                <p className="text-sm font-bold truncate leading-tight mt-1">{latestToast.body}</p>
              </div>
              <button 
                onClick={() => setLatestToast(null)}
                className="bg-gray-800 text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center text-lg font-black flex-shrink-0 transition-colors"
              >✕</button>
            </div>
          </div>
        )}

        {showNotifCenter && (
          <div className="fixed inset-0 z-[100] md:absolute md:inset-auto md:right-4 md:top-20 md:w-80">
            <div className="md:hidden fixed inset-0 bg-black/50" onClick={() => setShowNotifCenter(false)} />
            <div className="relative bg-white h-full md:h-auto md:rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">
              <div className="p-4 border-b flex justify-between items-center bg-gray-50 rounded-t-2xl">
                <h3 className="font-black text-gray-800">通知履歴</h3>
                <button onClick={() => setShowNotifCenter(false)} className="md:hidden text-gray-400">閉じる</button>
              </div>
              <div className="p-2 border-b bg-white flex justify-end">
                <button onClick={markAllAsRead} className="text-xs font-bold text-blue-600 hover:underline">全て既読にする</button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {notifications.length === 0 ? (
                  <p className="text-center py-10 text-gray-400 text-sm">通知はありません</p>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} className={`p-3 rounded-xl border relative ${n.isRead ? 'bg-white border-gray-100' : 'bg-blue-50 border-blue-100'}`}>
                      <p className="text-[10px] text-gray-400 mb-1">{n.time}</p>
                      <p className="text-xs font-bold text-gray-800 pr-6">{n.body}</p>
                      <button onClick={() => removeNotification(n.id)} className="absolute top-2 right-2 text-gray-300 hover:text-gray-600 text-lg">×</button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8 pb-24 md:pb-8 w-full max-w-7xl mx-auto">
          {activeTab === 'menu' && <Menu currentUser={currentUser} />}
          {activeTab === 'manager' && currentUser.role === 'manager' && <ManagerDashboard currentUser={currentUser} />}
          {activeTab === 'summary' && currentUser.role === 'manager' && <Summary />}
          {activeTab === 'admin' && currentUser.role === 'admin' && <AdminDashboard />}
        </main>

        <nav className="md:hidden bg-white border-t border-gray-200 fixed bottom-0 w-full flex justify-around p-2 pb-safe shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-50">
          <button onClick={() => setActiveTab('menu')} className={`flex-1 py-2 text-center text-xs font-bold rounded-lg ${activeTab === 'menu' ? 'text-red-600 bg-red-50' : 'text-gray-500'}`}>注文</button>
          {currentUser.role === 'manager' && (
            <>
              <button onClick={() => setActiveTab('manager')} className={`flex-1 py-2 text-center text-xs font-bold rounded-lg ${activeTab === 'manager' ? 'text-red-600 bg-red-50' : 'text-gray-500'}`}>担当者</button>
              <button onClick={() => setActiveTab('summary')} className={`flex-1 py-2 text-center text-xs font-bold rounded-lg ${activeTab === 'summary' ? 'text-red-600 bg-red-50' : 'text-gray-500'}`}>会計</button>
            </>
          )}
          {currentUser.role === 'admin' && (
            <button onClick={() => setActiveTab('admin')} className={`flex-1 py-2 text-center text-xs font-bold rounded-lg ${activeTab === 'admin' ? 'text-red-600 bg-red-50' : 'text-gray-500'}`}>管理</button>
          )}
        </nav>
      </div>
    </div>
  );
}
