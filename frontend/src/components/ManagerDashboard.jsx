import { useMemo, useState } from 'react';
import { apiRequest, getErrorMessage } from '../lib/api';
import { formatTime } from '../lib/format';
import { groupPendingOrders } from '../lib/orderAccess';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';
import ConfirmDialog from './ConfirmDialog';

export default function ManagerDashboard({
  currentUser,
  orders,
  ordersError,
  isLoading,
  isRefreshing,
  lastUpdated,
  refreshOrders,
}) {
  const [quantityDrafts, setQuantityDrafts] = useState({});
  const [busyOrderId, setBusyOrderId] = useState(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [ordersToComplete, setOrdersToComplete] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState('');
  const isAdmin = currentUser.role === 'admin';
  const groupOptions = [...new Set(orders.map((order) => order.group_id))].sort((a, b) => String(a).localeCompare(String(b), 'ja'));
  const visibleOrders = useMemo(() => (
    isAdmin && selectedGroup ? orders.filter((order) => order.group_id === selectedGroup) : orders
  ), [isAdmin, orders, selectedGroup]);

  const groupedOrders = useMemo(() => groupPendingOrders(visibleOrders, quantityDrafts), [visibleOrders, quantityDrafts]);

  const hasUnsavedQuantityDrafts = useMemo(() => orders.some((order) => (
    Object.prototype.hasOwnProperty.call(quantityDrafts, order.id)
      && Number(quantityDrafts[order.id]) !== Number(order.quantity)
  )), [orders, quantityDrafts]);

  const showFeedback = (tone, title, message) => setFeedback({ tone, title, message });

  const changeQuantityDraft = (order, delta) => {
    setQuantityDrafts((drafts) => {
      const current = Number(drafts[order.id] ?? order.quantity);
      const nextQuantity = Math.max(1, Math.min(20, current + delta));
      const nextDrafts = { ...drafts };
      if (nextQuantity === Number(order.quantity)) delete nextDrafts[order.id];
      else nextDrafts[order.id] = nextQuantity;
      return nextDrafts;
    });
  };

  const saveQuantity = async (order) => {
    if (busyOrderId !== null || isCompleting) return;
    const quantity = Number(quantityDrafts[order.id] ?? order.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      showFeedback('danger', '個数を保存できません', '個数は1～20の整数にしてください。');
      return;
    }

    setBusyOrderId(order.id);
    try {
      await apiRequest(`/api/manager/orders/${order.id}/quantity`, {
        method: 'PATCH',
        body: { quantity },
      });
      setQuantityDrafts((drafts) => {
        const next = { ...drafts };
        delete next[order.id];
        return next;
      });
      showFeedback('success', '個数を保存しました', `${order.menu_name}を${quantity}個に変更しました。`);
      await refreshOrders();
    } catch (error) {
      showFeedback('danger', '個数を保存できませんでした', getErrorMessage(error));
    } finally {
      setBusyOrderId(null);
    }
  };

  const markAllAsOrdered = async () => {
    if (!ordersToComplete?.length || isCompleting || hasUnsavedQuantityDrafts) return;
    // Only update the orders shown when confirmation was opened. New arrivals
    // during the dialog remain pending for the next handoff to the restaurant.
    const orderIds = ordersToComplete;

    setIsCompleting(true);
    try {
      const payload = await apiRequest('/api/manager/orders/status', {
        method: 'PATCH',
        body: { order_ids: orderIds, status: 'ordered' },
      });
      const updatedCount = Number(payload?.data?.updated_count || 0);
      if (updatedCount === orderIds.length) {
        showFeedback('success', `${updatedCount}件を注文済みにしました`, '新しい注文が届いていないか、一覧を更新します。');
      } else {
        showFeedback('warning', `${updatedCount}件を注文済みにしました`, `${orderIds.length - updatedCount}件は、ほかの操作で状態が変わっていたため更新しませんでした。`);
      }
      setQuantityDrafts({});
      setOrdersToComplete(null);
      await refreshOrders();
    } catch (error) {
      setOrdersToComplete(null);
      showFeedback('danger', '注文済みに変更できませんでした', getErrorMessage(error));
    } finally {
      setIsCompleting(false);
    }
  };

  return (
    <section className="screen manager-screen">
      <ScreenIntro
        eyebrow={isAdmin ? '全グループ 管理者' : `${currentUser.group_id} 担当者`}
        title="注文を取りまとめる"
        description="個数を確認し、店員へ伝えた後にまとめて「伝達済み」にします。"
        action={(
          <button type="button" className="secondary-button compact-button" onClick={() => refreshOrders()} disabled={isRefreshing}>
            {isRefreshing ? '更新中…' : '今すぐ更新'}
          </button>
        )}
      />

      {isAdmin && (
        <label className="manager-group-filter">
          <span>取りまとめるグループ</span>
          <select value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)} disabled={isCompleting || busyOrderId !== null}>
            <option value="">すべてのグループ</option>
            {[...new Set([...groupOptions, ...(selectedGroup ? [selectedGroup] : [])])].map((group) => <option key={group} value={group}>{group}</option>)}
          </select>
        </label>
      )}

      <div className="manager-status-row">
        <div className="pending-count-card">
          <span>店員へ伝える注文</span>
          <strong>{visibleOrders.length}<small>件</small></strong>
        </div>
        <div className="last-update-card">
          <span>最終更新</span>
          <strong>{lastUpdated ? formatTime(lastUpdated) : '未取得'}</strong>
          <small>5秒ごとに自動更新</small>
        </div>
      </div>

      {feedback && (
        <StatusNotice tone={feedback.tone} title={feedback.title} live action={(
          <button type="button" className="notice-close" onClick={() => setFeedback(null)} aria-label="お知らせを閉じる">×</button>
        )}>
          {feedback.message}
        </StatusNotice>
      )}

      {ordersError && orders.length > 0 && (
        <StatusNotice tone="warning" title="最新情報へ更新できませんでした" action={(
          <button type="button" className="small-button" onClick={() => refreshOrders()}>再読み込み</button>
        )}>
          直前の注文を残して表示しています。店員へ伝える前に再読み込みしてください。
        </StatusNotice>
      )}

      <section className="manager-order-section" aria-labelledby="pending-orders-title">
        <div className="section-heading">
          <div>
            <h2 id="pending-orders-title">個数を確認して店員へ伝える</h2>
          </div>
        </div>

        {isLoading && orders.length === 0 ? (
          <LoadingState label="新しい注文を確認しています" />
        ) : ordersError && orders.length === 0 ? (
          <EmptyState
            symbol="!"
            title="注文一覧を読み込めませんでした"
            description={getErrorMessage(ordersError, '通信状態を確認してください。')}
            action={<button type="button" className="primary-button compact-button" onClick={() => refreshOrders()}>もう一度読み込む</button>}
          />
        ) : visibleOrders.length === 0 ? (
          <EmptyState
            symbol="○"
            title="現在、新しい注文はありません"
            description="この画面は5秒ごとに自動更新されます。"
          />
        ) : (
          <div className="manager-order-groups">
            {groupedOrders.map((group) => (
              <article key={group.key} className="manager-order-group">
                <header>
                  <div>
                    {isAdmin && <span>{group.groupId}</span>}
                    <h3>{group.menuName}</h3>
                    <span>{group.size}</span>
                  </div>
                  <strong>合計 {group.total}個</strong>
                </header>
                <ul>
                  {group.items.map((order) => {
                    const quantity = Number(quantityDrafts[order.id] ?? order.quantity);
                    const changed = quantity !== Number(order.quantity);
                    const isSaving = busyOrderId === order.id;
                    const controlsBusy = busyOrderId !== null || isCompleting;
                    return (
                      <li key={order.id}>
                        <strong className="order-person">{order.user_name}</strong>
                        <div className="quantity-control" aria-label={`${order.user_name}の個数`}>
                          <button type="button" onClick={() => changeQuantityDraft(order, -1)} aria-label={`${order.user_name}さんの${order.menu_name}を1つ減らす`} disabled={controlsBusy}>−</button>
                          <output>{quantity}</output>
                          <button type="button" onClick={() => changeQuantityDraft(order, 1)} aria-label={`${order.user_name}さんの${order.menu_name}を1つ増やす`} disabled={controlsBusy}>＋</button>
                        </div>
                        {changed ? (
                          <button
                            type="button"
                            className="save-line-button"
                            disabled={controlsBusy}
                            onClick={() => saveQuantity(order)}
                          >
                            {isSaving ? '保存中…' : '個数を保存'}
                          </button>
                        ) : <span className="saved-label">保存済み</span>}
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </div>
        )}

        {visibleOrders.length > 0 && (
          <div className="complete-orders-panel">
            <div>
              <strong>店員へ伝え終わりましたか？</strong>
              <span>表示中の{visibleOrders.length}件が注文待ち一覧から外れます。</span>
              {hasUnsavedQuantityDrafts && (
                <small id="complete-orders-disabled-reason" role="status">
                  未保存の個数があります。すべての変更を保存してから伝達済みにしてください。
                </small>
              )}
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => setOrdersToComplete(visibleOrders.map((order) => order.id))}
              disabled={isCompleting || busyOrderId !== null || hasUnsavedQuantityDrafts}
              aria-describedby={hasUnsavedQuantityDrafts ? 'complete-orders-disabled-reason' : undefined}
            >
              {isCompleting ? '変更しています…' : `${visibleOrders.length}件を伝達済みにする`}
            </button>
          </div>
        )}

      </section>

      <details className="manager-help">
        <summary>困ったとき・注文の訂正</summary>
        <div>
          <p>注文一覧は5秒ごとに更新されます。通信エラーが出た場合は「今すぐ更新」で確認してください。</p>
          <p>注文の取消や参加者の変更は、管理者へ直接伝えてください。</p>
        </div>
      </details>
      <ConfirmDialog open={Boolean(ordersToComplete)} title="店員へ伝え終わりましたか？"
        confirmLabel={`${ordersToComplete?.length || 0}件を伝達済みにする`} busy={isCompleting}
        onConfirm={markAllAsOrdered} onCancel={() => setOrdersToComplete(null)}>
        <p>確認を開いた時点の{ordersToComplete?.length || 0}件を、注文待ちの一覧から外します。まだ伝えていない注文があれば「戻る」を押してください。</p>
      </ConfirmDialog>
    </section>
  );
}
