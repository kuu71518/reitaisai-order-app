export function ScreenIntro({ eyebrow, title, description, action }) {
  return (
    <header className="screen-intro">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="screen-description">{description}</p>}
      </div>
      {action && <div className="screen-action">{action}</div>}
    </header>
  );
}

export function StatusNotice({ tone = 'info', title, children, action, live = false }) {
  return (
    <div
      className={`status-notice status-${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={live && tone !== 'danger' ? 'polite' : undefined}
    >
      <div className="status-copy">
        {title && <strong>{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {action && <div className="status-action">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = '読み込んでいます' }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <strong>{label}</strong>
      <span>少しだけお待ちください。</span>
    </div>
  );
}

export function EmptyState({ symbol = '○', title, description, action }) {
  return (
    <div className="state-panel state-empty">
      <span className="state-symbol" aria-hidden="true">{symbol}</span>
      <strong>{title}</strong>
      {description && <span>{description}</span>}
      {action}
    </div>
  );
}

export function Field({ label, hint, required = false, children }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <span className="required-label">必須</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
