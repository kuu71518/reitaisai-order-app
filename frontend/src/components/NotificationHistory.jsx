import { useEffect, useId, useRef, useState } from 'react';
import { StatusNotice } from './States';

const timestamp = (value) => new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(value);

export default function NotificationHistory({ open, notifications, onClose, onOpenOrders, busy = false }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const returnFocus = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [open]);

  const read = async (ids, navigate = false) => {
    if (saving || busy) return;
    setSaving(true);
    try {
      const success = await notifications.markRead(ids);
      if (success && navigate) { onClose(); onOpenOrders(); }
    } finally { setSaving(false); }
  };
  return <dialog ref={dialogRef} className="notification-history" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="notification-history-heading">
      <h2 id={titleId}>通知の受信履歴</h2>
      <button ref={closeRef} type="button" className="secondary-button compact-button" onClick={onClose} disabled={saving}>閉じる</button>
    </div>
    <div className="notification-history-controls">
      <strong role="status" aria-live="polite">未読 {notifications.unreadCount}件</strong>
      <button type="button" className="small-button" disabled={!notifications.unreadCount || saving || busy}
        onClick={() => void read(notifications.entries.map((entry) => entry.id))}>{saving ? '保存中…' : 'すべて既読にする'}</button>
    </div>
    <p className="notification-history-note">この端末の受信履歴を新しい順に表示します（最新200件）。</p>
    {notifications.error && <StatusNotice tone="warning" title={notifications.error} />}
    {!notifications.entries.length ? <p className="notification-history-empty">通知の受信履歴はまだありません。</p>
      : <ul className="notification-history-list">
        {notifications.entries.map((entry) => <li key={entry.id} className={entry.readAt ? 'is-read' : 'is-unread'}>
          <div className="notification-history-meta">
            <span className="notification-read-label">{entry.readAt ? '既読' : '未読'}</span>
            <time dateTime={new Date(entry.receivedAt).toISOString()}>{timestamp(entry.receivedAt)}</time>
          </div>
          <div className="notification-history-row">
            <strong>{entry.count ? `${entry.count}件の新しい注文` : '新しい注文があります'}</strong>
            <button type="button" className="small-button" disabled={saving || busy}
              onClick={() => void read([entry.id], true)}>注文を確認</button>
          </div>
        </li>)}
      </ul>}
  </dialog>;
}
