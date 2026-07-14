const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const RESPONSE_FORMAT_ERROR = 'サーバーから正しい応答を受け取れませんでした。時間をおいて、もう一度お試しください。';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let csrfToken = '';

export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function resolveApiUrl(path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function getDiscordLoginUrl() {
  return resolveApiUrl('/api/auth/discord/start');
}

export function clearSessionToken() {
  csrfToken = '';
}

function notifySessionExpired() {
  try {
    window.dispatchEvent(new CustomEvent('reitaisai:auth-expired'));
  } catch {
    // The request helper also runs in non-browser test environments.
  }
}

export async function loadSession() {
  const payload = await apiRequest('/api/auth/me', { notifyAuthExpired: false });
  if (!payload?.user || typeof payload.csrf_token !== 'string' || !payload.csrf_token) {
    clearSessionToken();
    throw new ApiError(RESPONSE_FORMAT_ERROR, 500, payload);
  }
  csrfToken = payload.csrf_token;
  return payload.user;
}

export async function apiRequest(path, options = {}) {
  const { body, headers, notifyAuthExpired = true, ...requestOptions } = options;
  const requestHeaders = new Headers(headers || {});
  const method = String(requestOptions.method || 'GET').toUpperCase();
  let requestBody = body;

  if (body !== undefined && body !== null && !(body instanceof FormData) && !(body instanceof Blob)) {
    requestHeaders.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(body);
  }

  if (UNSAFE_METHODS.has(method) && csrfToken) {
    requestHeaders.set('X-CSRF-Token', csrfToken);
  }

  let response;
  try {
    response = await fetch(resolveApiUrl(path), {
      cache: 'no-store',
      credentials: 'include',
      ...requestOptions,
      method,
      headers: requestHeaders,
      body: requestBody,
    });
  } catch {
    throw new ApiError('通信できませんでした。電波状況を確認して、もう一度お試しください。', 0);
  }

  let payload = null;
  if (response.status !== 204) {
    const text = await response.text();
    if (!text.trim()) {
      throw new ApiError(RESPONSE_FORMAT_ERROR, response.status);
    }

    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(RESPONSE_FORMAT_ERROR, response.status);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ApiError(RESPONSE_FORMAT_ERROR, response.status);
    }
  }

  if (!response.ok || payload?.success === false) {
    if (response.status === 401 && notifyAuthExpired) {
      clearSessionToken();
      notifySessionExpired();
    }
    const fallback = response.ok
      ? '処理を完了できませんでした。入力内容を確認してください。'
      : `処理を完了できませんでした（${response.status}）。`;
    throw new ApiError(fallback, response.status, payload);
  }

  return payload ?? { success: true };
}

export function apiFetcher(path) {
  return apiRequest(path);
}

export function getErrorMessage(error, fallback = '処理を完了できませんでした。') {
  if (error instanceof ApiError) {
    const serverMessage = typeof error.payload?.message === 'string' ? error.payload.message : '';
    if (error.status === 400 || error.status === 422) return serverMessage || '入力内容を確認してください。すでに登録済みの内容がないかも確認してください。';
    if (error.status === 401) return 'ログイン情報を確認できませんでした。もう一度ログインしてください。';
    if (error.status === 403) return 'この操作を行う権限がありません。';
    if (error.status === 404) return '対象が見つかりませんでした。画面を更新してください。';
    if (error.status === 409) return serverMessage || 'ほかの操作と重なりました。最新の状態を読み込んで確認してください。';
    return serverMessage || error.message || fallback;
  }
  return fallback;
}
