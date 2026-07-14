import { Hono, type Context, type Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  cleanText,
  createVerificationCode,
  deriveCsrfToken,
  hasRole,
  isAllowedOrigin,
  isClientRequestId,
  isDiscordSnowflake,
  isOrderStatus,
  isUnsafeMethod,
  isUserRole,
  normalizeVerificationCode,
  parsePositiveInteger,
  randomToken,
  sha256Base64Url,
  timingSafeEqual,
} from './security.js';
import type { AppEnv, AuthContext, Bindings, SessionUser, UserRole } from './types.js';

const SESSION_IDLE_SECONDS = 5 * 60 * 60;
const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const LINK_REQUEST_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TOUCH_SECONDS = 5 * 60;
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const DISCORD_ME_URL = 'https://discord.com/api/v10/users/@me';
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/discord/start',
  '/api/auth/discord/callback',
]);

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503;
type JsonObject = Record<string, unknown>;

type SessionRow = SessionUser & {
  session_id: number;
  last_seen_at: number;
};

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
};

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string;
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
  if (!clientId || !clientSecret || !redirectUri || !frontendUrl) return null;

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

  return { clientId, clientSecret, redirectUri, frontendUrl };
}

function redirectToFrontend(c: Context<AppEnv>, result: string, verificationCode = '') {
  const config = getOAuthConfig(c.env);
  if (!config) return fail(c, 503, 'ログイン設定が完了していません。', 'AUTH_NOT_CONFIGURED');
  const target = new URL(config.frontendUrl);
  target.searchParams.set('auth', result);
  if (verificationCode) target.hash = new URLSearchParams({ code: verificationCode }).toString();
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
    LIMIT 1
  `).bind(tokenHash, now, now).first<SessionRow>();

  if (!row || !isUserRole(row.role)) {
    clearSessionCookie(c);
    return null;
  }

  if (now - row.last_seen_at >= SESSION_TOUCH_SECONDS) {
    await c.env.DB.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?, idle_expires_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(now, now + SESSION_IDLE_SECONDS, row.session_id).run();
  }

  return {
    sessionId: row.session_id,
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

async function findUserByDiscordId(env: Bindings, discordUserId: string) {
  return env.DB.prepare(`
    SELECT id, name, group_id, role
    FROM users
    WHERE discord_user_id = ? AND is_active = 1
    LIMIT 1
  `).bind(discordUserId).first<SessionUser>();
}

async function tryBootstrapAdmin(env: Bindings, discordUserId: string) {
  if (!env.BOOTSTRAP_ADMIN_DISCORD_USER_ID
    || !timingSafeEqual(env.BOOTSTRAP_ADMIN_DISCORD_USER_ID, discordUserId)) return null;

  const result = await env.DB.prepare(`
    SELECT id, name, group_id, role
    FROM users
    WHERE role = 'admin' AND is_active = 1 AND discord_user_id IS NULL
    ORDER BY id
    LIMIT 2
  `).all<SessionUser>();

  if (result.results.length !== 1) return null;
  const user = result.results[0];
  const update = await env.DB.prepare(`
    UPDATE users
    SET discord_user_id = ?, updated_at = ?
    WHERE id = ? AND discord_user_id IS NULL
  `).bind(discordUserId, nowSeconds(), user.id).run();
  if (update.meta.changes !== 1) return null;

  await audit(env, user.id, 'AUTH_BOOTSTRAP_LINK', 'user', user.id);
  return user;
}

async function savePendingDiscordIdentity(env: Bindings, discordUser: DiscordUser) {
  const now = nowSeconds();
  const username = cleanText(discordUser.username, 80) || 'Discord利用者';
  const displayName = cleanText(discordUser.global_name || '', 80) || username;
  const verificationCode = createVerificationCode();
  const verificationCodeHash = await sha256Base64Url(`discord-link:${verificationCode}`);
  await env.DB.prepare(`
    INSERT INTO discord_link_requests
      (discord_user_id, username_snapshot, display_name_snapshot, requested_at, expires_at, status, verification_code_hash)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET
      username_snapshot = excluded.username_snapshot,
      display_name_snapshot = excluded.display_name_snapshot,
      requested_at = excluded.requested_at,
      expires_at = excluded.expires_at,
      status = 'pending',
      decided_at = NULL,
      approved_by = NULL,
      linked_user_id = NULL,
      verification_code_hash = excluded.verification_code_hash
  `).bind(
    discordUser.id,
    username,
    displayName,
    now,
    now + LINK_REQUEST_SECONDS,
    verificationCodeHash,
  ).run();
  return verificationCode;
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

    const discordUser = await userResponse.json() as DiscordUser;
    if (!isDiscordSnowflake(discordUser.id) || !cleanText(discordUser.username, 80)) {
      return redirectToFrontend(c, 'failed');
    }

    let user = await findUserByDiscordId(c.env, discordUser.id);
    if (!user) user = await tryBootstrapAdmin(c.env, discordUser.id);
    if (!user) {
      const verificationCode = await savePendingDiscordIdentity(c.env, discordUser);
      return redirectToFrontend(c, 'pending', verificationCode);
    }

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
  const { results } = await c.env.DB.prepare(`
    SELECT id, category, name, size, price
    FROM menu_items
    WHERE is_active = 1
    ORDER BY category, name, price, id
  `).all();
  return c.json({ success: true, data: results });
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
    SELECT id, name, category, size, price
    FROM menu_items WHERE id = ? AND is_active = 1
  `).bind(menuItemId).first<{ id: number; name: string; category: string; size: string; price: number }>();
  if (!menu) return fail(c, 404, 'この商品は現在注文できません。');

  const inserted = await c.env.DB.prepare(`
    INSERT INTO orders
      (user_id, menu_item_id, quantity, status, menu_name_snapshot, menu_size_snapshot,
       unit_price_snapshot, client_request_id)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(user_id, client_request_id) DO NOTHING
  `).bind(
    auth.user.id,
    menu.id,
    quantity,
    menu.name,
    menu.size,
    menu.price,
    requestId,
  ).run();

  const order = await c.env.DB.prepare(`
    SELECT id FROM orders WHERE user_id = ? AND client_request_id = ?
  `).bind(auth.user.id, requestId).first<{ id: number }>();
  if (!order) return fail(c, 500, '注文を保存できませんでした。');

  if (inserted.meta.changes === 1) {
    await audit(c.env, auth.user.id, 'ORDER_CREATE', 'order', order.id, { quantity });
  }
  return c.json({ success: true, data: { order_id: order.id, duplicate: inserted.meta.changes === 0 } });
});

app.get('/api/orders/mine', async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(`
    SELECT
      id,
      menu_name_snapshot AS item_name,
      menu_size_snapshot AS size,
      unit_price_snapshot AS price,
      quantity,
      status,
      created_at
    FROM orders
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).bind(auth.user.id).all();
  return c.json({ success: true, data: results });
});

app.get('/api/manager/orders', async (c) => {
  const roleError = requireRole(c, ['manager', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const requestedStatus = c.req.query('status') || 'pending';
  if (!isOrderStatus(requestedStatus)) return fail(c, 422, '注文状態が正しくありません。');

  const isAdmin = auth.user.role === 'admin';
  const sql = `
    SELECT
      o.id,
      o.quantity,
      o.status,
      u.name AS user_name,
      o.menu_name_snapshot AS menu_name,
      o.menu_size_snapshot AS size
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.status = ? ${isAdmin ? '' : 'AND u.group_id = ?'}
    ORDER BY o.created_at, o.id
  `;
  const statement = c.env.DB.prepare(sql);
  const { results } = isAdmin
    ? await statement.bind(requestedStatus).all()
    : await statement.bind(requestedStatus, auth.user.group_id).all();
  return c.json({ success: true, data: results });
});

app.patch('/api/manager/orders/:id/quantity', async (c) => {
  const roleError = requireRole(c, ['manager', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const orderId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const quantity = body ? parsePositiveInteger(body.quantity, 20) : null;
  if (!orderId || !quantity) return fail(c, 422, '注文番号と個数を確認してください。');

  const isAdmin = auth.user.role === 'admin';
  const sql = `
    UPDATE orders
    SET quantity = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
    ${isAdmin ? '' : 'AND EXISTS (SELECT 1 FROM users u WHERE u.id = orders.user_id AND u.group_id = ?)'}
  `;
  const statement = c.env.DB.prepare(sql);
  const result = isAdmin
    ? await statement.bind(quantity, nowSeconds(), orderId).run()
    : await statement.bind(quantity, nowSeconds(), orderId, auth.user.group_id).run();
  if (result.meta.changes !== 1) return fail(c, 404, '変更できる注文が見つかりません。');

  await audit(c.env, auth.user.id, 'ORDER_QUANTITY_UPDATE', 'order', orderId, { quantity });
  return c.json({ success: true });
});

app.patch('/api/manager/orders/status', async (c) => {
  const roleError = requireRole(c, ['manager', 'admin']);
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
  const isAdmin = auth.user.role === 'admin';
  const sql = `
    UPDATE orders
    SET status = 'ordered', manager_memo = ?, ordered_at = ?, updated_at = ?
    WHERE id IN (${placeholders}) AND status = 'pending'
    ${isAdmin ? '' : 'AND EXISTS (SELECT 1 FROM users u WHERE u.id = orders.user_id AND u.group_id = ?)'}
  `;
  const now = nowSeconds();
  const bindings: unknown[] = [memo, now, now, ...ids];
  if (!isAdmin) bindings.push(auth.user.group_id);
  const result = await c.env.DB.prepare(sql).bind(...bindings).run();
  if (result.meta.changes === 0) return fail(c, 404, '変更できる注文が見つかりません。');

  await audit(c.env, auth.user.id, 'ORDER_STATUS_UPDATE', 'order_batch', null, {
    requested_count: ids.length,
    updated_count: result.meta.changes,
  });
  return c.json({ success: true, data: { updated_count: result.meta.changes } });
});

app.get('/api/orders/summary', async (c) => {
  const roleError = requireRole(c, ['manager', 'admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const isAdmin = auth.user.role === 'admin';
  const sql = `
    SELECT u.name, SUM(o.unit_price_snapshot * o.quantity) AS total_price
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.status != 'cancelled' ${isAdmin ? '' : 'AND u.group_id = ?'}
    GROUP BY u.id, u.name
    ORDER BY u.name
  `;
  const statement = c.env.DB.prepare(sql);
  const { results } = isAdmin
    ? await statement.all()
    : await statement.bind(auth.user.group_id).all();
  return c.json({ success: true, data: results });
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
      o.created_at,
      u.group_id
    FROM orders o
    JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC, o.id DESC
  `).all();
  return c.json({ success: true, data: results });
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
      CASE WHEN u.discord_user_id IS NULL THEN 0 ELSE 1 END AS discord_linked,
      COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.unit_price_snapshot * o.quantity ELSE 0 END), 0) AS total_spent
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY u.group_id, u.name
  `).all();
  return c.json({ success: true, data: results });
});

app.post('/api/admin/users', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const body = await readJsonObject(c);
  const name = cleanText(body?.name, 80);
  const groupId = cleanText(body?.group_id, 80);
  const role = body?.role;
  if (!name || !groupId || !isUserRole(role)) return fail(c, 422, '参加者名、グループ、権限を確認してください。');

  const result = await c.env.DB.prepare(`
    INSERT INTO users (name, group_id, role, is_manual_added)
    VALUES (?, ?, ?, 1)
  `).bind(name, groupId, role).run();
  const userId = Number(result.meta.last_row_id);
  await audit(c.env, auth.user.id, 'USER_CREATE', 'user', userId, { role, group_id: groupId });
  return c.json({ success: true, data: { user_id: userId } });
});

app.patch('/api/admin/users/:id', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const userId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const groupId = cleanText(body?.group_id, 80);
  const role = body?.role;
  if (!userId || !groupId || !isUserRole(role)) return fail(c, 422, '参加者、グループ、権限を確認してください。');

  const target = await c.env.DB.prepare(`
    SELECT id, role FROM users WHERE id = ? AND is_active = 1
  `).bind(userId).first<{ id: number; role: UserRole }>();
  if (!target) return fail(c, 404, '参加者が見つかりません。');
  if (target.role === 'admin' && role !== 'admin') {
    const adminCount = await c.env.DB.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1
    `).first<{ count: number }>();
    if (Number(adminCount?.count || 0) <= 1) return fail(c, 409, '最後の管理者の権限は変更できません。');
  }

  try {
    await c.env.DB.prepare(`
      UPDATE users SET group_id = ?, role = ?, updated_at = ? WHERE id = ?
    `).bind(groupId, role, nowSeconds(), userId).run();
  } catch {
    return fail(c, 409, '最後の管理者の権限は変更できません。');
  }
  await audit(c.env, auth.user.id, 'USER_UPDATE', 'user', userId, { role, group_id: groupId });
  return c.json({ success: true });
});

app.get('/api/admin/discord-links', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT id, username_snapshot, display_name_snapshot, requested_at
    FROM discord_link_requests
    WHERE status = 'pending' AND expires_at > ?
    ORDER BY requested_at
    LIMIT 100
  `).bind(nowSeconds()).all();
  return c.json({ success: true, data: results });
});

app.post('/api/admin/discord-links/:id/approve', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const auth = c.get('auth');
  const requestId = parsePositiveInteger(c.req.param('id'));
  const body = await readJsonObject(c);
  const userId = body ? parsePositiveInteger(body.user_id) : null;
  const verificationCode = body ? normalizeVerificationCode(body.verification_code) : '';
  if (!requestId || !userId || !verificationCode) return fail(c, 422, '参加者と、本人の画面に表示された確認コードを確認してください。');

  const request = await c.env.DB.prepare(`
    SELECT id, discord_user_id, verification_code_hash
    FROM discord_link_requests
    WHERE id = ? AND status = 'pending' AND expires_at > ?
  `).bind(requestId, nowSeconds()).first<{ id: number; discord_user_id: string; verification_code_hash: string | null }>();
  if (!request) return fail(c, 404, '有効な連携申請が見つかりません。');

  const submittedCodeHash = await sha256Base64Url(`discord-link:${verificationCode}`);
  if (!request.verification_code_hash || !timingSafeEqual(submittedCodeHash, request.verification_code_hash)) {
    return fail(c, 422, '確認コードが一致しません。本人の画面を直接確認してください。');
  }

  const user = await c.env.DB.prepare(`
    SELECT id FROM users WHERE id = ? AND is_active = 1 AND discord_user_id IS NULL
  `).bind(userId).first<{ id: number }>();
  if (!user) return fail(c, 409, 'この参加者は連携できない状態です。');

  try {
    const now = nowSeconds();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`
        UPDATE users SET discord_user_id = ?, updated_at = ?
        WHERE id = ? AND discord_user_id IS NULL
      `).bind(request.discord_user_id, now, userId),
      c.env.DB.prepare(`
        UPDATE discord_link_requests
        SET status = 'approved', linked_user_id = ?, approved_by = ?, decided_at = ?, verification_code_hash = NULL
        WHERE id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND discord_user_id = ?
          )
      `).bind(userId, auth.user.id, now, requestId, userId, request.discord_user_id),
    ]);

    if (results.some((result) => result.meta.changes !== 1)) {
      return fail(c, 409, '連携状態が更新されました。画面を再読み込みしてください。');
    }
  } catch {
    return fail(c, 409, 'このDiscordアカウントはすでに連携されています。');
  }

  await audit(c.env, auth.user.id, 'DISCORD_LINK_APPROVE', 'user', userId);
  return c.json({ success: true });
});

app.get('/api/admin/menu', async (c) => {
  const roleError = requireRole(c, ['admin']);
  if (roleError) return roleError;
  const { results } = await c.env.DB.prepare(`
    SELECT id, category, name, size, price, is_active
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
      INSERT INTO menu_items (name, category, price, size, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).bind(name, category, price, size).run();
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
