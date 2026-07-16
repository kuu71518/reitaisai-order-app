import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { apiFetcher, apiRequest, getErrorMessage } from '../lib/api';
import { formatTime, formatYen, getOrderStatus, orderTotal } from '../lib/format';
import { visibleMenuItemsForRole } from '../lib/menuVisibility';
import { createRequestId } from '../lib/requestId';
import { millisecondsUntilNextMinute, shouldShowLateNightNotice } from '../lib/time';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';

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

export default function Menu({ currentUser }) {
  const [view, setView] = useState('menu');
  const [cart, setCart] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('すべて');
  const [selectedVariations, setSelectedVariations] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [cartToast, setCartToast] = useState(null);
  const [showLateNightNotice, setShowLateNightNotice] = useState(() => shouldShowLateNightNotice());
  const cartToastTimer = useRef(null);
  const cartToastSequence = useRef(0);

  const menuQuery = useSWR('/api/menu', apiFetcher, {
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
  const historyQuery = useSWR(
    view === 'history' ? '/api/orders/mine' : null,
    apiFetcher,
    { revalidateOnFocus: true, keepPreviousData: true },
  );

  const menuItems = useMemo(
    () => visibleMenuItemsForRole(menuQuery.data?.data || EMPTY_ITEMS, currentUser.role),
    [currentUser.role, menuQuery.data?.data],
  );
  const history = historyQuery.data?.data || EMPTY_ITEMS;

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

  const categories = useMemo(() => {
    const available = [...new Set(menuItems.map((item) => item.category).filter(Boolean))];
    return [
      'すべて',
      ...CATEGORY_PRIORITY.filter((category) => available.includes(category)),
      ...available.filter((category) => !CATEGORY_PRIORITY.includes(category)).sort(),
    ];
  }, [menuItems]);

  const groupedItems = useMemo(() => {
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

    const normalizedSearch = searchQuery.trim().toLocaleLowerCase('ja-JP');
    return [...groups.values()]
      .filter((group) => selectedCategory === 'すべて' || group.category === selectedCategory)
      .filter((group) => !normalizedSearch || group.name.toLocaleLowerCase('ja-JP').includes(normalizedSearch))
      .sort((left, right) => {
        if (left.name === 'キリン一番搾り（生）') return -1;
        if (right.name === 'キリン一番搾り（生）') return 1;
        return left.name.localeCompare(right.name, 'ja-JP');
      });
  }, [menuItems, searchQuery, selectedCategory]);

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
    if (isSubmitting) return;
    const selectedId = Number(selectedVariations[group.key] ?? group.variations[0]?.id);
    const selectedItem = group.variations.find((variation) => Number(variation.id) === selectedId);
    if (!selectedItem) {
      showFeedback('danger', '商品を追加できませんでした', 'サイズを選び直して、もう一度お試しください。');
      return;
    }
    const existing = cart.find((item) => item.menu_item_id === selectedItem.id);
    if (existing?.quantity >= 20) {
      showFeedback('warning', 'この商品の上限は20点です', '個数はカートの確認画面で変更できます。');
      return;
    }

    setCart((current) => {
      const currentItem = current.find((item) => item.menu_item_id === selectedItem.id);
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
    if (isSubmitting) return;
    setCart((current) => current.flatMap((item) => {
      if (item.menu_item_id !== id) return [item];
      const quantity = item.quantity + delta;
      if (quantity <= 0) return [];
      return [{ ...item, quantity: Math.min(quantity, 20) }];
    }));
  };

  const submitOrder = async () => {
    if (cart.length === 0 || isSubmitting) return;
    const submittedItems = [...cart];
    setIsSubmitting(true);
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
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') successfulIds.add(submittedItems[index].menu_item_id);
      else failed.push(result.reason);
    });

    setCart((current) => current.filter((item) => !successfulIds.has(item.menu_item_id)));
    setIsSubmitting(false);

    if (failed.length === 0) {
      showFeedback('success', '注文を送信しました', '担当者が内容を確認します。注文履歴で状態を確認できます。');
      setView('history');
      await historyQuery.mutate();
      return;
    }

    const successCount = successfulIds.size;
    showFeedback(
      successCount > 0 ? 'warning' : 'danger',
      successCount > 0 ? `${successCount}件は送信、${failed.length}件は未送信です` : '注文を送信できませんでした',
      `${getErrorMessage(failed[0], '通信状態を確認してください。')} 重複を防ぐため、注文履歴を確認してから残った商品を再送してください。`,
    );
    if (successCount > 0) await historyQuery.mutate();
  };

  const switchView = (nextView) => {
    if (isSubmitting) return;
    setFeedback(null);
    setCartToast(null);
    window.clearTimeout(cartToastTimer.current);
    setView(nextView);
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
    <section className={`screen menu-screen${view === 'menu' ? ' has-cart-dock' : ''}`}>
      <nav className="view-switch" aria-label="注文画面の切り替え">
        <button
          type="button"
          aria-pressed={view !== 'history'}
          className={view !== 'history' ? 'is-active' : ''}
          onClick={() => switchView(cart.length > 0 && view === 'review' ? 'review' : 'menu')}
          disabled={isSubmitting}
        >
          注文する
          {cartSummary.units > 0 && <span>{cartSummary.units}</span>}
        </button>
        <button
          type="button"
          aria-pressed={view === 'history'}
          className={view === 'history' ? 'is-active' : ''}
          onClick={() => switchView('history')}
          disabled={isSubmitting}
        >
          注文履歴
        </button>
      </nav>

      {view !== 'history' && renderOrderSteps()}

      {showLateNightNotice && (
        <StatusNotice tone="warning" title="22時以降は店で10%加算されます">
          アプリの表示価格と合計は通常時間の金額です。22時以降の注文は、会計時に店舗の深夜料金10%が加算されます。
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
            eyebrow="手順 1"
            title="料理・飲み物を選ぶ"
            description="商品を選び、「カートに入れる」を押してください。送信はまだされません。"
          />

          <div className="catalog-tools">
            <label className="search-field">
              <span>メニューを検索</span>
              <div>
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="例：ビール、唐揚げ"
                />
                {searchQuery && <button type="button" onClick={() => setSearchQuery('')}>消す</button>}
              </div>
            </label>

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
              return (
                <article key={group.key} className="menu-card">
                  <div className="menu-card-copy">
                    <span className="category-label">{group.category}</span>
                    <h2>{group.name}</h2>
                  </div>
                  <div className="menu-card-controls">
                    {group.variations.length > 1 ? (
                      <label>
                        <span>サイズ・価格</span>
                        <select
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
                    <button type="button" className="add-cart-button" onClick={() => addToCart(group)}>
                      <span aria-hidden="true">＋</span> カートに入れる
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

          <div className="cart-dock" role="region" aria-label="カート">
            <div>
              <span>{cartSummary.units > 0 ? `${cartSummary.units}点を選択中` : 'カートは空です'}</span>
              <strong>{cartSummary.units > 0 ? formatYen(cartSummary.total) : '商品を選んでください'}</strong>
            </div>
            <button type="button" onClick={() => switchView('review')} disabled={cartSummary.units === 0}>
              {cartSummary.units > 0 ? 'カートを見る' : 'まだ選ばれていません'}
            </button>
          </div>
        </>
      )}

      {view === 'review' && (
        <>
          <ScreenIntro
            eyebrow="手順 2"
            title="注文内容を確認"
            description="商品・サイズ・個数を確認してください。赤いボタンを押すまで送信されません。"
            action={<button type="button" className="secondary-button compact-button" onClick={() => switchView('menu')} disabled={isSubmitting}>メニューへ戻る</button>}
          />

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
                  </div>
                  <div className="quantity-control" aria-label={`${item.name}の個数`}>
                    <button type="button" onClick={() => changeQuantity(item.menu_item_id, -1)} aria-label={`${item.name}を1つ減らす`} disabled={isSubmitting}>−</button>
                    <output aria-live="polite">{item.quantity}</output>
                    <button type="button" onClick={() => changeQuantity(item.menu_item_id, 1)} aria-label={`${item.name}を1つ増やす`} disabled={isSubmitting}>＋</button>
                  </div>
                  <strong className="cart-line-total">{formatYen(Number(item.price || 0) * item.quantity)}</strong>
                  <button type="button" className="text-button danger-text" onClick={() => changeQuantity(item.menu_item_id, -item.quantity)} disabled={isSubmitting}>
                    削除
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
              <span>押すと担当者へ注文が送られます</span>
              <button type="button" className="primary-button" onClick={submitOrder} disabled={isSubmitting} aria-busy={isSubmitting}>
                {isSubmitting ? '注文を送信しています…' : `この${cartSummary.units}点を注文する`}
              </button>
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        <>
          <ScreenIntro
            eyebrow="注文後の確認"
            title="自分の注文履歴"
            description="「確認中」は担当者が店員へ伝える前、「注文済み」は伝達済みです。"
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
                  <span>注文済みの確定額</span>
                  <strong>{formatYen(historyTotals.confirmed)}</strong>
                </div>
                <div>
                  <span>担当者が確認中の予定額</span>
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
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
