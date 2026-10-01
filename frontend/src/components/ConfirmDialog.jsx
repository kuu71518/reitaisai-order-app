import { useEffect, useId, useRef } from 'react';

export default function ConfirmDialog({ open, title, children, confirmLabel, busy = false, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open) return;
    const returnFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id={titleId}>{title}</h2>
      <div className="confirm-dialog-copy">{children}</div>
      <div className="confirm-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy} autoFocus>戻る</button>
        <button type="button" className="primary-button" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? '処理しています…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
