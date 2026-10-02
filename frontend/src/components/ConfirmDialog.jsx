import { useEffect, useId, useRef } from 'react';

export default function ConfirmDialog({ open, title, children, confirmLabel, busy = false, confirmDisabled = false, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open) return;
    const returnFocus = document.activeElement;
    dialog.showModal();
    cancelRef.current?.focus({ preventScroll: true });
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
        <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={busy}>戻る</button>
        <button type="button" className="primary-button" onClick={onConfirm} disabled={busy || confirmDisabled} aria-busy={busy}>
          {busy ? '処理しています…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
