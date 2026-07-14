const encoder = new TextEncoder();
const VERIFICATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const USER_ROLES = Object.freeze(['member', 'manager', 'admin']);
export const ORDER_STATUSES = Object.freeze(['pending', 'ordered', 'cancelled']);

function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function createVerificationCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => VERIFICATION_CODE_ALPHABET[byte & 31]).join('');
}

export function normalizeVerificationCode(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Z2-9]{8}$/.test(normalized) ? normalized : '';
}

export async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function timingSafeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function deriveCsrfToken(sessionToken) {
  return sha256Base64Url(`csrf:${sessionToken}`);
}

export function parseAllowedOrigins(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => {
      try {
        const url = new URL(origin);
        return url.origin === origin && (url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost');
      } catch {
        return false;
      }
    }))];
}

export function isAllowedOrigin(origin, configuredOrigins) {
  return typeof origin === 'string' && parseAllowedOrigins(configuredOrigins).includes(origin);
}

export function isUnsafeMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase());
}

export function isUserRole(value) {
  return USER_ROLES.includes(value);
}

export function isOrderStatus(value) {
  return ORDER_STATUSES.includes(value);
}

export function hasRole(userRole, allowedRoles) {
  return isUserRole(userRole) && allowedRoles.includes(userRole);
}

export function isDiscordSnowflake(value) {
  return typeof value === 'string' && /^\d{16,22}$/.test(value);
}

export function parsePositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

export function cleanText(value, maximumLength) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= maximumLength ? cleaned : '';
}

export function isClientRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
}
