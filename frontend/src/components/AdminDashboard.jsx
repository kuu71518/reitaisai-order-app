import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, getErrorMessage, resolveApiUrl } from '../lib/api';
import { formatDateTime, formatYen, orderTotal } from '../lib/format';
import { createRequestId } from '../lib/requestId';
import { EmptyState, Field, LoadingState, ScreenIntro, StatusNotice } from './States';
import BulkUserImport from './admin/BulkUserImport';
import DataResetPanel from './admin/DataResetPanel';
import UserDeleteAction from './admin/UserDeleteAction';

const ADMIN_TABS = [
  { id: 'overview', label: '全体状況' },
  { id: 'people', label: '参加者' },
  { id: 'orders', label: '注文' },
  { id: 'menu', label: 'メニュー' },
  { id: 'logs', label: '操作履歴' },
  { id: 'safety', label: '安全な操作' },
];

const ROLE_OPTIONS = [
  { value: 'member', label: '一般参加者' },
  { value: 'manager', label: '担当者' },
  { value: 'admin', label: '管理者' },
];
const ASSIGNABLE_ROLE_OPTIONS = ROLE_OPTIONS.filter((option) => option.value !== 'admin');
const BANQUET_CATEGORY = '宴会コース';

const DEFAULT_GROUPS = ['Aグループ', 'あグループ'];
const EMPTY_STATS = { total_users: 0, total_orders: 0, total_cancels: 0, total_sales: 0 };
const EMPTY_MENU = { name: '', category: '', price: '', size: '' };
const AUDIT_LABELS = {
  AUTH_LOGIN: 'ログイン',
  AUTH_LOGOUT: 'ログアウト',
  AUTH_BOOTSTRAP_LINK: '初回管理者連携',
  DISCORD_ALLOWLIST_UPDATE: 'Discordログイン許可変更',
  DISCORD_ALLOWLIST_REVOKE: 'Discordログイン許可解除',
  ORDER_CREATE: '注文作成',
  ADMIN_ORDER_CREATE: '管理者による注文追加',
  ADMIN_ORDER_CANCEL: '管理者による事前追加の訂正',
  ORDER_QUANTITY_UPDATE: '注文個数変更',
  ORDER_STATUS_UPDATE: '注文伝達済み',
  USER_CREATE: '参加者追加',
  USER_BULK_CREATE: '参加者一括追加',
  USER_DEACTIVATE: '参加者削除',
  USER_UPDATE: '参加者設定変更',
  MENU_CREATE: 'メニュー追加',
  EVENT_DATA_RESET: '開催データリセット',
};

function getData(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function formatCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, count).toLocaleString('ja-JP') : '0';
}

function validateMenu(values) {
  const name = values.name.trim();
  const category = values.category.trim();
  const size = values.size.trim();
  const price = Number(values.price);

  if (!name || !category || !size) {
    return { error: 'カテゴリ、メニュー名、サイズをすべて入力してください。' };
  }
  if (values.price === '' || !Number.isInteger(price) || price < 0 || price > 100000) {
    return { error: '価格は0円から100,000円までの整数で入力してください。' };
  }

  return { value: { name, category, size, price } };
}

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notice, setNotice] = useState(null);
  const latestLoadId = useRef(0);

  const [orders, setOrders] = useState([]);
  const [users, setUsers] = useState([]);
  const [adminMenu, setAdminMenu] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [stats, setStats] = useState(EMPTY_STATS);
  const [loadedTabs, setLoadedTabs] = useState([]);

  const [editingUserId, setEditingUserId] = useState(null);
  const [userDraft, setUserDraft] = useState({ group_id: '', role: 'member', discord_user_id: '' });
  const [userActions, setUserActions] = useState({});
  const [newUser, setNewUser] = useState({ name: '', group_id: '', role: 'member', discord_user_id: '' });
  const [newUserState, setNewUserState] = useState({ busy: false, error: '' });

  const [adminOrder, setAdminOrder] = useState(() => ({
    user_id: '',
    category: BANQUET_CATEGORY,
    menu_item_id: '',
    quantity: '1',
    request_id: createRequestId('admin'),
  }));
  const [adminOrderState, setAdminOrderState] = useState({ busy: false, error: '' });
  const [busyAdminOrderId, setBusyAdminOrderId] = useState(null);

  const [selectedCategory, setSelectedCategory] = useState('すべて');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [newMenu, setNewMenu] = useState(EMPTY_MENU);
  const [newMenuState, setNewMenuState] = useState({ busy: false, error: '' });

  const fetchData = useCallback(async ({ initial = false, tabId = 'overview', requestId } = {}) => {
    try {
      if (tabId === 'overview') {
        const payload = await apiRequest('/api/admin/stats');
        setStats(payload?.data || EMPTY_STATS);
      } else if (tabId === 'people') {
        const payload = await apiRequest('/api/admin/users');
        setUsers(getData(payload));
      } else if (tabId === 'orders') {
        const [ordersPayload, usersPayload, menuPayload] = await Promise.all([
          apiRequest('/api/admin/orders'),
          apiRequest('/api/admin/users'),
          apiRequest('/api/admin/menu'),
        ]);
        setOrders(getData(ordersPayload));
        setUsers(getData(usersPayload));
        setAdminMenu(getData(menuPayload));
      } else if (tabId === 'menu') {
        const payload = await apiRequest('/api/admin/menu');
        setAdminMenu(getData(payload));
      } else if (tabId === 'logs') {
        const payload = await apiRequest('/api/admin/logs');
        setAuditLogs(getData(payload));
      }

      setLoadedTabs((current) => current.includes(tabId) ? current : [...current, tabId]);
      if (requestId === latestLoadId.current) {
        setLoadError('');
        setLoadState('ready');
      }
      return true;
    } catch (error) {
      if (requestId === latestLoadId.current) {
        setLoadError(getErrorMessage(error, '管理情報を読み込めませんでした。'));
        if (initial) setLoadState('error');
      }
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++latestLoadId.current;
    void Promise.resolve().then(() => {
      if (!cancelled) return fetchData({ initial: true, tabId: 'overview', requestId });
      return false;
    });

    return () => {
      cancelled = true;
    };
  }, [fetchData]);

  const refreshData = async ({ initial = false, tabId = activeTab } = {}) => {
    if (tabId === 'safety') return true;
    const requestId = ++latestLoadId.current;
    if (initial) setLoadState('loading');
    else setIsRefreshing(true);
    setLoadError('');

    try {
      return await fetchData({ initial, tabId, requestId });
    } finally {
      if (requestId === latestLoadId.current) setIsRefreshing(false);
    }
  };

  const existingGroups = useMemo(() => {
    const groups = [...new Set(
      users
        .filter((user) => user.role !== 'admin')
        .map((user) => user.group_id)
        .filter(Boolean),
    )];
    return groups.length > 0 ? groups : DEFAULT_GROUPS;
  }, [users]);
  const selectedNewUserGroup = existingGroups.includes(newUser.group_id)
    ? newUser.group_id
    : existingGroups[0] || '';

  const menuCategories = useMemo(() => {
    return [...new Set(adminMenu.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [adminMenu]);

  const filteredMenu = useMemo(() => {
    return [...adminMenu]
      .filter((item) => selectedCategory === 'すべて' || item.category === selectedCategory)
      .sort((a, b) => {
        const categoryResult = String(a.category).localeCompare(String(b.category), 'ja');
        return categoryResult || String(a.name).localeCompare(String(b.name), 'ja');
      });
  }, [adminMenu, selectedCategory]);

  const effectiveAdminOrderCategory = menuCategories.includes(adminOrder.category)
    ? adminOrder.category
    : menuCategories.includes(BANQUET_CATEGORY) ? BANQUET_CATEGORY : menuCategories[0] || '';
  const adminOrderMenuOptions = adminMenu
    .filter((item) => item.category === effectiveAdminOrderCategory && Number(item.is_active) === 1)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  const effectiveAdminOrderMenuId = adminOrderMenuOptions.some((item) => String(item.id) === String(adminOrder.menu_item_id))
    ? String(adminOrder.menu_item_id)
    : String(adminOrderMenuOptions[0]?.id || '');
  const adminOrderUsers = users.filter((user) => user.role !== 'admin');
  const effectiveAdminOrderUserId = adminOrderUsers.some((user) => String(user.id) === String(adminOrder.user_id))
    ? String(adminOrder.user_id)
    : String(adminOrderUsers[0]?.id || '');
  const selectedAdminOrderMenu = adminOrderMenuOptions.find((item) => String(item.id) === effectiveAdminOrderMenuId);
  const selectedAdminOrderUser = adminOrderUsers.find((user) => String(user.id) === effectiveAdminOrderUserId);
  const selectedAdminOrderIsImmediate = Number(selectedAdminOrderMenu?.is_admin_only) === 1
    || selectedAdminOrderMenu?.category === BANQUET_CATEGORY;

  const setUserAction = (id, patch) => {
    setUserActions((current) => ({
      ...current,
      [id]: { busy: false, error: '', ...current[id], ...patch },
    }));
  };

  const changeTab = (tabId) => {
    const requestId = ++latestLoadId.current;
    setActiveTab(tabId);
    setIsRefreshing(false);
    setNotice(null);
    setLoadError('');

    if (tabId === 'safety' || loadedTabs.includes(tabId)) {
      setLoadState('ready');
      return;
    }

    setLoadState('loading');
    void fetchData({ initial: true, tabId, requestId });
  };

  const handleTabKeyDown = (event, index) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();

    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % ADMIN_TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = ADMIN_TABS.length - 1;

    const nextTab = ADMIN_TABS[nextIndex];
    changeTab(nextTab.id);
    document.getElementById(`admin-tab-${nextTab.id}`)?.focus();
  };

  const startUserEdit = (user) => {
    setEditingUserId(user.id);
    setUserDraft({ group_id: user.group_id, role: user.role, discord_user_id: '' });
    setUserAction(user.id, { error: '' });
  };

  const cancelUserEdit = () => {
    setEditingUserId(null);
    setUserDraft({ group_id: '', role: 'member', discord_user_id: '' });
  };

  const saveUser = async (user) => {
    const groupId = userDraft.group_id.trim();
    const discordUserId = userDraft.discord_user_id.trim();
    const roleIsValid = user.role === 'admin'
      ? userDraft.role === 'admin'
      : ASSIGNABLE_ROLE_OPTIONS.some((option) => option.value === userDraft.role);
    if (!groupId || !roleIsValid || (discordUserId && !/^\d{16,22}$/.test(discordUserId))) {
      setUserAction(user.id, { error: 'グループ、権限、DiscordユーザーIDを確認してください。' });
      return;
    }
    const changeSummary = discordUserId
      ? 'グループ・権限・ログイン許可'
      : 'グループまたは権限';
    if ((user.group_id !== groupId || user.role !== userDraft.role || discordUserId)
      && !window.confirm(`${user.name}さんの${changeSummary}を、この内容へ変更しますか？`)) return;

    setUserAction(user.id, { busy: true, error: '' });
    try {
      await apiRequest(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: {
          group_id: groupId,
          role: userDraft.role,
          ...(discordUserId ? { discord_user_id: discordUserId } : {}),
        },
      });
      setUsers((current) => current.map((item) => (
        item.id === user.id
          ? { ...item, group_id: groupId, role: userDraft.role, discord_registered: discordUserId ? 1 : item.discord_registered }
          : item
      )));
      cancelUserEdit();
      setNotice({
        tone: 'success',
        title: '参加者情報を保存しました。',
        message: discordUserId ? '新しいログイン許可を登録し、以前のログイン状態を解除しました。' : '',
      });
    } catch (error) {
      setUserAction(user.id, { error: getErrorMessage(error, '参加者情報を保存できませんでした。') });
    } finally {
      setUserAction(user.id, { busy: false });
    }
  };

  const addUser = async (event) => {
    event.preventDefault();
    const values = {
      name: newUser.name.trim(),
      group_id: selectedNewUserGroup.trim(),
      role: newUser.role,
      discord_user_id: newUser.discord_user_id.trim(),
    };
    const roleIsValid = ASSIGNABLE_ROLE_OPTIONS.some((option) => option.value === values.role);

    if (!values.name || !values.group_id || !roleIsValid || !/^\d{16,22}$/.test(values.discord_user_id)) {
      setNewUserState({ busy: false, error: '名前、グループ、権限、DiscordのユーザーIDを確認してください。' });
      return;
    }
    if (values.role !== 'member'
      && !window.confirm(`${values.name}さんを「${ROLE_OPTIONS.find((option) => option.value === values.role)?.label}」として追加しますか？`)) return;

    setNewUserState({ busy: true, error: '' });
    try {
      await apiRequest('/api/admin/users', { method: 'POST', body: values });
      setNewUser((current) => ({ ...current, name: '', role: 'member', discord_user_id: '' }));
      setNotice({ tone: 'success', title: '参加者を追加しました。' });
      await fetchData({ tabId: 'people' });
    } catch (error) {
      setNewUserState({ busy: false, error: getErrorMessage(error, '参加者を追加できませんでした。') });
    } finally {
      setNewUserState((current) => ({ ...current, busy: false }));
    }
  };

  const refreshPeopleAfterBulkAdd = async () => {
    setLoadedTabs((current) => current.filter((tabId) => !['overview', 'people', 'orders', 'logs'].includes(tabId)));
    return await refreshData({ tabId: 'people' });
  };

  const handleUserDeleted = (user) => {
    setUsers((current) => current.filter((item) => item.id !== user.id));
    setUserActions((current) => {
      const next = { ...current };
      delete next[user.id];
      return next;
    });
    if (editingUserId === user.id) cancelUserEdit();
    setLoadedTabs((current) => current.filter((tabId) => !['overview', 'orders', 'logs'].includes(tabId)));
    setNotice({
      tone: 'success',
      title: `${user.name}さんを参加者一覧から削除しました。`,
      message: '本人はログインできなくなりました。過去の注文・会計・操作履歴は残ります。',
    });
  };

  const handleDataReset = () => {
    setUsers((current) => current.filter((user) => user.role === 'admin'));
    setOrders([]);
    setAuditLogs([]);
    setStats(EMPTY_STATS);
    setLoadedTabs([]);
    setEditingUserId(null);
    setUserActions({});
    setNotice({
      tone: 'success',
      title: '開催データをリセットしました。',
      message: '参加者と注文は削除され、管理者・メニュー・操作履歴は残っています。',
    });
  };

  const revokeDiscordAccess = async (user) => {
    if (!window.confirm(`${user.name}さんのログイン許可を解除しますか？ 現在ログイン中の端末もログアウトされます。`)) return;

    setUserAction(user.id, { busy: true, error: '' });
    try {
      await apiRequest(`/api/admin/users/${user.id}/discord-access/revoke`, { method: 'POST' });
      setUsers((current) => current.map((item) => (
        item.id === user.id ? { ...item, discord_registered: 0 } : item
      )));
      setNotice({
        tone: 'success',
        title: `${user.name}さんのログイン許可を解除しました。`,
        message: '再び許可するときは編集画面から本人確認済みのDiscordユーザーIDを登録してください。',
      });
    } catch (error) {
      setUserAction(user.id, { error: getErrorMessage(error, 'ログイン許可を解除できませんでした。') });
    } finally {
      setUserAction(user.id, { busy: false });
    }
  };

  const addOrderForUser = async (event) => {
    event.preventDefault();
    const quantity = Number(adminOrder.quantity);
    if (!selectedAdminOrderUser || !selectedAdminOrderMenu || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      setAdminOrderState({ busy: false, error: '参加者、メニュー、個数を確認してください。' });
      return;
    }

    const statusLabel = selectedAdminOrderIsImmediate
      ? '注文済みとして事前加算'
      : '担当者の確認待ちとして追加';
    if (!window.confirm(`${selectedAdminOrderUser.name}さんへ「${selectedAdminOrderMenu.name}」を${quantity}点、${statusLabel}しますか？`)) return;

    setAdminOrderState({ busy: true, error: '' });
    try {
      await apiRequest(`/api/admin/users/${selectedAdminOrderUser.id}/orders`, {
        method: 'POST',
        body: {
          menu_item_id: selectedAdminOrderMenu.id,
          quantity,
          request_id: adminOrder.request_id,
        },
      });
      setAdminOrder((current) => ({
        ...current,
        quantity: '1',
        request_id: createRequestId('admin'),
      }));
      setNotice({
        tone: 'success',
        title: `${selectedAdminOrderUser.name}さんへ注文を追加しました。`,
        message: selectedAdminOrderIsImmediate
          ? '利用者の注文履歴には「管理者が事前に追加」と表示され、金額へ加算されます。'
          : '担当者が店員へ伝える注文として追加されました。',
      });
      await fetchData({ tabId: 'orders' });
    } catch (error) {
      setAdminOrderState({ busy: false, error: getErrorMessage(error, '注文を追加できませんでした。') });
    } finally {
      setAdminOrderState((current) => ({ ...current, busy: false }));
    }
  };

  const cancelAdminAddedOrder = async (order) => {
    if (busyAdminOrderId !== null) return;
    if (!window.confirm(`${order.user_name}さんへ事前追加した「${order.item_name}」を訂正し、合計から除外しますか？`)) return;

    setBusyAdminOrderId(order.id);
    try {
      await apiRequest(`/api/admin/orders/${order.id}/cancel`, { method: 'POST' });
      setOrders((current) => current.map((item) => (
        item.id === order.id ? { ...item, status: 'cancelled' } : item
      )));
      setNotice({
        tone: 'success',
        title: '事前追加した注文を訂正しました。',
        message: '利用者の注文履歴にも取消済みとして残り、合計から除外されます。',
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: '事前追加した注文を訂正できませんでした。',
        message: getErrorMessage(error),
      });
    } finally {
      setBusyAdminOrderId(null);
    }
  };

  const addMenu = async (event) => {
    event.preventDefault();
    const validation = validateMenu(newMenu);
    if (validation.error) {
      setNewMenuState({ busy: false, error: validation.error });
      return;
    }

    setNewMenuState({ busy: true, error: '' });
    try {
      await apiRequest('/api/admin/menu', { method: 'POST', body: validation.value });
      setNewMenu(EMPTY_MENU);
      setShowAddMenu(false);
      setNotice({ tone: 'success', title: 'メニューを追加しました。' });
      await fetchData({ tabId: 'menu' });
    } catch (error) {
      setNewMenuState({ busy: false, error: getErrorMessage(error, 'メニューを追加できませんでした。') });
    } finally {
      setNewMenuState((current) => ({ ...current, busy: false }));
    }
  };

  const renderOverview = () => (
    <div className="admin-overview">
      <section className="admin-panel" aria-labelledby="admin-overview-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">いまの状況</p>
            <h2 id="admin-overview-heading">全体を確認する</h2>
          </div>
          <p className="admin-panel-description">参加者、注文、会計の現在値です。</p>
        </div>
        <dl className="admin-stat-grid">
          <div className="admin-stat-card">
            <dt>参加者</dt>
            <dd>{formatCount(stats.total_users)}人</dd>
          </div>
          <div className="admin-stat-card">
            <dt>注文</dt>
            <dd>{formatCount(stats.total_orders)}件</dd>
          </div>
          <div className="admin-stat-card">
            <dt>取消記録</dt>
            <dd>{formatCount(stats.total_cancels)}件</dd>
          </div>
          <div className="admin-stat-card admin-stat-card-emphasis">
            <dt>注文合計</dt>
            <dd>{formatYen(stats.total_sales)}</dd>
          </div>
        </dl>
      </section>

      <section className="admin-panel" aria-labelledby="admin-next-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">次にすること</p>
            <h2 id="admin-next-heading">管理する内容を選ぶ</h2>
          </div>
        </div>
        <div className="admin-quick-actions">
          {ADMIN_TABS.filter((tab) => !['overview', 'safety'].includes(tab.id)).map((tab) => (
            <button key={tab.id} type="button" className="admin-quick-action" onClick={() => changeTab(tab.id)}>
              {tab.label}を開く
            </button>
          ))}
        </div>
      </section>
    </div>
  );

  const renderPeople = () => (
    <div className="admin-section-stack">
      <section className="admin-panel" aria-labelledby="admin-people-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">登録済み</p>
            <h2 id="admin-people-heading">参加者一覧</h2>
          </div>
          <p className="admin-panel-description">グループと権限は、編集後に保存したときだけ反映されます。</p>
        </div>

        <StatusNotice tone="info" title="削除しても過去の記録は残ります">
          参加者を削除するとログインできなくなります。過去の注文・会計・操作履歴は確認用に残ります。
        </StatusNotice>

        {users.length === 0 ? (
          <EmptyState
            symbol="人"
            title="参加者はまだ登録されていません"
            description="下の入力欄から最初の参加者を追加できます。"
          />
        ) : (
          <ul className="admin-list admin-people-list">
            {users.map((user) => {
              const action = userActions[user.id] || {};
              const isEditing = editingUserId === user.id;
              return (
                <li key={user.id} className="admin-list-item admin-person-item">
                  <div className="admin-person-summary">
                    <strong className="admin-person-name">{user.name}</strong>
                    <span className="admin-person-meta">{user.group_id}・{ROLE_OPTIONS.find((option) => option.value === user.role)?.label || '権限不明'}</span>
                    <span className={user.discord_registered ? 'admin-link-state is-linked' : 'admin-link-state'}>
                      {user.discord_registered ? 'ログイン許可済み' : 'ログインID未登録'}
                    </span>
                    <span className="admin-person-total">利用額 {formatYen(user.total_spent)}</span>
                  </div>

                  {isEditing ? (
                    <div className="admin-inline-editor" aria-label={`${user.name}さんの登録内容を編集`}>
                      <div className="admin-form-grid">
                        <Field label="グループ" required>
                          <select
                            className="admin-select"
                            value={userDraft.group_id}
                            onChange={(event) => setUserDraft((current) => ({ ...current, group_id: event.target.value }))}
                            disabled={action.busy}
                          >
                            {existingGroups.map((group) => <option key={group} value={group}>{group}</option>)}
                          </select>
                        </Field>
                        <Field label="権限" required>
                          <select
                            className="admin-select"
                            value={userDraft.role}
                            onChange={(event) => setUserDraft((current) => ({ ...current, role: event.target.value }))}
                            disabled={action.busy || user.role === 'admin'}
                          >
                            {(user.role === 'admin' ? ROLE_OPTIONS.filter((option) => option.value === 'admin') : ASSIGNABLE_ROLE_OPTIONS)
                              .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                        </Field>
                        {user.role !== 'admin' && (
                          <Field label="DiscordのユーザーID" hint="変更するときだけ入力します">
                            <input
                              className="admin-input"
                              value={userDraft.discord_user_id}
                              onChange={(event) => setUserDraft((current) => ({ ...current, discord_user_id: event.target.value.replace(/\D/g, '') }))}
                              inputMode="numeric"
                              autoComplete="off"
                              minLength={16}
                              maxLength={22}
                              placeholder="数字16〜22桁"
                              disabled={action.busy}
                            />
                          </Field>
                        )}
                      </div>
                      {action.error && <StatusNotice tone="danger" title="保存できませんでした" live>{action.error}</StatusNotice>}
                      <div className="admin-row-actions">
                        <button type="button" className="admin-button admin-button-secondary" onClick={cancelUserEdit} disabled={action.busy}>編集をやめる</button>
                        <button type="button" className="admin-button admin-button-primary" onClick={() => saveUser(user)} disabled={action.busy}>
                          {action.busy ? '保存しています' : '変更を保存'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="admin-row-actions">
                      <button type="button" className="admin-button admin-button-secondary" onClick={() => startUserEdit(user)} disabled={action.busy}>編集</button>
                      {user.role !== 'admin' && Number(user.discord_registered) === 1 && (
                        <button type="button" className="admin-button admin-button-danger-subtle" onClick={() => revokeDiscordAccess(user)} disabled={action.busy}>
                          {action.busy ? '解除しています' : 'ログイン許可を解除'}
                        </button>
                      )}
                      <UserDeleteAction
                        user={user}
                        disabled={action.busy}
                        onBusyChange={(busy) => setUserAction(user.id, { busy, error: '' })}
                        onDeleted={handleUserDeleted}
                      />
                    </div>
                  )}

                  {!isEditing && action.error && <StatusNotice tone="danger" title="操作できませんでした" live>{action.error}</StatusNotice>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="admin-add-person-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">新規登録</p>
            <h2 id="admin-add-person-heading">参加者を追加する</h2>
          </div>
          <p className="admin-panel-description">先にDiscordのユーザーIDを登録します。未登録アカウントはログインできません。</p>
        </div>
        <StatusNotice tone="info" title="DiscordのIDそのものは保存しません">
          入力したIDは照合用HMACへ変換後に破棄します。画面・操作履歴・D1へIDそのものやプロフィールは残りません。
        </StatusNotice>
        <form className="admin-form" onSubmit={addUser}>
          <div className="admin-form-grid">
            <Field label="参加者名" required>
              <input
                className="admin-input"
                value={newUser.name}
                onChange={(event) => setNewUser((current) => ({ ...current, name: event.target.value }))}
                maxLength={80}
                disabled={newUserState.busy}
              />
            </Field>
            <Field label="グループ" required>
              <select
                className="admin-select"
                value={selectedNewUserGroup}
                onChange={(event) => setNewUser((current) => ({ ...current, group_id: event.target.value }))}
                disabled={newUserState.busy}
              >
                {existingGroups.map((group) => <option key={group} value={group}>{group}</option>)}
              </select>
            </Field>
            <Field label="権限" required>
              <select
                className="admin-select"
                value={newUser.role}
                onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value }))}
                disabled={newUserState.busy}
              >
                {ASSIGNABLE_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="DiscordのユーザーID" hint="Discordでプロフィールを長押しし「ユーザーIDをコピー」" required>
              <input
                className="admin-input"
                value={newUser.discord_user_id}
                onChange={(event) => setNewUser((current) => ({ ...current, discord_user_id: event.target.value.replace(/\D/g, '') }))}
                inputMode="numeric"
                autoComplete="off"
                minLength={16}
                maxLength={22}
                placeholder="数字16〜22桁"
                disabled={newUserState.busy}
              />
            </Field>
          </div>
          {newUserState.error && <StatusNotice tone="danger" title="追加できませんでした" live>{newUserState.error}</StatusNotice>}
          <div className="admin-form-actions">
            <button type="submit" className="admin-button admin-button-primary" disabled={newUserState.busy}>
              {newUserState.busy ? '追加しています' : 'この参加者を追加'}
            </button>
          </div>
        </form>
      </section>

      <BulkUserImport groups={existingGroups} onComplete={refreshPeopleAfterBulkAdd} />
    </div>
  );

  const renderOrders = () => (
    <div className="admin-section-stack">
      <section className="admin-panel admin-order-add-panel" aria-labelledby="admin-add-order-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">事前に加算</p>
            <h2 id="admin-add-order-heading">利用者へ注文を追加する</h2>
          </div>
          <p className="admin-panel-description">宴会コースなど、本人の操作が不要な注文を管理者が追加できます。</p>
        </div>

        <StatusNotice tone="info" title="宴会コースはそのまま会計へ加算されます">
          宴会コースは事前に店へ伝えてあるため「注文済み」で追加します。それ以外は担当者の確認待ちになります。
        </StatusNotice>

        <form className="admin-form" onSubmit={addOrderForUser} aria-busy={adminOrderState.busy}>
          <div className="admin-form-grid">
            <Field label="追加する利用者" required>
              <select
                className="admin-select"
                value={effectiveAdminOrderUserId}
                onChange={(event) => setAdminOrder((current) => ({ ...current, user_id: event.target.value }))}
                disabled={adminOrderState.busy || adminOrderUsers.length === 0}
              >
                {adminOrderUsers.length === 0 && <option value="">利用者がいません</option>}
                {adminOrderUsers.map((user) => <option key={user.id} value={user.id}>{user.name}（{user.group_id}）</option>)}
              </select>
            </Field>
            <Field label="カテゴリー" required>
              <select
                className="admin-select"
                value={effectiveAdminOrderCategory}
                onChange={(event) => setAdminOrder((current) => ({ ...current, category: event.target.value, menu_item_id: '' }))}
                disabled={adminOrderState.busy || menuCategories.length === 0}
              >
                {menuCategories.length === 0 && <option value="">メニューがありません</option>}
                {menuCategories.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </Field>
            <Field label="メニュー" required>
              <select
                className="admin-select"
                value={effectiveAdminOrderMenuId}
                onChange={(event) => setAdminOrder((current) => ({ ...current, menu_item_id: event.target.value }))}
                disabled={adminOrderState.busy || adminOrderMenuOptions.length === 0}
              >
                {adminOrderMenuOptions.length === 0 && <option value="">選べるメニューがありません</option>}
                {adminOrderMenuOptions.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}・{item.size}・{formatYen(item.price)}</option>
                ))}
              </select>
            </Field>
            <Field label="個数" hint="1〜20点" required>
              <input
                className="admin-input"
                type="number"
                min="1"
                max="20"
                step="1"
                inputMode="numeric"
                value={adminOrder.quantity}
                onChange={(event) => setAdminOrder((current) => ({ ...current, quantity: event.target.value }))}
                disabled={adminOrderState.busy}
              />
            </Field>
          </div>

          {selectedAdminOrderMenu && selectedAdminOrderUser && (
            <div className="admin-order-preview" aria-live="polite">
              <span>{selectedAdminOrderUser.name}さんへ追加</span>
              <strong>{selectedAdminOrderMenu.name} × {formatCount(adminOrder.quantity)}</strong>
              <b>{formatYen(Number(selectedAdminOrderMenu.price || 0) * Math.max(0, Number(adminOrder.quantity) || 0))}</b>
            </div>
          )}
          {adminOrderState.error && <StatusNotice tone="danger" title="注文を追加できませんでした" live>{adminOrderState.error}</StatusNotice>}
          <div className="admin-form-actions">
            <button
              type="submit"
              className="admin-button admin-button-primary"
              disabled={adminOrderState.busy || !selectedAdminOrderUser || !selectedAdminOrderMenu}
            >
              {adminOrderState.busy ? '追加しています' : 'この注文を利用者へ追加'}
            </button>
          </div>
        </form>
      </section>

      <section className="admin-panel" aria-labelledby="admin-orders-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">注文確認</p>
            <h2 id="admin-orders-heading">注文一覧</h2>
          </div>
          <p className="admin-panel-description">現在登録されている注文を確認できます。</p>
        </div>
        <div id="admin-order-cancel-policy">
          <StatusNotice tone="info" title="管理者が事前追加した注文だけ訂正できます">
            入力を誤った場合は「事前追加を訂正」を押してください。参加者本人の注文を取り消す場合は、従来どおり担当者へ直接確認してください。
          </StatusNotice>
        </div>

        {orders.length === 0 ? (
          <EmptyState symbol="注" title="注文はありません" description="注文が入るとこの画面に表示されます。" />
        ) : (
          <ul className="admin-list admin-order-list">
            {orders.map((order) => (
              <li key={order.id} className={`admin-list-item admin-order-item${order.status === 'cancelled' ? ' is-cancelled' : ''}`}>
                <div className="admin-order-copy">
                  <strong>{order.item_name}</strong>
                  <span>{order.user_name}・{order.group_id}</span>
                  <span>{order.size} × {formatCount(order.quantity)}</span>
                  {Number(order.added_by_admin) === 1 && <small className="admin-source-label">管理者が事前追加</small>}
                  {order.status === 'cancelled' && <small className="admin-source-label is-cancelled">取消済み・合計対象外</small>}
                </div>
                <div className="admin-order-total">{formatYen(orderTotal(order))}</div>
                {Number(order.added_by_admin) === 1 && order.status !== 'cancelled' ? (
                  <button
                    type="button"
                    className="admin-button admin-button-danger"
                    disabled={busyAdminOrderId !== null}
                    onClick={() => cancelAdminAddedOrder(order)}
                  >
                    {busyAdminOrderId === order.id ? '訂正しています' : '事前追加を訂正'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="admin-button admin-button-disabled"
                    disabled
                    aria-describedby="admin-order-cancel-policy"
                  >
                    {order.status === 'cancelled' ? '取消済み' : '取消は利用停止中'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const renderMenu = () => (
    <div className="admin-section-stack">
      <section className="admin-panel" aria-labelledby="admin-menu-heading">
        <div className="admin-panel-heading">
          <div>
            <p className="admin-eyebrow">登録と編集</p>
            <h2 id="admin-menu-heading">メニュー管理</h2>
          </div>
          <button
            type="button"
            className="admin-button admin-button-primary"
            onClick={() => {
              setShowAddMenu((current) => !current);
              setNewMenuState({ busy: false, error: '' });
            }}
            aria-expanded={showAddMenu}
            aria-controls="admin-add-menu-form"
          >
            {showAddMenu ? '追加をやめる' : 'メニューを追加'}
          </button>
        </div>

        {showAddMenu && (
          <form id="admin-add-menu-form" className="admin-form admin-form-highlight" onSubmit={addMenu}>
            <h3>新しいメニュー</h3>
            <div className="admin-form-grid">
              <Field label="カテゴリ" required>
                <input className="admin-input" value={newMenu.category} onChange={(event) => setNewMenu((current) => ({ ...current, category: event.target.value }))} maxLength={60} disabled={newMenuState.busy} />
              </Field>
              <Field label="メニュー名" required>
                <input className="admin-input" value={newMenu.name} onChange={(event) => setNewMenu((current) => ({ ...current, name: event.target.value }))} maxLength={100} disabled={newMenuState.busy} />
              </Field>
              <Field label="サイズ" required>
                <input className="admin-input" value={newMenu.size} onChange={(event) => setNewMenu((current) => ({ ...current, size: event.target.value }))} maxLength={40} disabled={newMenuState.busy} />
              </Field>
              <Field label="価格（円）" hint="0円から100,000円までの整数" required>
                <input
                  className="admin-input"
                  type="number"
                  min="0"
                  max="100000"
                  step="1"
                  inputMode="numeric"
                  value={newMenu.price}
                  onChange={(event) => setNewMenu((current) => ({ ...current, price: event.target.value }))}
                  disabled={newMenuState.busy}
                />
              </Field>
            </div>
            {newMenuState.error && <StatusNotice tone="danger" title="追加できませんでした" live>{newMenuState.error}</StatusNotice>}
            <div className="admin-form-actions">
              <button type="submit" className="admin-button admin-button-primary" disabled={newMenuState.busy}>
                {newMenuState.busy ? '追加しています' : 'この内容で追加'}
              </button>
            </div>
          </form>
        )}

        <StatusNotice tone="warning" title="登録済みメニューの変更・削除は準備中です">
          過去の会計金額を変えない保存方式が整うまで、新規追加と閲覧だけ利用できます。
        </StatusNotice>

        <div className="admin-filter-row">
          <Field label="カテゴリで絞り込む">
            <select className="admin-select" value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
              <option value="すべて">すべてのカテゴリ</option>
              {menuCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <span className="admin-result-count">{formatCount(filteredMenu.length)}件</span>
        </div>

        {adminMenu.length === 0 ? (
          <EmptyState symbol="品" title="メニューはまだ登録されていません" description="「メニューを追加」から最初の商品を登録できます。" />
        ) : filteredMenu.length === 0 ? (
          <EmptyState
            symbol="検"
            title="このカテゴリにメニューはありません"
            description="別のカテゴリを選んでください。"
            action={<button type="button" className="admin-button admin-button-secondary" onClick={() => setSelectedCategory('すべて')}>すべて表示</button>}
          />
        ) : (
          <ul className="admin-list admin-menu-list">
            {filteredMenu.map((item) => (
              <li key={item.id} className="admin-list-item admin-menu-item">
                <div className="admin-menu-summary">
                  <span className="admin-menu-category">{item.category}</span>
                  <strong>{item.name}</strong>
                  <span>{item.size}・{formatYen(item.price)}</span>
                </div>
                <span className="admin-readonly-label">閲覧のみ</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const renderLogs = () => (
    <section className="admin-panel" aria-labelledby="admin-logs-heading">
      <div className="admin-panel-heading">
        <div>
          <p className="admin-eyebrow">監査</p>
          <h2 id="admin-logs-heading">操作履歴</h2>
        </div>
        <a className="admin-button admin-button-secondary" href={resolveApiUrl('/api/admin/logs/export')}>
          CSVを保存
        </a>
      </div>
      <p className="admin-panel-description">直近200件です。Discord ID、session、OAuth tokenは記録しません。</p>
      {auditLogs.length === 0 ? (
        <EmptyState symbol="履" title="操作履歴はありません" description="ログインや注文、管理操作を行うとここに表示されます。" />
      ) : (
        <ul className="admin-list">
          {auditLogs.map((log) => (
            <li key={log.id} className="admin-list-item admin-log-item">
              <div>
                <strong>{AUDIT_LABELS[log.action_type] || log.action_type}</strong>
                <span>{log.actor_user_id ? `実行者ID ${log.actor_user_id}` : 'システム'}{log.target_type ? `・対象 ${log.target_type}${log.target_id ? ` #${log.target_id}` : ''}` : ''}</span>
              </div>
              <time>{formatDateTime(log.created_at)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const renderSafety = () => <DataResetPanel onComplete={handleDataReset} />;

  const renderActiveTab = () => {
    if (activeTab === 'people') return renderPeople();
    if (activeTab === 'orders') return renderOrders();
    if (activeTab === 'menu') return renderMenu();
    if (activeTab === 'logs') return renderLogs();
    if (activeTab === 'safety') return renderSafety();
    return renderOverview();
  };

  return (
    <div className="admin-dashboard">
      <ScreenIntro
        eyebrow="管理者メニュー"
        title="管理する内容を選んでください"
        description="参加者、注文、メニュー、操作履歴を項目ごとに確認できます。"
        action={activeTab !== 'safety' ? (
          <button type="button" className="admin-button admin-button-secondary" onClick={() => refreshData()} disabled={isRefreshing || loadState === 'loading'}>
            {isRefreshing ? '更新しています' : '最新情報に更新'}
          </button>
        ) : undefined}
      />

      <nav className="admin-tabs" role="tablist" aria-label="管理項目">
        {ADMIN_TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={`admin-tab-${tab.id}`}
            type="button"
            role="tab"
            className={`admin-tab${activeTab === tab.id ? ' admin-tab-active' : ''}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`admin-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => changeTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {notice && (
        <StatusNotice
          tone={notice.tone}
          title={notice.title}
          live
          action={<button type="button" className="admin-button admin-button-quiet" onClick={() => setNotice(null)}>閉じる</button>}
        >
          {notice.message}
        </StatusNotice>
      )}

      {loadState === 'ready' && loadError && (
        <StatusNotice
          tone="warning"
          title="最新情報へ更新できませんでした"
          live
          action={<button type="button" className="admin-button admin-button-secondary" onClick={() => refreshData()}>もう一度更新</button>}
        >
          {loadError}
        </StatusNotice>
      )}

      <section
        id={`admin-panel-${activeTab}`}
        className="admin-tab-panel"
        role="tabpanel"
        aria-labelledby={`admin-tab-${activeTab}`}
        tabIndex="0"
      >
        {loadState === 'loading' && <LoadingState label="管理情報を読み込んでいます" />}
        {loadState === 'error' && (
          <StatusNotice
            tone="danger"
            title="管理情報を読み込めませんでした"
            live
            action={<button type="button" className="admin-button admin-button-primary" onClick={() => refreshData({ initial: true })}>もう一度読み込む</button>}
          >
            {loadError}
          </StatusNotice>
        )}
        {loadState === 'ready' && renderActiveTab()}
      </section>
    </div>
  );
}
