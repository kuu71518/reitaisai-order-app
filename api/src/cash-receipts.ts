import { sha256Base64Url } from './security.js';
import type { Bindings } from './types.js';

export const CASH_HISTORY_SNAPSHOT_SQL = `SELECT json_group_array(json_array(
  user_id, received, recorded_order_total, received_at, revision, updated_at, last_actor_user_id, last_request_token
)) FROM (SELECT * FROM cash_receipts ORDER BY user_id)`;

const TOTAL_SQL = `(SELECT COALESCE(SUM(o.unit_price_snapshot * o.quantity), 0)
  FROM orders o WHERE o.user_id = u.id AND o.status != 'cancelled')`;
const SNAPSHOT_SQL = `json_array(u.id, u.group_id, u.is_active, ${TOTAL_SQL},
  COALESCE(r.revision, 0), COALESCE(r.received, 0), r.recorded_order_total,
  r.received_at, r.updated_at, r.last_actor_user_id, r.last_request_token,
  COALESCE((SELECT MAX(id) FROM audit_logs WHERE action_type = 'EVENT_DATA_RESET'), 0))`;
const ELIGIBLE_SQL = `(u.is_active = 1 OR r.user_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status != 'cancelled'))`;
const ACCOUNTING_SQL = `
  SELECT u.id AS user_id, u.name, u.group_id, ${TOTAL_SQL} AS total_price,
    COALESCE(r.received, 0) AS cash_received,
    r.received_at AS cash_received_at, r.recorded_order_total AS cash_recorded_total,
    COALESCE(r.revision, 0) AS cash_receipt_revision,
    r.last_actor_user_id, r.last_request_token, ${SNAPSHOT_SQL} AS cash_snapshot
  FROM users u LEFT JOIN cash_receipts r ON r.user_id = u.id
  WHERE ${ELIGIBLE_SQL}
`;

export type AccountingRow = {
  user_id: number;
  name: string;
  group_id: string;
  total_price: number;
  cash_received: number;
  cash_received_at: number | null;
  cash_recorded_total: number | null;
  cash_receipt_revision: number;
  last_actor_user_id: number | null;
  last_request_token: string | null;
  cash_snapshot: string;
};

export async function accountingPublicRow(row: AccountingRow) {
  const { cash_snapshot, last_actor_user_id: _actor, last_request_token: _request, ...publicRow } = row;
  if (typeof cash_snapshot !== 'string') throw new Error('Accounting snapshot unavailable');
  return {
    ...publicRow,
    cash_received: row.cash_received === 1,
    cash_amount_changed: row.cash_received === 1 && row.cash_recorded_total !== row.total_price,
    cash_receipt_snapshot_token: await sha256Base64Url(cash_snapshot),
  };
}

export async function readAccounting(env: Bindings, groupId?: string) {
  const statement = env.DB.prepare(`${ACCOUNTING_SQL}${groupId === undefined ? '' : ' AND u.group_id = ?'} ORDER BY u.group_id, u.name, u.id`);
  const { results } = groupId === undefined
    ? await statement.all<AccountingRow>()
    : await statement.bind(groupId).all<AccountingRow>();
  return Promise.all(results.map(accountingPublicRow));
}

export async function readCashReceipt(env: Bindings, userId: number) {
  return env.DB.prepare(`${ACCOUNTING_SQL} AND u.id = ?`).bind(userId).first<AccountingRow>();
}

export async function writeCashReceipt(env: Bindings, actorId: number, expected: AccountingRow, received: boolean, requestToken: string) {
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO cash_receipts
        (user_id, received, recorded_order_total, received_at, revision, updated_at, last_actor_user_id, last_request_token)
      SELECT u.id, ?, ?, ?, COALESCE(r.revision, 0) + 1, ?, ?, ?
      FROM users u LEFT JOIN cash_receipts r ON r.user_id = u.id
      WHERE u.id = ? AND ${ELIGIBLE_SQL} AND ${SNAPSHOT_SQL} = ?
        AND EXISTS (SELECT 1 FROM users actor WHERE actor.id = ?
          AND actor.is_active = 1 AND actor.discord_id_hmac IS NOT NULL AND actor.role IN ('admin', 'chief'))
      ON CONFLICT(user_id) DO UPDATE SET
        received = excluded.received, recorded_order_total = excluded.recorded_order_total,
        received_at = excluded.received_at, revision = excluded.revision,
        updated_at = excluded.updated_at, last_actor_user_id = excluded.last_actor_user_id,
        last_request_token = excluded.last_request_token
    `).bind(received ? 1 : 0, received ? expected.total_price : null, received ? now : null,
      now, actorId, requestToken, expected.user_id, expected.cash_snapshot, actorId),
    env.DB.prepare(`
      INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
      SELECT ?, ?, 'cash_receipt', ?, ? WHERE changes() = 1
    `).bind(actorId, received ? 'CASH_RECEIPT_SET' : 'CASH_RECEIPT_CLEAR', expected.user_id, JSON.stringify({
      order_total: expected.total_price, previous_received: expected.cash_received === 1,
      previous_recorded_total: expected.cash_recorded_total, revision: expected.cash_receipt_revision + 1,
    })),
  ]);
  return results[0].meta.changes === 1 && results[1].meta.changes === 1;
}
