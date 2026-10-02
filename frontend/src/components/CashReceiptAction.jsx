import { useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { apiRequest, getErrorMessage } from '../lib/api';
import { formatYen } from '../lib/format';
import { canManageCashReceipts, cashReceiptBody, cashReceiptState, isCashReceiptConfirmed } from '../lib/cashReceipt';
import ConfirmDialog from './ConfirmDialog';
import '../styles/cash-receipt.css';

export default function CashReceiptAction({ person, currentUser, onChanged, disabled = false, onBusyChange }) {
  const { mutate } = useSWRConfig();
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const retryBody = useRef(null);
  const canManage = canManageCashReceipts(currentUser);
  const receipt = cashReceiptState(person);

  const refresh = () => Promise.allSettled([
    mutate((key) => (Array.isArray(key) ? key[0] : key) === '/api/orders/summary'),
    Promise.resolve().then(() => onChanged?.()),
  ]);

  const open = (received) => {
    if (disabled || inFlight.current || !canManage || !cashReceiptBody(person, received)) return;
    setSnapshot({ person: { ...person }, received });
    setError('');
    setStale(false);
    setUncertain(false);
    retryBody.current = null;
  };

  const save = async () => {
    const body = retryBody.current || cashReceiptBody(snapshot?.person, snapshot?.received);
    if (inFlight.current || disabled || !canManage || !body || stale) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const response = await apiRequest(`/api/accounting/users/${snapshot.person.user_id}/cash-receipt`, {
        method: 'POST', body,
      });
      if (!isCashReceiptConfirmed(body, response)) throw new Error('Unconfirmed cash receipt update');
      setSnapshot(null);
      await refresh();
    } catch (failure) {
      if (failure.status === 409) {
        setStale(true);
        setError('注文金額または受取状況が変わりました。いったん閉じ、更新された一覧を確認してから操作し直してください。');
        await refresh();
      } else if (!failure.status || failure.status >= 500) {
        retryBody.current = body;
        setUncertain(true);
        setError('記録の結果を確認できませんでした。同じ内容で再確認できます。画面を閉じる場合は、一覧の受取状況を更新して確認してください。');
      } else {
        setError(getErrorMessage(failure));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const observedReceipt = cashReceiptState(snapshot?.person);
  return (
    <div className="cash-receipt-action">
      <div className="cash-receipt-state" aria-live="polite">
        <span className={`cash-receipt-badge ${receipt.received ? 'is-received' : 'is-unreceived'}`}>
          {receipt.received ? '現金受取済み' : '現金未受取'}
        </span>
        {receipt.changed && <strong className="cash-receipt-changed">金額変更あり・要確認</strong>}
        {receipt.received && receipt.recordedTotal !== null && (
          <small>受取確認時の注文合計 {formatYen(receipt.recordedTotal)}</small>
        )}
      </div>
      {canManage && (
        <div className="cash-receipt-buttons">
          {(!receipt.received || receipt.changed) && (
            <button type="button" className="small-button" disabled={disabled || busy || !cashReceiptBody(person, true)}
              onClick={() => open(true)}>{receipt.received ? '現在の金額で再確認' : '受取済みにする'}</button>
          )}
          {receipt.received && (
            <button type="button" className="text-button" disabled={disabled || busy || !cashReceiptBody(person, false)}
              onClick={() => open(false)}>受取記録を解除</button>
          )}
        </div>
      )}
      <ConfirmDialog open={Boolean(snapshot)} busy={busy}
        title={snapshot?.received ? '現金受取を記録する' : '現金受取の記録を解除する'}
        confirmLabel={uncertain ? '同じ内容で再確認' : snapshot?.received ? '受取確認済みとして記録' : '受取記録を解除'}
        confirmDisabled={disabled || !canManage || stale || (!uncertain && !cashReceiptBody(snapshot?.person, snapshot?.received))}
        onConfirm={save} onCancel={() => setSnapshot(null)}>
        {snapshot && <>
          <p><strong>{snapshot.person.name}</strong><br />{snapshot.person.group_id}</p>
          <p className="cash-receipt-current-total">現在の注文合計 <strong>{formatYen(snapshot.person.total_price)}</strong></p>
          {observedReceipt.received && observedReceipt.recordedTotal !== null && (
            <p>前回の受取確認時の注文合計：{formatYen(observedReceipt.recordedTotal)}</p>
          )}
          {snapshot.received ? (
            <p>現金の受取を確認し、この注文合計の時点で確認済みとして記録します。</p>
          ) : <p>この参加者を「現金未受取」に戻します。現金の受け渡し状況を確認してから解除してください。</p>}
          <p className="cash-receipt-charge-note">注文合計とは別に、1人につきテーブルチャージ495円（税込）がかかります。最終金額は店舗の伝票で確認してください。</p>
          {error && <p className="inline-error" role="alert">{error}</p>}
        </>}
      </ConfirmDialog>
    </div>
  );
}
