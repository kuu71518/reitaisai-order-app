import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest, getErrorMessage } from '../../lib/api';
import { Field, LoadingState, StatusNotice } from '../States';

const RESET_CONFIRMATION = '開催データをリセット';

function safeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function normalizePreview(payload) {
  const data = payload?.data || {};
  return {
    userCount: safeCount(data.user_count),
    orderCount: safeCount(data.order_count),
    otherSessionCount: safeCount(data.other_session_count),
    preservedMenuCount: safeCount(data.preserved_menu_count),
    preservedAuditCount: safeCount(data.preserved_audit_count),
  };
}

function resetErrorMessage(error) {
  if (error instanceof ApiError && error.payload?.code === 'RECENT_LOGIN_REQUIRED') {
    return '安全確認のため、いったんログアウトしてDiscordへ再ログインし、この画面へ戻ってください。';
  }
  if (error instanceof ApiError && error.payload?.code === 'RESET_PREVIEW_STALE') {
    return '確認後に参加者または注文が更新されました。最新件数を読み直してから、もう一度確認してください。';
  }
  return getErrorMessage(error, '開催データをリセットできませんでした。');
}

export default function DataResetPanel({ onComplete }) {
  const [preview, setPreview] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const loadPreview = useCallback(async ({ resetChecks = true } = {}) => {
    setLoadState('loading');
    setLoadError('');
    try {
      const payload = await apiRequest('/api/admin/data-reset/preview');
      setPreview(normalizePreview(payload));
      setLoadState('ready');
      if (resetChecks) {
        setBackupConfirmed(false);
        setConfirmation('');
      }
      return true;
    } catch (error) {
      setLoadError(getErrorMessage(error, 'リセット対象の件数を読み込めませんでした。'));
      setLoadState('error');
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) return loadPreview();
      return false;
    });
    return () => {
      cancelled = true;
    };
  }, [loadPreview]);

  const canReset = Boolean(preview)
    && loadState === 'ready'
    && backupConfirmed
    && confirmation === RESET_CONFIRMATION
    && !busy;

  const resetData = async () => {
    if (!canReset) return;
    setBusy(true);
    setNotice(null);
    let payload;
    try {
      payload = await apiRequest('/api/admin/data-reset', {
        method: 'POST',
        body: {
          backup_confirmed: true,
          confirmation,
          expected_user_count: preview.userCount,
          expected_order_count: preview.orderCount,
          expected_other_session_count: preview.otherSessionCount,
        },
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        title: '開催データをリセットできませんでした',
        message: resetErrorMessage(error),
      });
      if (error instanceof ApiError && error.payload?.code === 'RESET_PREVIEW_STALE') {
        void loadPreview();
      }
      setBusy(false);
      return;
    }

    const data = payload?.data || {};
    const deletedUsers = safeCount(data.deleted_user_count);
    const deletedOrders = safeCount(data.deleted_order_count);
    const deletedSessions = safeCount(data.deleted_session_count);
    setBackupConfirmed(false);
    setConfirmation('');
    setPreview((current) => current ? {
      ...current,
      userCount: Math.max(0, current.userCount - deletedUsers),
      orderCount: Math.max(0, current.orderCount - deletedOrders),
      otherSessionCount: Math.max(0, current.otherSessionCount - deletedSessions),
    } : current);
    setNotice({
      tone: 'success',
      title: '開催データをリセットしました',
      message: `参加者${deletedUsers}人、注文${deletedOrders}件、ログイン状態${deletedSessions}件を削除しました。`,
    });
    try {
      onComplete?.({ payload });
    } catch {
      // The reset itself succeeded; a parent screen refresh must not turn it into a failure notice.
    }

    try {
      const refreshed = await apiRequest('/api/admin/data-reset/preview');
      setPreview(normalizePreview(refreshed));
      setLoadState('ready');
      setLoadError('');
    } catch {
      setNotice({
        tone: 'warning',
        title: 'リセットは完了しました',
        message: '最新件数の読み直しだけ完了できませんでした。通信状態を確認して、「最新件数を読み込む」を押してください。',
      });
    }
    setBusy(false);
  };

  return (
    <section className="admin-panel admin-safety-panel" aria-labelledby="admin-safety-heading">
      <div className="admin-panel-heading">
        <div>
          <p className="admin-eyebrow">危険な操作</p>
          <h2 id="admin-safety-heading">開催データをリセット</h2>
        </div>
        <button type="button" className="admin-button admin-button-secondary" onClick={() => loadPreview()} disabled={busy || loadState === 'loading'}>
          {loadState === 'loading' ? '読み込み中' : '最新件数を読み込む'}
        </button>
      </div>

      <StatusNotice tone="danger" title="この画面からは元に戻せません">
        実行前にD1の復元地点を記録し、下の削除件数を必ず確認してください。
      </StatusNotice>

      {loadState === 'loading' && !preview && <LoadingState label="リセット対象を確認しています" />}
      {loadState === 'error' && (
        <StatusNotice
          tone="danger"
          title="リセット対象を読み込めませんでした"
          live
          action={<button type="button" className="admin-button admin-button-secondary" onClick={() => loadPreview()}>もう一度読み込む</button>}
        >
          {loadError}
        </StatusNotice>
      )}

      {preview && (
        <div className="admin-reset-content" aria-busy={busy}>
          <div className="admin-reset-summary">
            <section className="admin-reset-counts is-delete" aria-labelledby="admin-reset-delete-heading">
              <h3 id="admin-reset-delete-heading">削除されるもの</h3>
              <dl>
                <div><dt>参加者</dt><dd>{preview.userCount}人</dd></div>
                <div><dt>注文・取消記録</dt><dd>{preview.orderCount}件</dd></div>
                <div><dt>他端末のログイン状態</dt><dd>{preview.otherSessionCount}件</dd></div>
              </dl>
            </section>
            <section className="admin-reset-counts is-keep" aria-labelledby="admin-reset-keep-heading">
              <h3 id="admin-reset-keep-heading">そのまま残るもの</h3>
              <dl>
                <div><dt>現在の管理者</dt><dd>1人</dd></div>
                <div><dt>メニュー</dt><dd>{preview.preservedMenuCount}件</dd></div>
                <div className="admin-reset-count-detail">
                  <dt>
                    <span>操作履歴</span>
                    <small>削除した参加者との紐づけは解除され、実行者は「システム」表示になります</small>
                  </dt>
                  <dd>{preview.preservedAuditCount}件</dd>
                </div>
              </dl>
            </section>
          </div>

          <div className="admin-reset-checks">
            <label className="admin-confirm-checkbox">
              <input
                type="checkbox"
                checked={backupConfirmed}
                onChange={(event) => setBackupConfirmed(event.target.checked)}
                disabled={busy}
              />
              <span>D1の復元地点を記録済みであることを確認しました</span>
            </label>
            <Field label="確認の言葉" hint={`「${RESET_CONFIRMATION}」とそのまま入力します`} required>
              <input
                className="admin-input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                disabled={busy}
              />
            </Field>
          </div>

          {notice && <StatusNotice tone={notice.tone} title={notice.title} live>{notice.message}</StatusNotice>}

          <div className="admin-form-actions">
            <button type="button" className="admin-button admin-button-danger" onClick={resetData} disabled={!canReset}>
              {busy ? 'リセットしています' : '開催データをリセット'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
