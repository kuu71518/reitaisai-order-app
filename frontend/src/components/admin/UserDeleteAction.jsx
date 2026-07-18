import { useEffect, useRef, useState } from 'react';
import { apiRequest, getErrorMessage } from '../../lib/api';
import { StatusNotice } from '../States';

export default function UserDeleteAction({ user, disabled = false, onBusyChange, onDeactivated }) {
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

  if (user.role === 'admin') {
    return <span className="admin-readonly-label">管理者は利用停止できません</span>;
  }

  const closeConfirmation = () => {
    if (busy) return;
    setConfirming(false);
    setError('');
  };

  const deactivateUser = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    onBusyChange?.(true);
    let deactivated = false;
    try {
      await apiRequest(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      deactivated = true;
      onDeactivated?.(user);
    } catch (requestError) {
      setError(getErrorMessage(requestError, '参加者の利用を停止できませんでした。'));
    } finally {
      setBusy(false);
      if (!deactivated) onBusyChange?.(false);
    }
  };

  if (!confirming) {
    return (
      <button
        ref={triggerButtonRef}
        type="button"
        className="admin-button admin-button-danger-subtle admin-user-deactivate-button"
        onClick={() => setConfirming(true)}
        disabled={disabled}
      >
        この参加者の利用を停止
      </button>
    );
  }

  const headingId = `admin-deactivate-user-${user.id}`;
  return (
    <div className="admin-inline-confirm" role="group" aria-labelledby={headingId}>
      <div className="admin-inline-confirm-copy">
        <strong id={headingId}>{user.name}さんの利用を停止しますか？</strong>
        <span>利用停止するとログインできなくなり、現在ログイン中の端末もログアウトします。過去の注文・会計・操作履歴は残ります。</span>
      </div>
      {error && <StatusNotice tone="danger" title="利用停止できませんでした" live>{error}</StatusNotice>}
      <div className="admin-row-actions">
        <button ref={cancelButtonRef} type="button" className="admin-button admin-button-secondary" onClick={closeConfirmation} disabled={busy}>戻る</button>
        <button type="button" className="admin-button admin-button-danger" onClick={deactivateUser} disabled={busy || disabled}>
          {busy ? '利用を停止しています' : '利用を停止する'}
        </button>
      </div>
    </div>
  );
}
