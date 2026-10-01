// Group names confirmed by the organizer on 2026-10-01. No participant data here.
export const EVENT_GROUPS = ['クラシック席', 'ニュークラシック席'];

export function assignableGroups(users = []) {
  // Keep existing assignments selectable while making the confirmed seats
  // available before the first participant has been registered in either seat.
  return [...new Set([
    ...EVENT_GROUPS,
    ...users.filter((user) => user.role !== 'admin').map((user) => user.group_id).filter(Boolean),
  ])];
}
