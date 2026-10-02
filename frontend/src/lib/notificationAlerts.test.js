import assert from 'node:assert/strict';
import test from 'node:test';
import { playNotificationAlert, prepareNotificationSound, pushAlertOptions, VIBRATION_PATTERN } from './notificationAlerts.js';

test('disabled or hidden foreground alerts do not play sound or vibrate', () => {
  let calls = 0;
  const navigator = { vibrate: () => { calls++; return true; } };
  assert.deepEqual(playNotificationAlert({ sound: false, vibration: false }, { navigator }), { sound: false, vibration: false });
  assert.deepEqual(playNotificationAlert({ sound: true, vibration: true }, { navigator, visible: false }), { sound: false, vibration: false });
  assert.equal(calls, 0);
});

test('unsupported, denied and throwing vibration APIs never interrupt a notification', () => {
  const preferences = { sound: false, vibration: true };
  assert.equal(playNotificationAlert(preferences, { navigator: {} }).vibration, false);
  assert.equal(playNotificationAlert(preferences, { navigator: { vibrate: () => false } }).vibration, false);
  assert.equal(playNotificationAlert(preferences, { navigator: { vibrate: () => { throw new Error('denied'); } } }).vibration, false);
  const patterns = [];
  assert.equal(playNotificationAlert(preferences, { navigator: { vibrate: (pattern) => { patterns.push(pattern); return true; } } }).vibration, true);
  assert.deepEqual(patterns, [VIBRATION_PATTERN]);
});

test('background notifications request sound and vibration without the invalid silent-plus-vibrate combination', () => {
  assert.deepEqual(pushAlertOptions(), { silent: false, vibrate: VIBRATION_PATTERN });
  assert.deepEqual(pushAlertOptions({ sound: false, vibration: false }), { silent: true });
  assert.deepEqual(pushAlertOptions({ sound: true, vibration: false }), { silent: false });
});

test('Web Audio prepares from user interaction, resumes after suspension, and respects sound opt-out', async () => {
  const events = [];
  const param = { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} };
  class AudioContext {
    state = 'suspended'; currentTime = 1; destination = {};
    resume() { events.push('resume'); this.state = 'running'; return Promise.resolve(); }
    createOscillator() { return { frequency: param, connect: () => {}, disconnect: () => {}, start: () => events.push('start'), stop: () => events.push('stop') }; }
    createGain() { return { gain: param, connect: () => {}, disconnect: () => {} }; }
  }
  assert.equal(await prepareNotificationSound({}), false);
  assert.equal(await prepareNotificationSound({ AudioContext }), true);
  assert.equal(playNotificationAlert({ sound: true, vibration: false }).sound, true);
  assert.deepEqual(events, ['resume', 'start', 'stop']);
  assert.equal(playNotificationAlert({ sound: false, vibration: false }).sound, false);
  assert.equal(events.length, 3);
});
