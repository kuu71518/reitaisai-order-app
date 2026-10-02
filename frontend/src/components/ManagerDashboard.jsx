import { useMemo, useState } from 'react';
import { apiRequest, getErrorMessage } from '../lib/api';
import { formatTime } from '../lib/format';
import { groupOrdersForHandoff } from '../lib/managerOrderGroups';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';
import ConfirmDialog from './ConfirmDialog';
import OrderCancelAction from './OrderCancelAction';
import '../styles/manager-compact.css';

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
  const [isCancelling, setIsCancelling] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [ordersToComplete, setOrdersToComplete] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState('');
  const isAdmin = currentUser.role === 'admin';
  const groupOptions = [...new Set(orders.map((order) => order.group_id))].sort((a, b) => String(a).localeCompare(String(b), 'ja'));
  const visibleOrders = useMemo(() => (
    isAdmin && selectedGroup ? orders.filter((order) => order.group_id === selectedGroup) : orders
  ), [isAdmin, orders, selectedGroup]);

  const groupedTables = useMemo(() => groupOrdersForHandoff(visibleOrders, quantityDrafts), [visibleOrders, quantityDrafts]);

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
    if (busyOrderId !== null || isCompleting || isCancelling) return;
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
    if (!ordersToComplete?.length || isCompleting || isCancelling || busyOrderId !== null || hasUnsavedQuantityDrafts) return;
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
          <select value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)} disabled={isCompleting || isCancelling || busyOrderId !== null}>
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
          <div className="manager-handoff-tables">
            {groupedTables.map((table) => (
              <section key={table.key} className="manager-handoff-table" aria-label={`${table.groupId}の注文`}>
                {isAdmin && <h3>{table.groupId}</h3>}
                <div className="manager-handoff-products">
                  {table.products.map((product) => (
                    <details key={product.key} className="manager-product">
                      <summary>
                        <span className="manager-product-summary">
                          <strong className="manager-product-name">{product.menuName}</strong>
                          <span className="manager-product-quantities">
                            {product.variants.map((variant) => (
                              <span key={variant.key}>{variant.size}<b>{variant.total}個</b></span>
                            ))}
                            {product.hasDraft && <span className="manager-product-unsaved">未保存の変更あり</span>}
                          </span>
                        </span>
                        <span className="manager-product-toggle">内訳<span className="sr-only">と個数変更</span></span>
                      </summary>
                      <div className="manager-product-details">
                        <p>個数の変更は注文ごとに保存します。</p>
                        {product.variants.map((variant) => (
                          <section key={variant.key} className="manager-variant-detail" aria-label={`${product.menuName} ${variant.size}の内訳`}>
                            <h4>{variant.size}・合計{variant.total}個</h4>
                            <ul className="manager-person-list">
                              {variant.people.map((person) => (
                                <li key={person.key}>
                                  <div className="manager-person-heading">
                                    <strong>{person.name}</strong>
                                    <span>合計{person.total}個{person.orders.length > 1 && `（${person.orders.length}件の注文）`}</span>
                                  </div>
                                  <ul className="manager-order-edit-list">
                                    {person.orders.map((order, index) => {
                                      const quantity = Number(quantityDrafts[order.id] ?? order.quantity);
                                      const changed = quantity !== Number(order.quantity);
                                      const isSaving = busyOrderId === order.id;
                                      const controlsBusy = busyOrderId !== null || isCompleting || isCancelling;
                                      const orderLabel = `${order.user_name}さんの${order.menu_name} ${order.size}${person.orders.length > 1 ? ` ${index + 1}件目` : ''}`;
                                      return (
                                        <li key={order.id} className="manager-order-edit-row">
                                          {person.orders.length > 1 && <small>{index + 1}件目{order.created_at && `・${formatTime(order.created_at)}`}</small>}
                                          <div className="quantity-control" aria-label={`${orderLabel}の個数`}>
                                            <button type="button" onClick={() => changeQuantityDraft(order, -1)} aria-label={`${orderLabel}を1つ減らす`} disabled={controlsBusy || quantity <= 1}>−</button>
                                            <output>{quantity}</output>
                                            <button type="button" onClick={() => changeQuantityDraft(order, 1)} aria-label={`${orderLabel}を1つ増やす`} disabled={controlsBusy || quantity >= 20}>＋</button>
                                          </div>
                                          {changed ? (
                                            <button type="button" className="save-line-button" disabled={controlsBusy} onClick={() => saveQuantity(order)} aria-label={`${orderLabel}の個数を保存`}>
                                              {isSaving ? '保存中…' : '個数を保存'}
                                            </button>
                                          ) : <span className="saved-label">保存済み</span>}
                                          <OrderCancelAction order={order} currentUser={currentUser} disabled={controlsBusy}
                                            onBusyChange={setIsCancelling} onCancelled={async () => {
                                              setQuantityDrafts((drafts) => {
                                                const next = { ...drafts };
                                                delete next[order.id];
                                                return next;
                                              });
                                              await refreshOrders();
                                            }} />
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </li>
                              ))}
                            </ul>
                          </section>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </section>
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
              disabled={isCompleting || isCancelling || busyOrderId !== null || hasUnsavedQuantityDrafts}
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
          <p>商品を開くと、注文者ごとの内訳と個数の変更ボタンが表示されます。同じ方の注文が複数ある場合も、個数は1件ずつ保存します。</p>
          <p>伝達前の注文は、商品を開いて「取り消す」から取消できます。店員へ伝えた後の訂正や参加者の変更は、管理者へ直接伝えてください。</p>
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
