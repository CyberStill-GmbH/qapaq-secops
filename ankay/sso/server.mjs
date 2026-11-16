#!/usr/bin/env node
/*
 * Ankay SSO — puente entre la sesión QAPAQ y Shuffle v2.3.0 (decisión B11, docs/10).
 *
 * Solo lo alcanza el edge por la red interna de Docker. El edge valida la sesión QAPAQ
 * (auth_request a /api/auth/introspect), pisa x-qapaq-user/x-qapaq-roles con lo que devuelve el
 * introspect y añade x-qapaq-edge-token (secreto compartido). Sin ese token el puente responde 403.
 *
 *   GET  /sso?next=/ankay/…  → asegura el usuario de Shuffle, ajusta su rol, abre sesión y
 *                                     deja la cookie de Shuffle (HttpOnly, Path=/ankay) → 302
 *   POST /logout                    → cierra la sesión de Shuffle de la cookie y borra las cookies
 *   GET  /healthz
 *
 * Ninguna contraseña ni API key de Shuffle llega al navegador: la contraseña de cada usuario es
 * aleatoria, vive solo en memoria del puente y se rota con la API de administración cuando hace falta.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearCookies,
  edgeTokenMatches,
  isSessionToken,
  LOGOUT_COOKIE,
  mapRole,
  normalizeUser,
  parseCookies,
  parseRoles,
  randomPassword,
  safeNext,
  sessionCookies,
} from './lib.mjs';
import { createShuffleClient, ShuffleError } from './shuffle-client.mjs';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title, message) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="background:#080808;color:#f4f4f5;font-family:'Segoe UI',Inter,'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:72px auto;padding:0 16px;line-height:1.6">
<h1 style="font-size:22px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p><a href='/app/qapaq-alerts' target='_top' style="color:#c49a5a;font-weight:700">Volver al SIEM</a></p></body></html>`;
}

function send(res, status, headers, body = '') {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendPage(res, status, title, message) {
  send(res, status, { 'content-type': 'text/html; charset=utf-8' }, page(title, message));
}

function firstForwardedFor(header) {
  if (typeof header !== 'string') return undefined;
  const ip = header.split(',')[0].trim();
  return /^[0-9a-fA-F:.]{2,45}$/u.test(ip) ? ip : undefined;
}

/**
 * `fixed`: cuentas con contraseña conocida que el puente NO rota (el admin inicial de Shuffle, que
 * también es una persona de QAPAQ). Solo entran si su rol QAPAQ se mapea a admin.
 * @param {{ edgeToken: string, shuffle: ReturnType<typeof createShuffleClient>, reserved: Set<string>, fixed?: Map<string, string>, log?: (e: object) => void }} deps
 */
export function createHandler({
  edgeToken,
  shuffle,
  reserved,
  fixed = new Map(),
  log = (entry) => console.log(JSON.stringify(entry)),
}) {
  const passwords = new Map();
  const locks = new Map();

  /** Un usuario a la vez: dos pestañas no rotan la contraseña en paralelo. */
  function withLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined).finally(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    locks.set(key, tail);
    return run;
  }

  async function revoke(username) {
    // Cambiar la contraseña borra la sesión de Shuffle (HandlePasswordChange → Session = "").
    const existing = await shuffle.findUser(username);
    if (!existing) return;
    const password = randomPassword();
    await shuffle.setPassword(username, password);
    passwords.delete(username);
  }

  async function sessionFor(username, role, forwardedFor) {
    if (fixed.has(username)) {
      if (role !== 'admin') throw new ShuffleError('FIXED_ACCOUNT_NEEDS_ADMIN', 403);
      const token = await shuffle.login(username, fixed.get(username), forwardedFor);
      if (!token) throw new ShuffleError('SHUFFLE_LOGIN_REJECTED', 401);
      return token;
    }
    let user = await shuffle.findUser(username);
    if (!user) {
      const password = randomPassword();
      await shuffle.register(username, password);
      passwords.set(username, password);
      user = await shuffle.findUser(username);
      if (!user) throw new ShuffleError('SHUFFLE_USER_NOT_CREATED', 500);
      log({ event: 'respond_sso.user_created', user: username, role });
    }
    if (user.role !== role) {
      await shuffle.setRole(user.id, role);
      log({ event: 'respond_sso.role_set', user: username, from: user.role ?? null, role });
    }
    const known = passwords.get(username);
    if (known) {
      const token = await shuffle.login(username, known, forwardedFor);
      if (token) return token;
    }
    const password = randomPassword();
    await shuffle.setPassword(username, password);
    passwords.set(username, password);
    const token = await shuffle.login(username, password, forwardedFor);
    if (!token) throw new ShuffleError('SHUFFLE_LOGIN_REJECTED', 401);
    return token;
  }

  async function handleSso(req, res, url) {
    const username = normalizeUser(req.headers['x-qapaq-user']);
    const roles = parseRoles(req.headers['x-qapaq-roles']);
    if (!username) {
      sendPage(res, 401, 'Sesión no válida', 'No se pudo identificar tu sesión de QAPAQ SOC. Vuelve a iniciar sesión.');
      return;
    }
    if (reserved.has(username)) {
      log({ event: 'respond_sso.denied', user: username, reason: 'RESERVED_ACCOUNT' });
      sendPage(res, 403, 'Cuenta reservada', 'Esta cuenta es de servicio de Ankay y no entra por el SOC.');
      return;
    }
    const role = mapRole(roles);
    if (!role) {
      if (!fixed.has(username)) await withLock(username, () => revoke(username)).catch(() => undefined);
      log({ event: 'respond_sso.denied', user: username, reason: 'NO_MAPPED_ROLE', roles });
      send(res, 403, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': clearCookies() },
        page('Sin acceso a Ankay', 'Tu rol en QAPAQ SOC no incluye Ankay. Pide acceso a tu Líder SOC.'));
      return;
    }
    const next = safeNext(url.searchParams.get('next'));
    const forwardedFor = firstForwardedFor(req.headers['x-forwarded-for']);
    try {
      const token = await withLock(username, () => sessionFor(username, role, forwardedFor));
      log({ event: 'respond_sso.session', user: username, role });
      send(res, 302, { location: next, 'set-cookie': sessionCookies(token) });
    } catch (error) {
      const code = error instanceof ShuffleError ? error.code : 'RESPOND_SSO_ERROR';
      log({ event: 'respond_sso.error', user: username, code, status: error?.status ?? null });
      if (code === 'FIXED_ACCOUNT_NEEDS_ADMIN') {
        sendPage(res, 403, 'Sin acceso a Ankay', 'Esta cuenta solo entra a Ankay con el rol de administración de plataforma.');
        return;
      }
      if (code === 'SHUFFLE_RATE_LIMITED') {
        send(res, 503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' },
          page('Ankay está ocupado', 'Demasiados inicios de sesión seguidos. Espera unos segundos y vuelve a intentarlo.'));
        return;
      }
      sendPage(res, 502, 'Ankay no está disponible', 'No se pudo abrir tu sesión en Ankay. Inténtalo de nuevo en un momento.');
    }
  }

  async function handleLogout(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    const token = [cookies.get(LOGOUT_COOKIE), cookies.get('session_token'), cookies.get('__session')].find(isSessionToken);
    if (token) {
      const status = await shuffle.logout(token).catch(() => 0);
      log({ event: 'respond_sso.logout', status });
    }
    send(res, 204, { 'set-cookie': clearCookies() });
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://respond-sso.internal');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      send(res, 200, { 'content-type': 'text/plain' }, 'ok');
      return;
    }
    // Confianza: solo el edge conoce el token. Cualquier otro cliente de la red interna (por
    // ejemplo, un worker de Shuffle) no puede inventar x-qapaq-user.
    if (!edgeTokenMatches(req.headers['x-qapaq-edge-token'], edgeToken)) {
      log({ event: 'respond_sso.untrusted_request', path: url.pathname });
      send(res, 403, { 'content-type': 'application/json' }, '{"code":"EDGE_REQUIRED"}');
      return;
    }
    if (url.pathname === '/sso' && req.method === 'GET') return handleSso(req, res, url);
    if (url.pathname === '/logout' && req.method === 'POST') return handleLogout(req, res);
    send(res, 404, { 'content-type': 'application/json' }, '{"code":"NOT_FOUND"}');
  };
}

function readSecret(path, name) {
  let value = '';
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    // se informa abajo
  }
  if (value.length < 32) {
    console.error(JSON.stringify({ event: 'respond_sso.config_error', missing: name }));
    process.exit(1);
  }
  return value;
}

async function main() {
  const baseUrl = process.env.SHUFFLE_URL ?? 'http://shuffle-backend:5001';
  const dir = process.env.RESPOND_SSO_SECRETS ?? '/run/ankay-sso';
  const edgeToken = readSecret(`${dir}/edge-token`, 'edge-token');
  const apiKey = readSecret(`${dir}/shuffle-apikey`, 'shuffle-apikey');
  const shuffle = createShuffleClient({ baseUrl, apiKey });
  const reserved = new Set(
    (process.env.RESPOND_SSO_RESERVED_USERS ?? '')
      .split(',')
      .map((user) => user.trim().toLowerCase())
      .filter(Boolean),
  );
  // La propia cuenta de servicio nunca se entrega a una persona.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const me = await shuffle.whoami();
      if (me?.username) reserved.add(String(me.username).toLowerCase());
      if (me?.admin !== 'true' && me?.admin !== true) {
        console.error(JSON.stringify({ event: 'respond_sso.config_error', reason: 'APIKEY_NOT_ADMIN' }));
        process.exit(1);
      }
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // Admin inicial de Shuffle (SHUFFLE_ADMIN_*): si además es una persona de QAPAQ, entra con su
  // contraseña (que el puente no rota, para no romper el acceso de emergencia ni el bootstrap).
  const fixed = new Map();
  if (process.env.SHUFFLE_ADMIN_USERNAME && process.env.SHUFFLE_ADMIN_PASSWORD) {
    fixed.set(process.env.SHUFFLE_ADMIN_USERNAME.trim().toLowerCase(), process.env.SHUFFLE_ADMIN_PASSWORD);
  }
  const handler = createHandler({ edgeToken, shuffle, reserved, fixed });
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => {
    handler(req, res).catch(() => send(res, 500, { 'content-type': 'application/json' }, '{"code":"INTERNAL"}'));
  }).listen(port, () => console.log(JSON.stringify({ event: 'respond_sso.listening', port, reserved: reserved.size })));
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'respond_sso.fatal', code: error?.code ?? error?.message }));
    process.exit(1);
  });
}
