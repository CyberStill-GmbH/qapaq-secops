/**
 * Cuentas demo adicionales (`QAPAQ_DEMO_ACCOUNTS`): extensión de la excepción demo de contraseña
 * (demo-admin-login.schema.ts). Solo existen con la excepción del administrador habilitada, en los
 * mismos perfiles, con tope de cuentas, usuarios válidos y únicos y uno de los cuatro roles runtime.
 */

import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/configuration.errors.js';
import { loadDemoAdminLoginConfig } from '../src/configuration-loader.js';
import { DEMO_ACCOUNT_ROLES, DEMO_ACCOUNTS_MAX, KNOWN_QAPAQ_VARIABLES } from '../src/index.js';
import { rejectUnknownQapaqVariables } from '../src/schema/environment.schema.js';

const HASH = `$scrypt$ln=15,r=8,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`;
const ADMIN = 'admin@qapaq.pe';

function account(username: string, role: string, passwordHash = HASH) {
  return { username, role, passwordHash };
}

function environment(accounts: unknown, overrides: Record<string, string | undefined> = {}) {
  return {
    QAPAQ_PROFILE: 'test',
    QAPAQ_DEMO_ADMIN_LOGIN_ENABLED: 'true',
    QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    QAPAQ_DEMO_ADMIN_USERNAME: ADMIN,
    QAPAQ_DEMO_ADMIN_PASSWORD_HASH: HASH,
    QAPAQ_DEMO_ACCOUNTS: typeof accounts === 'string' ? accounts : JSON.stringify(accounts),
    ...overrides,
  };
}

function failureOf(load: () => unknown): ConfigurationError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error('Se esperaba un ConfigurationError.');
}

const DEMO_IDENTITY = {
  QAPAQ_PROFILE: 'production',
  QAPAQ_ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  QAPAQ_ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  QAPAQ_ENTRA_REDIRECT_URI: 'https://app.qapaq.pe/api/auth/callback',
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS: 'https://app.qapaq.pe/api/auth/callback',
  QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://aws-secretsmanager/qapaq/entra/client-secret',
  QAPAQ_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8',
  QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS: '10.0.0.0/16',
  QAPAQ_CONSOLE_BASE_URL: 'https://app.qapaq.pe',
};

describe('QAPAQ_DEMO_ACCOUNTS', () => {
  it('son variables conocidas (con su referencia a secreto)', () => {
    expect(KNOWN_QAPAQ_VARIABLES.has('QAPAQ_DEMO_ACCOUNTS')).toBe(true);
    expect(KNOWN_QAPAQ_VARIABLES.has('QAPAQ_DEMO_ACCOUNTS_REF')).toBe(true);
    expect(() =>
      rejectUnknownQapaqVariables({ QAPAQ_DEMO_ACCOUNTS: '[]', QAPAQ_DEMO_ACCOUNTS_REF: 'x' }),
    ).not.toThrow();
  });

  it('ausentes, la excepción del administrador queda igual (sin cuentas adicionales)', () => {
    const config = loadDemoAdminLoginConfig(
      environment(undefined, { QAPAQ_DEMO_ACCOUNTS: undefined }),
      new Date(),
    );
    expect(config).toMatchObject({ enabled: true, username: ADMIN, accounts: [] });
  });

  it('acepta una cuenta por cada uno de los cuatro roles, sin exponer los hashes', () => {
    expect([...DEMO_ACCOUNT_ROLES].sort()).toEqual([
      'qapaq.auditor',
      'qapaq.platform.admin',
      'qapaq.soc.analyst',
      'qapaq.soc.lead',
    ]);
    const accounts = [
      account('analista@qapaq.pe', 'qapaq.soc.analyst'),
      account('lider@qapaq.pe', 'qapaq.soc.lead'),
      account('auditor@qapaq.pe', 'qapaq.auditor'),
      account('admin2@qapaq.pe', 'qapaq.platform.admin'),
    ];
    const config = loadDemoAdminLoginConfig(environment(accounts), new Date());
    if (!config.enabled) throw new Error('debería estar habilitada');
    expect(config.accounts.map(({ username, role }) => ({ username, role }))).toEqual(
      accounts.map(({ username, role }) => ({ username, role })),
    );
    expect(config.accounts[0]!.passwordHash.reveal()).toBe(HASH);
    expect(JSON.stringify(config)).not.toContain(HASH);
  });

  it('en production solo con la identidad del despliegue demo', () => {
    const accounts = [account('analista@qapaq.pe', 'qapaq.soc.analyst')];
    const ok = loadDemoAdminLoginConfig(
      { ...DEMO_IDENTITY, ...environment(accounts), QAPAQ_PROFILE: 'production' },
      new Date(),
    );
    expect(ok).toMatchObject({ enabled: true, deployment: 'demo' });
    const failure = failureOf(() =>
      loadDemoAdminLoginConfig(
        {
          ...DEMO_IDENTITY,
          ...environment(accounts),
          QAPAQ_PROFILE: 'production',
          QAPAQ_ENTRA_TENANT_ID: '33333333-3333-4333-8333-333333333333',
        },
        new Date(),
      ),
    );
    expect(failure).toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_DEMO_ADMIN_LOGIN_ENABLED',
    });
  });

  it.each([undefined, 'false'])(
    'sin la excepción del administrador (%s) su sola presencia impide arrancar',
    (flag) => {
      const failure = failureOf(() =>
        loadDemoAdminLoginConfig(
          environment([account('analista@qapaq.pe', 'qapaq.soc.analyst')], {
            QAPAQ_DEMO_ADMIN_LOGIN_ENABLED: flag,
          }),
          new Date(),
        ),
      );
      expect(failure).toMatchObject({
        code: 'CONFIG_VALUE_INVALID',
        path: 'QAPAQ_DEMO_ACCOUNTS',
        details: { reason: 'DEMO_ACCOUNTS_REQUIRE_DEMO_ADMIN_LOGIN' },
      });
    },
  );

  it('el vencimiento sigue acotado a 30 días aunque haya cuentas adicionales', () => {
    const failure = failureOf(() =>
      loadDemoAdminLoginConfig(
        environment([account('analista@qapaq.pe', 'qapaq.soc.analyst')], {
          QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        }),
        new Date(),
      ),
    );
    expect(failure).toMatchObject({
      code: 'CONFIG_LIMIT_INVALID',
      path: 'QAPAQ_DEMO_ADMIN_LOGIN_UNTIL',
    });
  });

  it(`tope de ${DEMO_ACCOUNTS_MAX} cuentas`, () => {
    const many = Array.from({ length: DEMO_ACCOUNTS_MAX + 1 }, (_, index) =>
      account(`cuenta${index}@qapaq.pe`, 'qapaq.soc.analyst'),
    );
    expect(
      loadDemoAdminLoginConfig(environment(many.slice(0, DEMO_ACCOUNTS_MAX)), new Date()),
    ).toMatchObject({ enabled: true });
    expect(failureOf(() => loadDemoAdminLoginConfig(environment(many), new Date()))).toMatchObject({
      code: 'CONFIG_LIMIT_INVALID',
      path: 'QAPAQ_DEMO_ACCOUNTS',
    });
    expect(
      failureOf(() => loadDemoAdminLoginConfig(environment(' '.repeat(9_000)), new Date())),
    ).toMatchObject({ code: 'CONFIG_LIMIT_INVALID', path: 'QAPAQ_DEMO_ACCOUNTS' });
  });

  it.each([
    ['JSON inválido', '{no-json', 'NOT_JSON'],
    ['objeto en vez de arreglo', { username: 'a@qapaq.pe' }, 'NOT_A_NON_EMPTY_ARRAY'],
    ['arreglo vacío', [], 'NOT_A_NON_EMPTY_ARRAY'],
    ['entrada no objeto', ['analista@qapaq.pe'], 'ENTRY_NOT_OBJECT'],
    [
      'campo extra (p. ej. roles múltiples)',
      [{ ...account('analista@qapaq.pe', 'qapaq.soc.analyst'), roles: ['qapaq.soc.lead'] }],
      'ENTRY_KEYS',
    ],
    ['falta el hash', [{ username: 'analista@qapaq.pe', role: 'qapaq.soc.analyst' }], 'ENTRY_KEYS'],
    ['usuario con mayúsculas', [account('Analista@qapaq.pe', 'qapaq.soc.analyst')], 'USERNAME_INVALID'],
    ['usuario con espacios', [account('ana lista@qapaq.pe', 'qapaq.soc.analyst')], 'USERNAME_INVALID'],
    ['usuario demasiado corto', [account('ab', 'qapaq.soc.analyst')], 'USERNAME_INVALID'],
    [
      'usuario duplicado',
      [account('analista@qapaq.pe', 'qapaq.soc.analyst'), account('analista@qapaq.pe', 'qapaq.soc.lead')],
      'USERNAME_DUPLICATE',
    ],
    ['mismo usuario que el admin', [account(ADMIN, 'qapaq.soc.analyst')], 'USERNAME_DUPLICATE'],
    ['rol aprobador de acceso', [account('a1@qapaq.pe', 'qapaq.access.approver')], 'ROLE_INVALID'],
    ['rol aprobador de seguridad', [account('a1@qapaq.pe', 'qapaq.security.approver')], 'ROLE_INVALID'],
    ['rol desconocido', [account('a1@qapaq.pe', 'qapaq.root')], 'ROLE_INVALID'],
    ['rol como lista', [{ ...account('a1@qapaq.pe', ''), role: ['qapaq.soc.lead'] }], 'ROLE_INVALID'],
    [
      'hash que no es scrypt',
      [account('a1@qapaq.pe', 'qapaq.soc.lead', 'plaintext')],
      'PASSWORD_HASH_INVALID',
    ],
  ])('rechaza %s sin citar el valor', (_label, accounts, reason) => {
    const failure = failureOf(() => loadDemoAdminLoginConfig(environment(accounts), new Date()));
    expect(failure).toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_DEMO_ACCOUNTS',
      details: expect.objectContaining({ reason }),
    });
    const serialized = JSON.stringify(failure) + failure.message;
    expect(serialized).not.toContain('analista@qapaq.pe');
    expect(serialized).not.toContain('plaintext');
  });
});

/** Identidad de Entra real (no la de la demo), como la de dev.security.qapaq.pe. */
const REAL_ENTRA_IDENTITY = {
  ...DEMO_IDENTITY,
  QAPAQ_ENTRA_TENANT_ID: '33333333-3333-4333-8333-333333333333',
  QAPAQ_ENTRA_CLIENT_ID: '44444444-4444-4444-8444-444444444444',
  QAPAQ_ENTRA_REDIRECT_URI: 'https://soc.cliente.example/api/auth/callback',
  QAPAQ_ENTRA_ALLOWED_REDIRECT_URIS: 'https://soc.cliente.example/api/auth/callback',
  QAPAQ_CONSOLE_BASE_URL: 'https://soc.cliente.example',
};

describe('QAPAQ_DEMO_LOGIN_WITH_ENTRA (convivencia con Entra real)', () => {
  const accounts = [
    account('lider@qapaq.pe', 'qapaq.soc.lead'),
    account('analista@qapaq.pe', 'qapaq.soc.analyst'),
  ];

  it('es una variable conocida', () => {
    expect(KNOWN_QAPAQ_VARIABLES.has('QAPAQ_DEMO_LOGIN_WITH_ENTRA')).toBe(true);
    expect(() => rejectUnknownQapaqVariables({ QAPAQ_DEMO_LOGIN_WITH_ENTRA: 'true' })).not.toThrow();
  });

  it('sin opt-in, producción con Entra real sigue rechazando la excepción', () => {
    const failure = failureOf(() =>
      loadDemoAdminLoginConfig(
        { ...REAL_ENTRA_IDENTITY, ...environment(accounts), QAPAQ_PROFILE: 'production' },
        new Date(),
      ),
    );
    expect(failure).toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_DEMO_ADMIN_LOGIN_ENABLED',
      details: { reason: 'DEMO_ADMIN_LOGIN_NOT_ALLOWED_IN_PROFILE' },
    });
  });

  it('con opt-in, admite el admin y las cuentas demo junto a la identidad real', () => {
    const config = loadDemoAdminLoginConfig(
      {
        ...REAL_ENTRA_IDENTITY,
        ...environment(accounts),
        QAPAQ_PROFILE: 'production',
        QAPAQ_DEMO_LOGIN_WITH_ENTRA: 'true',
      },
      new Date(),
    );
    expect(config).toMatchObject({ enabled: true, deployment: 'entra', username: ADMIN });
    expect(config.enabled && config.accounts.map((entry) => entry.role)).toEqual([
      'qapaq.soc.lead',
      'qapaq.soc.analyst',
    ]);
    expect(JSON.stringify(config)).not.toContain(HASH);
  });

  it('la identidad fija de la demo sigue siendo `demo`, con o sin opt-in', () => {
    for (const optIn of [undefined, 'true', 'false']) {
      const config = loadDemoAdminLoginConfig(
        {
          ...DEMO_IDENTITY,
          ...environment(accounts),
          QAPAQ_PROFILE: 'production',
          QAPAQ_DEMO_LOGIN_WITH_ENTRA: optIn,
        },
        new Date(),
      );
      expect(config).toMatchObject({ enabled: true, deployment: 'demo' });
    }
  });

  it('el opt-in conserva la ventana de 30 días, el tope de cuentas y la exclusión de aprobadores', () => {
    const base = {
      ...REAL_ENTRA_IDENTITY,
      QAPAQ_PROFILE: 'production',
      QAPAQ_DEMO_LOGIN_WITH_ENTRA: 'true',
    };
    expect(
      failureOf(() =>
        loadDemoAdminLoginConfig(
          {
            ...base,
            ...environment(accounts, {
              QAPAQ_DEMO_ADMIN_LOGIN_UNTIL: new Date(Date.now() + 31 * 86_400_000).toISOString(),
            }),
            QAPAQ_PROFILE: 'production',
          },
          new Date(),
        ),
      ),
    ).toMatchObject({ code: 'CONFIG_LIMIT_INVALID', path: 'QAPAQ_DEMO_ADMIN_LOGIN_UNTIL' });
    const tooMany = Array.from({ length: DEMO_ACCOUNTS_MAX + 1 }, (_, index) =>
      account(`cuenta${index}@qapaq.pe`, 'qapaq.soc.analyst'),
    );
    expect(
      failureOf(() =>
        loadDemoAdminLoginConfig(
          { ...base, ...environment(tooMany), QAPAQ_PROFILE: 'production' },
          new Date(),
        ),
      ),
    ).toMatchObject({ code: 'CONFIG_LIMIT_INVALID', path: 'QAPAQ_DEMO_ACCOUNTS' });
    for (const approver of ['qapaq.access.approver', 'qapaq.security.approver']) {
      expect(
        failureOf(() =>
          loadDemoAdminLoginConfig(
            {
              ...base,
              ...environment([account('aprobador@qapaq.pe', approver)]),
              QAPAQ_PROFILE: 'production',
            },
            new Date(),
          ),
        ),
      ).toMatchObject({ path: 'QAPAQ_DEMO_ACCOUNTS', details: { reason: 'ROLE_INVALID' } });
    }
  });

  it('el opt-in sin la excepción habilitada impide arrancar', () => {
    for (const flag of [undefined, 'false']) {
      expect(
        failureOf(() =>
          loadDemoAdminLoginConfig(
            {
              ...REAL_ENTRA_IDENTITY,
              QAPAQ_PROFILE: 'production',
              QAPAQ_DEMO_ADMIN_LOGIN_ENABLED: flag,
              QAPAQ_DEMO_LOGIN_WITH_ENTRA: 'true',
            },
            new Date(),
          ),
        ),
      ).toMatchObject({
        code: 'CONFIG_VALUE_INVALID',
        path: 'QAPAQ_DEMO_LOGIN_WITH_ENTRA',
        details: { reason: 'DEMO_LOGIN_WITH_ENTRA_REQUIRES_DEMO_ADMIN_LOGIN' },
      });
    }
  });

  it('un valor distinto de true/false impide arrancar', () => {
    expect(
      failureOf(() =>
        loadDemoAdminLoginConfig(
          {
            ...REAL_ENTRA_IDENTITY,
            ...environment(accounts),
            QAPAQ_PROFILE: 'production',
            QAPAQ_DEMO_LOGIN_WITH_ENTRA: 'yes',
          },
          new Date(),
        ),
      ),
    ).toMatchObject({ code: 'CONFIG_VALUE_INVALID', path: 'QAPAQ_DEMO_LOGIN_WITH_ENTRA' });
  });
});
