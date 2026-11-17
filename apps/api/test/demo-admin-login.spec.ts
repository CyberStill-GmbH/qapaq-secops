/**
 * Excepción demo: contraseña del administrador (docs/04-identidad-y-acceso.md).
 *
 * Se ejercita sobre HTTP real (inyección Fastify) lo que hace a la excepción aceptable: apagada
 * por defecto, una sola cuenta sintética con solo el rol admin y `amr: ['pwd']`, cookie HttpOnly
 * Secure SameSite=Strict, JWT validado por el mismo pipeline pero nunca entregado ni aceptado
 * como bearer, no enumeración, bloqueo, tope propio de intentos, vencimiento sin reinicio y
 * arranque que falla cerrado en producción o con un hash inválido.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConfigurationError, loadDemoAdminLoginConfig } from '@qapaq/configuration';
import type { InMemorySoc } from '@qapaq/soc';

import {
  DEMO_ADMIN_ATTEMPT_POLICY,
  DEMO_ADMIN_SESSION_MAX_MS,
  DemoAdminLogin,
  demoAdminSubjectOf,
  formatScryptHash,
  hashDemoAdminPassword,
  parseScryptHash,
  verifyScryptPassword,
} from '../src/access/demo-admin-credentials.js';
import { buildApi } from '../src/bootstrap.js';
import type { SecOpsRuntime, SignInDiagnostic } from '../src/runtime/secops-runtime.js';

const USERNAME = 'admin.demo@qapaq.pe';
const PASSWORD = 'contraseña-demo-de-prueba-larga';
const LOCAL_DEV_PASSWORD = 'qapaq-dev-password';
const HASH_SCRIPT = fileURLToPath(
  new URL('../../../scripts/dev/hash-demo-admin-password.mjs', import.meta.url),
);

/** Hash de prueba con el mínimo admitido (N = 2^15) para que la suite no sea lenta. */
let passwordHash = '';

beforeAll(async () => {
  passwordHash = await hashDemoAdminPassword(PASSWORD, { logN: 15 });
});

function demoEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    QAPAQ_PROFILE: 'test',
    QAPAQ_DEMO_ADMIN_LOGIN_ENABLED: 'true',
    QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    QAPAQ_DEMO_ADMIN_USERNAME: USERNAME,
    QAPAQ_DEMO_ADMIN_PASSWORD_HASH: passwordHash,
    ...overrides,
  };
}

/** Identidad de un despliegue de producción real (no la de la demo). */
const PRODUCTION_ACCESS = {
  QAPAQ_PROFILE: 'production',
  QAPAQ_ENTRA_TENANT_ID: '33333333-3333-4333-8333-333333333333',
  QAPAQ_ENTRA_CLIENT_ID: '44444444-4444-4444-8444-444444444444',
  QAPAQ_ENTRA_REDIRECT_URI: 'https://soc.cliente.example/api/auth/callback',
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS: 'https://soc.cliente.example/api/auth/callback',
  QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://aws-secretsmanager/qapaq/entra/client-secret',
  QAPAQ_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8',
  QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS: '10.0.0.0/16',
  QAPAQ_CONSOLE_BASE_URL: 'https://soc.cliente.example',
} as const;

/** La misma identidad que infra/aws/environments/demo.tfvars. */
const DEMO_DEPLOYMENT_ACCESS = {
  ...PRODUCTION_ACCESS,
  QAPAQ_ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  QAPAQ_ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  QAPAQ_ENTRA_REDIRECT_URI: 'https://app.qapaq.pe/api/auth/callback',
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS: 'https://app.qapaq.pe/api/auth/callback',
  QAPAQ_CONSOLE_BASE_URL: 'https://app.qapaq.pe',
} as const;

type Built = Awaited<ReturnType<typeof buildApi>>;

interface Harness {
  readonly built: Built;
  readonly runtime: SecOpsRuntime;
  readonly diagnostics: SignInDiagnostic[];
  readonly events: string[];
}

async function harness(environment: Record<string, string | undefined>): Promise<Harness> {
  const diagnostics: SignInDiagnostic[] = [];
  const events: string[] = [];
  const built = await buildApi(
    environment,
    (state) => events.push(state),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (diagnostic) => diagnostics.push(diagnostic),
  );
  await built.application.init();
  await built.application.getHttpAdapter().getInstance().ready();
  return { built, runtime: built.runtime, diagnostics, events };
}

let ipSequence = 0;
/** Cada prueba usa su propio origen de oficina: los límites reales no se relajan, se aíslan. */
function officeIp(): string {
  ipSequence += 1;
  return `10.20.${200 + Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function server(h: Harness) {
  return h.built.application.getHttpAdapter().getInstance();
}

function submit(
  h: Harness,
  fields: Record<string, string>,
  remoteAddress: string,
  headers: Record<string, string> = {},
) {
  return server(h).inject({
    method: 'POST',
    url: '/api/auth/password',
    remoteAddress,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(fields).toString(),
  });
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? (header as string[]) : header ? [header as string] : [];
}

function sessionCookieOf(response: { headers: Record<string, unknown> }): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith('qapaq_session='));
}

function cookiePairOf(response: { headers: Record<string, unknown> }): string {
  return sessionCookieOf(response)?.split(';', 1)[0] ?? '';
}

function authErrorOf(response: { headers: Record<string, unknown> }): string | null {
  return new URL(response.headers.location as string, 'http://local').searchParams.get('authError');
}

function session(h: Harness, cookie: string, remoteAddress: string, headers = {}) {
  return server(h).inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    remoteAddress,
  });
}

async function signInLocal(h: Harness, username: string, remoteAddress: string) {
  const response = await submit(h, { username, password: LOCAL_DEV_PASSWORD }, remoteAddress);
  return cookiePairOf(response);
}

async function auditOf(h: Harness) {
  return (await (h.runtime.soc as InMemorySoc).allAudit()).filter(
    (event) => event.action === 'access.sign_in',
  );
}

/** Instancia viva de la excepción, para simular la fuga de un JWT bien firmado. */
function demoLoginOf(h: Harness): DemoAdminLogin {
  const login = (h.runtime as unknown as { options: { demoAdminLogin?: DemoAdminLogin } }).options
    .demoAdminLogin;
  if (!login) throw new Error('la excepción demo no está configurada');
  return login;
}

describe('hash scrypt de la contraseña demo', () => {
  it('genera un formato autodescrito con N ≥ 2^15 y sal de 16 bytes que verifica', async () => {
    const parsed = parseScryptHash(passwordHash);
    expect(passwordHash).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/u);
    expect(parsed).toMatchObject({ logN: 15, r: 8, p: 1 });
    expect(parsed!.salt.length).toBeGreaterThanOrEqual(16);
    expect(formatScryptHash(parsed!)).toBe(passwordHash);
    await expect(verifyScryptPassword(PASSWORD, parsed!)).resolves.toBe(true);
    await expect(verifyScryptPassword(`${PASSWORD}x`, parsed!)).resolves.toBe(false);
  });

  it('cada hash lleva sal aleatoria propia', async () => {
    const other = await hashDemoAdminPassword(PASSWORD, { logN: 15 });
    expect(other).not.toBe(passwordHash);
  });

  it('exige al menos 14 caracteres al generar', async () => {
    await expect(hashDemoAdminPassword('corta-13-chrs')).rejects.toThrow(
      'DEMO_ADMIN_PASSWORD_TOO_SHORT',
    );
  });

  it.each([
    ['texto arbitrario', 'no-es-un-hash'],
    ['N por debajo de 2^15', passwordHashWith({ ln: '14' })],
    ['r por debajo de 8', passwordHashWith({ r: '4' })],
    ['memoria excesiva', passwordHashWith({ ln: '17', r: '16' })],
    ['sal de 8 bytes', passwordHashWith({ salt: Buffer.alloc(8, 1).toString('base64') })],
    ['clave corta', passwordHashWith({ key: Buffer.alloc(16, 1).toString('base64') })],
    ['base64 con relleno', passwordHashWith({ salt: `${Buffer.alloc(16, 1).toString('base64')}` })],
    ['otro algoritmo', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g'],
  ])('rechaza un hash mal formado: %s', (_label, value) => {
    expect(parseScryptHash(value)).toBeUndefined();
  });

  it('el script de generación lee por stdin, imprime solo el hash y aplica la política', () => {
    const ok = spawnSync(process.execPath, [HASH_SCRIPT], { input: `${PASSWORD}\n` });
    expect(ok.status).toBe(0);
    const printed = ok.stdout.toString('utf8').trim();
    expect(printed).toMatch(/^\$scrypt\$ln=16,r=8,p=1\$/u);
    expect(ok.stdout.toString('utf8')).not.toContain(PASSWORD);
    expect(ok.stderr.toString('utf8')).not.toContain(PASSWORD);
    const parsed = parseScryptHash(printed);
    expect(parsed).toBeDefined();
    return verifyScryptPassword(PASSWORD, parsed!).then((matches) => expect(matches).toBe(true));
  }, 20_000);

  it('el script rechaza contraseñas cortas y contraseñas como argumento', () => {
    const short = spawnSync(process.execPath, [HASH_SCRIPT], { input: 'corta-13-chrs' });
    expect(short.status).toBe(1);
    expect(short.stdout.toString('utf8')).toBe('');
    const argument = spawnSync(process.execPath, [HASH_SCRIPT, PASSWORD], { input: '' });
    expect(argument.status).toBe(1);
    expect(argument.stdout.toString('utf8')).toBe('');
  }, 20_000);
});

/** Variante del hash de prueba con un campo alterado. */
function passwordHashWith(change: {
  ln?: string;
  r?: string;
  salt?: string;
  key?: string;
}): string {
  // Se arma a partir de valores fijos: `passwordHash` aún no existe al evaluar `it.each`.
  const salt = change.salt ?? Buffer.alloc(16, 7).toString('base64').replace(/=+$/u, '');
  const key = change.key ?? Buffer.alloc(32, 9).toString('base64').replace(/=+$/u, '');
  return `$scrypt$ln=${change.ln ?? '15'},r=${change.r ?? '8'},p=1$${salt}$${key}`;
}

describe('configuración y arranque de la excepción demo', () => {
  it('apagada por defecto: sin la bandera no existe', () => {
    expect(loadDemoAdminLoginConfig({ QAPAQ_PROFILE: 'test' }, new Date())).toEqual({
      enabled: false,
    });
    expect(
      loadDemoAdminLoginConfig(
        { ...demoEnvironment(), QAPAQ_DEMO_ADMIN_LOGIN_ENABLED: 'false' },
        new Date(),
      ),
    ).toEqual({ enabled: false });
  });

  it('con la bandera exige vencimiento, usuario y hash bien formados', () => {
    const now = new Date();
    for (const [name, value, code] of [
      ['QAPAQ_DEMO_ADMIN_LOGIN_ENABLED', 'yes', 'CONFIG_VALUE_INVALID'],
      ['QAPAQ_DEMO_ADMIN_LOGIN_UNTIL', undefined, 'CONFIG_REQUIRED_VALUE_MISSING'],
      ['QAPAQ_DEMO_ADMIN_LOGIN_UNTIL', '2026-12-01', 'CONFIG_VALUE_INVALID'],
      ['QAPAQ_DEMO_ADMIN_LOGIN_UNTIL', '2026-12-01T00:00:00+05:00', 'CONFIG_VALUE_INVALID'],
      [
        'QAPAQ_DEMO_ADMIN_LOGIN_UNTIL',
        new Date(now.getTime() + 31 * 86_400_000).toISOString(),
        'CONFIG_LIMIT_INVALID',
      ],
      ['QAPAQ_DEMO_ADMIN_USERNAME', undefined, 'CONFIG_REQUIRED_VALUE_MISSING'],
      ['QAPAQ_DEMO_ADMIN_USERNAME', 'Admin Demo', 'CONFIG_VALUE_INVALID'],
      ['QAPAQ_DEMO_ADMIN_PASSWORD_HASH', undefined, 'CONFIG_REQUIRED_VALUE_MISSING'],
    ] as const) {
      const environment = { ...demoEnvironment(), [name]: value };
      expect(() => loadDemoAdminLoginConfig(environment, now), name).toThrow(
        expect.objectContaining({ code, path: name }),
      );
    }
  });

  it('en producción el arranque falla con un error de configuración claro', async () => {
    const environment = { ...PRODUCTION_ACCESS, ...demoEnvironment(), QAPAQ_PROFILE: 'production' };
    const failure = await buildApi(environment, () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_DEMO_ADMIN_LOGIN_ENABLED',
      profile: 'production',
      details: { reason: 'DEMO_ADMIN_LOGIN_NOT_ALLOWED_IN_PROFILE' },
    });
  });

  it('la demo de AWS (perfil production con la identidad fija de demo.tfvars) sí la admite', () => {
    const config = loadDemoAdminLoginConfig(
      { ...DEMO_DEPLOYMENT_ACCESS, ...demoEnvironment(), QAPAQ_PROFILE: 'production' },
      new Date(),
    );
    expect(config).toMatchObject({ enabled: true, deployment: 'demo', username: USERNAME });
    // El hash viaja envuelto: no se serializa ni se imprime.
    expect(JSON.stringify(config)).not.toContain(passwordHash);
  });

  it('producción con Entra real la admite solo con el opt-in QAPAQ_DEMO_LOGIN_WITH_ENTRA=true', () => {
    const environment = { ...PRODUCTION_ACCESS, ...demoEnvironment(), QAPAQ_PROFILE: 'production' };
    expect(() => loadDemoAdminLoginConfig(environment, new Date())).toThrow(ConfigurationError);
    const config = loadDemoAdminLoginConfig(
      { ...environment, QAPAQ_DEMO_LOGIN_WITH_ENTRA: 'true' },
      new Date(),
    );
    expect(config).toMatchObject({ enabled: true, deployment: 'entra', username: USERNAME });
    expect(JSON.stringify(config)).not.toContain(passwordHash);
  });

  it('el arranque expone el despliegue que justificó la excepción para el log', async () => {
    const h = await harness(demoEnvironment());
    try {
      expect(h.built.demoAdminLoginDeployment).toBe('test');
    } finally {
      await h.built.stop();
    }
  });

  it.each([
    ['mal formado', 'no-es-un-hash'],
    ['con parámetros débiles', passwordHashWith({ ln: '14' })],
  ])('un hash %s impide arrancar sin citar el hash', async (_label, value) => {
    const failure = await buildApi(
      demoEnvironment({ QAPAQ_DEMO_ADMIN_PASSWORD_HASH: value }),
      () => {},
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_DEMO_ADMIN_PASSWORD_HASH',
    });
    expect(JSON.stringify(failure)).not.toContain(value);
  });

  it('el arranque expone el vencimiento para la advertencia del log', async () => {
    const until = new Date(Date.now() + 86_400_000);
    const h = await harness(demoEnvironment({ QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: until.toISOString() }));
    try {
      expect(h.built.demoAdminLoginUntil?.toISOString()).toBe(until.toISOString());
    } finally {
      await h.built.stop();
    }
  });
});

describe('acceso con la contraseña demo del administrador', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness(demoEnvironment());
  });

  afterAll(async () => {
    await h.built.stop();
  });

  it('abre una sesión admin con amr pwd entregada solo en una cookie HttpOnly, Secure y Strict', async () => {
    const ip = officeIp();
    const response = await submit(
      h,
      { username: USERNAME, password: PASSWORD, returnTo: '/app/qapaq-alerts' },
      ip,
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(new URL(response.headers.location as string, 'http://local').pathname).toBe(
      '/app/qapaq-alerts',
    );
    expect(response.body).toBe('');
    const cookie = sessionCookieOf(response)!;
    expect(cookie).toBeDefined();
    const attributes = cookie.split(';').map((part) => part.trim());
    expect(attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']),
    );
    const maxAge = Number(attributes.find((part) => part.startsWith('Max-Age='))?.slice(8));
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(DEMO_ADMIN_SESSION_MAX_MS / 1000);
    // Ningún JWT sale al navegador: ni en cabeceras ni en el cuerpo.
    expect(JSON.stringify(response.headers)).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/u);

    const pair = cookiePairOf(response);
    const current = await session(h, pair, ip);
    expect(current.statusCode).toBe(200);
    const body = JSON.parse(current.body);
    expect(body).toMatchObject({
      subjectId: demoAdminSubjectOf(USERNAME),
      roles: ['qapaq.platform.admin'],
      amr: ['pwd'],
      email: USERNAME,
    });
    expect(body.subjectId).toMatch(/^demo-admin:[0-9a-f]{16}$/u);

    const introspect = await server(h).inject({
      method: 'GET',
      url: '/api/auth/introspect',
      headers: { cookie: pair },
      remoteAddress: ip,
    });
    expect(introspect.statusCode).toBe(204);
    expect(introspect.headers['x-qapaq-roles']).toBe('qapaq.platform.admin');

    const stored = await h.runtime.sessions.byId(decodeURIComponent(pair.split('=')[1]!));
    expect(stored!.absoluteExpiresAt.getTime() - stored!.createdAt.getTime()).toBeLessThanOrEqual(
      DEMO_ADMIN_SESSION_MAX_MS,
    );
    expect(stored!.oid).toBeUndefined();

    const audit = await auditOf(h);
    expect(
      audit.some(
        (event) =>
          event.outcome === 'succeeded' &&
          event.reason === 'demo_admin_password_login' &&
          event.actor.id === demoAdminSubjectOf(USERNAME),
      ),
    ).toBe(true);
  });

  it('cerrar sesión la revoca en el acto', async () => {
    const ip = officeIp();
    const pair = cookiePairOf(await submit(h, { username: USERNAME, password: PASSWORD }, ip));
    const current = await session(h, pair, ip);
    const csrf = JSON.parse(current.body).csrfToken as string;
    const logout = await server(h).inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: pair, 'x-csrf-token': csrf },
      remoteAddress: ip,
    });
    expect(logout.statusCode).toBe(204);
    expect((await session(h, pair, ip)).statusCode).toBe(401);
  });

  it('contraseña errónea y usuario inexistente son indistinguibles y se auditan', async () => {
    const ip = officeIp();
    const before = (await auditOf(h)).length;
    const wrong = await submit(h, { username: USERNAME, password: `${PASSWORD}-no` }, ip);
    const unknown = await submit(h, { username: 'nadie@qapaq.pe', password: PASSWORD }, ip);
    for (const response of [wrong, unknown]) {
      expect(response.statusCode).toBe(303);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toBe('');
      expect(sessionCookieOf(response)).toBeUndefined();
      expect(authErrorOf(response)).toBe('AUTH_FAILED');
    }
    const strip = (location: string) => location.replace(/correlationId=[^&]+/u, '');
    expect(strip(wrong.headers.location as string)).toBe(strip(unknown.headers.location as string));
    const denials = (await auditOf(h)).slice(before);
    expect(denials).toHaveLength(2);
    for (const event of denials) {
      expect(event).toMatchObject({ outcome: 'denied', reason: 'demo_admin_denied' });
    }
  });

  it('bloquea tras varios fallos aunque luego llegue la contraseña correcta', async () => {
    const ip = officeIp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submit(h, { username: USERNAME, password: 'incorrecta-pero-larga' }, ip);
    }
    const response = await submit(h, { username: USERNAME, password: PASSWORD }, ip);
    expect(sessionCookieOf(response)).toBeUndefined();
    expect(authErrorOf(response)).toBe('AUTH_FAILED');
    const last = (await auditOf(h)).at(-1);
    expect(last).toMatchObject({ reason: 'demo_admin_denied', metadata: { denial: 'LOCKED_OUT' } });
  });

  it('aplica un tope propio de intentos por origen aunque se roten cuentas', async () => {
    const ip = officeIp();
    for (let attempt = 0; attempt < DEMO_ADMIN_ATTEMPT_POLICY.maxAttempts; attempt += 1) {
      const response = await submit(
        h,
        { username: `rotada-${attempt}@qapaq.pe`, password: 'incorrecta-pero-larga' },
        ip,
      );
      expect(authErrorOf(response)).toBe('AUTH_FAILED');
    }
    const blocked = await submit(h, { username: USERNAME, password: PASSWORD }, ip);
    expect(sessionCookieOf(blocked)).toBeUndefined();
    expect(authErrorOf(blocked)).toBe('RATE_LIMITED');
  });

  it('rechaza peticiones de otro sitio (login CSRF)', async () => {
    const ip = officeIp();
    const crossSite = await submit(h, { username: USERNAME, password: PASSWORD }, ip, {
      'sec-fetch-site': 'cross-site',
    });
    const foreignOrigin = await submit(h, { username: USERNAME, password: PASSWORD }, ip, {
      origin: 'https://evil.example',
      host: 'app.qapaq.pe',
    });
    for (const response of [crossSite, foreignOrigin]) {
      expect(sessionCookieOf(response)).toBeUndefined();
      expect(authErrorOf(response)).toBe('REQUEST_NOT_VERIFIED');
    }
  });

  it('fuera de la red permitida la excepción no aplica', async () => {
    const response = await submit(h, { username: USERNAME, password: PASSWORD }, '203.0.113.50');
    expect(sessionCookieOf(response)).toBeUndefined();
    expect(authErrorOf(response)).not.toBeNull();
  });

  it('no da acceso a otras cuentas ni toca sus sesiones', async () => {
    const ip = officeIp();
    const localAdmin = await signInLocal(h, 'admin@qapaq.pe', ip);
    expect(localAdmin).not.toBe('');
    // La contraseña demo con el usuario de otra persona no entra.
    for (const username of ['admin@qapaq.pe', 'analista@qapaq.pe']) {
      const response = await submit(h, { username, password: PASSWORD }, officeIp());
      expect(sessionCookieOf(response)).toBeUndefined();
      expect(authErrorOf(response)).toBe('AUTH_FAILED');
    }
    // El acceso demo abre su propia sesión sin reemplazar la de la persona real.
    const demo = await submit(h, { username: USERNAME, password: PASSWORD }, officeIp());
    expect(cookiePairOf(demo)).not.toBe('');
    const real = await session(h, localAdmin, ip);
    expect(real.statusCode).toBe(200);
    expect(JSON.parse(real.body).subjectId).toBe('local-platform-admin-1');
  });

  it('el JWT no sirve como bearer ni como cookie, y su código no se canjea por el callback', async () => {
    const ip = officeIp();
    const login = demoLoginOf(h);
    const jwt = login.sign('nonce-filtrado', new Date());
    for (const headers of [{ authorization: `Bearer ${jwt}` }, { cookie: `qapaq_session=${jwt}` }]) {
      expect((await session(h, '', ip, headers)).statusCode).toBe(401);
      const alerts = await server(h).inject({
        method: 'GET',
        url: '/api/alerts',
        headers,
        remoteAddress: ip,
      });
      expect(alerts.statusCode).toBe(401);
    }
    // Un código del emisor demo no vale en el callback de Entra/local.
    const start = await server(h).inject({
      method: 'GET',
      url: '/api/auth/start',
      remoteAddress: ip,
    });
    const state = new URL(start.headers.location as string, 'http://local').searchParams.get(
      'state',
    )!;
    const flowCookie = setCookies(start)[0]!.split(';', 1)[0]!;
    const code = login.issueCode('cualquier-nonce', 'cualquier-verifier', new Date());
    const callback = await server(h).inject({
      method: 'GET',
      url: `/api/auth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
      headers: { cookie: flowCookie },
      remoteAddress: ip,
    });
    expect(sessionCookieOf(callback)).toBeUndefined();
    expect(authErrorOf(callback)).toBe('AUTH_FAILED');
  });

  it('la contraseña y el hash no aparecen en auditoría ni en los diagnósticos', async () => {
    await submit(h, { username: USERNAME, password: `${PASSWORD}-mal` }, officeIp());
    await submit(h, { username: USERNAME, password: PASSWORD }, officeIp());
    const everything = JSON.stringify(
      {
        audit: await (h.runtime.soc as InMemorySoc).allAudit(),
        diagnostics: h.diagnostics,
        events: h.events,
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    const [, , , salt, key] = passwordHash.split('$');
    for (const secret of [PASSWORD, passwordHash, salt!, key!]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('vencimiento y apagado de la excepción demo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('con la bandera apagada la ruta rechaza la credencial demo', async () => {
    const h = await harness({
      QAPAQ_PROFILE: 'test',
      QAPAQ_DEMO_ADMIN_USERNAME: USERNAME,
      QAPAQ_DEMO_ADMIN_PASSWORD_HASH: passwordHash,
    });
    try {
      const response = await submit(h, { username: USERNAME, password: PASSWORD }, officeIp());
      expect(sessionCookieOf(response)).toBeUndefined();
      expect(authErrorOf(response)).toBe('AUTH_FAILED');
      expect(h.built.demoAdminLoginUntil).toBeUndefined();
    } finally {
      await h.built.stop();
    }
  });

  it('al vencer, sin reinicio, la ruta rechaza y la sesión abierta deja de valer', async () => {
    // Menos que la inactividad tolerada (30 min): lo que corta la sesión es el vencimiento.
    const until = new Date(Date.now() + 10 * 60 * 1000);
    const h = await harness(demoEnvironment({ QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: until.toISOString() }));
    try {
      const ip = officeIp();
      const opened = await submit(h, { username: USERNAME, password: PASSWORD }, ip);
      const pair = cookiePairOf(opened);
      expect((await session(h, pair, ip)).statusCode).toBe(200);
      const stored = await h.runtime.sessions.byId(decodeURIComponent(pair.split('=')[1]!));
      expect(stored!.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(until.getTime());

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(until.getTime() + 1_000));

      const expired = await session(h, pair, ip);
      // La sesión nació con vida absoluta acotada a `until`: vence junto con la excepción.
      expect(expired.statusCode).toBe(401);
      expect(JSON.parse(expired.body).code).toBe('SESSION_EXPIRED');

      const again = await submit(h, { username: USERNAME, password: PASSWORD }, officeIp());
      expect(sessionCookieOf(again)).toBeUndefined();
      expect(authErrorOf(again)).toBe('AUTH_FAILED');
    } finally {
      vi.useRealTimers();
      await h.built.stop();
    }
  });

  it('una sesión demo-admin de otro sujeto o sin excepción configurada no vale', async () => {
    const h = await harness({ QAPAQ_PROFILE: 'test' });
    try {
      const at = new Date();
      await h.runtime.sessions.create({
        id: 'sesion-demo-huerfana-de-prueba-0000000000000',
        subjectId: demoAdminSubjectOf(USERNAME),
        tenantId: h.runtime.tenantId,
        state: 'active',
        roles: ['qapaq.platform.admin'],
        scopes: [],
        capabilities: new Set(),
        amr: ['pwd'],
        createdAt: at,
        lastSeenAt: at,
        absoluteExpiresAt: new Date(at.getTime() + 3_600_000),
        clientIp: '10.20.0.1',
        revision: 1,
      });
      const response = await session(
        h,
        'qapaq_session=sesion-demo-huerfana-de-prueba-0000000000000',
        '10.20.0.1',
      );
      expect(response.statusCode).toBe(401);
      // resolveActor la revoca en el acto, no solo la rechaza.
      const stored = await h.runtime.sessions.byId('sesion-demo-huerfana-de-prueba-0000000000000');
      expect(stored).toMatchObject({ state: 'revoked', revocationReason: 'identity_revoked' });
    } finally {
      await h.built.stop();
    }
  });
});
