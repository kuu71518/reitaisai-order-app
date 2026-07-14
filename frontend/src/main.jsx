import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'
import UpdateNotice from './components/UpdateNotice.jsx'

let isUpdateNoticeVisible = false
const updateNoticeListeners = new Set()

function setUpdateNoticeVisible(isVisible) {
  if (isUpdateNoticeVisible === isVisible) return

  isUpdateNoticeVisible = isVisible
  updateNoticeListeners.forEach((listener) => listener())
}

function subscribeToUpdateNotice(listener) {
  updateNoticeListeners.add(listener)
  return () => updateNoticeListeners.delete(listener)
}

function getUpdateNoticeSnapshot() {
  return isUpdateNoticeVisible
}

const updateSW = registerSW({
  onNeedRefresh() {
    setUpdateNoticeVisible(true)
  },
  onRegisterError(error) {
    console.error('Service Worker registration failed:', error)
  },
})

export function Root() {
  const showUpdateNotice = useSyncExternalStore(
    subscribeToUpdateNotice,
    getUpdateNoticeSnapshot,
    getUpdateNoticeSnapshot,
  )

  return (
    <>
      <App />
      {showUpdateNotice && (
        <UpdateNotice
          onUpdate={() => updateSW(true)}
          onDismiss={() => setUpdateNoticeVisible(false)}
        />
      )}
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
