import type { Bindings } from './types.ts';

const encoder = new TextEncoder();
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);

export function allowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && url.pathname !== '/' && value === url.href
      && (PUSH_HOSTS.has(url.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname));
  } catch { return false; }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid push configuration');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}

export function getPushConfig(env: Bindings) {
  if (!env.WEB_PUSH_PUBLIC_KEY || !env.WEB_PUSH_PRIVATE_KEY || !env.FRONTEND_URL) return null;
  try {
    const publicBytes = decode(env.WEB_PUSH_PUBLIC_KEY);
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || decode(env.WEB_PUSH_PRIVATE_KEY).length !== 32) return null;
    const subject = new URL(env.FRONTEND_URL);
    if (subject.protocol !== 'https:' || subject.username || subject.password) return null;
    return { publicKey: env.WEB_PUSH_PUBLIC_KEY, privateKey: env.WEB_PUSH_PRIVATE_KEY, subject: subject.origin };
  } catch { return null; }
}

// RFC 8292 VAPID. Send an empty Web Push message: no participant or order data
// leaves the API. The service worker displays a fixed, generic notification.
export async function vapidAuthorization(config: NonNullable<ReturnType<typeof getPushConfig>>, endpoint: string, now: number) {
  const publicBytes = decode(config.publicKey);
  const signingKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: base64url(publicBytes.slice(1, 33)),
    y: base64url(publicBytes.slice(33)), d: config.privateKey,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 3600, sub: config.subject })));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encoder.encode(input));
  return `vapid t=${input}.${base64url(new Uint8Array(signature))}, k=${config.publicKey}`;
}

const RECIPIENTS_SQL = `
  SELECT p.endpoint, p.session_id
  FROM push_subscriptions p
  JOIN users recipient ON recipient.id = p.user_id
  JOIN auth_sessions s ON s.id = p.session_id AND s.user_id = recipient.id
  JOIN orders o ON o.id = ? AND o.status = 'pending'
  JOIN users sender ON sender.id = o.user_id
  WHERE recipient.is_active = 1 AND recipient.discord_id_hmac IS NOT NULL
    AND (recipient.role IN ('admin', 'chief') OR (recipient.role = 'manager' AND recipient.group_id = sender.group_id))
    AND s.revoked_at IS NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ?
    AND p.application_server_key = ?
`;

export async function notifyOrder(env: Bindings, orderId: number) {
  const config = getPushConfig(env);
  if (!config) return;
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(RECIPIENTS_SQL).bind(orderId, now, now, config.publicKey)
    .all<{ endpoint: string; session_id: number }>();
  // Limit concurrency, consume response bodies, and never log private endpoints.
  for (let offset = 0; offset < results.length; offset += 5) {
    await Promise.all(results.slice(offset, offset + 5).map(async (subscription) => {
      try {
        if (!allowedPushEndpoint(subscription.endpoint)) return;
        const claimed = await env.DB.prepare(`
          UPDATE push_subscriptions SET last_sent_at = ?
          WHERE endpoint = ? AND session_id = ? AND last_sent_at <= ?
            AND endpoint IN (${RECIPIENTS_SQL.replace('SELECT p.endpoint, p.session_id', 'SELECT p.endpoint')})
        `).bind(now, subscription.endpoint, subscription.session_id, now - 5, orderId, now, now, config.publicKey).run();
        if (claimed.meta.changes !== 1) return;
        const authorization = await vapidAuthorization(config, subscription.endpoint, now);
        const response = await fetch(subscription.endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { Authorization: authorization, TTL: '300', Urgency: 'high', Topic: 'pending-orders', 'Content-Length': '0' },
        });
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND session_id = ?')
            .bind(subscription.endpoint, subscription.session_id).run();
        } else if (!response.ok) {
          console.error(JSON.stringify({ event: 'order_push_delivery_failed', status: response.status }));
        }
      } catch {
        console.error(JSON.stringify({ event: 'order_push_delivery_failed' }));
      }
    }));
  }
}
