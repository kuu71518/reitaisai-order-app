import { useEffect, useRef, useState } from 'react';
import { apiRequest, getErrorMessage } from '../../lib/api';
import { StatusNotice } from '../States';

export default function UserDeleteAction({ user, disabled = false, onBusyChange, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelButtonRef = useRef(null);
  const triggerButtonRef = useRef(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) cancelButtonRef.current?.focus();
    else if (wasConfirming.current) triggerButtonRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (user.role === 'admin') return null;

  const closeConfirmation = () => {
    if (busy) return;
    setConfirming(false);
    setError('');
  };

  const deleteUser = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    onBusyChange?.(true);
    let deleted = false;
    try {
      await apiRequest(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      deleted = true;
      onDeleted?.(user);
    } catch (requestError) {
      setError(getErrorMessage(requestError, '参加者を削除できませんでした。'));
    } finally {
      setBusy(false);
      if (!deleted) onBusyChange?.(false);
    }
  };

  if (!confirming) {
    return (
      <button
        ref={triggerButtonRef}
        type="button"
        className="admin-button admin-button-danger-subtle"
        onClick={() => setConfirming(true)}
        disabled={disabled}
      >
        参加者から削除
      </button>
    );
  }

  const headingId = `admin-delete-user-${user.id}`;
  return (
    <div className="admin-inline-confirm" role="group" aria-labelledby={headingId}>
      <div className="admin-inline-confirm-copy">
        <strong id={headingId}>{user.name}さんを参加者一覧から削除しますか？</strong>
        <span>削除するとログインできなくなり、現在ログイン中の端末もログアウトします。過去の注文・会計・操作履歴は残ります。</span>
      </div>
      {error && <StatusNotice tone="danger" title="削除できませんでした" live>{error}</StatusNotice>}
      <div className="admin-row-actions">
        <button ref={cancelButtonRef} type="button" className="admin-button admin-button-secondary" onClick={closeConfirmation} disabled={busy}>戻る</button>
        <button type="button" className="admin-button admin-button-danger" onClick={deleteUser} disabled={busy || disabled}>
          {busy ? '削除しています' : 'この参加者を削除'}
        </button>
      </div>
    </div>
  );
}
