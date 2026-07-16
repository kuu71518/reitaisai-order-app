import assert from 'node:assert/strict';
import test from 'node:test';
import { millisecondsUntilNextMinute, shouldShowLateNightNotice } from './time.js';

test('late-night notice follows the 21:30 to 05:59 JST window', () => {
  assert.equal(shouldShowLateNightNotice(new Date('2026-07-15T12:29:00Z')), false);
  assert.equal(shouldShowLateNightNotice(new Date('2026-07-15T12:30:00Z')), true);
  assert.equal(shouldShowLateNightNotice(new Date('2026-07-15T14:59:00Z')), true);
  assert.equal(shouldShowLateNightNotice(new Date('2026-07-15T15:00:00Z')), true);
  assert.equal(shouldShowLateNightNotice(new Date('2026-07-15T20:59:00Z')), true);
  assert.equal(shouldShowLateNightNotice(new Date('2026-07-15T21:00:00Z')), false);
});

test('next-minute scheduling stays close to a minute boundary', () => {
  assert.equal(millisecondsUntilNextMinute(new Date('2026-07-15T12:29:30.000Z')), 30_050);
});
