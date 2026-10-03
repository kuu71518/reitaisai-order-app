import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, getDiscordLoginUrl, getErrorMessage } from '../../lib/api';
import { Field, LoadingState, StatusNotice } from '../States';
import { clearNotificationHistory } from '../../lib/notificationHistory';

const CONFIRMATION = '注文履歴だけを削除';

function checkedPreview(payload) {
  const data = payload?.data;
  const fields = ['order_count', 'pending_count', 'ordered_count', 'cancelled_count', 'preserved_user_count', 'preserved_menu_count'];
  if (!data || fields.some((field) => !Number.isSafeInteger(data[field]) || data[field] < 0)
    || !/^[A-Za-z0-9_-]{43}$/.test(data.snapshot_token || '')
    || data.order_count !== data.pending_count + data.ordered_count + data.cancelled_count) {
    throw new Error('Invalid order history preview');
  }
  return data;
}

export default function OrderHistoryClearPanel({ onComplete }) {
  const [preview, setPreview] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [confirmation, setConfirmation] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const inFlight = useRef(false);
  const loadId = useRef(0);

  const loadPreview = useCallback(async () => {
    const requestId = ++loadId.current;
    setLoadState('loading');
    setConfirmation('');
    setBackupConfirmed(false);
    try {
      const nextPreview = checkedPreview(await apiRequest('/api/admin/order-history/preview'));
      if (requestId !== loadId.current) return false;
      setPreview(nextPreview);
      setLoadState('ready');
      return true;
    } catch {
      if (requestId !== loadId.current) return false;
      setLoadState('error');
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) return loadPreview(); });
    return () => { cancelled = true; loadId.current += 1; };
  }, [loadPreview]);

  const canClear = Boolean(preview) && loadState === 'ready'
    && backupConfirmed && confirmation === CONFIRMATION && !busy;

  const clearHistory = async () => {
    if (!canClear || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    setNeedsLogin(false);
    try {
      const payload = await apiRequest('/api/admin/order-history/clear', {
        method: 'POST',
        body: { confirmation, backup_confirmed: true, snapshot_token: preview.snapshot_token },
      });
      const deletedCount = payload?.data?.deleted_order_count;
      const revision = payload?.data?.notification_history_revision;
      setConfirmation('');
      setBackupConfirmed(false);
      setPreview(null);
      setNotice({ tone: 'success', title: deletedCount ? `注文履歴${deletedCount}件と通知履歴を削除しました` : '通知履歴を削除しました',
        message: '通知履歴と未読数もリセットしました。各端末が次に接続したときに反映されます。参加者・グループ・メニュー・ログイン状態は保持されています。' });
      const refreshResults = await Promise.allSettled([clearNotificationHistory(revision), Promise.resolve().then(() => onComplete?.()), loadPreview()]);
      if (refreshResults.some((result) => result.status === 'rejected' || result.value === false)) {
        setNotice({ tone: 'warning', title: '注文履歴の削除は完了しました',
          message: 'この端末の通知履歴または表示の更新だけ完了できませんでした。再度削除せず、アプリを開き直して最新件数を確認してください。' });
      }
    } catch (error) {
      const recentLogin = error instanceof ApiError && error.payload?.code === 'RECENT_LOGIN_REQUIRED';
      setNeedsLogin(recentLogin);
      const uncertain = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      setNotice({ tone: 'danger', title: uncertain ? '削除結果を確認できませんでした' : '注文履歴を削除できませんでした',
        message: recentLogin ? '削除の前に、Discordで管理者本人の確認が必要です。再ログイン後、この画面で内容を確認し直してください。'
          : uncertain ? '通信が途切れた場合も削除が完了している可能性があります。最新件数と操作履歴を確認してください。'
            : getErrorMessage(error) });
      await loadPreview();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel admin-safety-panel" aria-labelledby="order-history-clear-heading" aria-busy={busy}>
      <div className="admin-panel-heading">
        <div>
          <p className="admin-eyebrow">注文履歴の整理</p>
          <h2 id="order-history-clear-heading">注文履歴だけを削除</h2>
        </div>
        <button type="button" className="admin-button admin-button-secondary" onClick={() => void loadPreview()} disabled={busy || loadState === 'loading'}>
          {loadState === 'loading' ? '読み込み中' : '注文の最新件数を読み込む'}
        </button>
      </div>
      <StatusNotice tone="danger" title="全員分の注文と注文合計が消えます">
        確認中・伝達済み・取消済みを含む注文履歴と、全端末の通知受信履歴・未読数をまとめて削除します。店員への注文取消にはなりません。
        注文の受付を止め、D1の復元地点を記録してから実行してください。この画面から元に戻すことはできません。
        通知履歴は各端末が次に接続したときに削除され、D1を復元しても戻りません。
      </StatusNotice>
      {loadState === 'loading' && !preview && <LoadingState label="削除する注文履歴を確認しています" />}
      {loadState === 'error' && <StatusNotice tone="danger" title="注文履歴の件数を確認できませんでした" live>
        通信状態を確認して、「注文の最新件数を読み込む」を押してください。確認できるまで削除できません。
      </StatusNotice>}
      {preview && <div className="admin-reset-content">
        <div className="admin-reset-summary">
          <section className="admin-reset-counts is-delete" aria-label="削除する注文履歴">
            <h3>削除する注文：{preview.order_count}件</h3>
            <dl>
              <div><dt>確認中</dt><dd>{preview.pending_count}件</dd></div>
              <div><dt>伝達済み</dt><dd>{preview.ordered_count}件</dd></div>
              <div><dt>取消済み</dt><dd>{preview.cancelled_count}件</dd></div>
              <div><dt>通知履歴・未読数</dt><dd>全端末</dd></div>
            </dl>
          </section>
          <section className="admin-reset-counts is-keep" aria-label="保持するデータ">
            <h3>そのまま残るもの</h3>
            <dl>
              <div><dt>管理者・主任・担当者・参加者</dt><dd>{preview.preserved_user_count}人</dd></div>
              <div><dt>メニュー</dt><dd>{preview.preserved_menu_count}件</dd></div>
            </dl>
            <p>グループ・権限・ログイン状態・操作履歴・現金受取記録・通知登録・音と振動の設定も残ります。受取確認時と注文合計が変わった場合は、会計に「金額変更あり」と表示します。</p>
          </section>
        </div>
        {preview.order_count === 0 && <StatusNotice tone="info" title="注文は0件です。通知履歴だけを削除できます" />}
        <>
          <div className="admin-reset-checks">
            <label className="admin-confirm-checkbox">
              <input type="checkbox" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} disabled={busy || loadState !== 'ready'} />
              <span>注文の受付を止め、D1の復元地点を記録しました</span>
            </label>
            <Field label="注文履歴削除の確認文" hint={`「${CONFIRMATION}」と入力してください`} required>
              <input className="admin-input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" disabled={busy || loadState !== 'ready'} />
            </Field>
          </div>
          <div className="admin-form-actions">
            <button type="button" className="admin-button admin-button-danger" onClick={() => void clearHistory()} disabled={!canClear}>
              {busy ? '注文・通知履歴を削除しています' : `注文履歴${preview.order_count}件と通知履歴を削除する`}
            </button>
          </div>
        </>
      </div>}
      {notice && <StatusNotice tone={notice.tone} title={notice.title} live>{notice.message}</StatusNotice>}
      {needsLogin && <a className="admin-button admin-button-secondary" href={getDiscordLoginUrl()}>Discordで管理者本人を確認する</a>}
    </section>
  );
}
