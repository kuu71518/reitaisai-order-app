export function canManageOrders(user) {
  return user?.role === 'chief' || user?.role === 'admin';
}

export function canReceiveOrderNotifications(user) {
  return user?.role === 'manager' || canManageOrders(user);
}

export function canViewAccounting(user) {
  return user?.role === 'manager' || canManageOrders(user);
}

export function canManageAllGroups(user) {
  return user?.role === 'chief' || user?.role === 'admin';
}

export function canViewAllAccounting(user, responseScope) {
  // A changed server role must narrow an already-open chief/admin screen too.
  return canManageAllGroups(user) && (responseScope === undefined || responseScope === 'all_groups');
}

export function getNavItems(user) {
  const items = [
    { id: 'menu', label: 'メニュー' },
    { id: 'history', label: '注文履歴' },
  ];
  if (canManageOrders(user)) {
    items.push({ id: 'manager', label: '取りまとめ' });
  }
  if (canViewAccounting(user)) items.push({ id: 'summary', label: '会計' });
  if (user?.role === 'admin') items.push({ id: 'admin', label: '管理' });
  return items;
}

export function collectOrderNotifications(previousIds, orders) {
  const ids = new Set(previousIds || []);
  let newCount = 0;
  for (const order of orders) {
    if (!ids.has(order.id)) {
      if (previousIds !== null) newCount += 1;
      ids.add(order.id);
    }
  }
  return { ids, newCount };
}

export function groupPendingOrders(orders, quantityDrafts = {}) {
  const groups = new Map();
  for (const order of orders) {
    // Administrators and chiefs see every group. Keep each table's handoff separate.
    const key = JSON.stringify([order.group_id, order.menu_name, order.size]);
    if (!groups.has(key)) groups.set(key, {
      key, groupId: order.group_id, menuName: order.menu_name, size: order.size, total: 0, items: [],
    });
    const group = groups.get(key);
    group.total += Number(quantityDrafts[order.id] ?? order.quantity);
    group.items.push(order);
  }
  return [...groups.values()];
}
