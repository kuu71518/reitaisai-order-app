import { Hono, type Context, type Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  cleanText,
  deriveDiscordIdHmac,
  deriveDiscordIdHmacBatch,
  deriveCsrfToken,
  hasRole,
  isAllowedOrigin,
  isAssignableUserRole,
  isClientRequestId,
  isDiscordSnowflake,
  isOrderStatus,
  isUnsafeMethod,
  isUserRole,
  parsePositiveInteger,
  randomToken,
  sha256Base64Url,
  timingSafeEqual,
} from './security.js';
import type { AppEnv, AuthContext, Bindings, SessionUser, UserRole } from './types.js';
import { clearOrderHistory, ORDER_HISTORY_CONFIRMATION, readOrderHistory } from './order-history.ts';
import { allowedPushEndpoint, getPushConfig, notifyOrder } from './push.ts';
import { CANCEL_SNAPSHOT_SQL, canAccessCancellation, cancelOrder, readCancellationOrder, withCancelTokens } from './order-cancellation.ts';
import { CASH_HISTORY_SNAPSHOT_SQL, readAccounting, readGroupAccountingTotal, readCashReceipt, writeCashReceipt } from './cash-receipts.ts';

// Keep this browser signed in for at most 30 days after Discord authentication.
// Activity must not extend that deadline or refresh the administrator auth time.
const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_IDLE_SECONDS = SESSION_ABSOLUTE_SECONDS;
const OAUTH_STATE_SECONDS = 10 * 60;
const SESSION_TOUCH_SECONDS = 5 * 60;
const RECENT_ADMIN_AUTH_SECONDS = 5 * 60;
const RESET_CONFIRMATION = '開催データをリセット';
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const DISCORD_ME_URL = 'https://discord.com/api/v10/users/@me';
const ADMIN_ONLY_MENU_CATEGORY = '宴会コース';
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/discord/start',
  '/api/auth/discord/callback',
]);

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 428 | 429 | 500 | 502 | 503;
type JsonObject = Record<string, unknown>;

type SessionRow = SessionUser & {
  session_id: number;
  created_at: number;
  last_seen_at: number;
};

type BulkUser = {
  name: string;
  groupId: string;
  role: Exclude<UserRole, 'admin'>;
  discordIdHmac: string;
};

type ResetPreview = {
  user_count: number;
  order_count: number;
  other_session_count: number;
  preserved_menu_count: number;
  preserved_audit_count: number;
  cash_receipt_count: number;
  cash_receipt_snapshot_token: string;
};

type ResetState = ResetPreview & { cash_snapshot: string };

type DiscordUser = {
  id: string;
};

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string;
  discordIdHmacKey: string;
};

const app = new Hono<AppEnv>();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function fail(c: Context<AppEnv>, status: ErrorStatus, message: string, code?: string) {
  return c.json({ success: false, message, ...(code ? { code } : {}) }, status);
}

async function readJsonObject(c: Context<AppEnv>): Promise<JsonObject | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}

function secureCookies(env: Bindings) {
  return env.APP_ENV !== 'local';
}

function sessionCookieName(env: Bindings) {
  return secureCookies(env) ? '__Host-reitaisai_session' : 'reitaisai_session';
}

function stateCookieName(env: Bindings) {
  return secureCookies(env) ? '__Host-reitaisai_oauth_state' : 'reitaisai_oauth_state';
}

function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, sessionCookieName(c.env), token, {
    httpOnly: true,
    secure: secureCookies(c.env),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_ABSOLUTE_SECONDS,
  });
}

function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, sessionCookieName(c.env), {
    secure: secureCookies(c.env),
    path: '/',
  });
}

function setStateCookie(c: Context<AppEnv>, state: string) {
  setCookie(c, stateCookieName(c.env), state, {
    httpOnly: true,
    secure: secureCookies(c.env),
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_STATE_SECONDS,
  });
}

function clearStateCookie(c: Context<AppEnv>) {
  deleteCookie(c, stateCookieName(c.env), {
    secure: secureCookies(c.env),
    path: '/',
  });
}

function getOAuthConfig(env: Bindings): OAuthConfig | null {
  const clientId = cleanText(env.DISCORD_CLIENT_ID, 64);
  const clientSecret = cleanText(env.DISCORD_CLIENT_SECRET, 256);
  const redirectUri = cleanText(env.DISCORD_REDIRECT_URI, 500);
  const frontendUrl = cleanText(env.FRONTEND_URL, 500);
  const discordIdHmacKey = cleanText(env.DISCORD_ID_HMAC_KEY, 512);
  if (!clientId || !clientSecret || !redirectUri || !frontendUrl || discordIdHmacKey.length < 32) return null;

  try {
    const redirect = new URL(redirectUri);
    const frontend = new URL(frontendUrl);
    const localRedirect = redirect.hostname === '127.0.0.1' || redirect.hostname === 'localhost';
    const localFrontend = frontend.hostname === '127.0.0.1' || frontend.hostname === 'localhost';
    if (redirect.protocol !== 'https:' && !(localRedirect && redirect.protocol === 'http:')) return null;
    if (frontend.protocol !== 'https:' && !(localFrontend && frontend.protocol === 'http:')) return null;

    if (env.APP_ENV !== 'local') {
      const siteDomain = cleanText(env.SESSION_SITE_DOMAIN, 253).toLowerCase();
      const blockedPublicSuffixes = new Set(['pages.dev', 'workers.dev']);
      const isWithinSite = (hostname: string) => hostname === siteDomain || hostname.endsWith(`.${siteDomain}`);
      if (!siteDomain || blockedPublicSuffixes.has(siteDomain)
        || !isWithinSite(redirect.hostname.toLowerCase())
        || !isWithinSite(frontend.hostname.toLowerCase())) return null;
    }
  } catch {
    return null;
  }

  return { clientId, clientSecret, redirectUri, frontendUrl, discordIdHmacKey };
}

function redirectToFrontend(c: Context<AppEnv>, result: string) {
  const config = getOAuthConfig(c.env);
  if (!config) return fail(c, 503, 'ログイン設定が完了していません。', 'AUTH_NOT_CONFIGURED');
  const target = new URL(config.frontendUrl);
  target.searchParams.set('auth', result);
  return c.redirect(target.toString(), 302);
}

async function audit(
  env: Bindings,
  actorUserId: number | null,
  actionType: string,
  targetType: string | null = null,
  targetId: number | null = null,
  metadata: JsonObject = {},
) {
  try {
    await env.DB.prepare(`
      INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).bind(actorUserId, actionType, targetType, targetId, JSON.stringify(metadata)).run();
  } catch {
    console.error(JSON.stringify({ event: 'audit_write_failed', action_type: actionType }));
  }
}

function addCorsHeaders(c: Context<AppEnv>, origin: string) {
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  c.header('Access-Control-Max-Age', '600');
  c.header('Vary', 'Origin');
}

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');

  const origin = c.req.header('Origin');
  const originAllowed = origin ? isAllowedOrigin(origin, c.env.ALLOWED_ORIGINS) : false;

  if (c.req.method === 'OPTIONS') {
    if (!originAllowed || !origin) return fail(c, 403, '許可されていない接続元です。', 'ORIGIN_DENIED');
    addCorsHeaders(c, origin);
    return c.body(null, 204);
  }

  if (isUnsafeMethod(c.req.method) && !originAllowed) {
    return fail(c, 403, '許可されていない接続元です。', 'ORIGIN_DENIED');
  }

  if (originAllowed && origin) addCorsHeaders(c, origin);
  await next();
});

async function loadSession(c: Context<AppEnv>): Promise<AuthContext | null> {
  const sessionToken = getCookie(c, sessionCookieName(c.env));
  if (!sessionToken || sessionToken.length < 32 || sessionToken.length > 100) return null;

  const tokenHash = await sha256Base64Url(sessionToken);
  const now = nowSeconds();
  const row = await c.env.DB.prepare(`
    SELECT
      s.id AS session_id,
      s.created_at,
      s.last_seen_at,
      u.id,
      u.name,
      u.group_id,
      u.role
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.idle_expires_at > ?
      AND s.absolute_expires_at > ?
      AND u.is_active = 1
      AND u.discord_id_hmac IS NOT NULL
    LIMIT 1
  `).bind(tokenHash, now, now).first<SessionRow>();

  if (!row || !isUserRole(row.role)) {
    clearSessionCookie(c);
    return null;
  }

  if (now - row.last_seen_at >= SESSION_TOUCH_SECONDS) {
    await c.env.DB.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?, idle_expires_at = MIN(?, absolute_expires_at)
      WHERE id = ? AND revoked_at IS NULL
    `).bind(now, now + SESSION_IDLE_SECONDS, row.session_id).run();
  }

  return {
    sessionId: row.session_id,
    sessionCreatedAt: row.created_at,
    sessionToken,
    user: {
      id: row.id,
      name: row.name,
      group_id: row.group_id,
      role: row.role,
    },
  };
}

app.use('/api/*', async (c, next: Next) => {
  if (c.req.method === 'OPTIONS' || PUBLIC_PATHS.has(c.req.path)) return next();

  const auth = await loadSession(c);
  if (!auth) return fail(c, 401, 'ログインが必要です。', 'AUTH_REQUIRED');
  c.set('auth', auth);

  if (isUnsafeMethod(c.req.method)) {
    const expectedToken = await deriveCsrfToken(auth.sessionToken);
    const submittedToken = c.req.header('X-CSRF-Token');
    if (!submittedToken || !timingSafeEqual(submittedToken, expectedToken)) {
      return fail(c, 403, '安全確認に失敗しました。画面を再読み込みしてください。', 'CSRF_FAILED');
    }
  }

  return next();
});

function requireRole(c: Context<AppEnv>, roles: UserRole[]) {
  const auth = c.get('auth');
  return hasRole(auth.user.role, roles)
    ? null
    : fail(c, 403, 'この操作を行う権限がありません。', 'FORBIDDEN');
}

function requireRecentAdminLogin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const ageSeconds = nowSeconds() - auth.sessionCreatedAt;
  return Number.isInteger(auth.sessionCreatedAt) && ageSeconds >= 0 && ageSeconds <= RECENT_ADMIN_AUTH_SECONDS
    ? null
    : fail(
      c,
      428,
      '安全のため、Discordへ再ログインしてからもう一度お試しください。',
      'RECENT_LOGIN_REQUIRED',
    );
}

function parseNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function resultNumber(result: D1Result, key: string) {
  return Number((result.results[0] as Record<string, unknown> | undefined)?.[key] || 0);
}

async function readResetPreview(env: Bindings, currentSessionId: number): Promise<ResetState> {
  const [users, orders, sessions, menuItems, auditLogs, cashReceipts] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role != 'admin'"),
    env.DB.prepare('SELECT COUNT(*) AS count FROM orders'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE id != ?').bind(currentSessionId),
    env.DB.prepare('SELECT COUNT(*) AS count FROM menu_items'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM audit_logs'),
    env.DB.prepare(`SELECT COUNT(*) AS count, (${CASH_HISTORY_SNAPSHOT_SQL}) AS snapshot FROM cash_receipts`),
  ]);
  const cashSnapshot = (cashReceipts.results[0] as { snapshot?: unknown } | undefined)?.snapshot;
  if (typeof cashSnapshot !== 'string') throw new Error('Cash receipt snapshot unavailable');
  return {
    user_count: resultNumber(users, 'count'),
    order_count: resultNumber(orders, 'count'),
    other_session_count: resultNumber(sessions, 'count'),
    preserved_menu_count: resultNumber(menuItems, 'count'),
    preserved_audit_count: resultNumber(auditLogs, 'count'),
    cash_receipt_count: resultNumber(cashReceipts, 'count'),
    cash_receipt_snapshot_token: await sha256Base64Url(cashSnapshot),
    cash_snapshot: cashSnapshot,
  };
}

async function missingOrderResponse(c: Context<AppEnv>, userId: number, requestId: string) {
  const cleared = await c.env.DB.prepare(`
    SELECT 1 AS cleared FROM cleared_order_requests WHERE user_id = ? AND client_request_id = ?
  `).bind(userId, requestId).first();
  if (cleared) return fail(c, 410, 'この注文は管理者が履歴を削除済みです。新たに注文する場合はメニューから選び直してください。', 'ORDER_HISTORY_CLEARED');
  return fail(c, 500, '注文を保存できませんでした。');
}

function sendOrderNotifications(c: Context<AppEnv>, orderId: number) {
  if (!getPushConfig(c.env)) return;
  // Keep notification failures separate from order acceptance and retries.
  c.executionCtx.waitUntil(notifyOrder(c.env, orderId).catch(() => {
    console.error(JSON.stringify({ event: 'order_push_delivery_failed' }));
  }));
}

async function issueSession(c: Context<AppEnv>, user: SessionUser) {
  const now = nowSeconds();
  const sessionToken = randomToken(32);
  const tokenHash = await sha256Base64Url(sessionToken);

  await c.env.DB.batch([
    c.env.DB.prepare(`
      DELETE FROM auth_sessions
      WHERE revoked_at IS NOT NULL OR absolute_expires_at <= ? OR idle_expires_at <= ?
    `).bind(now, now),
    c.env.DB.prepare(`
      INSERT INTO auth_sessions
        (token_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      tokenHash,
      user.id,
      now,
      now,
      now + SESSION_IDLE_SECONDS,
      now + SESSION_ABSOLUTE_SECONDS,
    ),
  ]);

  setSessionCookie(c, sessionToken);
}

async function findUserByDiscordId(env: Bindings, discordUserId: string, hmacKey: string) {
  const discordIdHmac = await deriveDiscordIdHmac(hmacKey, discordUserId);
  if (!discordIdHmac) return null;
  return env.DB.prepare(`
    SELECT id, name, group_id, role
    FROM users
    WHERE discord_id_hmac = ? AND is_active = 1
    LIMIT 1
  `).bind(discordIdHmac).first<SessionUser>();
}

async function tryBootstrapAdmin(env: Bindings, discordUserId: string, hmacKey: string) {
  if (!env.BOOTSTRAP_ADMIN_DISCORD_USER_ID
    || !timingSafeEqual(env.BOOTSTRAP_ADMIN_DISCORD_USER_ID, discordUserId)) return null;

  const discordIdHmac = await deriveDiscordIdHmac(hmacKey, discordUserId);
  if (!discordIdHmac) return null;

  const result = await env.DB.prepare(`
    SELECT id, name, group_id, role
    FROM users
    WHERE role = 'admin' AND is_active = 1 AND discord_id_hmac IS NULL
    ORDER BY id
    LIMIT 2
  `).all<SessionUser>();

  if (result.results.length !== 1) return null;
  const user = result.results[0];
  const update = await env.DB.prepare(`
    UPDATE users
    SET discord_id_hmac = ?, updated_at = ?
    WHERE id = ? AND discord_id_hmac IS NULL
  `).bind(discordIdHmac, nowSeconds(), user.id).run();
  if (update.meta.changes !== 1) return null;

  await audit(env, user.id, 'AUTH_BOOTSTRAP_LINK', 'user', user.id);
  return user;
}

app.get('/api/health', (c) => c.json({ success: true, data: { status: 'ok' } }));

app.get('/api/auth/discord/start', async (c) => {
  const config = getOAuthConfig(c.env);
  if (!config) return fail(c, 503, 'ログイン設定が完了していません。', 'AUTH_NOT_CONFIGURED');

  const state = randomToken(32);
  const stateHash = await sha256Base64Url(state);
  const now = nowSeconds();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ? OR used_at IS NOT NULL').bind(now),
    c.env.DB.prepare(`
      INSERT INTO oauth_states (state_hash, created_at, expires_at)
      VALUES (?, ?, ?)
    `).bind(stateHash, now, now + OAUTH_STATE_SECONDS),
  ]);
  setStateCookie(c, state);

  const authorizeUrl = new URL(DISCORD_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
  return c.redirect(authorizeUrl.toString(), 302);
});

app.get('/api/auth/discord/callback', async (c) => {
  const config = getOAuthConfig(c.env);
  if (!config) return fail(c, 503, 'ログイン設定が完了していません。', 'AUTH_NOT_CONFIGURED');

  const returnedState = c.req.query('state') || '';
  const cookieState = getCookie(c, stateCookieName(c.env)) || '';
  clearStateCookie(c);

  if (!returnedState || !cookieState || !timingSafeEqual(returnedState, cookieState)) {
    return redirectToFrontend(c, 'state_error');
  }

  const now = nowSeconds();
  const stateHash = await sha256Base64Url(returnedState);
  const consumed = await c.env.DB.prepare(`
    UPDATE oauth_states
    SET used_at = ?
    WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
  `).bind(now, stateHash, now).run();
  if (consumed.meta.changes !== 1) return redirectToFrontend(c, 'state_error');

  if (c.req.query('error')) return redirectToFrontend(c, 'cancelled');
  const code = cleanText(c.req.query('code') || '', 500);
  if (!code) return redirectToFrontend(c, 'failed');

  try {
    const tokenBody = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    });
    const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    if (!tokenResponse.ok) return redirectToFrontend(c, 'failed');

    const tokenPayload = await tokenResponse.json() as { access_token?: unknown; token_type?: unknown };
    if (typeof tokenPayload.access_token !== 'string' || tokenPayload.token_type !== 'Bearer') {
      return redirectToFrontend(c, 'failed');
    }

    const userResponse = await fetch(DISCORD_ME_URL, {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
    });
    if (!userResponse.ok) return redirectToFrontend(c, 'failed');

    const discordPayload: unknown = await userResponse.json();
    const discordUserId = discordPayload && typeof discordPayload === 'object'
      && typeof (discordPayload as Partial<DiscordUser>).id === 'string'
      ? (discordPayload as DiscordUser).id
      : '';
    if (!isDiscordSnowflake(discordUserId)) {
      return redirectToFrontend(c, 'failed');
    }

    let user = await findUserByDiscordId(c.env, discordUserId, config.discordIdHmacKey);
    if (!user) user = await tryBootstrapAdmin(c.env, discordUserId, config.discordIdHmacKey);
    if (!user) return redirectToFrontend(c, 'not_registered');

    await issueSession(c, user);
    await audit(c.env, user.id, 'AUTH_LOGIN', 'user', user.id);
    return redirectToFrontend(c, 'success');
  } catch {
    return redirectToFrontend(c, 'failed');
  }
});

app.get('/api/auth/me', async (c) => {
  const auth = c.get('auth');
  const csrfToken = await deriveCsrfToken(auth.sessionToken);
  return c.json({ success: true, user: auth.user, csrf_token: csrfToken });
});

app.post('/api/auth/logout', async (c) => {
  const auth = c.get('auth');
  const now = nowSeconds();
  await c.env.DB.prepare(`
    UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
  `).bind(now, auth.sessionId).run();
  clearSessionCookie(c);
  await audit(c.env, auth.user.id, 'AUTH_LOGOUT', 'user', auth.user.id);
  return c.json({ success: true });
});

app.get('/api/menu', async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(`
    SELECT id, category, name, size, price
    FROM menu_items
    WHERE is_active = 1
      AND (? = 1 OR (is_admin_only = 0 AND category != '宴会コース'))
    ORDER BY category, name, price, id
  `).bind(auth.user.role === 'admin' ? 1 : 0).all();
  return c.json({ success: true, data: results });
});

app.get('/api/notifications/config', (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const config = getPushConfig(c.env);
  return c.json({ success: true, data: { configured: Boolean(config), public_key: config?.publicKey || null } });
});

app.get('/api/notifications/orders', async (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const allGroups = auth.user.role === 'admin' || auth.user.role === 'chief';
  // This lightweight notification endpoint exposes IDs only. Handoff details
  // are available separately, with managers restricted to their assigned group.
  const { results } = await c.env.DB.prepare(`
    SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.status = 'pending' AND (? = 1 OR u.group_id = ?)
    ORDER BY o.created_at, o.id
  `).bind(allGroups ? 1 : 0, auth.user.group_id).all<{ id: number }>();
  return c.json({ success: true, data: results });
});

app.post('/api/notifications/subscriptions', async (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const config = getPushConfig(c.env);
  if (!config) return fail(c, 503, 'プッシュ通知の公開設定が完了していません。', 'PUSH_NOT_CONFIGURED');
  const body = await readJsonObject(c);
  if (!allowedPushEndpoint(body?.endpoint) || body?.public_key !== config.publicKey) {
    return fail(c, 422, '通知の登録情報が正しくありません。対応ブラウザで通知設定をやり直してください。');
  }
  const auth = c.get('auth');
  const now = nowSeconds();
  const result = await c.env.DB.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, session_id, application_server_key, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM push_subscriptions p
      JOIN auth_sessions s ON s.id = p.session_id
      WHERE p.user_id = ? AND s.revoked_at IS NULL AND s.absolute_expires_at > ? AND s.idle_expires_at > ?
        AND p.application_server_key = ?) < 5
      OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id,
      application_server_key = excluded.application_server_key, updated_at = excluded.updated_at
  `).bind(body.endpoint, auth.user.id, auth.sessionId, config.publicKey, now, now,
    auth.user.id, now, now, config.publicKey, body.endpoint, auth.user.id).run();
  if (result.meta.changes !== 1) return fail(c, 409, '通知を受け取る端末は5台までです。別の端末の通知を止めてください。');
  return c.json({ success: true });
});

app.delete('/api/notifications/subscriptions', async (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const body = await readJsonObject(c);
  if (!allowedPushEndpoint(body?.endpoint)) return fail(c, 422, '通知の登録情報が正しくありません。');
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(body.endpoint, c.get('auth').user.id).run();
  return c.json({ success: true });
});

app.post('/api/orders', async (c) => {
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  if (!body) return fail(c, 400, '注文内容を読み取れませんでした。');

  const menuItemId = parsePositiveInteger(body.menu_item_id);
  const quantity = parsePositiveInteger(body.quantity, 20);
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  if (!menuItemId || !quantity || !isClientRequestId(requestId)) {
    return fail(c, 422, '商品、個数、送信識別子を確認してください。');
  }

  const menu = await c.env.DB.prepare(`
    SELECT id, name, category, size, price, is_admin_only
    FROM menu_items
    WHERE id = ? AND is_active = 1
      AND (? = 1 OR (is_admin_only = 0 AND category != '宴会コース'))
  `).bind(menuItemId, auth.user.role === 'admin' ? 1 : 0)
    .first<{ id: number; name: string; category: string; size: string; price: number; is_admin_only: number }>();
  if (!menu) return fail(c, 404, 'この商品は現在注文できません。');

  const inserted = await c.env.DB.prepare(`
    INSERT INTO orders
      (user_id, menu_item_id, quantity, status, menu_name_snapshot, menu_size_snapshot,
       unit_price_snapshot, client_request_id, order_source, created_by_user_id)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 'self', ?)
    ON CONFLICT(user_id, client_request_id) DO NOTHING
  `).bind(
    auth.user.id,
    menu.id,
    quantity,
    menu.name,
    menu.size,
    menu.price,
    requestId,
    auth.user.id,
  ).run();

  const order = await c.env.DB.prepare(`
    SELECT id FROM orders WHERE user_id = ? AND client_request_id = ?
  `).bind(auth.user.id, requestId).first<{ id: number }>();
  if (!order) return missingOrderResponse(c, auth.user.id, requestId);

  if (inserted.meta.changes === 1) {
    await audit(c.env, auth.user.id, 'ORDER_CREATE', 'order', order.id, { quantity });
    sendOrderNotifications(c, order.id);
  }
  return c.json({ success: true, data: { order_id: order.id, duplicate: inserted.meta.changes === 0 } });
});

app.get('/api/orders/mine', async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(`
    SELECT
      id,
      user_id,
      menu_name_snapshot AS item_name,
      menu_size_snapshot AS size,
      unit_price_snapshot AS price,
      quantity,
      status,
      CASE WHEN order_source = 'admin' THEN 1 ELSE 0 END AS added_by_admin,
      created_at,
      ${CANCEL_SNAPSHOT_SQL} AS cancel_snapshot
    FROM orders o
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).bind(auth.user.id).all();
  return c.json({ success: true, data: await withCancelTokens(results) });
});

app.get('/api/manager/orders', async (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const requestedStatus = c.req.query('status') || 'pending';
  if (!isOrderStatus(requestedStatus)) return fail(c, 422, '注文状態が正しくありません。');

  const allGroups = auth.user.role === 'admin' || auth.user.role === 'chief';
  const sql = `
    SELECT
      o.id,
      o.quantity,
      o.status,
      o.user_id,
      CASE WHEN o.order_source = 'admin' THEN 1 ELSE 0 END AS added_by_admin,
      u.name AS user_name,
      u.group_id,
      o.menu_name_snapshot AS menu_name,
      o.menu_size_snapshot AS size,
      ${CANCEL_SNAPSHOT_SQL} AS cancel_snapshot
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.status = ? ${allGroups ? '' : 'AND u.group_id = ?'}
    ORDER BY o.created_at, o.id
  `;
  const statement = c.env.DB.prepare(sql);
  const { results } = allGroups
    ? await statement.bind(requestedStatus).all()
    : await statement.bind(requestedStatus, auth.user.group_id).all();
  return c.json({ success: true, data: await withCancelTokens(results) });
});

async function handleOrderCancellation(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const orderId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const reason = cleanText(body?.reason, 200);
  const token = body?.snapshot_token;
  if (!orderId || !reason || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return fail(c, 422, '取消理由と対象注文を確認してください。');
  }
  const order = await readCancellationOrder(c.env, orderId);
  if (!order || !canAccessCancellation(auth.user, order)) return fail(c, 404, '取り消せる注文が見つかりません。');
  if (order.status === 'cancelled') return c.json({ success: true, data: { cancelled: true, duplicate: true } });
  if (!timingSafeEqual(token, await sha256Base64Url(order.cancel_snapshot))) {
    return fail(c, 409, '注文が更新されました。最新の内容を確認してから取り消してください。', 'ORDER_CHANGED');
  }
  if (order.status === 'ordered' && auth.user.role !== 'admin') {
    return fail(c, 403, '店員へ伝えた注文の取消は、管理者へ依頼してください。');
  }
  if (order.status === 'ordered' && body?.restaurant_confirmed !== true) {
    return fail(c, 422, '店への取消確認が完了してから操作してください。', 'RESTAURANT_CONFIRMATION_REQUIRED');
  }
  const updated = await cancelOrder(c.env, auth.user, order, reason, order.status === 'ordered');
  if (!updated) return fail(c, 409, '注文が更新されました。最新の内容を確認してから取り消してください。', 'ORDER_CHANGED');
  return c.json({ success: true, data: { cancelled: true, duplicate: false } });
}

app.post('/api/orders/:id/cancel', handleOrderCancellation);

app.patch('/api/manager/orders/:id/quantity', async (c) => {
  const roleError = requireRole(c, ['chief', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const orderId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const quantity = body ? parsePositiveInteger(body.quantity, 20) : null;
  if (!orderId || !quantity) return fail(c, 422, '注文番号と個数を確認してください。');

  const allGroups = auth.user.role === 'admin' || auth.user.role === 'chief';
  const sql = `
    UPDATE orders
    SET quantity = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
    ${allGroups ? '' : 'AND EXISTS (SELECT 1 FROM users u WHERE u.id = orders.user_id AND u.group_id = ?)'}
  `;
  const statement = c.env.DB.prepare(sql);
  const result = allGroups
    ? await statement.bind(quantity, nowSeconds(), orderId).run()
    : await statement.bind(quantity, nowSeconds(), orderId, auth.user.group_id).run();
  if (result.meta.changes !== 1) return fail(c, 404, '変更できる注文が見つかりません。');

  await audit(c.env, auth.user.id, 'ORDER_QUANTITY_UPDATE', 'order', orderId, { quantity });
  return c.json({ success: true });
});

app.patch('/api/manager/orders/status', async (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  const rawIds = body?.order_ids;
  const status = body?.status;
  const memo = cleanText(body?.manager_memo, 200) || null;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100 || status !== 'ordered') {
    return fail(c, 422, '対象注文と変更後の状態を確認してください。');
  }
  const ids = [...new Set(rawIds.map((id) => parsePositiveInteger(id)).filter((id): id is number => Boolean(id)))];
  if (ids.length !== rawIds.length) return fail(c, 422, '注文番号が正しくありません。');

  const placeholders = ids.map(() => '?').join(',');
  const allGroups = auth.user.role === 'admin' || auth.user.role === 'chief';
  const sql = `
    UPDATE orders
    SET status = 'ordered', manager_memo = ?, ordered_at = ?, updated_at = ?
    WHERE id IN (${placeholders}) AND status = 'pending'
    ${allGroups ? '' : 'AND EXISTS (SELECT 1 FROM users u WHERE u.id = orders.user_id AND u.group_id = ?)'}
  `;
  const now = nowSeconds();
  const bindings: unknown[] = [memo, now, now, ...ids];
  if (!allGroups) bindings.push(auth.user.group_id);
  const result = await c.env.DB.prepare(sql).bind(...bindings).run();
  if (result.meta.changes === 0) return fail(c, 404, '変更できる注文が見つかりません。');

  await audit(c.env, auth.user.id, 'ORDER_STATUS_UPDATE', 'order_batch', null, {
    requested_count: ids.length,
    updated_count: result.meta.changes,
  });
  return c.json({ success: true, data: { updated_count: result.meta.changes } });
});

app.get('/api/orders/summary', async (c) => {
  const roleError = requireRole(c, ['manager', 'chief', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const allGroups = auth.user.role === 'admin' || auth.user.role === 'chief';
  const data = allGroups ? await readAccounting(c.env) : await readGroupAccountingTotal(c.env, auth.user.group_id);
  return c.json({ success: true, scope: allGroups ? 'all_groups' : 'assigned_group', data });
});

app.post('/api/accounting/users/:id/cash-receipt', async (c) => {
  const roleError = requireRole(c, ['chief', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const userId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const token = body?.snapshot_token;
  if (!userId || typeof body?.received !== 'boolean'
    || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return fail(c, 422, '参加者と現金受領の確認内容を確認してください。');
  }
  const expected = await readCashReceipt(c.env, userId);
  if (!expected) return fail(c, 404, '会計対象の参加者が見つかりません。');
  if (expected.last_actor_user_id === auth.user.id && expected.last_request_token === token
    && (expected.cash_received === 1) === body.received) {
    return c.json({ success: true, data: { received: body.received, duplicate: true } });
  }
  if (!timingSafeEqual(token, await sha256Base64Url(expected.cash_snapshot))) {
    return fail(c, 409, '会計または受領状況が更新されました。最新の内容を確認してください。', 'CASH_RECEIPT_CHANGED');
  }
  const updated = await writeCashReceipt(c.env, auth.user.id, expected, body.received, token);
  if (!updated) return fail(c, 409, '会計または受領状況が更新されました。最新の内容を確認してください。', 'CASH_RECEIPT_CHANGED');
  return c.json({ success: true, data: { received: body.received, duplicate: false } });
});

app.get('/api/admin/stats', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const [users, orders, cancels, sales] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE is_active = 1'),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM orders'),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'cancelled'"),
    c.env.DB.prepare("SELECT COALESCE(SUM(unit_price_snapshot * quantity), 0) AS total FROM orders WHERE status != 'cancelled'"),
  ]);
  const value = (result: D1Result, key: string) => Number((result.results[0] as Record<string, unknown> | undefined)?.[key] || 0);
  return c.json({
    success: true,
    data: {
      total_users: value(users, 'count'),
      total_orders: value(orders, 'count'),
      total_cancels: value(cancels, 'count'),
      total_sales: value(sales, 'total'),
    },
  });
});

app.get('/api/admin/order-history/preview', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { preview } = await readOrderHistory(c.env);
  return c.json({ success: true, data: preview });
});

app.post('/api/admin/order-history/clear', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const recentLoginError = requireRecentAdminLogin(c);
  if (recentLoginError) return recentLoginError;
  const body = await readJsonObject(c);
  if (body?.backup_confirmed !== true) {
    return fail(c, 422, '復元地点を記録したことを確認してください。', 'BACKUP_CONFIRMATION_REQUIRED');
  }
  if (body.confirmation !== ORDER_HISTORY_CONFIRMATION) {
    return fail(c, 422, '確認用の文字が一致しません。', 'ORDER_HISTORY_CONFIRMATION_MISMATCH');
  }
  if (typeof body.snapshot_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.snapshot_token)) {
    return fail(c, 422, '削除対象をもう一度確認してください。', 'ORDER_HISTORY_PREVIEW_REQUIRED');
  }
  const expected = await readOrderHistory(c.env);
  if (body.snapshot_token !== expected.preview.snapshot_token) {
    return fail(c, 409, '確認後に注文が変わりました。削除済みの場合もあります。最新の件数を確認してください。', 'ORDER_HISTORY_PREVIEW_STALE');
  }
  if (expected.preview.order_count === 0) {
    return fail(c, 409, '削除する注文履歴はありません。', 'ORDER_HISTORY_EMPTY');
  }
  const cleared = await clearOrderHistory(c.env, c.get('auth').user.id, expected);
  if (!cleared) {
    return fail(c, 409, '確認後に注文が変わりました。最新の件数を確認してください。', 'ORDER_HISTORY_PREVIEW_STALE');
  }
  return c.json({ success: true, data: { deleted_order_count: expected.preview.order_count } });
});

app.get('/api/admin/data-reset/preview', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  try {
    const { cash_snapshot: _cashSnapshot, ...preview } = await readResetPreview(c.env, auth.sessionId);
    return c.json({ success: true, data: preview });
  } catch {
    return fail(c, 500, 'リセット対象を確認できませんでした。');
  }
});

app.post('/api/admin/data-reset', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const recentLoginError = requireRecentAdminLogin(c);
  if (recentLoginError) return recentLoginError;
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  if (!body) return fail(c, 400, 'リセットの確認内容を読み取れませんでした。');

  if (body.backup_confirmed !== true) {
    return fail(c, 422, '復元地点を記録したことを確認してください。', 'BACKUP_CONFIRMATION_REQUIRED');
  }
  if (body.confirmation !== RESET_CONFIRMATION) {
    return fail(c, 422, '確認用の文字が一致しません。', 'RESET_CONFIRMATION_MISMATCH');
  }
  const expectedUserCount = parseNonNegativeInteger(body.expected_user_count);
  const expectedOrderCount = parseNonNegativeInteger(body.expected_order_count);
  const expectedOtherSessionCount = parseNonNegativeInteger(body.expected_other_session_count);
  const expectedCashReceiptToken = body.expected_cash_receipt_snapshot_token;
  if (expectedUserCount === null || expectedOrderCount === null || expectedOtherSessionCount === null) {
    return fail(c, 422, 'リセット対象の件数を再確認してください。', 'RESET_COUNTS_INVALID');
  }
  if (typeof expectedCashReceiptToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedCashReceiptToken)) {
    return fail(c, 422, '現金受領記録の削除対象を再確認してください。', 'RESET_CASH_SNAPSHOT_INVALID');
  }

  let preview: ResetState;
  try {
    preview = await readResetPreview(c.env, auth.sessionId);
  } catch {
    return fail(c, 500, 'リセット対象を再確認できませんでした。');
  }
  if (preview.user_count !== expectedUserCount
    || preview.order_count !== expectedOrderCount
    || preview.other_session_count !== expectedOtherSessionCount
    || !timingSafeEqual(preview.cash_receipt_snapshot_token, expectedCashReceiptToken)) {
    return fail(c, 409, 'リセット対象が変更されました。内容を再確認してください。', 'RESET_PREVIEW_STALE');
  }

  const now = nowSeconds();
  const guardHash = await sha256Base64Url(`event-data-reset:${randomToken()}`);
  const metadata = JSON.stringify({
    deleted_user_count: expectedUserCount,
    deleted_order_count: expectedOrderCount,
    deleted_session_count: expectedOtherSessionCount,
    deleted_cash_receipt_count: preview.cash_receipt_count,
  });
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT INTO oauth_states (state_hash, created_at, expires_at, used_at)
        SELECT ?, ?, ?, NULL
        WHERE (SELECT COUNT(*) FROM users WHERE role != 'admin') = ?
          AND (SELECT COUNT(*) FROM orders) = ?
          AND (SELECT COUNT(*) FROM auth_sessions WHERE id != ?) = ?
          AND (${CASH_HISTORY_SNAPSHOT_SQL}) = ?
      `).bind(
        guardHash,
        now,
        now + 60,
        expectedUserCount,
        expectedOrderCount,
        auth.sessionId,
        expectedOtherSessionCount,
        preview.cash_snapshot,
      ),
      c.env.DB.prepare(`
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
        ) THEN 1 ELSE 0 END AS acquired
      `).bind(guardHash),
      c.env.DB.prepare(`
        DELETE FROM orders
        WHERE EXISTS (
          SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
        )
      `).bind(guardHash),
      c.env.DB.prepare(`
        DELETE FROM cash_receipts
        WHERE EXISTS (
          SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
        )
      `).bind(guardHash),
      c.env.DB.prepare(`
        DELETE FROM auth_sessions
        WHERE id != ?
          AND EXISTS (
            SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
          )
      `).bind(auth.sessionId, guardHash),
      c.env.DB.prepare(`
        DELETE FROM users
        WHERE role != 'admin'
          AND EXISTS (
            SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
          )
      `).bind(guardHash),
      c.env.DB.prepare(`
        DELETE FROM oauth_states
        WHERE state_hash != ?
          AND EXISTS (
            SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
          )
      `).bind(guardHash, guardHash),
      c.env.DB.prepare(`
        INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
        SELECT ?, 'EVENT_DATA_RESET', 'event_data', NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM oauth_states WHERE state_hash = ? AND used_at IS NULL
        )
      `).bind(auth.user.id, metadata, guardHash),
      c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(guardHash),
    ]);

    const guardAcquired = Number(
      (results[1].results[0] as { acquired?: unknown } | undefined)?.acquired || 0,
    ) === 1;
    if (!guardAcquired) {
      return fail(c, 409, 'リセット対象が変更されました。内容を再確認してください。', 'RESET_PREVIEW_STALE');
    }

    // D1 commits a successful batch atomically. Per-statement `meta.changes` can
    // differ from the requested row counts when related foreign-key work is
    // involved, so it is not a stable post-commit verification method here.
    // The guard SELECT above is the atomic stale-preview check; once the batch
    // resolves, return its approved counts instead of reporting a false failure
    // after the reset has already completed.

    return c.json({
      success: true,
      data: {
        deleted_user_count: expectedUserCount,
        deleted_order_count: expectedOrderCount,
        deleted_session_count: expectedOtherSessionCount,
      },
    });
  } catch {
    return fail(c, 500, '開催データをリセットできませんでした。');
  }
});

app.get('/api/admin/orders', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT
      o.id,
      u.name AS user_name,
      o.menu_name_snapshot AS item_name,
      o.menu_size_snapshot AS size,
      o.unit_price_snapshot AS price,
      o.quantity,
      o.status,
      CASE WHEN o.order_source = 'admin' THEN 1 ELSE 0 END AS added_by_admin,
      o.created_at,
      u.group_id,
      ${CANCEL_SNAPSHOT_SQL} AS cancel_snapshot
    FROM orders o
    JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC, o.id DESC
  `).all();
  return c.json({ success: true, data: await withCancelTokens(results) });
});

app.post('/api/admin/users/:id/orders', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const userId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const menuItemId = body ? parsePositiveInteger(body.menu_item_id) : null;
  const quantity = body ? parsePositiveInteger(body.quantity, 20) : null;
  const requestId = typeof body?.request_id === 'string' ? body.request_id : '';
  if (!userId || !menuItemId || !quantity || !isClientRequestId(requestId)) {
    return fail(c, 422, '参加者、商品、個数、送信識別子を確認してください。');
  }

  const [target, menu] = await Promise.all([
    c.env.DB.prepare(`
      SELECT id FROM users WHERE id = ? AND is_active = 1 AND role != 'admin'
    `).bind(userId).first<{ id: number }>(),
    c.env.DB.prepare(`
      SELECT id, name, category, size, price, is_admin_only
      FROM menu_items WHERE id = ? AND is_active = 1
    `).bind(menuItemId).first<{
      id: number;
      name: string;
      category: string;
      size: string;
      price: number;
      is_admin_only: number;
    }>(),
  ]);
  if (!target) return fail(c, 404, '参加者が見つかりません。');
  if (!menu) return fail(c, 404, 'この商品は現在注文できません。');

  const now = nowSeconds();
  const status = menu.is_admin_only === 1 || menu.category === ADMIN_ONLY_MENU_CATEGORY ? 'ordered' : 'pending';
  const inserted = await c.env.DB.prepare(`
    INSERT INTO orders
      (user_id, menu_item_id, quantity, status, menu_name_snapshot, menu_size_snapshot,
       unit_price_snapshot, client_request_id, ordered_at, order_source, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?)
    ON CONFLICT(user_id, client_request_id) DO NOTHING
  `).bind(
    userId,
    menu.id,
    quantity,
    status,
    menu.name,
    menu.size,
    menu.price,
    requestId,
    status === 'ordered' ? now : null,
    auth.user.id,
  ).run();

  const order = await c.env.DB.prepare(`
    SELECT id, status FROM orders WHERE user_id = ? AND client_request_id = ?
  `).bind(userId, requestId).first<{ id: number; status: string }>();
  if (!order) return missingOrderResponse(c, userId, requestId);

  if (inserted.meta.changes === 1) {
    await audit(c.env, auth.user.id, 'ADMIN_ORDER_CREATE', 'order', order.id, {
      target_user_id: userId,
      quantity,
      status,
    });
    if (status === 'pending') sendOrderNotifications(c, order.id);
  }
  return c.json({
    success: true,
    data: { order_id: order.id, status: order.status, duplicate: inserted.meta.changes === 0 },
  });
});

app.post('/api/admin/orders/:id/cancel', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  return handleOrderCancellation(c);
});

app.post('/api/admin/users/:id/discord-access/revoke', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const userId = parsePositiveInteger(c.req.param('id'));
  if (!userId) return fail(c, 422, '参加者を確認してください。');

  const target = await c.env.DB.prepare(`
    SELECT id
    FROM users
    WHERE id = ? AND is_active = 1 AND role != 'admin' AND discord_id_hmac IS NOT NULL
  `).bind(userId).first<{ id: number }>();
  if (!target) return fail(c, 404, 'ログイン許可済みの参加者が見つかりません。');

  const now = nowSeconds();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE users
      SET discord_id_hmac = NULL, updated_at = ?
      WHERE id = ? AND is_active = 1 AND role != 'admin' AND discord_id_hmac IS NOT NULL
    `).bind(now, userId),
    c.env.DB.prepare(`
      UPDATE auth_sessions
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role != 'admin')
    `).bind(now, userId, userId),
  ]);
  if (results[0].meta.changes !== 1) {
    return fail(c, 404, 'ログイン許可済みの参加者が見つかりません。');
  }

  await audit(c.env, auth.user.id, 'DISCORD_ALLOWLIST_REVOKE', 'user', userId);
  return c.json({ success: true });
});

app.get('/api/admin/users', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT
      u.id,
      u.name,
      u.group_id,
      u.role,
      u.is_manual_added,
      CASE WHEN u.discord_id_hmac IS NULL THEN 0 ELSE 1 END AS discord_registered,
      COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.unit_price_snapshot * o.quantity ELSE 0 END), 0) AS total_spent
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY u.group_id, u.name
  `).all();
  return c.json({ success: true, data: results });
});

app.post('/api/admin/users/bulk', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  const rows = body?.users;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    return c.json({
      success: false,
      message: '一括追加する参加者は1人から100人で指定してください。',
      code: 'BULK_VALIDATION_FAILED',
      data: { errors: [{ row: 0, fields: ['users'] }] },
    }, 422);
  }

  const candidates: Array<{
    name: string;
    groupId: string;
    role: Exclude<UserRole, 'admin'>;
    discordUserId: string;
  }> = [];
  const errors: Array<{ row: number; fields: string[] }> = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ row: rowNumber, fields: ['row'] });
      return;
    }
    const input = row as JsonObject;
    const name = cleanText(input.name, 80);
    const groupId = cleanText(input.group_id, 80);
    const role = input.role;
    const discordUserId = cleanText(input.discord_user_id, 22);
    const fields: string[] = [];
    if (!name) fields.push('name');
    if (!groupId) fields.push('group_id');
    if (!isAssignableUserRole(role)) fields.push('role');
    if (!isDiscordSnowflake(discordUserId)) fields.push('discord_user_id');
    if (fields.length > 0) {
      errors.push({ row: rowNumber, fields });
      return;
    }
    candidates.push({
      name,
      groupId,
      role: role as Exclude<UserRole, 'admin'>,
      discordUserId,
    });
  });
  if (errors.length > 0) {
    return c.json({
      success: false,
      message: '一括追加する参加者の内容を確認してください。',
      code: 'BULK_VALIDATION_FAILED',
      data: { errors },
    }, 422);
  }

  const hmacKey = cleanText(c.env.DISCORD_ID_HMAC_KEY, 512);
  if (hmacKey.length < 32) return fail(c, 503, 'ログイン照合の設定が完了していません。', 'AUTH_NOT_CONFIGURED');
  const discordIdHmacs = await deriveDiscordIdHmacBatch(
    hmacKey,
    candidates.map((candidate) => candidate.discordUserId),
  );
  if (discordIdHmacs.length !== candidates.length) {
    return fail(c, 500, '参加者のログイン照合値を作成できませんでした。');
  }
  const users: BulkUser[] = candidates.map((candidate, index) => ({
    name: candidate.name,
    groupId: candidate.groupId,
    role: candidate.role,
    discordIdHmac: discordIdHmacs[index],
  }));

  const firstRowByHmac = new Map<string, number>();
  const duplicateRequestRows = new Set<number>();
  users.forEach((user, index) => {
    const rowNumber = index + 1;
    const firstRow = firstRowByHmac.get(user.discordIdHmac);
    if (firstRow) {
      duplicateRequestRows.add(firstRow);
      duplicateRequestRows.add(rowNumber);
    } else {
      firstRowByHmac.set(user.discordIdHmac, rowNumber);
    }
  });
  if (duplicateRequestRows.size > 0) {
    return c.json({
      success: false,
      message: '同じDiscordアカウントが一括追加の中に重複しています。',
      code: 'BULK_DUPLICATE_IN_REQUEST',
      data: { rows: [...duplicateRequestRows].sort((left, right) => left - right) },
    }, 409);
  }

  const placeholders = users.map(() => '?').join(',');
  let existingHmacs: Set<string>;
  try {
    const existing = await c.env.DB.prepare(`
      SELECT discord_id_hmac
      FROM users
      WHERE discord_id_hmac IN (${placeholders})
    `).bind(...users.map((user) => user.discordIdHmac)).all<{ discord_id_hmac: string }>();
    existingHmacs = new Set(existing.results.map((row) => row.discord_id_hmac));
  } catch {
    return fail(c, 500, '参加者の重複を確認できませんでした。');
  }
  const duplicateExistingRows = users
    .map((user, index) => existingHmacs.has(user.discordIdHmac) ? index + 1 : null)
    .filter((row): row is number => row !== null);
  if (duplicateExistingRows.length > 0) {
    return c.json({
      success: false,
      message: 'すでに別の参加者へ登録されているDiscordアカウントがあります。',
      code: 'BULK_DUPLICATE_EXISTING',
      data: { rows: duplicateExistingRows },
    }, 409);
  }

  const roleCounts = users.reduce((counts, user) => {
    counts[user.role] += 1;
    return counts;
  }, { member: 0, manager: 0, chief: 0 });
  const metadata = JSON.stringify({
    created_count: users.length,
    role_counts: roleCounts,
    group_count: new Set(users.map((user) => user.groupId)).size,
  });
  const chunks: BulkUser[][] = [];
  for (let index = 0; index < users.length; index += 25) {
    chunks.push(users.slice(index, index + 25));
  }
  const insertStatements = chunks.map((chunk) => c.env.DB.prepare(`
    INSERT INTO users (name, group_id, role, discord_id_hmac, is_manual_added)
    VALUES ${chunk.map(() => '(?, ?, ?, ?, 1)').join(', ')}
  `).bind(...chunk.flatMap((user) => [user.name, user.groupId, user.role, user.discordIdHmac])));
  try {
    const results = await c.env.DB.batch([
      ...insertStatements,
      c.env.DB.prepare(`
        INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
        VALUES (?, 'USER_BULK_CREATE', 'user_batch', NULL, ?)
      `).bind(auth.user.id, metadata),
    ]);
    const insertedCount = results
      .slice(0, insertStatements.length)
      .reduce((total, result) => total + result.meta.changes, 0);
    if (insertedCount !== users.length || results.at(-1)?.meta.changes !== 1) {
      return fail(c, 500, '参加者の一括追加を完了できませんでした。');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({
        success: false,
        message: 'すでに登録されているDiscordアカウントがあります。',
        code: 'BULK_DUPLICATE_EXISTING',
        data: { rows: [] },
      }, 409);
    }
    return fail(c, 500, '参加者の一括追加を完了できませんでした。');
  }

  return c.json({ success: true, data: { created_count: users.length } });
});

app.post('/api/admin/users', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  const name = cleanText(body?.name, 80);
  const groupId = cleanText(body?.group_id, 80);
  const role = body?.role;
  const discordUserId = cleanText(body?.discord_user_id, 22);
  const hmacKey = cleanText(c.env.DISCORD_ID_HMAC_KEY, 512);
  if (!name || !groupId || !isAssignableUserRole(role) || !isDiscordSnowflake(discordUserId)) {
    return fail(c, 422, '参加者名、グループ、権限、DiscordのユーザーIDを確認してください。');
  }
  if (hmacKey.length < 32) return fail(c, 503, 'ログイン照合の設定が完了していません。', 'AUTH_NOT_CONFIGURED');

  const discordIdHmac = await deriveDiscordIdHmac(hmacKey, discordUserId);
  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO users (name, group_id, role, discord_id_hmac, is_manual_added)
      VALUES (?, ?, ?, ?, 1)
    `).bind(name, groupId, role, discordIdHmac).run();
    const userId = Number(result.meta.last_row_id);
    await audit(c.env, auth.user.id, 'USER_CREATE', 'user', userId, { role, group_id: groupId });
    return c.json({ success: true, data: { user_id: userId, discord_registered: true } });
  } catch {
    return fail(c, 409, 'このDiscordアカウントは、すでに別の参加者へ登録されています。');
  }
});

app.delete('/api/admin/users/:id', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const recentLoginError = requireRecentAdminLogin(c);
  if (recentLoginError) return recentLoginError;
  const auth = c.get('auth');
  const userId = parsePositiveInteger(c.req.param('id'));
  if (!userId) return fail(c, 422, '参加者を確認してください。');

  let target: { id: number; role: UserRole } | null;
  try {
    target = await c.env.DB.prepare(`
      SELECT id, role FROM users WHERE id = ? AND is_active = 1
    `).bind(userId).first<{ id: number; role: UserRole }>();
  } catch {
    return fail(c, 500, '参加者の状態を確認できませんでした。');
  }
  if (!target) return fail(c, 404, '参加者が見つかりません。');
  if (target.role === 'admin') {
    return fail(c, 409, '管理者アカウントは利用停止できません。', 'ADMIN_DEACTIVATION_FORBIDDEN');
  }

  const now = nowSeconds();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`
        UPDATE users
        SET is_active = 0, discord_id_hmac = NULL, updated_at = ?
        WHERE id = ? AND is_active = 1 AND role != 'admin'
      `).bind(now, userId),
      c.env.DB.prepare(`
        INSERT INTO audit_logs (actor_user_id, action_type, target_type, target_id, metadata_json)
        SELECT ?, 'USER_DEACTIVATE', 'user', ?, '{"orders_preserved":true}'
        WHERE changes() = 1
      `).bind(auth.user.id, userId),
      c.env.DB.prepare(`
        UPDATE auth_sessions
        SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `).bind(now, userId),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      return fail(c, 409, '参加者の状態が更新されました。画面を再読み込みしてください。');
    }
  } catch {
    return fail(c, 500, '参加者を利用停止できませんでした。');
  }
  return c.json({ success: true, data: { deactivated: true } });
});

app.patch('/api/admin/users/:id', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const userId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const groupId = cleanText(body?.group_id, 80);
  const role = body?.role;
  const hasDiscordUserId = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'discord_user_id'));
  const discordUserId = hasDiscordUserId ? cleanText(body?.discord_user_id, 22) : '';
  if (!userId || !groupId || !isUserRole(role)) return fail(c, 422, '参加者、グループ、権限を確認してください。');

  const target = await c.env.DB.prepare(`
    SELECT id, role FROM users WHERE id = ? AND is_active = 1
  `).bind(userId).first<{ id: number; role: UserRole }>();
  if (!target) return fail(c, 404, '参加者が見つかりません。');
  if (target.role === 'admin') {
    if (role !== 'admin' || hasDiscordUserId) {
      return fail(c, 409, '管理者アカウントの権限とDiscord登録はこの画面から変更できません。');
    }
  } else if (!isAssignableUserRole(role)) {
    return fail(c, 409, '管理者アカウントを追加または変更することはできません。');
  }

  let discordIdHmac = '';
  if (hasDiscordUserId) {
    if (!isDiscordSnowflake(discordUserId)) return fail(c, 422, 'DiscordのユーザーIDを確認してください。');
    const hmacKey = cleanText(c.env.DISCORD_ID_HMAC_KEY, 512);
    if (hmacKey.length < 32) return fail(c, 503, 'ログイン照合の設定が完了していません。', 'AUTH_NOT_CONFIGURED');
    discordIdHmac = await deriveDiscordIdHmac(hmacKey, discordUserId);
  }

  try {
    const now = nowSeconds();
    if (discordIdHmac) {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(`
          UPDATE users
          SET group_id = ?, role = ?, discord_id_hmac = ?, updated_at = ?
          WHERE id = ? AND is_active = 1 AND role != 'admin'
        `).bind(groupId, role, discordIdHmac, now, userId),
        c.env.DB.prepare(`
          UPDATE auth_sessions
          SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL
        `).bind(now, userId),
      ]);
      if (results[0].meta.changes !== 1) return fail(c, 409, '参加者の状態が更新されました。画面を再読み込みしてください。');
    } else {
      const result = await c.env.DB.prepare(`
        UPDATE users SET group_id = ?, role = ?, updated_at = ? WHERE id = ? AND is_active = 1
      `).bind(groupId, role, now, userId).run();
      if (result.meta.changes !== 1) return fail(c, 409, '参加者の状態が更新されました。画面を再読み込みしてください。');
    }
  } catch {
    return fail(c, 409, 'このDiscordアカウントは、すでに別の参加者へ登録されています。');
  }
  await audit(c.env, auth.user.id, 'USER_UPDATE', 'user', userId, { role, group_id: groupId });
  if (discordIdHmac) await audit(c.env, auth.user.id, 'DISCORD_ALLOWLIST_UPDATE', 'user', userId);
  return c.json({ success: true });
});

app.get('/api/admin/menu', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT id, category, name, size, price, is_active, is_admin_only
    FROM menu_items ORDER BY category, name, price, id
  `).all();
  return c.json({ success: true, data: results });
});

app.post('/api/admin/menu', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  const name = cleanText(body?.name, 100);
  const category = cleanText(body?.category, 60);
  const size = cleanText(body?.size, 60);
  const price = typeof body?.price === 'number' ? body.price : Number(body?.price);
  if (!name || !category || !size || !Number.isInteger(price) || price < 0 || price > 100000) {
    return fail(c, 422, 'メニュー名、カテゴリ、サイズ、価格を確認してください。');
  }

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO menu_items (name, category, price, size, is_active, is_admin_only)
      VALUES (?, ?, ?, ?, 1, ?)
    `).bind(name, category, price, size, category === ADMIN_ONLY_MENU_CATEGORY ? 1 : 0).run();
    const menuId = Number(result.meta.last_row_id);
    await audit(c.env, auth.user.id, 'MENU_CREATE', 'menu_item', menuId, { price });
    return c.json({ success: true, data: { menu_id: menuId } });
  } catch {
    return fail(c, 409, '同じメニューがすでに登録されています。');
  }
});

function csvCell(value: unknown) {
  const text = String(value ?? '').replace(/"/g, '""');
  return `"${text}"`;
}

app.get('/api/admin/logs/export', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT id, actor_user_id, action_type, target_type, target_id, metadata_json, created_at
    FROM audit_logs ORDER BY created_at DESC, id DESC
  `).all<Record<string, unknown>>();
  const header = ['ID', '実行者ID', '操作', '対象種別', '対象ID', '補足', '日時'].map(csvCell).join(',');
  const rows = results.map((row) => [
    row.id,
    row.actor_user_id,
    row.action_type,
    row.target_type,
    row.target_id,
    row.metadata_json,
    row.created_at,
  ].map(csvCell).join(','));
  return new Response(`\uFEFF${[header, ...rows].join('\n')}`, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit_log.csv"',
    },
  });
});

app.get('/api/admin/logs', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT id, actor_user_id, action_type, target_type, target_id, metadata_json, created_at
    FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 200
  `).all();
  return c.json({ success: true, data: results });
});

app.notFound((c) => fail(c, 404, '指定された機能は見つかりません。'));

app.onError((_error, c) => fail(c, 500, 'サーバーで処理を完了できませんでした。'));

export { app };
export default app;
