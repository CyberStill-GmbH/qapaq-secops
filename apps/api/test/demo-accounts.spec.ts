/**
 * Cuentas demo adicionales (`QAPAQ_DEMO_ACCOUNTS`): una por rol, con las mismas reglas que la
 * excepción demo del administrador (demo-admin-login.spec.ts). Se comprueba sobre HTTP real que
 * cada cuenta obtiene exactamente su rol, que la sesión única es por cuenta (el login de un agente
 * no expulsa al administrador), que una contraseña no abre otra cuenta, que ninguna cuenta demo
 * recibe capacidades de aprobación (SoD) y que una sesión con un rol distinto al configurado se
 * revoca.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigurationError } from '@qapaq/configuration';
import type { InMemorySoc } from '@qapaq/soc';

import {
  DemoAdminLogin,
  demoAccountSubjectOf,
  demoAdminSubjectOf,
  hashDemoAdminPassword,
} from '../src/access/demo-admin-credentials.js';
import { buildApi } from '../src/bootstrap.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const ADMIN = 'admin@qapaq.pe';
const ADMIN_PASSWORD = 'contraseña-admin-demo-larga';
const ACCOUNTS = [
  { username: 'analista@qapaq.pe', role: 'qapaq.soc.analyst', password: 'contraseña-analista-larga' },
  { username: 'lider@qapaq.pe', role: 'qapaq.soc.lead', password: 'contraseña-lider-soc-larga' },
  { username: 'auditor@qapaq.pe', role: 'qapaq.auditor', password: 'contraseña-auditor-larga' },
] as const;

const hashes = new Map<string, string>();

beforeAll(async () => {
  hashes.set(ADMIN, await hashDemoAdminPassword(ADMIN_PASSWORD, { logN: 15 }));
  for (const account of ACCOUNTS) {
    hashes.set(account.username, await hashDemoAdminPassword(account.password, { logN: 15 }));
  }
});

function accountsJson(overrides: { username?: string; role?: string; hash?: string }[] = []) {
  return JSON.stringify(
    ACCOUNTS.map((account, index) => ({
      username: overrides[index]?.username ?? account.username,
      role: overrides[index]?.role ?? account.role,
      passwordHash: overrides[index]?.hash ?? hashes.get(account.username),
    })),
  );
}

function demoEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    QAPAQ_PROFILE: 'test',
    QAPAQ_DEMO_ADMIN_LOGIN_ENABLED: 'true',
    QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    QAPAQ_DEMO_ADMIN_USERNAME: ADMIN,
    QAPAQ_DEMO_ADMIN_PASSWORD_HASH: hashes.get(ADMIN),
    QAPAQ_DEMO_ACCOUNTS: accountsJson(),
    ...overrides,
  };
}

type Built = Awaited<ReturnType<typeof buildApi>>;

async function harness(environment: Record<string, string | undefined>) {
  const built: Built = await buildApi(environment, () => {});
  await built.application.init();
  await built.application.getHttpAdapter().getInstance().ready();
  return built;
}

let ipSequence = 0;
function officeIp(): string {
  ipSequence += 1;
  return `10.20.${100 + Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function server(built: Built) {
  return built.application.getHttpAdapter().getInstance();
}

function submit(built: Built, username: string, password: string, remoteAddress: string) {
  return server(built).inject({
    method: 'POST',
    url: '/api/auth/password',
    remoteAddress,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username, password }).toString(),
  });
}

function cookiePairOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? (header as string[]) : header ? [header as string] : [];
  return cookies.find((cookie) => cookie.startsWith('qapaq_session='))?.split(';', 1)[0] ?? '';
}

function authErrorOf(response: { headers: Record<string, unknown> }): string | null {
  return new URL(response.headers.location as string, 'http://local').searchParams.get('authError');
}

function session(built: Built, cookie: string, remoteAddress: string) {
  return server(built).inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: cookie ? { cookie } : {},
    remoteAddress,
  });
}

function demoLoginOf(runtime: SecOpsRuntime): DemoAdminLogin {
  const login = (runtime as unknown as { options: { demoAdminLogin?: DemoAdminLogin } }).options
    .demoAdminLogin;
  if (!login) throw new Error('la excepción demo no está configurada');
  return login;
}

describe('arranque con cuentas demo adicionales', () => {
  it('un hash scrypt inválido en una cuenta impide arrancar sin citarlo', async () => {
    const weak = `$scrypt$ln=14,r=8,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`;
    const failure = await buildApi(
      demoEnvironment({ QAPAQ_DEMO_ACCOUNTS: accountsJson([{ hash: weak }]) }),
      () => {},
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toMatchObject({ code: 'CONFIG_VALUE_INVALID', path: 'QAPAQ_DEMO_ACCOUNTS' });
    expect(JSON.stringify(failure)).not.toContain(weak);
  });

  it('el verificador rechaza roles aprobadores y usuarios repetidos aunque se salte la configuración', () => {
    const base = {
      username: ADMIN,
      passwordHash: hashes.get(ADMIN)!,
      until: new Date(Date.now() + 86_400_000),
      issuer: 'urn:qapaq:demo-admin-password',
      audience: 'aud',
      tenantId: 'tenant',
      profile: 'test' as const,
    };
    const hash = hashes.get(ACCOUNTS[0].username)!;
    for (const accounts of [
      [{ username: 'a1@qapaq.pe', role: 'qapaq.access.approver', passwordHash: hash }],
      [{ username: 'a1@qapaq.pe', role: 'qapaq.security.approver', passwordHash: hash }],
      [{ username: ADMIN, role: 'qapaq.soc.analyst', passwordHash: hash }],
      Array.from({ length: 9 }, (_, index) => ({
        username: `a${index}@qapaq.pe`,
        role: 'qapaq.soc.analyst',
        passwordHash: hash,
      })),
    ]) {
      expect(() => new DemoAdminLogin({ ...base, accounts })).toThrow(ConfigurationError);
    }
  });
});

describe('acceso con cuentas demo por rol', () => {
  let built: Built;

  beforeAll(async () => {
    built = await harness(demoEnvironment());
  });

  afterAll(async () => {
    await built.stop();
  });

  it('el administrador sigue funcionando igual (compatibilidad)', async () => {
    const ip = officeIp();
    const pair = cookiePairOf(await submit(built, ADMIN, ADMIN_PASSWORD, ip));
    const body = JSON.parse((await session(built, pair, ip)).body);
    expect(body).toMatchObject({
      subjectId: demoAdminSubjectOf(ADMIN),
      roles: ['qapaq.platform.admin'],
      amr: ['pwd'],
    });
  });

  it.each(ACCOUNTS)(
    '$username entra con exactamente $role y sin capacidades de aprobación',
    async (account) => {
      const ip = officeIp();
      const response = await submit(built, account.username, account.password, ip);
      expect(response.statusCode).toBe(303);
      const pair = cookiePairOf(response);
      expect(pair).not.toBe('');
      const current = await session(built, pair, ip);
      expect(current.statusCode).toBe(200);
      const body = JSON.parse(current.body) as {
        subjectId: string;
        roles: string[];
        amr: string[];
        email: string;
        capabilities: string[];
      };
      expect(body).toMatchObject({
        subjectId: demoAccountSubjectOf(account.username, account.role),
        roles: [account.role],
        amr: ['pwd'],
        email: account.username,
      });
      expect(body.subjectId).toMatch(/^demo-admin:[0-9a-f]{16}$/u);
      expect(body.subjectId).not.toBe(demoAdminSubjectOf(ADMIN));
      // SoD: ninguna cuenta demo resuelve solicitudes de rol.
      expect(body.capabilities).not.toContain('roles.approve');
      expect(body.capabilities).not.toContain('roles.approve.privileged');
      if (account.role === 'qapaq.auditor') {
        expect(body.capabilities).not.toContain('incidents.write');
        expect(body.capabilities).toContain('audit.verify');
      }
      if (account.role === 'qapaq.soc.analyst') {
        expect(body.capabilities).not.toContain('incidents.close');
        expect(body.capabilities).not.toContain('audit.read');
      }
      const audit = (await (built.runtime.soc as InMemorySoc).allAudit()).filter(
        (event) => event.action === 'access.sign_in',
      );
      expect(
        audit.some(
          (event) =>
            event.outcome === 'succeeded' &&
            event.reason === 'demo_admin_password_login' &&
            event.actor.id === body.subjectId,
        ),
      ).toBe(true);
    },
  );

  it('la sesión única es por cuenta: el login de un agente no expulsa al administrador', async () => {
    const adminIp = officeIp();
    const admin = cookiePairOf(await submit(built, ADMIN, ADMIN_PASSWORD, adminIp));
    const others = [];
    for (const account of ACCOUNTS) {
      others.push(
        cookiePairOf(await submit(built, account.username, account.password, officeIp())),
      );
    }
    expect((await session(built, admin, adminIp)).statusCode).toBe(200);
    // Un segundo login de la misma cuenta sí reemplaza su sesión anterior.
    const firstIp = officeIp();
    const first = cookiePairOf(
      await submit(built, ACCOUNTS[0].username, ACCOUNTS[0].password, firstIp),
    );
    const second = cookiePairOf(
      await submit(built, ACCOUNTS[0].username, ACCOUNTS[0].password, officeIp()),
    );
    expect(second).not.toBe('');
    expect((await session(built, first, firstIp)).statusCode).toBe(401);
    expect((await session(built, admin, adminIp)).statusCode).toBe(200);
  });

  it('la contraseña de una cuenta no abre otra', async () => {
    for (const [username, password] of [
      [ACCOUNTS[0].username, ACCOUNTS[1].password],
      [ACCOUNTS[2].username, ADMIN_PASSWORD],
      [ADMIN, ACCOUNTS[1].password],
      ['otra@qapaq.pe', ACCOUNTS[0].password],
    ] as const) {
      const response = await submit(built, username, password, officeIp());
      expect(cookiePairOf(response)).toBe('');
      expect(authErrorOf(response)).toBe('AUTH_FAILED');
    }
  });

  it('el código emitido para una cuenta firma solo su sujeto y su rol', () => {
    const login = demoLoginOf(built.runtime);
    const lead = login.accounts.find((account) => account.role === 'qapaq.soc.lead')!;
    const code = login.issueCode('nonce', 'verifier', new Date(), lead);
    const jwt = login.exchange(code, 'verifier', new Date());
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      sub: lead.subjectId,
      roles: ['qapaq.soc.lead'],
      preferred_username: 'lider@qapaq.pe',
      amr: ['pwd'],
    });
  });

  it('una sesión demo con un rol distinto al de su cuenta se revoca', async () => {
    const at = new Date();
    const id = 'sesion-demo-rol-cambiado-de-prueba-000000000000';
    await built.runtime.sessions.create({
      id,
      subjectId: demoAccountSubjectOf(ACCOUNTS[0].username, ACCOUNTS[0].role),
      tenantId: built.runtime.tenantId,
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
    const response = await session(built, `qapaq_session=${id}`, '10.20.0.1');
    expect(response.statusCode).toBe(401);
    expect(await built.runtime.sessions.byId(id)).toMatchObject({
      state: 'revoked',
      revocationReason: 'identity_revoked',
    });
  });

  it('las contraseñas y hashes no aparecen en la auditoría', async () => {
    const everything = JSON.stringify(
      await (built.runtime.soc as InMemorySoc).allAudit(),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    for (const account of ACCOUNTS) {
      expect(everything).not.toContain(account.password);
      expect(everything).not.toContain(hashes.get(account.username)!);
    }
  });
});
