export function canCancelOrder(user, order) {
  if (!user || !order || !['member', 'manager', 'chief', 'admin'].includes(user.role)) return false;
  if (!['pending', 'ordered'].includes(order.status)) return false;
  if (user.role === 'admin') return true;
  if (order.status !== 'pending') return false;
  return Number(user.id) > 0 && (user.role === 'chief' || Number(user.id) === Number(order.user_id));
}

export function cancellationBody(order, reason, restaurantConfirmed) {
  const cleanReason = String(reason || '').trim();
  if (!order || !['pending', 'ordered'].includes(order.status)
    || !/^[A-Za-z0-9_-]{43}$/.test(order.cancel_snapshot_token || '')
    || cleanReason.length < 1 || cleanReason.length > 200
    || (order.status === 'ordered' && restaurantConfirmed !== true)) return null;
  return {
    snapshot_token: order.cancel_snapshot_token,
    reason: cleanReason,
    restaurant_confirmed: order.status === 'ordered' && restaurantConfirmed === true,
  };
}
