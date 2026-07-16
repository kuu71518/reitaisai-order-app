export function visibleMenuItemsForRole(items, role) {
  if (!Array.isArray(items)) return [];
  if (role === 'admin') return items;
  return items.filter((item) => Number(item?.is_admin_only) !== 1 && item?.category !== '宴会コース');
}
