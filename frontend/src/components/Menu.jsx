import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { apiFetcher, apiRequest, getErrorMessage } from '../lib/api';
import { formatTime, formatYen, getOrderStatus, orderTotal } from '../lib/format';
import { visibleMenuItemsForRole } from '../lib/menuVisibility';
import { menuGroupMatchesSearch } from '../lib/menuSearch';
import { createRequestId } from '../lib/requestId';
import { applyOrderSubmissionResults, changeCartQuantity, wasOrderHistoryCleared } from '../lib/orderRetry';
import { millisecondsUntilNextMinute, shouldShowLateNightNotice } from '../lib/time';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';
import MenuSearch from './MenuSearch';
import OrderCancelAction from './OrderCancelAction';

const EMPTY_ITEMS = [];
const CATEGORY_PRIORITY = [
  'ビール',
  'サワー',
  'ハイボール',
  'ソフトドリンク',
  '名物',
  '串焼',
  '揚物',
  '一品',
  '食事',
];

export default function Menu({ currentUser, view, onViewChange, onSubmittingChange }) {
  const [cart, setCart] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('すべて');
  const [selectedVariations, setSelectedVariations] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [cartToast, setCartToast] = useState(null);
  const [showLateNightNotice, setShowLateNightNotice] = useState(() => shouldShowLateNightNotice());
  const cartToastTimer = useRef(null);
  const cartToastSequence = useRef(0);
  const submissionInFlight = useRef(false);
  const cancellationInFlight = useRef(false);

  const userScope = [currentUser.id, currentUser.group_id, currentUser.role];
  const menuQuery = useSWR(['/api/menu', ...userScope], apiFetcher, {
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
  const historyQuery = useSWR(
    view === 'history' ? ['/api/orders/mine', ...userScope] : null,
    apiFetcher,
    { revalidateOnFocus: true, keepPreviousData: true },
  );

  const menuItems = useMemo(
    () => visibleMenuItemsForRole(menuQuery.data?.data || EMPTY_ITEMS, currentUser.role),
    [currentUser.role, menuQuery.data?.data],
  );
  const history = historyQuery.data?.data || EMPTY_ITEMS;
  const unconfirmedCount = cart.filter((item) => item.needsConfirmation).length;

  useEffect(() => {
    let timer;
    const updateNotice = () => {
      const now = new Date();
      setShowLateNightNotice(shouldShowLateNightNotice(now));
      timer = window.setTimeout(updateNotice, millisecondsUntilNextMinute(now));
    };
    updateNotice();
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => window.clearTimeout(cartToastTimer.current), []);

  useEffect(() => {
    if (cart.length === 0) return undefined;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [cart.length]);

  const categories = useMemo(() => {
    const available = [...new Set(menuItems.map((item) => item.category).filter(Boolean))];
    return [
      'すべて',
      ...CATEGORY_PRIORITY.filter((category) => available.includes(category)),
      ...available.filter((category) => !CATEGORY_PRIORITY.includes(category)).sort(),
    ];
  }, [menuItems]);

  const allGroupedItems = useMemo(() => {
    const groups = new Map();
    menuItems.forEach((item) => {
      const key = `${item.category || 'その他'}::${item.name}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          name: item.name,
          category: item.category || 'その他',
          variations: [],
        });
      }
      groups.get(key).variations.push(item);
    });

    return [...groups.values()]
      .sort((left, right) => {
        if (left.name === 'キリン一番搾り（生）') return -1;
        if (right.name === 'キリン一番搾り（生）') return 1;
        return left.name.localeCompare(right.name, 'ja-JP');
      });
  }, [menuItems]);

  const groupedItems = useMemo(() => allGroupedItems
    .filter((group) => selectedCategory === 'すべて' || group.category === selectedCategory)
    .filter((group) => menuGroupMatchesSearch(group, searchQuery)),
  [allGroupedItems, searchQuery, selectedCategory]);

  const cartSummary = useMemo(() => ({
    units: cart.reduce((sum, item) => sum + item.quantity, 0),
    total: cart.reduce((sum, item) => sum + Number(item.price || 0) * item.quantity, 0),
  }), [cart]);

  const historyTotals = useMemo(() => history.reduce((totals, order) => {
    const amount = orderTotal(order);
    if (order.status === 'ordered') totals.confirmed += amount;
    else if (order.status === 'pending') totals.pending += amount;
    return totals;
  }, { confirmed: 0, pending: 0 }), [history]);

  const showFeedback = (tone, title, message) => {
    setFeedback({ tone, title, message });
  };

  const showCartAddedToast = (item) => {
    cartToastSequence.current += 1;
    const toast = { id: cartToastSequence.current, message: `${item.name}（${item.size}）` };
    setCartToast(toast);
    window.clearTimeout(cartToastTimer.current);
    cartToastTimer.current = window.setTimeout(() => {
      setCartToast((current) => current?.id === toast.id ? null : current);
    }, 2600);
  };

  const addToCart = (group) => {
    if (submissionInFlight.current) return;
    const selectedId = Number(selectedVariations[group.key] ?? group.variations[0]?.id);
    const selectedItem = group.variations.find((variation) => Number(variation.id) === selectedId);
    if (!selectedItem) {
      showFeedback('danger', '商品を追加できませんでした', 'サイズを選び直して、もう一度お試しください。');
      return;
    }
    const existing = cart.find((item) => item.menu_item_id === selectedItem.id);
    if (existing?.needsConfirmation) {
      showFeedback('warning', '先に送信状況を確認してください', 'この商品は注文が届いている可能性があります。カートから同じ内容で再確認するか、注文履歴を確認してください。');
      return;
    }
    if (existing?.quantity >= 20) {
      showFeedback('warning', 'この商品の上限は20点です', '個数はカートの確認画面で変更できます。');
      return;
    }

    setCart((current) => {
      const currentItem = current.find((item) => item.menu_item_id === selectedItem.id);
      if (currentItem?.needsConfirmation) return current;
      if (currentItem) {
        return current.map((item) => (
          item.menu_item_id === selectedItem.id && item.quantity < 20
            ? { ...item, quantity: item.quantity + 1 }
            : item
        ));
      }
      return [...current, {
        ...selectedItem,
        menu_item_id: selectedItem.id,
        quantity: 1,
        request_id: createRequestId(),
      }];
    });
    setFeedback(null);
    showCartAddedToast(selectedItem);
  };

  const changeQuantity = (id, delta) => {
    if (submissionInFlight.current) return;
    setCart((current) => changeCartQuantity(current, id, delta));
  };

  const dismissConfirmedItem = (item) => {
    if (submissionInFlight.current || !item.needsConfirmation) return;
    const confirmed = window.confirm(`${item.name}（${item.size}）${item.quantity}点について、注文履歴または担当者への確認が済み、再送不要であることを確認しましたか？\nカートから外しても、送信済みの注文は取り消されません。結果が不明な場合は「キャンセル」を押してください。`);
    if (!confirmed) return;
    setCart((current) => current.filter((entry) => entry.request_id !== item.request_id));
    showFeedback('success', '確認済みの商品をカートから外しました', '送信済みの注文はそのまま残ります。注文内容は履歴で確認できます。');
  };

  const submitOrder = async () => {
    if (cart.length === 0 || submissionInFlight.current) return;
    submissionInFlight.current = true;
    const submittedItems = [...cart];
    setIsSubmitting(true);
    onSubmittingChange(true);
    setFeedback(null);

    const results = await Promise.allSettled(submittedItems.map((item) => apiRequest('/api/orders', {
      method: 'POST',
      body: {
        menu_item_id: item.menu_item_id,
        quantity: item.quantity,
        request_id: item.request_id,
      },
    })));

    const successfulIds = new Set();
    const failed = [];
    let clearedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') successfulIds.add(submittedItems[index].menu_item_id);
      else if (wasOrderHistoryCleared(result.reason)) clearedCount += 1;
      else failed.push(result.reason);
    });

    setCart((current) => applyOrderSubmissionResults(current, submittedItems, results));
    submissionInFlight.current = false;
    setIsSubmitting(false);
    onSubmittingChange(false);

    if (failed.length === 0 && clearedCount === 0) {
      showFeedback('success', '注文を送信しました', '担当者が内容を確認します。注文履歴で状態を確認できます。');
      onViewChange('history');
      await historyQuery.mutate();
      return;
    }

    const successCount = successfulIds.size;
    if (failed.length === 0 && clearedCount > 0) {
      showFeedback('warning', `${clearedCount}件は管理者による履歴削除済みです`,
        `${successCount > 0 ? `${successCount}件の受付を確認しました。` : ''}削除済みの注文をカートから外しました。新たに注文する場合は、メニューから選び直してください。`);
      await historyQuery.mutate();
      return;
    }
    showFeedback(
      successCount > 0 ? 'warning' : 'danger',
      successCount > 0 ? `${successCount}件の受付を確認、${failed.length}件は確認できませんでした` : '注文の受付を確認できませんでした',
      `${clearedCount > 0 ? `${clearedCount}件は履歴削除済みのためカートから外しました。` : ''}${getErrorMessage(failed[0], '通信状態を確認してください。')} 注文が届いている可能性があります。結果不明の商品は内容を変えずに再確認できます。`,
    );
    if (successCount > 0) await historyQuery.mutate();
  };

  const switchView = (nextView) => {
    if (submissionInFlight.current || cancellationInFlight.current) return;
    setFeedback(null);
    setCartToast(null);
    window.clearTimeout(cartToastTimer.current);
    onViewChange(nextView);
  };

  const renderOrderSteps = () => (
    <ol className="order-steps" aria-label="注文の手順">
      {[
        ['menu', '1', '選ぶ'],
        ['review', '2', '確認'],
        ['send', '3', '送る'],
      ].map(([id, number, label]) => {
        const isActive = isSubmitting ? id === 'send' : view === id;
        const isComplete = (view === 'review' && id === 'menu') || (isSubmitting && id !== 'send');
        return (
          <li key={id} className={`${isActive ? 'is-active' : ''} ${isComplete ? 'is-complete' : ''}`.trim()}>
            <span>{isComplete ? '✓' : number}</span>
            <strong>{label}</strong>
          </li>
        );
      })}
    </ol>
  );

  if (menuQuery.isLoading && !menuQuery.data) return <LoadingState label="メニューを読み込んでいます" />;

  if (menuQuery.error && !menuQuery.data) {
    return (
      <EmptyState
        symbol="!"
        title="メニューを読み込めませんでした"
        description={getErrorMessage(menuQuery.error, '通信状態を確認してください。')}
        action={<button type="button" className="primary-button compact-button" onClick={() => menuQuery.mutate()}>もう一度読み込む</button>}
      />
    );
  }

  return (
    <section className={`screen menu-screen${cart.length > 0 ? ' has-cart-dock' : ''}`}>

      {showLateNightNotice && (
        <StatusNotice tone="warning" title="深夜料金は予約条件と店舗の伝票で確認してください">
          公式案内では22時以降の注文に10%の深夜料金があります。アプリでは追加料金を自動計算しません。予約条件と店舗の伝票で確認してください。
        </StatusNotice>
      )}

      {unconfirmedCount > 0 && (
        <StatusNotice tone="warning" title={`${unconfirmedCount}件の送信状況が不明です`} action={(
          <button type="button" className="small-button" onClick={() => switchView(view === 'history' ? 'review' : 'history')} disabled={isSubmitting}>
            {view === 'history' ? 'カートで再確認する' : '注文履歴を確認する'}
          </button>
        )}>
          重複を防ぐため、結果が分かるまで数量変更・削除はできません。カートから同じ内容で再確認するか、履歴・担当者に確認してください。
        </StatusNotice>
      )}

      {feedback && (
        <StatusNotice tone={feedback.tone} title={feedback.title} live action={(
          <button type="button" className="notice-close" onClick={() => setFeedback(null)} aria-label="お知らせを閉じる">×</button>
        )}>
          {feedback.message}
        </StatusNotice>
      )}

      {cartToast && (
        <div className="cart-added-toast" role="status" aria-live="polite" aria-atomic="true">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>カートに追加しました</strong>
            <small>{cartToast.message}</small>
          </div>
        </div>
      )}

      {view === 'menu' && (
        <>
          <ScreenIntro
            title="料理・飲み物を選ぶ"
            description="好きなものをカートに。最後に確認して送信します。"
          />
          {renderOrderSteps()}

          <div className="catalog-tools">
            <MenuSearch
              query={searchQuery}
              category={selectedCategory}
              groups={allGroupedItems}
              onQueryChange={setSearchQuery}
              onChoose={(suggestion) => {
                setSelectedCategory(suggestion.category);
                setSearchQuery(suggestion.kind === 'category' ? '' : suggestion.label);
              }}
            />

            <div className="category-strip" aria-label="カテゴリーで絞り込む">
              {categories.map((category) => (
                <button
                  key={category}
                  type="button"
                  aria-pressed={selectedCategory === category}
                  className={selectedCategory === category ? 'is-active' : ''}
                  onClick={() => setSelectedCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
            <div className="catalog-filter-row">
              <label className="mobile-category-select">
                <span>種類</span>
                <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
                  {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <span className="catalog-result-count" role="status" aria-live="polite">{groupedItems.length}品</span>
            </div>
          </div>

          {menuQuery.error && (
            <StatusNotice tone="warning" title="最新情報へ更新できませんでした" action={(
              <button type="button" className="small-button" onClick={() => menuQuery.mutate()}>再読み込み</button>
            )}>
              直前に読み込んだメニューを表示しています。
            </StatusNotice>
          )}

          <div className="menu-grid">
            {groupedItems.map((group) => {
              const selectedId = Number(selectedVariations[group.key] ?? group.variations[0]?.id);
              const selectedItem = group.variations.find((item) => Number(item.id) === selectedId) || group.variations[0];
              const cartItem = cart.find((item) => item.menu_item_id === selectedItem?.id);
              return (
                <article key={group.key} className="menu-card">
                  <div className="menu-card-copy">
                    <div className="menu-card-meta"><span className="category-label">{group.category}</span>
                      {cartItem && <span className="in-cart-label">{cartItem.needsConfirmation ? '受付の確認が必要' : `カートに${cartItem.quantity}点`}</span>}
                    </div>
                    <h2>{group.name}</h2>
                  </div>
                  <div className="menu-card-controls">
                    {group.variations.length > 1 ? (
                      <label>
                        <span>サイズ・価格</span>
                        <select
                          aria-label={`${group.name}のサイズ・価格`}
                          value={selectedId}
                          onChange={(event) => setSelectedVariations((current) => ({
                            ...current,
                            [group.key]: Number(event.target.value),
                          }))}
                        >
                          {group.variations.map((variation) => (
                            <option key={variation.id} value={variation.id}>
                              {variation.size}・{formatYen(variation.price)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <div className="single-price">
                        <span>{selectedItem?.size || '通常'}</span>
                        <strong>{formatYen(selectedItem?.price)}</strong>
                      </div>
                    )}
                    <button type="button" className="add-cart-button" onClick={() => addToCart(group)}
                      aria-label={`${group.name}（${selectedItem?.size || '通常'}）をカートに追加`}
                      disabled={isSubmitting || Boolean(cartItem?.needsConfirmation) || cartItem?.quantity >= 20}>
                      <span aria-hidden="true">＋</span> {cartItem?.needsConfirmation ? '要確認' : cartItem?.quantity >= 20 ? '上限20点' : '追加する'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {groupedItems.length === 0 && (
            <EmptyState
              symbol="⌕"
              title="当てはまるメニューがありません"
              description="検索語を短くするか、カテゴリーを「すべて」に戻してください。"
              action={<button type="button" className="secondary-button compact-button" onClick={() => { setSearchQuery(''); setSelectedCategory('すべて'); }}>絞り込みを戻す</button>}
            />
          )}

        </>
      )}

      {view === 'review' && (
        <>
          <ScreenIntro
            title="注文内容を確認"
            description="商品と個数を確認して、席の担当者へ送ります。"
            action={<button type="button" className="secondary-button compact-button" onClick={() => switchView('menu')} disabled={isSubmitting}>メニューへ戻る</button>}
          />
          {renderOrderSteps()}

          <div className="order-ticket">
            <div className="ticket-heading">
              <div>
                <span>注文する人</span>
                <strong>{currentUser.name}</strong>
              </div>
              <div>
                <span>送信先</span>
                <strong>{currentUser.group_id}の担当者</strong>
              </div>
            </div>

            <ul className="cart-list">
              {cart.map((item) => (
                <li key={item.menu_item_id}>
                  <div className="cart-item-copy">
                    <strong>{item.name}</strong>
                    <span>{item.size}・1点 {formatYen(item.price)}</span>
                    {item.needsConfirmation && <small>送信結果が不明です。同じ内容で再確認できます。</small>}
                  </div>
                  <div className="quantity-control" aria-label={`${item.name}の個数`}>
                    <button type="button" onClick={() => changeQuantity(item.menu_item_id, -1)} aria-label={`${item.name}を1つ減らす`} disabled={isSubmitting || item.needsConfirmation}>−</button>
                    <output aria-live="polite">{item.quantity}</output>
                    <button type="button" onClick={() => changeQuantity(item.menu_item_id, 1)} aria-label={`${item.name}を1つ増やす`} disabled={isSubmitting || item.needsConfirmation || item.quantity >= 20}>＋</button>
                  </div>
                  <strong className="cart-line-total">{formatYen(Number(item.price || 0) * item.quantity)}</strong>
                  <button type="button" className="text-button danger-text" onClick={() => item.needsConfirmation ? dismissConfirmedItem(item) : changeQuantity(item.menu_item_id, -item.quantity)} disabled={isSubmitting}>
                    {item.needsConfirmation ? '確認済みなので外す' : 'カートから外す'}
                  </button>
                </li>
              ))}
            </ul>

            <div className="ticket-total">
              <span>合計 {cartSummary.units}点</span>
              <strong>{formatYen(cartSummary.total)}</strong>
            </div>
          </div>

          {cart.length === 0 ? (
            <EmptyState
              symbol="＋"
              title="カートは空です"
              description="メニューに戻って商品を選んでください。"
              action={<button type="button" className="primary-button compact-button" onClick={() => switchView('menu')}>メニューを見る</button>}
            />
          ) : (
            <div className="submit-panel">
              <span>{unconfirmedCount > 0 ? '内容を変えずに、受付を再確認します' : `${cartSummary.units}点・${formatYen(cartSummary.total)}を席の担当者へ`}</span>
              <button type="button" className="primary-button" onClick={submitOrder} disabled={isSubmitting} aria-busy={isSubmitting}>
                {isSubmitting ? '注文を確認しています…' : unconfirmedCount > 0 ? '送信と受付の再確認をする' : `この${cartSummary.units}点を注文する`}
              </button>
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        <>
          <ScreenIntro
            title="自分の注文履歴"
            description="「確認中」は担当者へ届いた注文。「注文済み」は店員へ伝達済みです。"
            action={<button type="button" className="secondary-button compact-button" onClick={() => historyQuery.mutate()} disabled={historyQuery.isValidating}>更新する</button>}
          />

          {historyQuery.isLoading && !historyQuery.data ? (
            <LoadingState label="注文履歴を読み込んでいます" />
          ) : historyQuery.error && !historyQuery.data ? (
            <EmptyState
              symbol="!"
              title="注文履歴を読み込めませんでした"
              description={getErrorMessage(historyQuery.error, '通信状態を確認してください。')}
              action={<button type="button" className="primary-button compact-button" onClick={() => historyQuery.mutate()}>もう一度読み込む</button>}
            />
          ) : (
            <>
              {historyQuery.error && (
                <StatusNotice tone="warning" title="最新の履歴へ更新できませんでした">
                  直前に読み込んだ内容を表示しています。
                </StatusNotice>
              )}
              <div className="history-totals">
                <div className="confirmed-total">
                  <span>注文済みの合計</span>
                  <strong>{formatYen(historyTotals.confirmed)}</strong>
                </div>
                <div>
                  <span>担当者が確認中</span>
                  <strong>{formatYen(historyTotals.pending)}</strong>
                </div>
              </div>

              {history.length === 0 ? (
                <EmptyState
                  symbol="○"
                  title="まだ注文はありません"
                  description="メニューから商品を選んでみましょう。"
                  action={<button type="button" className="primary-button compact-button" onClick={() => switchView('menu')}>注文を始める</button>}
                />
              ) : (
                <ul className="history-list">
                  {history.map((order) => {
                    const status = getOrderStatus(order.status);
                    return (
                      <li key={order.id} className={order.status === 'cancelled' ? 'is-cancelled' : ''}>
                        <div className="history-line-top">
                          <time>{formatTime(order.created_at)}</time>
                          <span className={`status-pill status-${status.tone}`}>{status.label}</span>
                        </div>
                        <div className="history-line-main">
                          <div>
                            <strong>{order.item_name}</strong>
                            <span>{order.size}・{formatYen(order.price)} × {order.quantity}</span>
                            {Number(order.added_by_admin) === 1 && <small className="history-source-note">管理者が事前に追加しました</small>}
                          </div>
                          <strong>{formatYen(orderTotal(order))}</strong>
                        </div>
                        <OrderCancelAction
                          order={order}
                          currentUser={currentUser}
                          disabled={isSubmitting || isCancelling}
                          onCancelled={() => historyQuery.mutate()}
                          onBusyChange={(busy) => {
                            cancellationInFlight.current = busy;
                            setIsCancelling(busy);
                            onSubmittingChange(busy);
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}
      {view !== 'review' && cart.length > 0 && (
        <div className="cart-dock" role="region" aria-label="カート">
          <div><span>{cartSummary.units}点を選択中</span><strong>{formatYen(cartSummary.total)}</strong></div>
          <button type="button" onClick={() => switchView('review')}>カートを確認<span aria-hidden="true"> ›</span></button>
        </div>
      )}
    </section>
  );
}
