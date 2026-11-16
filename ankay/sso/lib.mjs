/*
 * Ankay SSO — reglas puras del puente (sin red): confianza en el edge, mapeo de roles,
 * saneo de `next` y cookies. Ver docs/14 §8.1 y docs/10 (B11).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_PATH = '/ankay';
export const LOGOUT_COOKIE = 'ankay_logout';
export const LOGOUT_COOKIE_PATH = '/api/auth/logout';
export const SHUFFLE_COOKIES = ['session_token', '__session'];
export const DEFAULT_NEXT = '/ankay/workflows';
/** Igual que la sesión de Shuffle (8 h); la sesión QAPAQ sigue mandando por el auth_request del edge. */
export const SESSION_MAX_AGE = 8 * 60 * 60;

/**
 * Rol QAPAQ → rol de Shuffle 2.3.0 (admin, user, org-reader). Gana el de mayor privilegio.
 * Deny por defecto: un rol desconocido no da acceso (ADR-009).
 *  - qapaq.platform.admin            → admin
 *  - qapaq.soc.lead / qapaq.soc.analyst (incidents.write) → user
 *  - qapaq.auditor                   → org-reader (Shuffle le niega ejecutar, editar y programar)
 */
const ROLE_ORDER = [
  ['qapaq.platform.admin', 'admin'],
  ['qapaq.soc.lead', 'user'],
  ['qapaq.soc.analyst', 'user'],
  ['qapaq.auditor', 'org-reader'],
];

export function parseRoles(header) {
  if (typeof header !== 'string') return [];
  return header
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

export function mapRole(roles) {
  const set = new Set(roles);
  for (const [qapaqRole, shuffleRole] of ROLE_ORDER) {
    if (set.has(qapaqRole)) return shuffleRole;
  }
  return null;
}

/** Identidad del introspect (correo o subjectId). Se normaliza a minúsculas como Shuffle. */
export function normalizeUser(header) {
  if (typeof header !== 'string') return null;
  const user = header.trim().toLowerCase();
  if (user.length < 3 || user.length > 254) return null;
  if (!/^[a-z0-9][a-z0-9._%+@-]*$/u.test(user)) return null;
  return user;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** El edge es el único que conoce el token (archivo secreto); comparación en tiempo constante. */
export function edgeTokenMatches(presented, expected) {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Solo rutas propias bajo /ankay/ (sin open redirect ni bucles hacia login o sso). */
export function safeNext(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return DEFAULT_NEXT;
  if (!raw.startsWith('/ankay/')) return DEFAULT_NEXT;
  if (raw.includes('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/u.test(raw)) return DEFAULT_NEXT;
  if (/%(2f|5c|00)/iu.test(raw)) return DEFAULT_NEXT;
  if (/^\/ankay\/(login|sso|adminsetup|register)/u.test(raw)) return DEFAULT_NEXT;
  if (raw.split(/[?#]/u)[0].split('/').includes('..')) return DEFAULT_NEXT;
  return raw;
}

function cookie(name, value, path, maxAge) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

export function isSessionToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/** Cookies de sesión de Shuffle acotadas a /ankay y la copia que usa el logout de QAPAQ. */
export function sessionCookies(token) {
  if (!isSessionToken(token)) throw new Error('INVALID_SHUFFLE_SESSION');
  return [
    ...SHUFFLE_COOKIES.map((name) => cookie(name, token, COOKIE_PATH, SESSION_MAX_AGE)),
    cookie(LOGOUT_COOKIE, token, LOGOUT_COOKIE_PATH, SESSION_MAX_AGE),
    // Restos de logins anteriores de Shuffle con Path=/ (legibles en todo el origen).
    ...SHUFFLE_COOKIES.map((name) => cookie(name, '', '/', 0)),
  ];
}

export function clearCookies() {
  return [
    ...SHUFFLE_COOKIES.map((name) => cookie(name, '', COOKIE_PATH, 0)),
    cookie(LOGOUT_COOKIE, '', LOGOUT_COOKIE_PATH, 0),
    ...SHUFFLE_COOKIES.map((name) => cookie(name, '', '/', 0)),
  ];
}

export function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!out.has(name)) out.set(name, part.slice(index + 1).trim());
  }
  return out;
}

/** Contraseña aleatoria que cumple cualquier política de Shuffle y nunca sale del puente. */
export function randomPassword() {
  return `${randomBytes(24).toString('base64url')}Aa9!`;
}
