/*
 * node --test ankay/sso/sso.test.mjs
 * Reglas del puente (rol, confianza en el edge, next, cookies) y el flujo completo contra un
 * Shuffle falso con la forma de la API de v2.3.0.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  clearCookies,
  DEFAULT_NEXT,
  edgeTokenMatches,
  mapRole,
  normalizeUser,
  parseRoles,
  safeNext,
  sessionCookies,
} from './lib.mjs';
import { createHandler } from './server.mjs';
import { createShuffleClient } from './shuffle-client.mjs';

const EDGE = 'e'.repeat(64);
const TOKEN = '11111111-2222-4333-8444-555555555555';

test('mapRole: gana el mayor privilegio y deny por defecto', () => {
  assert.equal(mapRole(['qapaq.platform.admin']), 'admin');
  assert.equal(mapRole(['qapaq.soc.lead']), 'user');
  assert.equal(mapRole(['qapaq.soc.analyst']), 'user');
  assert.equal(mapRole(['qapaq.auditor']), 'org-reader');
  assert.equal(mapRole(['qapaq.auditor', 'qapaq.soc.analyst']), 'user');
  assert.equal(mapRole(['qapaq.soc.analyst', 'qapaq.platform.admin']), 'admin');
  assert.equal(mapRole([]), null);
  assert.equal(mapRole(['qapaq.access.approver']), null);
  assert.equal(mapRole(['QAPAQ.PLATFORM.ADMIN']), null);
  assert.equal(mapRole(['qapaq.platform.admin.fake']), null);
  assert.deepEqual(parseRoles(' qapaq.soc.lead , qapaq.auditor,'), ['qapaq.soc.lead', 'qapaq.auditor']);
  assert.deepEqual(parseRoles(undefined), []);
});

test('edgeTokenMatches: exige el token exacto del edge', () => {
  assert.equal(edgeTokenMatches(EDGE, EDGE), true);
  assert.equal(edgeTokenMatches(undefined, EDGE), false);
  assert.equal(edgeTokenMatches('', EDGE), false);
  assert.equal(edgeTokenMatches(`${EDGE}x`, EDGE), false);
  assert.equal(edgeTokenMatches(EDGE, ''), false, 'sin token configurado no se confía en nadie');
  assert.equal(edgeTokenMatches('short', 'short'), false);
});

test('normalizeUser: correo o subjectId en minúsculas, sin caracteres raros', () => {
  assert.equal(normalizeUser(' Lider@QAPAQ.Pe '), 'lider@qapaq.pe');
  assert.equal(normalizeUser('usr_123'), 'usr_123');
  assert.equal(normalizeUser('a'), null);
  assert.equal(normalizeUser('x@y.z\r\nset-cookie: a'), null);
  assert.equal(normalizeUser('"admin"'), null);
  assert.equal(normalizeUser(undefined), null);
});

test('safeNext: solo rutas propias de /ankay y sin bucles', () => {
  assert.equal(safeNext('/ankay/workflows/abc?x=1'), '/ankay/workflows/abc?x=1');
  for (const bad of [
    undefined,
    '',
    'https://evil.example/',
    '//evil.example',
    '/ankay//evil.example',
    '/ankay/\\evil',
    '/app/qapaq-alerts',
    '/ankay/login',
    '/ankay/login2',
    '/ankay/loginsetup',
    '/ankay/sso?next=x',
    '/ankay/../api/auth/logout',
    '/ankay/%2f%2fevil',
    '/ankay/x\r\nLocation: y',
  ]) {
    assert.equal(safeNext(bad), DEFAULT_NEXT, String(bad));
  }
});

test('cookies: HttpOnly, Secure, SameSite=Strict y acotadas a /ankay', () => {
  const cookies = sessionCookies(TOKEN);
  const session = cookies.filter((c) => c.startsWith('session_token=1') || c.startsWith('__session=1'));
  assert.equal(session.length, 2);
  for (const c of session) {
    assert.match(c, /; Path=\/ankay; /u);
    assert.match(c, /; Secure; HttpOnly; SameSite=Strict$/u);
  }
  assert.ok(cookies.some((c) => c.startsWith(`ankay_logout=${TOKEN}; Path=/api/auth/logout;`)));
  assert.ok(cookies.some((c) => c === 'session_token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'));
  assert.throws(() => sessionCookies('x; Path=/'), /INVALID_SHUFFLE_SESSION/u);
  assert.ok(clearCookies().every((c) => c.includes('Max-Age=0')));
});

/** Shuffle falso: solo la superficie de API que usa el puente. */
function fakeShuffle() {
  const state = { users: new Map(), calls: [], apikey: 'k'.repeat(36), loginIps: [] };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const url = new URL(req.url, 'http://x');
    state.calls.push(`${req.method} ${url.pathname}`);
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const isAdmin = req.headers.authorization === `Bearer ${state.apikey}`;
    if (url.pathname === '/api/v1/login') {
      state.loginIps.push(req.headers['x-forwarded-for']);
      const user = state.users.get(json.username);
      if (!user || user.password !== json.password) return reply(401, { success: false });
      user.session ??= crypto.randomUUID();
      return reply(200, { success: true, cookies: [{ key: 'session_token', value: user.session }] });
    }
    if (url.pathname === '/api/v1/logout') {
      const token = /session_token=([^;]+)/u.exec(req.headers.cookie ?? '')?.[1];
      for (const user of state.users.values()) if (user.session === token) user.session = undefined;
      return reply(200, { success: false, reason: 'Successfully logged out' });
    }
    if (!isAdmin) return reply(401, { success: false });
    if (url.pathname === '/api/v1/getusers') {
      return reply(200, [...state.users.values()].map(({ id, username, role }) => ({ id, username, role })));
    }
    if (url.pathname === '/api/v1/register') {
      state.users.set(json.username, { id: crypto.randomUUID(), username: json.username, role: 'user', password: json.password });
      return reply(200, { success: true });
    }
    if (url.pathname === '/api/v1/users/updateuser') {
      const user = [...state.users.values()].find((u) => u.id === json.user_id);
      user.role = json.role;
      return reply(200, { success: true });
    }
    if (url.pathname === '/api/v1/users/passwordchange') {
      const user = state.users.get(json.username);
      user.password = json.newpassword;
      user.session = undefined;
      return reply(200, { success: true });
    }
    return reply(404, { success: false });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

async function withBridge(run) {
  const { server, state } = await fakeShuffle();
  const shuffle = createShuffleClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: state.apikey });
  const events = [];
  const handler = createHandler({ edgeToken: EDGE, shuffle, reserved: new Set(['admin@qapaq.pe']), log: (e) => events.push(e) });
  const bridge = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const call = (path, headers = {}, method = 'GET') => fetch(`${base}${path}`, { method, headers, redirect: 'manual' });
  try {
    await run({ call, state, events });
  } finally {
    bridge.close();
    server.close();
  }
}

const edgeHeaders = (user, roles) => ({
  'x-qapaq-edge-token': EDGE,
  'x-qapaq-user': user,
  'x-qapaq-roles': roles,
  'x-forwarded-for': '203.0.113.7',
});

test('puente: sin el token del edge no confía en x-qapaq-user', async () => {
  await withBridge(async ({ call, state }) => {
    for (const headers of [
      { 'x-qapaq-user': 'lider@qapaq.pe', 'x-qapaq-roles': 'qapaq.platform.admin' },
      { 'x-qapaq-edge-token': 'nope', 'x-qapaq-user': 'lider@qapaq.pe', 'x-qapaq-roles': 'qapaq.platform.admin' },
    ]) {
      const res = await call('/sso', headers);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    const logout = await call('/logout', { cookie: `ankay_logout=${TOKEN}` }, 'POST');
    assert.equal(logout.status, 403);
    assert.equal(state.calls.length, 0, 'no toca Shuffle');
  });
});

test('puente: crea el usuario, fija el rol y entrega solo la cookie de sesión', async () => {
  await withBridge(async ({ call, state }) => {
    const res = await call('/sso?next=%2Fankay%2Fworkflows%2Fw1', edgeHeaders('Lider@QAPAQ.pe', 'qapaq.soc.lead'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/ankay/workflows/w1');
    const user = state.users.get('lider@qapaq.pe');
    assert.equal(user.role, 'user');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.includes(`session_token=${user.session}; Path=/ankay; Max-Age=28800; Secure; HttpOnly; SameSite=Strict`));
    const body = await res.text();
    assert.ok(!body.includes(user.password) && !cookies.join().includes(user.password), 'la contraseña no sale');
    assert.ok(!cookies.join().includes(state.apikey), 'la API key no sale');
    assert.deepEqual(state.loginIps, ['203.0.113.7']);

    // Segundo SSO: reutiliza la contraseña en memoria y la sesión vigente (no la invalida).
    const again = await call('/sso', edgeHeaders('lider@qapaq.pe', 'qapaq.soc.lead'));
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('location'), DEFAULT_NEXT);
    assert.ok(again.headers.getSetCookie().some((c) => c.startsWith(`session_token=${user.session};`)));
    assert.equal(state.calls.filter((c) => c.endsWith('/passwordchange')).length, 0);
  });
});

test('puente: el rol sigue al de QAPAQ (auditor → org-reader, admin → admin)', async () => {
  await withBridge(async ({ call, state }) => {
    await call('/sso', edgeHeaders('auditor@qapaq.pe', 'qapaq.auditor'));
    assert.equal(state.users.get('auditor@qapaq.pe').role, 'org-reader');
    await call('/sso', edgeHeaders('auditor@qapaq.pe', 'qapaq.platform.admin'));
    assert.equal(state.users.get('auditor@qapaq.pe').role, 'admin');
  });
});

test('puente: sin rol mapeado niega y revoca la sesión de Shuffle existente', async () => {
  await withBridge(async ({ call, state }) => {
    await call('/sso', edgeHeaders('ex@qapaq.pe', 'qapaq.soc.analyst'));
    assert.ok(state.users.get('ex@qapaq.pe').session);
    const res = await call('/sso', edgeHeaders('ex@qapaq.pe', 'qapaq.access.approver'));
    assert.equal(res.status, 403);
    assert.equal(state.users.get('ex@qapaq.pe').session, undefined);
    assert.ok(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
  });
});

test('puente: la cuenta de servicio / admin inicial nunca se entrega', async () => {
  await withBridge(async ({ call, state }) => {
    const res = await call('/sso', edgeHeaders('admin@qapaq.pe', 'qapaq.platform.admin'));
    assert.equal(res.status, 403);
    assert.equal(state.calls.length, 0);
  });
});

test('puente: si la contraseña en memoria ya no vale (reinicio), la rota y entra', async () => {
  await withBridge(async ({ call, state }) => {
    await call('/sso', edgeHeaders('lider@qapaq.pe', 'qapaq.soc.lead'));
    state.users.get('lider@qapaq.pe').password = 'cambiada-fuera';
    const res = await call('/sso', edgeHeaders('lider@qapaq.pe', 'qapaq.soc.lead'));
    assert.equal(res.status, 302);
    assert.equal(state.calls.filter((c) => c.endsWith('/passwordchange')).length, 1);
  });
});

test('puente: logout cierra la sesión de Shuffle de la cookie y borra las cookies', async () => {
  await withBridge(async ({ call, state }) => {
    await call('/sso', edgeHeaders('lider@qapaq.pe', 'qapaq.soc.lead'));
    const session = state.users.get('lider@qapaq.pe').session;
    const res = await call('/logout', { 'x-qapaq-edge-token': EDGE, cookie: `qapaq_session=x; ankay_logout=${session}` }, 'POST');
    assert.equal(res.status, 204);
    assert.equal(state.users.get('lider@qapaq.pe').session, undefined);
    assert.ok(res.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
  });
});

test('puente: el admin inicial de Shuffle entra con su contraseña fija (sin rotarla) y solo como admin', async () => {
  const { server, state } = await fakeShuffle();
  state.users.set('boss@qapaq.pe', { id: 'b1', username: 'boss@qapaq.pe', role: 'admin', password: 'fija-Aa9!' });
  const shuffle = createShuffleClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: state.apikey });
  const handler = createHandler({ edgeToken: EDGE, shuffle, reserved: new Set(), fixed: new Map([['boss@qapaq.pe', 'fija-Aa9!']]), log: () => {} });
  const bridge = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bridge.address().port}`;
  try {
    const ok = await fetch(`${base}/sso`, { headers: edgeHeaders('boss@qapaq.pe', 'qapaq.platform.admin'), redirect: 'manual' });
    assert.equal(ok.status, 302);
    const lead = await fetch(`${base}/sso`, { headers: edgeHeaders('boss@qapaq.pe', 'qapaq.soc.lead'), redirect: 'manual' });
    assert.equal(lead.status, 403);
    const none = await fetch(`${base}/sso`, { headers: edgeHeaders('boss@qapaq.pe', 'qapaq.other'), redirect: 'manual' });
    assert.equal(none.status, 403);
    assert.equal(state.users.get('boss@qapaq.pe').password, 'fija-Aa9!');
    assert.equal(state.users.get('boss@qapaq.pe').role, 'admin');
    assert.equal(state.calls.filter((c) => c.endsWith('/passwordchange') || c.endsWith('/updateuser')).length, 0);
  } finally {
    bridge.close();
    server.close();
  }
});
