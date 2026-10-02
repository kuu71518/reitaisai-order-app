export function canManageCashReceipts(user) {
  return user?.role === 'admin' || user?.role === 'chief';
}

export function cashReceiptBody(person, received) {
  if (!person || !Number.isSafeInteger(Number(person.user_id)) || Number(person.user_id) < 1
    || typeof received !== 'boolean'
    || !/^[A-Za-z0-9_-]{43}$/.test(person.cash_receipt_snapshot_token || '')) return null;
  return { received, snapshot_token: person.cash_receipt_snapshot_token };
}

export function cashReceiptState(person) {
  const received = person?.cash_received === true;
  return {
    received,
    changed: received && person?.cash_amount_changed === true,
    recordedTotal: received && person?.cash_recorded_total !== null
      && person?.cash_recorded_total !== undefined
      && Number.isFinite(Number(person.cash_recorded_total))
      ? Number(person.cash_recorded_total) : null,
  };
}

export function isCashReceiptConfirmed(body, response) {
  return typeof body?.received === 'boolean' && response?.data?.received === body.received;
}
