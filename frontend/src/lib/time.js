const JST_OFFSET_MINUTES = 9 * 60;
const NOTICE_START_MINUTES = 21 * 60 + 30;
const NOTICE_END_MINUTES = 6 * 60;

export function getJstMinuteOfDay(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMinutes + JST_OFFSET_MINUTES) % (24 * 60);
}

export function shouldShowLateNightNotice(date = new Date()) {
  const minutes = getJstMinuteOfDay(date);
  return minutes !== null && (minutes >= NOTICE_START_MINUTES || minutes < NOTICE_END_MINUTES);
}

export function millisecondsUntilNextMinute(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 60_000;
  return 60_000 - (date.getTime() % 60_000) + 50;
}
