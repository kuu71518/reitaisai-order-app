import { useState } from 'react'

export default function UpdateNotice({ onUpdate, onDismiss }) {
  const [isUpdating, setIsUpdating] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const handleUpdate = async () => {
    setIsUpdating(true)
    setErrorMessage('')

    try {
      await onUpdate()
    } catch {
      setErrorMessage('更新できませんでした。時間をおいて、もう一度お試しください。')
      setIsUpdating(false)
    }
  }

  return (
    <div
      className="update-notice-layer"
      aria-live="polite"
      aria-atomic="true"
    >
      <section
        className="update-notice-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="update-notice-title"
        aria-describedby="update-notice-description"
        aria-busy={isUpdating}
      >
        <div className="update-notice-copy">
          <h2 id="update-notice-title" className="update-notice-title">
            新しい画面を利用できます
          </h2>
          <p id="update-notice-description" className="update-notice-description">
            注文内容を確認してから更新してください
          </p>
          {errorMessage && (
            <p className="update-notice-error" role="alert">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="update-notice-actions">
          <button
            type="button"
            className="update-notice-button update-notice-button-primary"
            onClick={handleUpdate}
            disabled={isUpdating}
          >
            {isUpdating ? '更新しています…' : '更新して再読み込み'}
          </button>
          <button
            type="button"
            className="update-notice-button update-notice-button-secondary"
            onClick={onDismiss}
            disabled={isUpdating}
          >
            あとで
          </button>
        </div>
      </section>
    </div>
  )
}
