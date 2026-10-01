const REJECTED_BEFORE_SAVING = new Set([400, 401, 403, 404, 422]);

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
    return [{
      ...item,
      // A later rejection cannot disprove that an earlier attempt was saved.
      needsConfirmation: Boolean(item.needsConfirmation)
        || !REJECTED_BEFORE_SAVING.has(outcome.reason?.status),
    }];
  });
}
