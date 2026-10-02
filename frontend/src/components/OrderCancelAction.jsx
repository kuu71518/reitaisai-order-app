import { useId, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { apiRequest, getErrorMessage } from '../lib/api';
import { canCancelOrder, cancellationBody } from '../lib/orderCancellation';
import ConfirmDialog from './ConfirmDialog';
import '../styles/order-cancel.css';

export default function OrderCancelAction({ order, currentUser, onCancelled, onRefresh, disabled = false, onBusyChange }) {
  const { mutate } = useSWRConfig();
  const reasonId = useId();
  const [snapshot, setSnapshot] = useState(null);
  const [reason, setReason] = useState('');
  const [restaurantConfirmed, setRestaurantConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const retryBody = useRef(null);

  const refreshOrders = () => mutate((key) => {
    const path = Array.isArray(key) ? key[0] : key;
    return typeof path === 'string' && (path.startsWith('/api/orders/') || path.startsWith('/api/manager/orders'));
  });

  const open = () => {
    setSnapshot({ ...order });
    setReason('');
    setRestaurantConfirmed(false);
    setError('');
    setStale(false);
    setUncertain(false);
    retryBody.current = null;
  };

  const cancel = async () => {
    const body = retryBody.current || cancellationBody(snapshot, reason, restaurantConfirmed);
    if (inFlight.current || !body || stale) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const result = await apiRequest(`/api/orders/${snapshot.id}/cancel`, { method: 'POST', body });
      if (result?.data?.cancelled !== true) throw new Error('Unconfirmed cancellation');
      setSnapshot(null);
      await Promise.allSettled([refreshOrders(), Promise.resolve(onCancelled?.())]);
    } catch (failure) {
      if (failure.status === 409) {
        setStale(true);
        setError('注文内容や伝達状態が変わりました。いったん閉じて一覧を更新し、内容を確認し直してください。');
        await Promise.allSettled([refreshOrders(), Promise.resolve(onRefresh?.())]);
      } else if (!failure.status || failure.status >= 500) {
        retryBody.current = body;
        setUncertain(true);
        setError('取消の結果を確認できませんでした。同じ内容で再確認できます。画面を閉じる場合は、再注文する前に注文履歴を確認してください。');
      } else {
        setError(getErrorMessage(failure));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  if (!snapshot && !canCancelOrder(currentUser, order)) return null;
  const locked = busy || uncertain;
  return (
    <div className="order-cancel-action">
      <button type="button" className="text-button cancel-order-button" onClick={open}
        disabled={disabled || busy || !order.cancel_snapshot_token}>注文を取り消す</button>
      <ConfirmDialog open={Boolean(snapshot)} title="注文を取り消す" busy={busy}
        confirmLabel={uncertain ? '同じ内容で再確認' : 'この注文を取り消す'}
        confirmDisabled={stale || (!uncertain && !cancellationBody(snapshot, reason, restaurantConfirmed))}
        onConfirm={cancel} onCancel={() => setSnapshot(null)}>
        {snapshot && <>
          <p>{snapshot.user_name || currentUser.name}・{snapshot.group_id || currentUser.group_id}</p>
          <p><strong>{snapshot.item_name || snapshot.menu_name}</strong><br />{snapshot.size} × {snapshot.quantity}個</p>
          <p>取消後は注文合計から除外され、履歴には取消済みとして残ります。</p>
          {snapshot.status === 'ordered' ? <label className="cancel-restaurant-check">
            <input type="checkbox" checked={restaurantConfirmed} disabled={locked}
              onChange={(event) => setRestaurantConfirmed(event.target.checked)} />
            <span>店員へ連絡し、この注文を取り消せることを確認しました</span>
          </label> : <p className="cancel-status-note">この注文は、アプリ上ではまだ店員へ伝達されていません。</p>}
          <label className="cancel-reason" htmlFor={reasonId}>取消理由（必須・200文字以内）
            <textarea id={reasonId} rows={3} maxLength={200} value={reason} disabled={locked}
              onChange={(event) => setReason(event.target.value)} placeholder="例：重複して注文したため" />
          </label>
          {error && <p className="inline-error" role="alert">{error}</p>}
        </>}
      </ConfirmDialog>
    </div>
  );
}
