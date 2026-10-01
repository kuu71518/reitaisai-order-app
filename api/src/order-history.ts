import { randomToken, sha256Base64Url } from './security.js';
import type { Bindings } from './types.js';

export const ORDER_HISTORY_CONFIRMATION = '注文履歴だけを削除';

// An exact snapshot detects inserts, deletions, and edits, including edits made
// within the same second. It is kept server-side; only its digest reaches the UI.
const SNAPSHOT_SQL = `
  SELECT json_group_array(json_array(
    id, user_id, menu_item_id, quantity, status, manager_memo,
    menu_name_snapshot, menu_size_snapshot, unit_price_snapshot,
    client_request_id, ordered_at, cancelled_at, cancelled_by, cancel_reason,
    created_at, updated_at, order_source, created_by_user_id
  )) FROM (SELECT * FROM orders ORDER BY id)
`;

type HistorySnapshot = {
  order_count: number;
  pending_count: number;
  ordered_count: number;
  cancelled_count: number;
  preserved_user_count: number;
  preserved_menu_count: number;
  snapshot: string;
};

export async function readOrderHistory(env: Bindings) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS order_count,
      COALESCE(SUM(status = 'pending'), 0) AS pending_count,
      COALESCE(SUM(status = 'ordered'), 0) AS ordered_count,
      COALESCE(SUM(status = 'cancelled'), 0) AS cancelled_count,
      (SELECT COUNT(*) FROM users) AS preserved_user_count,
      (SELECT COUNT(*) FROM menu_items) AS preserved_menu_count,
      (${SNAPSHOT_SQL}) AS snapshot
    FROM orders
  `).first<HistorySnapshot>();
  if (!row || typeof row.snapshot !== 'string') throw new Error('Order history preview unavailable');
  const { snapshot, ...counts } = row;
  return { snapshot, preview: { ...counts, snapshot_token: await sha256Base64Url(snapshot) } };
}

export async function clearOrderHistory(env: Bindings, actorId: number, expected: Awaited<ReturnType<typeof readOrderHistory>>) {
  const now = Math.floor(Date.now() / 1000);
  const guardHash = await sha256Base64Url(`order-history-clear:${randomToken()}`);
  const guard = 'EXISTS (SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL)';
  const metadata = JSON.stringify({
    deleted_order_count: expected.preview.order_count,
    pending_count: expected.preview.pending_count,
    ordered_count: expected.preview.ordered_count,
    cancelled_count: expected.preview.cancelled_count,
  });
  // D1 batch is transactional: a failed receipt, delete, or audit rolls back all
  // changes. The temporary guard is removed within the same batch.
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO oauth_states (state_hash, created_at, expires_at, used_at)
      SELECT ?, ?, ?, NULL WHERE (${SNAPSHOT_SQL}) = ?
    `).bind(guardHash, now, now + 60, expected.snapshot),
    env.DB.prepare(`SELECT CASE WHEN ${guard} THEN 1 ELSE 0 END AS acquired`).bind(guardHash),
    env.DB.prepare(`
      INSERT INTO cleared_order_requests (user_id, client_request_id, cleared_at)
      SELECT user_id, client_request_id, ? FROM orders WHERE ${guard}
      ON CONFLICT(user_id, client_request_id) DO NOTHING
    `).bind(now, guardHash),
    env.DB.prepare(`DELETE FROM orders WHERE ${guard}`).bind(guardHash),
    env.DB.prepare(`
      INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
      SELECT ?, 'ORDER_HISTORY_CLEAR', 'order_history', NULL, ? WHERE ${guard}
    `).bind(actorId, metadata, guardHash),
    env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(guardHash),
  ]);
  return Number((results[1].results[0] as { acquired?: number } | undefined)?.acquired) === 1;
}
