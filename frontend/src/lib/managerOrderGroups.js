// Keep the original rows for edits and handoff IDs; totals are display-only.
export function groupOrdersForHandoff(orders, quantityDrafts = {}) {
  const tables = new Map();
  for (const order of orders) {
    const tableKey = JSON.stringify([order.group_id]);
    if (!tables.has(tableKey)) tables.set(tableKey, {
      key: tableKey, groupId: order.group_id, orderCount: 0, products: new Map(),
    });
    const table = tables.get(tableKey);
    table.orderCount += 1;
    const productKey = JSON.stringify([order.group_id, order.menu_name]);
    if (!table.products.has(productKey)) table.products.set(productKey, {
      key: productKey, menuName: order.menu_name, hasDraft: false, variants: new Map(),
    });
    const product = table.products.get(productKey);
    const quantity = Number(quantityDrafts[order.id] ?? order.quantity);
    product.hasDraft ||= quantity !== Number(order.quantity);
    const variantKey = JSON.stringify([order.size]);
    if (!product.variants.has(variantKey)) product.variants.set(variantKey, {
      key: variantKey, size: order.size, total: 0, people: new Map(),
    });
    const variant = product.variants.get(variantKey);
    variant.total += quantity;
    // A name is not an identity. If an old row lacks user_id, do not merge it.
    const personKey = JSON.stringify(order.user_id == null ? ['order', order.id] : ['user', order.user_id]);
    if (!variant.people.has(personKey)) variant.people.set(personKey, {
      key: personKey, name: order.user_name, total: 0, orders: [],
    });
    const person = variant.people.get(personKey);
    person.total += quantity;
    person.orders.push(order);
  }

  return [...tables.values()].map((table) => ({
    ...table,
    products: [...table.products.values()].map((product) => ({
      ...product,
      variants: [...product.variants.values()].map((variant) => ({
        ...variant, people: [...variant.people.values()],
      })),
    })),
  }));
}
