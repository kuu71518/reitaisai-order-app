const REJECTED_BEFORE_SAVING = new Set([400, 401, 403, 404, 422]);

export function wasOrderHistoryCleared(error) {
  return error?.status === 410 && error?.payload?.code === 'ORDER_HISTORY_CLEARED';
}

export function changeCartQuantity(cart, menuItemId, delta) {
  return cart.flatMap((item) => {
    if (item.menu_item_id !== menuItemId || item.needsConfirmation) return [item];
    const quantity = item.quantity + delta;
    return quantity <= 0 ? [] : [{ ...item, quantity: Math.min(quantity, 20) }];
  });
}

export function applyOrderSubmissionResults(cart, submittedItems, results) {
  const outcomes = new Map(submittedItems.map((item, index) => [item.request_id, results[index]]));
  return cart.flatMap((item) => {
    const outcome = outcomes.get(item.request_id);
    if (!outcome) return [item];
    if (outcome.status === 'fulfilled') return [];
    // A server receipt proves this request was cleared. Never replay it or
    // silently generate a new request for the same cart item.
    if (wasOrderHistoryCleared(outcome.reason)) return [];
    return [{
      ...item,
      // A later rejection cannot disprove that an earlier attempt was saved.
      needsConfirmation: Boolean(item.needsConfirmation)
        || !REJECTED_BEFORE_SAVING.has(outcome.reason?.status),
    }];
  });
}
