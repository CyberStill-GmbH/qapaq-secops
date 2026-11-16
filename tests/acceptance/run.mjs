#!/usr/bin/env node
/**
 * Suite de aceptación QAPAQ SOC (edge, login, dashboard, Wazuh, motor, SOAR e integraciones).
 *
 * Solo lectura salvo: inicio/cierre de sesión con las cuentas demo (lo que aplica la regla de
 * sesión única y expulsa otras sesiones de esa misma cuenta) y, si Qapaqzito está habilitado, un
 * «ping» al asistente. Crear incidentes requiere `--mutate` (no se hace por defecto).
 *
 *   node tests/acceptance/run.mjs --creds <creds.json> --out <dir> [--target aws|local|all]
 *        [--no-browser] [--mutate] [--no-extra|--always-extra]
 *        [--repeat N --interval-min 20 --stop-when-green]
 *
 * creds.json (fuera del repo; nunca se imprime):
 *   { "aws":   { "admin": {"username": "...", "password": "..."} },
 *     "local": { "admin": {...}, "analyst": {...} } }
 * También vale QAPAQ_QA_<TARGET>_<ROLE>_USER / _PASS en el entorno (p. ej. QAPAQ_QA_AWS_ADMIN_USER).
 *
 * Salida: tabla PASS/FAIL/SKIP por check y destino, `<out>/results-<stamp>.json`,
 * `<out>/latest.json` y capturas `<out>/shots/<stamp>/*.png`. Código de salida 0 solo si no
 * hay FAIL fuera del grupo «integrations».
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';

import {
  cookieInfo,
  headerValues,
  probePort,
  request,
  sha256,
  snippet,
  tlsCheck,
} from './lib/http.mjs';
import { launchBrowser } from './lib/browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const assetsDir = join(repoRoot, 'wazuh', 'dashboard', 'assets');

// ───────────────────────────── argumentos ─────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const outDir = resolve(option('out', join(repoRoot, 'output', 'acceptance')));
const targetFilter = option('target', 'all');
const useBrowser = !flag('no-browser');
const mutate = flag('mutate');
const repeat = Number(option('repeat', '1'));
const intervalMin = Number(option('interval-min', '20'));
const stopWhenGreen = flag('stop-when-green');
/**
 * El login demo admite 10 intentos por IP cada 15 min (compartidos con quien use esa IP). Los
 * checks que gastan intentos extra (sesión única, credenciales falsas) corren solo en la
 * primera iteración; `--always-extra` los fuerza siempre.
 */
let extraLoginChecks = true;
const alwaysExtra = flag('always-extra');

const TARGETS = [
  {
    name: 'aws',
    base: process.env.QAPAQ_QA_AWS_BASE ?? 'https://dev.security.qapaq.pe',
    insecure: false,
    publicInternet: true,
  },
  {
    name: 'local',
    base: process.env.QAPAQ_QA_LOCAL_BASE ?? 'https://localhost',
    insecure: true,
    publicInternet: false,
  },
].filter((target) => targetFilter === 'all' || targetFilter === target.name);

function loadCreds() {
  const file = option('creds', process.env.QAPAQ_QA_CREDS);
  const creds = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const target of ['aws', 'local']) {
    for (const role of ['admin', 'analyst']) {
      const prefix = `QAPAQ_QA_${target.toUpperCase()}_${role.toUpperCase()}`;
      if (process.env[`${prefix}_USER`] && process.env[`${prefix}_PASS`]) {
        creds[target] ??= {};
        creds[target][role] = {
          username: process.env[`${prefix}_USER`],
          password: process.env[`${prefix}_PASS`],
        };
      }
    }
  }
  return creds;
}

// ───────────────────────────── registro ─────────────────────────────
/** Dueño sugerido por grupo; un check puede sobrescribirlo. */
const OWNERS = {
  edge: 'deploy',
  login: 'plugin',
  dashboard: 'deploy',
  wazuh: 'deploy',
  spoofing: 'deploy',
  engine: 'backend',
  soar: 'deploy',
  integrations: 'integrations',
};

class Recorder {
  constructor(target) {
    this.target = target;
    this.results = [];
  }
  add(group, id, status, detail, evidence = {}, owner) {
    const ownerName = owner ?? OWNERS[group];
    const resolved =
      ownerName === 'deploy' ? `${this.target.name} deploy` : (ownerName ?? 'unknown');
    this.results.push({
      target: this.target.name,
      group,
      id,
      status,
      detail,
      owner: status === 'FAIL' ? resolved : undefined,
      evidence,
    });
  }
  pass(group, id, detail, evidence) {
    this.add(group, id, 'PASS', detail, evidence);
  }
  fail(group, id, detail, evidence, owner) {
    this.add(group, id, 'FAIL', detail, evidence, owner);
  }
  skip(group, id, detail, evidence) {
    this.add(group, id, 'SKIP', detail, evidence);
  }
  check(group, id, condition, okDetail, failDetail, evidence, owner) {
    if (condition) this.pass(group, id, okDetail, evidence);
    else this.fail(group, id, failDetail, evidence, owner);
  }
}

const ev = (response, extra = {}) => ({
  url: response.url,
  status: response.status,
  ...(response.headers?.location ? { location: response.headers.location } : {}),
  ...(response.error ? { error: response.error } : {}),
  ...extra,
});

const jsonOf = (response) => {
  try {
    return JSON.parse(response.text);
  } catch {
    return null;
  }
};

// ───────────────────────────── sesión ─────────────────────────────
function makeClient(target) {
  const call = (path, options = {}) =>
    request(path.startsWith('http') ? path : `${target.base}${path}`, {
      insecure: target.insecure,
      ...options,
    });
  return call;
}

async function readLoginForm(call) {
  const page = await call('/qapaq/login', { headers: { accept: 'text/html' } });
  const formTag = page.text.match(/<form[^>]*id="qapaq-password-form"[^>]*>/)?.[0];
  if (!formTag) return { page, form: null };
  const formBody = page.text.slice(page.text.indexOf(formTag)).split('</form>')[0];
  const action = formTag.match(/action="([^"]*)"/)?.[1] ?? '';
  const method = (formTag.match(/method="([^"]*)"/)?.[1] ?? 'get').toUpperCase();
  const inputs = [...formBody.matchAll(/<input[^>]*>/g)].map((match) => ({
    name: match[0].match(/name="([^"]*)"/)?.[1],
    type: match[0].match(/type="([^"]*)"/)?.[1] ?? 'text',
    value: match[0].match(/value="([^"]*)"/)?.[1] ?? '',
  }));
  return { page, form: { action, method, inputs } };
}

/** Envía el formulario tal como lo renderiza la página, con las cabeceras de un navegador. */
async function passwordLogin(target, call, creds, overrides = {}) {
  const { form } = await readLoginForm(call);
  if (!form) return { error: 'password form not found on /qapaq/login' };
  const params = new URLSearchParams();
  for (const input of form.inputs) {
    if (!input.name) continue;
    if (input.name === 'username') params.set('username', creds.username);
    else if (input.type === 'password') params.set(input.name, creds.password);
    else params.set(input.name, input.value.replace(/&amp;/g, '&'));
  }
  const response = await call(form.action, {
    method: form.method,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      origin: target.base,
      referer: `${target.base}/qapaq/login`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      ...overrides,
    },
    body: params.toString(),
  });
  const cookie = cookieInfo(response, 'qapaq_session');
  return {
    response,
    form,
    cookie,
    location: response.headers.location ?? '',
    sessionCookie: cookie?.value ? `qapaq_session=${cookie.value}` : null,
  };
}

async function sessionInfo(call, cookie) {
  const response = await call('/api/auth/session', {
    headers: { cookie, accept: 'application/json' },
  });
  return { response, body: jsonOf(response) };
}

async function logout(target, call, cookie) {
  const info = await sessionInfo(call, cookie);
  const csrf = info.body?.csrfToken;
  return call('/api/auth/logout', {
    method: 'POST',
    headers: {
      cookie,
      accept: 'application/json',
      origin: target.base,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': csrf ?? '',
    },
  });
}

// ───────────────────────────── grupos de checks ─────────────────────────────
async function edgeChecks(target, call, rec) {
  const root = await call('/', { headers: { accept: 'text/html' } });
  rec.check(
    'edge',
    'root-redirects-to-login',
    root.status === 302 && /\/qapaq\/login/.test(root.headers.location ?? ''),
    `302 → ${root.headers.location}`,
    `expected 302 → /qapaq/login, got ${root.status} ${root.headers.location ?? ''}`,
    ev(root, { location: root.headers.location }),
  );

  const appLogin = await call('/app/login', { headers: { accept: 'text/html' } });
  rec.check(
    'edge',
    'app-login-redirects',
    [301, 302, 303, 307, 308].includes(appLogin.status) &&
      /\/qapaq\/login/.test(appLogin.headers.location ?? ''),
    `${appLogin.status} → ${appLogin.headers.location}`,
    `expected redirect to /qapaq/login, got ${appLogin.status} ${appLogin.headers.location ?? ''}`,
    ev(appLogin, { location: appLogin.headers.location, snippet: snippet(appLogin.text) }),
  );

  const osdLogin = await call('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'osd-xsrf': 'true',
      accept: 'application/json',
    },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const osdCookie = cookieInfo(osdLogin, 'security_authentication');
  rec.check(
    'edge',
    'wazuh-security-login-blocked',
    osdLogin.status >= 300 && !osdCookie,
    `POST /auth/login → ${osdLogin.status}, no security_authentication cookie`,
    `POST /auth/login → ${osdLogin.status}${osdCookie ? ' and set security_authentication' : ''}`,
    ev(osdLogin, { snippet: snippet(osdLogin.text) }),
  );

  for (const path of ['/api/alerts', '/app/qapaq-alerts', '/api/status']) {
    const response = await call(path, { headers: { accept: 'application/json' } });
    rec.check(
      'edge',
      `json-no-session-401 ${path}`,
      response.status === 401,
      '401',
      `expected 401, got ${response.status}`,
      ev(response, { snippet: snippet(response.text, 120) }),
    );
  }

  const login = await call('/qapaq/login', { headers: { accept: 'text/html' } });
  const hsts = headerValues(login, 'strict-transport-security');
  rec.check(
    'edge',
    'hsts',
    hsts.some((value) => /max-age=\d{7,}/.test(value)),
    hsts.join(' | '),
    `missing/weak HSTS: ${hsts.join(' | ') || 'none'}`,
    ev(login, { hsts }),
  );
  const nosniff = headerValues(login, 'x-content-type-options');
  rec.check(
    'edge',
    'nosniff',
    nosniff.length > 0 && nosniff.every((value) => value.toLowerCase() === 'nosniff'),
    nosniff.join(' | '),
    `x-content-type-options: ${nosniff.join(' | ') || 'none'}`,
    ev(login, { nosniff }),
  );

  // Varias cabeceras Referrer-Policy se combinan y gana el ÚLTIMO token válido; una <meta>
  // posterior en el documento la sustituye. Se comprueba la política efectiva del login.
  const referrer = headerValues(login, 'referrer-policy');
  const lastHeaderPolicy = referrer
    .join(',')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .pop();
  const metaReferrer = login.text.match(/<meta name="referrer" content="([^"]*)"/)?.[1];
  const effective = metaReferrer ?? lastHeaderPolicy;
  rec.check(
    'edge',
    'login-referrer-same-origin',
    effective === 'same-origin',
    `effective=${effective} (headers: ${referrer.join(' | ')}; meta: ${metaReferrer ?? 'none'})` +
      (lastHeaderPolicy !== 'same-origin'
        ? ' [WARN: header alone resolves to ' + lastHeaderPolicy + ']'
        : ''),
    `effective=${effective} (headers: ${referrer.join(' | ')}; meta: ${metaReferrer ?? 'none'})`,
    ev(login, { referrer, metaReferrer }),
    'plugin',
  );

  const csp = headerValues(login, 'content-security-policy').join(' ; ');
  const xfo = headerValues(login, 'x-frame-options');
  rec.check(
    'edge',
    'login-frame-ancestors',
    /frame-ancestors\s+'none'/.test(csp) || /frame-ancestors\s+'self'/.test(csp),
    `CSP frame-ancestors ok; XFO=${xfo.join('|') || 'none'}`,
    `no frame-ancestors in CSP: ${snippet(csp, 160)}`,
    ev(login, { csp: snippet(csp, 300), xfo }),
    'plugin',
  );

  if (target.publicInternet) {
    const host = new URL(target.base).hostname;
    const tlsInfo = await tlsCheck(host);
    rec.check(
      'edge',
      'tls-valid',
      tlsInfo.ok && tlsInfo.daysLeft > 14,
      `${tlsInfo.protocol} CN=${tlsInfo.subject} issuer=${tlsInfo.issuer} expires in ${tlsInfo.daysLeft}d`,
      `TLS invalid: ${tlsInfo.error ?? `expires in ${tlsInfo.daysLeft}d`}`,
      tlsInfo,
    );
  } else {
    rec.skip('edge', 'tls-valid', 'self-signed certificate by design on local');
  }

  const plain = await request(`${target.base.replace('https:', 'http:')}/qapaq/login`, {
    timeoutMs: 6000,
  });
  if (!plain.ok && !target.publicInternet) {
    rec.skip('edge', 'http-to-https', `no :80 listener on local edge (${plain.error})`);
  } else {
    rec.check(
      'edge',
      'http-to-https',
      [301, 302, 307, 308].includes(plain.status) &&
        (plain.headers.location ?? '').startsWith('https://'),
      `${plain.status} → ${plain.headers.location}`,
      `expected redirect to https, got ${plain.status} ${plain.error ?? plain.headers.location ?? ''}`,
      ev(plain, { location: plain.headers.location }),
    );
  }
}

async function loginChecks(target, call, rec, creds) {
  const { page, form } = await readLoginForm(call);
  rec.check(
    'login',
    'login-page-renders',
    page.status === 200 && Boolean(form),
    `200, form ${form?.method} ${form?.action} fields=[${form?.inputs.map((i) => i.name).join(',')}]`,
    `GET /qapaq/login → ${page.status}, password form ${form ? 'found' : 'missing'}`,
    ev(page, { snippet: page.status === 200 ? undefined : snippet(page.text) }),
  );

  const heroPath =
    page.text.match(/url\((\/[^)]*hero[^)]*)\)/)?.[1] ?? '/ui/qapaq/qapaq_login_hero.webp';
  const hero = await call(heroPath);
  const heroLocal = join(assetsDir, 'images', 'qapaq_login_hero.webp');
  const heroRepo = existsSync(heroLocal) ? sha256(readFileSync(heroLocal)) : null;
  const heroServed = hero.status === 200 ? sha256(hero.buffer) : null;
  rec.check(
    'login',
    'hero-image-served',
    hero.status === 200 && /image\//.test(hero.headers['content-type'] ?? ''),
    `${heroPath} 200 ${hero.headers['content-type']} ${hero.buffer.length}B`,
    `${heroPath} → ${hero.status} ${hero.headers['content-type'] ?? ''}`,
    ev(hero),
  );
  if (heroServed && heroRepo) {
    rec.check(
      'login',
      'hero-image-matches-repo',
      heroServed === heroRepo,
      'sha256 matches wazuh/dashboard/assets/images/qapaq_login_hero.webp',
      'served hero differs from repo asset (stale build?)',
      { served: heroServed, repo: heroRepo },
    );
  }

  rec.check(
    'login',
    'cookie-notice-present',
    /id="qapaq-cookie-notice"/.test(page.text) && /Cookies necesarias/.test(page.text),
    'qapaq-cookie-notice markup present',
    'cookie notice markup missing in /qapaq/login',
    ev(page),
    'plugin',
  );

  // Login CSRF: un POST marcado cross-site no debe abrir sesión.
  if (creds.admin) {
    const cross = await passwordLogin(target, call, creds.admin, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    rec.check(
      'login',
      'cross-site-login-rejected',
      !cross.sessionCookie && /REQUEST_NOT_VERIFIED/.test(cross.location),
      `${cross.response?.status} → ${cross.location}`,
      `cross-site POST got ${cross.response?.status} ${cross.location} cookie=${Boolean(cross.sessionCookie)}`,
      cross.response ? ev(cross.response, { location: cross.location }) : { error: cross.error },
      'backend',
    );
  }
  if (!extraLoginChecks) {
    rec.skip(
      'login',
      'bad-credentials-rejected',
      'verified in first iteration (saves login budget)',
    );
  }
  const bogus = !extraLoginChecks
    ? null
    : await passwordLogin(target, call, {
        username: 'qa-nonexistent@qapaq.invalid',
        password: 'not-a-real-password',
      });
  if (bogus)
    rec.check(
      'login',
      'bad-credentials-rejected',
      !bogus.sessionCookie && /authError=/.test(bogus.location),
      `${bogus.response?.status} → ${bogus.location}`,
      `unknown user got ${bogus.response?.status} ${bogus.location} cookie=${Boolean(bogus.sessionCookie)}`,
      bogus.response ? ev(bogus.response, { location: bogus.location }) : { error: bogus.error },
      'backend',
    );

  const sessions = {};
  for (const role of ['admin', 'analyst']) {
    const account = creds[role];
    if (!account) {
      rec.skip('login', `password-login ${role}`, `no ${role} credentials for ${target.name}`);
      continue;
    }
    // Regla de sesión única: la segunda sesión de la misma cuenta revoca la primera.
    const first = await passwordLogin(target, call, account);
    const loggedIn =
      first.response?.status === 303 && first.sessionCookie && !/authError=/.test(first.location);
    rec.check(
      'login',
      `password-login ${role}`,
      loggedIn,
      `303 → ${first.location}`,
      `login failed: ${first.response?.status ?? first.error} → ${first.location}`,
      first.response
        ? ev(first.response, { location: first.location, setCookie: first.cookie?.redacted })
        : { error: first.error },
      'backend',
    );
    if (!loggedIn) continue;

    const flags = first.cookie.flags;
    const sameSite = String(flags.samesite ?? '').toLowerCase();
    rec.check(
      'login',
      `session-cookie-flags ${role}`,
      flags.httponly === true && flags.secure === true && ['strict', 'lax'].includes(sameSite),
      first.cookie.redacted,
      `cookie flags incomplete (need HttpOnly; Secure; SameSite): ${first.cookie.redacted}`,
      { setCookie: first.cookie.redacted },
      'deploy',
    );

    if (!extraLoginChecks) {
      rec.skip(
        'login',
        `single-session ${role}`,
        'verified in first iteration (saves login budget)',
      );
      sessions[role] = {
        cookie: first.sessionCookie,
        info: (await sessionInfo(call, first.sessionCookie)).body,
        account,
      };
      continue;
    }
    const second = await passwordLogin(target, call, account);
    if (second.sessionCookie) {
      const old = await sessionInfo(call, first.sessionCookie);
      const fresh = await sessionInfo(call, second.sessionCookie);
      rec.check(
        'login',
        `single-session ${role}`,
        old.response.status === 401 && fresh.response.status === 200,
        `old session → ${old.response.status}, new → ${fresh.response.status}; location ${second.location}`,
        `old session → ${old.response.status} (expected 401), new → ${fresh.response.status}`,
        { old: ev(old.response), fresh: ev(fresh.response), location: second.location },
        'backend',
      );
      sessions[role] = { cookie: second.sessionCookie, info: fresh.body, account };
    } else {
      rec.fail('login', `single-session ${role}`, 'second login failed', {
        location: second.location,
      });
      sessions[role] = { cookie: first.sessionCookie, account };
    }
  }
  return sessions;
}

async function dashboardChecks(target, call, rec, role, session) {
  const cookie = session.cookie;
  const app = await call('/app/qapaq-alerts', { headers: { cookie, accept: 'text/html' } });
  rec.check(
    'dashboard',
    `app-qapaq-alerts ${role}`,
    app.status === 200 && /<title>QAPAQ/.test(app.text),
    `200 ${snippet(app.text.match(/<title>[^<]*<\/title>/)?.[0], 60)}`,
    `/app/qapaq-alerts → ${app.status} ${app.headers.location ?? ''}`,
    ev(app, { snippet: app.status === 200 ? undefined : snippet(app.text) }),
  );

  const overlay = app.text.match(/\.qapaqSplashOverlay\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const background = overlay.match(/background(?:-color)?:\s*([^;]+);/)?.[1]?.trim();
  rec.check(
    'dashboard',
    `splash-overlay ${role}`,
    Boolean(overlay) && /^(#fff|#ffffff|white|rgb\(255,\s*255,\s*255\))$/i.test(background ?? ''),
    `.qapaqSplashOverlay background ${background}`,
    overlay ? `overlay background is ${background}` : '.qapaqSplashOverlay not in /app HTML',
    ev(app),
    'plugin',
  );

  const status = await call('/api/status', { headers: { cookie, accept: 'application/json' } });
  const overall = jsonOf(status)?.status?.overall?.state;
  rec.check(
    'dashboard',
    `osd-api-status ${role}`,
    status.status === 200 && overall === 'green',
    `200 overall=${overall}`,
    `/api/status → ${status.status} overall=${overall ?? 'n/a'}`,
    ev(status, { snippet: snippet(status.text, 160) }),
  );

  const authinfo = await call('/api/v1/auth/authinfo', {
    headers: { cookie, accept: 'application/json' },
  });
  const who = jsonOf(authinfo);
  const expectedUser = session.info?.email ?? session.account.username;
  rec.check(
    'dashboard',
    `proxy-auth-identity ${role}`,
    authinfo.status === 200 && who?.user_name?.toLowerCase() === expectedUser.toLowerCase(),
    `user_name=${who?.user_name} backend_roles=${who?.backend_roles?.join(',')} roles=${who?.roles?.join(',')}`,
    `authinfo → ${authinfo.status} user_name=${who?.user_name ?? 'n/a'} (expected ${expectedUser})`,
    ev(authinfo),
  );
  return who;
}

const FAVICON_PAIRS = [
  ['/ui/favicons/favicon.ico', 'favicons/favicon.ico'],
  ['/ui/favicons/favicon-32x32.png', 'favicons/favicon-32x32.png'],
  ['/ui/favicons/favicon-16x16.png', 'favicons/favicon-16x16.png'],
  ['/ui/favicons/apple-touch-icon.png', 'favicons/apple-touch-icon.png'],
  ['/ui/logos/wazuh_mark.svg', 'svg/qapaq_mark_on_dark.svg'],
  ['/ui/logos/wazuh_mark_on_light.svg', 'svg/qapaq_mark_on_light.svg'],
  ['/ui/qapaq/qapaq-qapaqzito.webp', 'images/qapaq-qapaqzito.webp'],
  ['/ui/qapaq/qapaq-mark-gradient.png', 'images/qapaq-mark-gradient-256.png'],
];

async function assetChecks(target, call, rec, cookie) {
  for (const [path, asset] of FAVICON_PAIRS) {
    const response = await call(path, { headers: cookie ? { cookie } : {} });
    const local = join(assetsDir, asset);
    if (!existsSync(local)) {
      rec.skip('dashboard', `asset ${path}`, `repo asset ${asset} missing`);
      continue;
    }
    const want = sha256(readFileSync(local));
    const got = response.status === 200 ? sha256(response.buffer) : null;
    rec.check(
      'dashboard',
      `asset ${path}`,
      got === want,
      `sha256 matches ${asset}`,
      got
        ? `sha256 differs from ${asset} (old/unbranded asset served)`
        : `${path} → ${response.status}`,
      ev(response, { served: got, repo: want }),
      'plugin',
    );
  }
}

async function wazuhChecks(target, call, rec, role, cookie) {
  const headers = { cookie, accept: 'application/json', 'osd-xsrf': 'true' };
  const patterns = await call(
    '/api/saved_objects/_find?type=index-pattern&per_page=100&fields=title',
    {
      headers,
    },
  );
  const titles = (jsonOf(patterns)?.saved_objects ?? []).map((object) => object.attributes?.title);
  const required = ['wazuh-alerts-*', 'wazuh-monitoring-*', 'wazuh-statistics-*'];
  const missing = required.filter((title) => !titles.includes(title));
  rec.check(
    'wazuh',
    `index-patterns ${role}`,
    patterns.status === 200 && missing.length === 0,
    `found ${titles.join(', ')}`,
    `status ${patterns.status}; missing ${missing.join(', ') || 'n/a'}`,
    ev(patterns, { titles, snippet: patterns.status === 200 ? undefined : snippet(patterns.text) }),
  );

  const hosts = await call('/hosts/apis', { headers });
  const apis = jsonOf(hosts);
  const api = Array.isArray(apis) ? apis[0] : null;
  rec.check(
    'wazuh',
    `api-hosts-configured ${role}`,
    hosts.status === 200 && Boolean(api?.id),
    `${apis?.length} host(s); first ${api?.url}:${api?.port} id=${api?.id}`,
    `/hosts/apis → ${hosts.status} ${snippet(hosts.text, 120)}`,
    ev(hosts),
  );
  if (!api?.id) {
    rec.skip('wazuh', `check-stored-api ${role}`, 'no API host configured');
    rec.skip('wazuh', `manager-api-request ${role}`, 'no API host configured');
    return;
  }

  const json = { ...headers, 'content-type': 'application/json' };
  const stored = await call('/api/check-stored-api', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ id: api.id }),
  });
  const storedBody = jsonOf(stored);
  rec.check(
    'wazuh',
    `check-stored-api ${role}`,
    stored.status === 200 && storedBody?.statusCode === 200,
    `200 manager=${storedBody?.data?.cluster_info?.manager}`,
    `/api/check-stored-api → ${stored.status} ${snippet(stored.text, 160)}`,
    ev(stored, { snippet: snippet(stored.text, 160) }),
  );

  // El app de Wazuh pide un token del manager (cookie wz-token) y luego proxifica /api/request.
  const wzLogin = await call('/api/login', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ idHost: api.id, force: true }),
  });
  const wzToken = cookieInfo(wzLogin, 'wz-token');
  if (!wzToken?.value) {
    rec.fail(
      'wazuh',
      `manager-api-request ${role}`,
      `/api/login → ${wzLogin.status}, no wz-token`,
      ev(wzLogin, {
        snippet: snippet(wzLogin.text.replace(/"token":"[^"]*"/, '"token":"<redacted>"'), 160),
      }),
    );
    return;
  }
  const info = await call('/api/request', {
    method: 'POST',
    headers: { ...json, cookie: `${cookie}; wz-token=${wzToken.value}; wz-api=${api.id}` },
    body: JSON.stringify({ method: 'GET', path: '/manager/info', body: {}, id: api.id }),
  });
  const version = jsonOf(info)?.data?.affected_items?.[0]?.version;
  rec.check(
    'wazuh',
    `manager-api-request ${role}`,
    info.status === 200 && Boolean(version),
    `GET /manager/info → ${version}`,
    `/api/request /manager/info → ${info.status} ${snippet(info.text, 160)}`,
    ev(info, { snippet: snippet(info.text, 160) }),
  );

  const agents = await call('/api/request', {
    method: 'POST',
    headers: { ...json, cookie: `${cookie}; wz-token=${wzToken.value}; wz-api=${api.id}` },
    body: JSON.stringify({
      method: 'GET',
      path: '/agents/summary/status',
      body: {},
      id: api.id,
    }),
  });
  const summary = jsonOf(agents)?.data?.connection;
  rec.check(
    'wazuh',
    `agents-connected ${role}`,
    agents.status === 200 && (summary?.active ?? 0) >= 1,
    `agents active=${summary?.active} total=${summary?.total}`,
    `agents summary → ${agents.status} active=${summary?.active ?? 'n/a'} total=${summary?.total ?? 'n/a'}`,
    ev(agents, { snippet: snippet(agents.text, 160) }),
  );
}

async function spoofingChecks(target, call, rec, adminSession) {
  const spoof = { 'x-proxy-user': 'qa-attacker', 'x-proxy-roles': 'all_access,admin' };
  for (const path of ['/api/status', '/api/v1/auth/authinfo', '/app/qapaq-alerts']) {
    const response = await call(path, { headers: { ...spoof, accept: 'application/json' } });
    rec.check(
      'spoofing',
      `no-session-spoof-rejected ${path}`,
      response.status === 401,
      '401',
      `spoofed proxy headers without session → ${response.status}`,
      ev(response, { snippet: snippet(response.text, 140) }),
    );
  }
  // /qapaq/ y /ui/ llegan a OSD sin auth_request: deben vaciar las cabeceras de proxy.
  const viaPublic = await call('/qapaq/login', {
    rawPath: '/qapaq/../api/v1/auth/authinfo',
    headers: { ...spoof, accept: 'application/json' },
  });
  rec.check(
    'spoofing',
    'public-route-traversal',
    !/qa-attacker/.test(viaPublic.text),
    `${viaPublic.status} (identity not accepted)`,
    `traversal via /qapaq/ accepted spoofed identity: ${snippet(viaPublic.text, 140)}`,
    ev(viaPublic, { snippet: snippet(viaPublic.text, 140) }),
  );

  if (adminSession) {
    const response = await call('/api/v1/auth/authinfo', {
      headers: { ...spoof, cookie: adminSession.cookie, accept: 'application/json' },
    });
    const who = jsonOf(response);
    rec.check(
      'spoofing',
      'session-spoof-overridden',
      response.status === 200 && who?.user_name && who.user_name !== 'qa-attacker',
      `edge replaced spoofed headers: user_name=${who?.user_name}`,
      `authinfo with spoofed headers → ${response.status} user_name=${who?.user_name}`,
      ev(response),
    );
  } else {
    rec.skip('spoofing', 'session-spoof-overridden', 'no admin session');
  }

  if (!target.publicInternet) {
    rec.skip('spoofing', 'internal-ports-closed', 'local target is not internet-facing');
    return;
  }
  const host = new URL(target.base).hostname;
  const addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
  const ports = [9200, 9300, 55000, 1514, 1515, 5601, 3000];
  const open = [];
  const states = {};
  for (const address of addresses) {
    for (const port of ports) {
      const result = await probePort(address, port, 3000);
      states[`${address}:${port}`] = result.state;
      if (result.state === 'open') open.push(`${address}:${port}`);
    }
  }
  rec.check(
    'spoofing',
    'internal-ports-closed',
    open.length === 0,
    `no internal port reachable on ${addresses.join(', ')}`,
    `reachable from internet: ${open.join(', ')}`,
    { states },
  );
}

async function engineChecks(target, call, rec, role, session) {
  const headers = { cookie: session.cookie, accept: 'application/json' };
  const caps = session.info?.capabilities ?? [];
  const health = await call('/api/sources/health', { headers });
  const sources = jsonOf(health)?.sources ?? [];
  const wazuh = sources.find((source) => /wazuh/i.test(source.sourceId));
  if (!caps.includes('sources.health.read')) {
    rec.check(
      'engine',
      `sources-health ${role}`,
      health.status === 404 || health.status === 403,
      `denied as expected (${health.status}; role lacks sources.health.read)`,
      `role lacks sources.health.read but got ${health.status}`,
      ev(health),
    );
  } else
    rec.check(
      'engine',
      `sources-health ${role}`,
      health.status === 200 && wazuh && wazuh.enabled && /^(healthy|ok|up)$/i.test(wazuh.state),
      `${wazuh?.displayName}: ${wazuh?.state} lastEventAt=${wazuh?.lastEventAt}`,
      `status ${health.status}; wazuh source ${wazuh ? `${wazuh.state}/${wazuh.reason} enabled=${wazuh.enabled}` : 'absent'}`,
      ev(health, {
        sources: sources.map((s) => ({ id: s.sourceId, state: s.state, reason: s.reason })),
      }),
    );

  const alerts = await call('/api/alerts?limit=5', { headers });
  const alertBody = jsonOf(alerts);
  const items = alertBody?.items ?? [];
  const fromWazuh = items.filter((item) => /wazuh/i.test(JSON.stringify(item.source ?? item)));
  rec.check(
    'engine',
    `alerts-ingested ${role}`,
    alerts.status === 200 && (alertBody?.totalCount ?? items.length) > 0,
    `totalCount=${alertBody?.totalCount} (wazuh-sourced in page: ${fromWazuh.length})`,
    `/api/alerts → ${alerts.status} totalCount=${alertBody?.totalCount ?? 'n/a'}`,
    ev(alerts, { snippet: snippet(alerts.text, 160) }),
  );

  const incidents = await call('/api/incidents', { headers });
  rec.check(
    'engine',
    `incidents-read ${role}`,
    incidents.status === 200,
    `totalCount=${jsonOf(incidents)?.totalCount}`,
    `/api/incidents → ${incidents.status}`,
    ev(incidents, { snippet: snippet(incidents.text, 160) }),
  );

  if (caps.includes('audit.verify')) {
    const verify = await call('/api/audit/verify', { headers });
    const body = jsonOf(verify);
    rec.check(
      'engine',
      `audit-chain-verify ${role}`,
      verify.status === 200 && body?.ok === true,
      `ok checked=${body?.checked}`,
      `/api/audit/verify → ${verify.status} ${snippet(verify.text, 160)}`,
      ev(verify),
    );
  } else {
    rec.skip('engine', `audit-chain-verify ${role}`, 'role lacks audit.verify');
  }
  if (caps.includes('audit.read')) {
    const from = new Date(Date.now() - 30 * 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const events = await call(
      `/api/audit/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=100`,
      { headers },
    );
    const list = jsonOf(events)?.items ?? jsonOf(events)?.events ?? [];
    const signIn = list.find((item) => /sign|session|login|auth/i.test(item.action ?? ''));
    rec.check(
      'engine',
      `audit-records-sign-in ${role}`,
      events.status === 200 && Boolean(signIn),
      `latest auth audit: ${signIn?.action} at ${signIn?.occurredAt ?? signIn?.at}`,
      `/api/audit/events → ${events.status}; ${list.length} events, no sign-in entry in last 30 min`,
      ev(events, { snippet: snippet(events.text, 200) }),
    );
  }

  if (!mutate) {
    rec.skip('engine', 'incident-create', 'read-only run (pass --mutate to open a QA incident)');
  } else {
    const target0 = items[0];
    if (!target0) {
      rec.skip('engine', 'incident-create', 'no alert to open an incident from');
    } else {
      const csrf = session.info?.csrfToken;
      const created = await call('/api/incidents', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          origin: target.base,
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': csrf ?? '',
        },
        body: JSON.stringify({
          alertId: target0.id,
          title: 'QA acceptance incident (safe to close)',
          severity: 'low',
          summary: 'Created by tests/acceptance/run.mjs --mutate',
          expectedAlertRevision: target0.revision,
        }),
      });
      rec.check(
        'engine',
        'incident-create',
        created.status === 200 || created.status === 201,
        `incident ${jsonOf(created)?.incident?.id}`,
        `POST /api/incidents → ${created.status} ${snippet(created.text, 160)}`,
        ev(created),
      );
    }
  }
}

async function soarChecks(target, call, rec, session) {
  const anonymous = await call('/ankay/', { headers: { accept: 'text/html' } });
  rec.check(
    'soar',
    'respond-requires-session',
    anonymous.status === 302 && /\/qapaq\/login/.test(anonymous.headers.location ?? ''),
    `302 → ${anonymous.headers.location}`,
    `/ankay/ without session → ${anonymous.status} ${anonymous.headers.location ?? ''}`,
    ev(anonymous, { location: anonymous.headers.location }),
  );
  if (!session) {
    rec.skip('soar', 'respond-with-session', 'no session');
    return;
  }
  const respond = await call('/ankay/', {
    headers: { cookie: session.cookie, accept: 'text/html' },
  });
  rec.check(
    'soar',
    'respond-with-session',
    respond.status === 200 && /<html/i.test(respond.text),
    `200 ${snippet(respond.text.match(/<title>[^<]*<\/title>/)?.[0], 60)}`,
    `/ankay/ with session → ${respond.status} ${snippet(respond.text, 140)}`,
    ev(respond, { snippet: snippet(respond.text, 140) }),
  );
  const csp = headerValues(respond, 'content-security-policy').join(' ; ');
  const xfo = headerValues(respond, 'x-frame-options');
  const ancestors = csp.match(/frame-ancestors([^;]*)/)?.[1]?.trim();
  rec.check(
    'soar',
    'respond-framing-same-origin',
    respond.status === 200 &&
      ancestors === "'self'" &&
      xfo.length > 0 &&
      xfo.every((value) => value.toUpperCase() === 'SAMEORIGIN'),
    `frame-ancestors ${ancestors}; XFO ${xfo.join('|')}`,
    `frame-ancestors=${ancestors ?? 'none'} XFO=${xfo.join('|') || 'none'} (status ${respond.status})`,
    { csp: snippet(csp, 300), xfo },
  );
}

const INTEGRATIONS = {
  office365: /office365|m365|microsoft/i,
  bitdefender: /bitdefender|gravityzone/i,
  snyk: /snyk/i,
  cloudflare: /cloudflare/i,
};

async function integrationChecks(target, call, rec, session) {
  if (!session) {
    for (const name of [...Object.keys(INTEGRATIONS), 'mail', 'qapaqzito']) {
      rec.skip('integrations', name, 'no admin session');
    }
    return;
  }
  const headers = { cookie: session.cookie, accept: 'application/json' };
  const health = await call('/api/sources/health', { headers });
  const sources = jsonOf(health)?.sources ?? [];
  for (const [name, pattern] of Object.entries(INTEGRATIONS)) {
    const source = sources.find((s) => pattern.test(`${s.sourceId} ${s.dataset} ${s.displayName}`));
    if (!source) {
      rec.skip('integrations', name, `not registered in /api/sources/health yet`);
      continue;
    }
    rec.check(
      'integrations',
      name,
      source.enabled && /^(healthy|ok|up)$/i.test(source.state),
      `${source.displayName}: ${source.state}`,
      `${source.displayName}: ${source.state}/${source.reason} lastError=${source.lastErrorClass}`,
      { source: { id: source.sourceId, state: source.state, reason: source.reason } },
    );
  }

  const ops = await call('/api/operations/health', { headers });
  const opsText = ops.text;
  const mailKey = opsText.match(/"(mail|email|smtp|ses)[A-Za-z]*"\s*:\s*\{[^}]*\}/i)?.[0];
  if (!mailKey) {
    rec.skip('integrations', 'mail', 'no mail section in /api/operations/health yet');
  } else {
    rec.check(
      'integrations',
      'mail',
      /"status"\s*:\s*"(OK|HEALTHY|UP)"/i.test(mailKey),
      snippet(mailKey, 160),
      `mail status: ${snippet(mailKey, 160)}`,
      ev(ops, { mail: snippet(mailKey, 200) }),
    );
  }

  const config = await call('/api/assistant/config', { headers });
  const configBody = jsonOf(config);
  if (config.status !== 200 || !configBody?.enabled) {
    rec.skip(
      'integrations',
      'qapaqzito',
      `assistant not enabled (config → ${config.status} enabled=${configBody?.enabled})`,
    );
    return;
  }
  const chat = await call('/api/assistant/chat', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      origin: target.base,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': session.info?.csrfToken ?? '',
    },
    body: JSON.stringify({ message: 'QA ping: responde solo OK.' }),
    timeoutMs: 60_000,
  });
  rec.check(
    'integrations',
    'qapaqzito',
    chat.status === 200,
    `chat 200 in ${chat.ms}ms (redactsPersonalData=${configBody.redactsPersonalData})`,
    `/api/assistant/chat → ${chat.status} ${snippet(chat.text, 160)}`,
    ev(chat, { ms: chat.ms }),
  );
}

// ───────────────────────────── navegador ─────────────────────────────
async function browserChecks(target, rec, browser, session, shotsDir) {
  const tag = target.name;
  const page = await browser.newPage();
  try {
    await page.goto(`${target.base}/qapaq/login`, { waitMs: 2500 });
    const notice = await page.evaluate(
      `(() => { const el = document.getElementById('qapaq-cookie-notice');
        if (!el) return null; const r = el.getBoundingClientRect();
        return { hidden: el.hidden, visible: el.classList.contains('is-visible'), h: r.height }; })()`,
    );
    const shot = await page.screenshot(join(shotsDir, `${tag}-login.png`));
    rec.check(
      'login',
      'cookie-notice-visible (browser)',
      notice && !notice.hidden && notice.h > 0,
      `visible (is-visible=${notice?.visible})`,
      `cookie notice not visible: ${JSON.stringify(notice)}`,
      { screenshot: shot },
      'plugin',
    );
    if (!session) return;

    const value = session.cookie.split('=').slice(1).join('=');
    await page.setCookie(target.base, 'qapaq_session', value);
    // Splash: se mira el overlay mientras carga (antes del load) y se captura.
    await page.send('Page.navigate', { url: `${target.base}/app/qapaq-alerts` });
    let splash = null;
    for (let i = 0; i < 40 && !splash; i += 1) {
      await page.sleep(100);
      splash = await page
        .evaluate(
          `(() => { const el = document.querySelector('.qapaqSplashOverlay');
            return el ? getComputedStyle(el).backgroundColor : null; })()`,
        )
        .catch(() => null);
    }
    const splashShot = await page.screenshot(join(shotsDir, `${tag}-splash.png`));
    rec.check(
      'dashboard',
      'splash-overlay-rendered (browser)',
      splash === 'rgb(255, 255, 255)',
      `overlay background ${splash}`,
      `overlay ${splash === null ? 'not rendered within 4s' : `background ${splash}`}`,
      { screenshot: splashShot },
      'plugin',
    );
    await page.sleep(12_000);
    const alertsShot = await page.screenshot(join(shotsDir, `${tag}-qapaq-alerts.png`));
    const finalUrl = await page.evaluate('location.href');
    rec.check(
      'dashboard',
      'qapaq-alerts-renders (browser)',
      new URL(finalUrl).pathname.startsWith('/app/qapaq-alerts'),
      `stayed on ${finalUrl}`,
      `redirected to ${finalUrl}`,
      { screenshot: alertsShot },
    );

    // El app embebido debe quedarse en /app/ankay con un iframe de /ankay/. Si la
    // página de arriba acaba en /ankay/*, el contenido rompió el marco (frame-busting).
    await page.goto(`${target.base}/app/ankay`, { waitMs: 1000 });
    const probe = `(() => { const f = document.querySelector('iframe[src*="ankay"]');
        const nav = [...document.querySelectorAll('a,button,span')].some(e => /Ankay/.test(e.textContent || ''));
        return { iframe: f ? f.getAttribute('src') : null, nav, url: location.href }; })()`;
    let embed = null;
    let firstIframe = null;
    for (let i = 0; i < 24; i += 1) {
      embed = await page.evaluate(probe).catch(() => embed);
      if (embed?.iframe && !firstIframe) firstIframe = embed.iframe;
      await page.sleep(500);
    }
    const respondShot = await page.screenshot(join(shotsDir, `${tag}-ankay.png`));
    const topPath = embed?.url ? new URL(embed.url).pathname : '';
    const bustedOut = topPath.startsWith('/ankay');
    rec.check(
      'soar',
      'respond-embedded-in-dashboard (browser)',
      Boolean(embed?.iframe) && !bustedOut,
      `iframe src=${embed?.iframe}; nav entry=${embed?.nav}; top=${topPath}`,
      bustedOut
        ? `top-level page left the dashboard: ${embed.url} (iframe ${firstIframe ? `appeared (${firstIframe}) then ` : 'never appeared; '}Ankay navigated the top window — frame-busting / own login)`
        : `no Ankay iframe at /app/ankay (nav entry=${embed?.nav}, url=${embed?.url})`,
      { screenshot: respondShot, finalUrl: embed?.url, firstIframe },
      'plugin',
    );
  } catch (error) {
    rec.skip('dashboard', 'browser', `browser error: ${error.message}`);
  } finally {
    page.close();
  }
}

// ───────────────────────────── orquestación ─────────────────────────────
/**
 * Otra persona o agente que entre con la misma cuenta revoca nuestra sesión (sesión única).
 * Se detecta y se vuelve a entrar una sola vez por rol para no confundirlo con un fallo.
 */
async function ensureSession(target, call, rec, sessions, role, stage) {
  const session = sessions[role];
  if (!session) return;
  const check = await sessionInfo(call, session.cookie);
  if (check.response.status === 200) return;
  if (session.relogged) {
    rec.skip('login', `session-stable ${role} @${stage}`, 'session revoked again externally');
    return;
  }
  const again = await passwordLogin(target, call, session.account);
  session.relogged = true;
  if (again.sessionCookie) {
    session.cookie = again.sessionCookie;
    session.info = (await sessionInfo(call, again.sessionCookie)).body;
  }
  // Evidencia: inicios de sesión recientes de la cuenta según la auditoría (sin datos personales).
  let recentSignIns = null;
  if (session.info?.capabilities?.includes('audit.read')) {
    const from = new Date(Date.now() - 15 * 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const audit = await call(
      `/api/audit/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=200`,
      { headers: { cookie: session.cookie, accept: 'application/json' } },
    );
    recentSignIns = (jsonOf(audit)?.items ?? [])
      .filter((item) => /sign_in|session/i.test(item.action ?? ''))
      .map((item) => `${item.occurredAt ?? item.at ?? ''} ${item.action} ${item.outcome ?? ''}`);
  }
  rec.skip(
    'login',
    `session-stable ${role} @${stage}`,
    `session revoked externally (same account signed in elsewhere: single-session rule); re-login ${again.sessionCookie ? 'ok' : `failed ${again.location}`}`,
    { recentSignIns },
  );
}

async function runTarget(target, creds, browser, shotsDir) {
  const rec = new Recorder(target);
  const call = makeClient(target);
  const reach = await call('/qapaq/login', { timeoutMs: 10_000 });
  if (!reach.ok) {
    rec.fail('edge', 'reachable', `edge unreachable: ${reach.error}`, ev(reach));
    return rec.results;
  }
  const guard = async (group, fn) => {
    try {
      await fn();
    } catch (error) {
      rec.fail(
        group,
        'suite-error',
        `check crashed: ${error.message}`,
        { stack: error.stack },
        'qa',
      );
    }
  };
  let sessions = {};
  await guard('edge', () => edgeChecks(target, call, rec));
  await guard('login', async () => {
    sessions = await loginChecks(target, call, rec, creds);
  });
  const whoByRole = {};
  for (const [role, session] of Object.entries(sessions)) {
    await guard('dashboard', async () => {
      whoByRole[role] = await dashboardChecks(target, call, rec, role, session);
    });
    await guard('wazuh', () => wazuhChecks(target, call, rec, role, session.cookie));
    await guard('engine', () => engineChecks(target, call, rec, role, session));
  }
  if (!sessions.admin) {
    for (const group of ['dashboard', 'wazuh', 'engine']) {
      rec.skip(group, 'admin-session', 'admin login failed; dependent checks skipped');
    }
  }
  await ensureSession(target, call, rec, sessions, 'admin', 'assets');
  await guard('dashboard', () => assetChecks(target, call, rec, sessions.admin?.cookie));
  await guard('spoofing', () => spoofingChecks(target, call, rec, sessions.admin));
  await ensureSession(target, call, rec, sessions, 'admin', 'soar');
  await guard('soar', () => soarChecks(target, call, rec, sessions.admin));
  await ensureSession(target, call, rec, sessions, 'admin', 'integrations');
  await guard('integrations', () => integrationChecks(target, call, rec, sessions.admin));
  if (browser) {
    await ensureSession(target, call, rec, sessions, 'admin', 'browser');
    await guard('dashboard', () => browserChecks(target, rec, browser, sessions.admin, shotsDir));
  } else {
    rec.skip('dashboard', 'browser', 'browser checks disabled');
  }

  // Cierre de sesión al final (comprueba logout y deja la cuenta sin sesión abierta del QA).
  for (const [role, session] of Object.entries(sessions)) {
    const out = await logout(target, call, session.cookie);
    const after = await sessionInfo(call, session.cookie);
    const cleared = cookieInfo(out, 'qapaq_session');
    rec.check(
      'login',
      `logout ${role}`,
      out.status === 204 && after.response.status === 401,
      `204, session revoked (cookie cleared: ${cleared?.redacted ?? 'n/a'})`,
      `logout → ${out.status}; session afterwards → ${after.response.status}`,
      ev(out, { after: after.response.status, snippet: snippet(out.text, 140) }),
      'backend',
    );
  }
  return rec.results;
}

function printTable(results) {
  const rows = results.map((r) => [
    r.target,
    r.group,
    r.id,
    r.status,
    r.status === 'FAIL' ? r.owner : '',
    r.detail,
  ]);
  const widths = [6, 12, 44, 5, 14];
  const pad = (value, width) =>
    String(value ?? '')
      .padEnd(width)
      .slice(0, width);
  const lines = [
    ['TARGET', 'GROUP', 'CHECK', 'RES', 'OWNER', 'DETAIL']
      .map((v, i) => pad(v, widths[i] ?? 0))
      .join(' '),
  ];
  for (const row of rows) {
    lines.push(
      row.map((v, i) => (i < widths.length ? pad(v, widths[i]) : snippet(v, 140))).join(' '),
    );
  }
  console.log(lines.join('\n'));
  for (const target of new Set(results.map((r) => r.target))) {
    const mine = results.filter((r) => r.target === target);
    const count = (status) => mine.filter((r) => r.status === status).length;
    console.log(`${target}: PASS ${count('PASS')}  FAIL ${count('FAIL')}  SKIP ${count('SKIP')}`);
  }
}

function coreGreen(results) {
  return !results.some((r) => r.status === 'FAIL' && r.group !== 'integrations');
}

async function runOnce(creds) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shotsDir = join(outDir, 'shots', stamp);
  mkdirSync(shotsDir, { recursive: true });
  let browser = null;
  if (useBrowser) {
    try {
      browser = await launchBrowser();
    } catch (error) {
      console.error(`browser unavailable: ${error.message}`);
    }
  }
  const results = [];
  try {
    for (const target of TARGETS) {
      results.push(...(await runTarget(target, creds[target.name] ?? {}, browser, shotsDir)));
    }
  } finally {
    await browser?.close();
  }
  const report = { startedAt: stamp, targets: TARGETS.map((t) => t.base), results };
  writeFileSync(join(outDir, `results-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(`\n=== QAPAQ acceptance ${stamp} ===`);
  printTable(results);
  console.log(`results: ${join(outDir, `results-${stamp}.json`)}\nscreenshots: ${shotsDir}`);
  return results;
}

const creds = loadCreds();
mkdirSync(outDir, { recursive: true });
let last = [];
for (let iteration = 1; iteration <= repeat; iteration += 1) {
  extraLoginChecks = (iteration === 1 && !flag('no-extra')) || alwaysExtra;
  last = await runOnce(creds);
  if (stopWhenGreen && coreGreen(last)) {
    console.log('All non-integration checks pass on every target; stopping.');
    break;
  }
  if (iteration < repeat) {
    console.log(`next run in ${intervalMin} min (${iteration}/${repeat})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMin * 60_000));
  }
}
process.exitCode = coreGreen(last) ? 0 : 1;
