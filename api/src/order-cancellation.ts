import { sha256Base64Url } from './security.js';
import type { Bindings, SessionUser } from './types.js';

// Use exact stored values, not just second-resolution updated_at. A quantity
// edit and handoff can both happen within a single second.
export const CANCEL_SNAPSHOT_SQL = `json_array(
  o.id, o.user_id, o.menu_item_id, o.quantity, o.status, o.manager_memo,
  o.menu_name_snapshot, o.menu_size_snapshot, o.unit_price_snapshot,
  o.client_request_id, o.ordered_at, o.cancelled_at, o.cancelled_by,
  o.cancel_reason, o.created_at, o.updated_at, o.order_source, o.created_by_user_id,
  (SELECT group_id FROM users WHERE id = o.user_id)
)`;

export async function withCancelTokens(rows: Record<string, unknown>[]) {
  return Promise.all(rows.map(async ({ cancel_snapshot, ...row }) => {
    if (typeof cancel_snapshot !== 'string') throw new Error('Order snapshot unavailable');
    return { ...row, cancel_snapshot_token: await sha256Base64Url(cancel_snapshot) };
  }));
}

export type CancellationOrder = {
  id: number;
  user_id: number;
  group_id: string;
  status: 'pending' | 'ordered' | 'cancelled';
  cancel_snapshot: string;
};

export async function readCancellationOrder(env: Bindings, id: number) {
  return env.DB.prepare(`
    SELECT o.id, o.user_id, o.status, u.group_id, ${CANCEL_SNAPSHOT_SQL} AS cancel_snapshot
    FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?
  `).bind(id).first<CancellationOrder>();
}

export function canAccessCancellation(user: SessionUser, order: CancellationOrder) {
  return user.role === 'admin' || user.role === 'chief' || user.id === order.user_id;
}

export async function cancelOrder(env: Bindings, actor: SessionUser, order: CancellationOrder, reason: string, restaurantConfirmed: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE orders AS o
      SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
      WHERE o.id = ? AND o.status != 'cancelled'
        AND ${CANCEL_SNAPSHOT_SQL} = ?
        AND EXISTS (
          SELECT 1 FROM users actor WHERE actor.id = ? AND actor.is_active = 1
            AND (actor.role = 'admin' OR (o.status = 'pending' AND (
              actor.role = 'chief' OR actor.id = o.user_id
            )))
        )
    `).bind(now, actor.id, reason, now, order.id, order.cancel_snapshot, actor.id),
    env.DB.prepare(`
      INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
      SELECT ?, 'ORDER_CANCEL', 'order', ?, ? WHERE changes() = 1
    `).bind(actor.id, order.id, JSON.stringify({ previous_status: order.status, reason, restaurant_confirmed: restaurantConfirmed })),
  ]);
  return results[0].meta.changes === 1 && results[1].meta.changes === 1;
}
