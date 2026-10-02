export const VIBRATION_PATTERN = [180, 100, 180];
let audioContext;

// Called directly from a tap/keypress: browsers require user interaction before
// they permit Web Audio. No audio assets or third-party requests are necessary.
export async function prepareNotificationSound(host = globalThis) {
  const AudioContext = host.AudioContext || host.webkitAudioContext;
  if (!AudioContext) return false;
  try {
    audioContext ||= new AudioContext();
    if (audioContext.state !== 'running') await audioContext.resume();
    return audioContext.state === 'running';
  } catch { return false; }
}

export function playNotificationAlert(preferences, { navigator = globalThis.navigator, visible = true } = {}) {
  const result = { sound: false, vibration: false };
  if (!visible) return result; // Background alerts belong to the OS notification.
  if (preferences.sound && audioContext?.state === 'running') {
    try {
      const oscillator = audioContext.createOscillator();
      const volume = audioContext.createGain();
      const now = audioContext.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.setValueAtTime(1174, now + 0.12);
      volume.gain.setValueAtTime(0, now);
      volume.gain.linearRampToValueAtTime(0.12, now + 0.015);
      volume.gain.setValueAtTime(0.12, now + 0.21);
      volume.gain.linearRampToValueAtTime(0, now + 0.28);
      oscillator.connect(volume); volume.connect(audioContext.destination);
      oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
      oscillator.start(now); oscillator.stop(now + 0.3);
      result.sound = true;
    } catch { /* An audio failure must not interrupt order handling. */ }
  }
  if (preferences.vibration && typeof navigator?.vibrate === 'function') {
    try { result.vibration = navigator.vibrate(VIBRATION_PATTERN) !== false; } catch { /* Optional browser feature. */ }
  }
  return result;
}

export function pushAlertOptions(preferences = { sound: true, vibration: true }) {
  if (!preferences.sound && !preferences.vibration) return { silent: true };
  // The Notifications API cannot control OS sound and vibration independently.
  return { silent: false, ...(preferences.vibration ? { vibrate: VIBRATION_PATTERN } : {}) };
}
