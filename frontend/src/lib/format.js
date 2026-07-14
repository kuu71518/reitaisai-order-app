export function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatYen(value) {
  return `¥${Math.round(toNumber(value)).toLocaleString('ja-JP')}`;
}

export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const date = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const source = String(value).trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(source);
  const normalized = source.includes('T') ? source : source.replace(' ', 'T');
  const date = new Date(hasTimezone ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(value) {
  const date = toDate(value);
  return date ? date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '時刻不明';
}

export function formatDateTime(value) {
  const date = toDate(value);
  return date
    ? date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '日時不明';
}

export function getOrderStatus(status) {
  if (status === 'ordered') return { label: '注文済み', tone: 'success' };
  if (status === 'cancelled') return { label: '取消済み', tone: 'muted' };
  return { label: '担当者が確認中', tone: 'warning' };
}

export function orderTotal(order) {
  return toNumber(order?.price ?? order?.unit_price) * toNumber(order?.quantity);
}
