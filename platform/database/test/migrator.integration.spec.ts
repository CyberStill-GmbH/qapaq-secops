/**
 * D-11 / D-12 — protocolo de bootstrap recuperable y redacción de la salida del migrator.
 *
 * El Secrets Manager es un doble en memoria que reproduce las etiquetas de versión
 * (`AWSPENDING`/`AWSCURRENT`): lo que se prueba es nuestro protocolo, no AWS. La base sí es
 * PostgreSQL real: la garantía se comprueba iniciando sesión con la contraseña vigente.
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error — módulo JS del migrator, sin declaraciones de tipos.
import { runBootstrapProtocol } from '../migrator/bootstrap-protocol.mjs';

const databaseUrl = process.env['DATABASE_URL'];
const ROLES = [
  { role: 'qapaq_migrator', secretId: 'postgres/migrator' },
  { role: 'qapaq_soc_runtime', secretId: 'postgres/soc-runtime' },
] as const;

interface Version {
  value: { username: string; password: string };
  stages: Set<string>;
}

/** Doble de Secrets Manager con etiquetas de versión y fallos inyectables por operación. */
class FakeSecrets {
  public readonly secrets = new Map<string, Map<string, Version>>();
  public staged = 0;
  public failNext: { operation: 'promote'; secretId?: string } | undefined;

  private versions(secretId: string): Map<string, Version> {
    let versions = this.secrets.get(secretId);
    if (!versions) this.secrets.set(secretId, (versions = new Map()));
    return versions;
  }

  public current(secretId: string): string | undefined {
    for (const version of this.versions(secretId).values()) {
      if (version.stages.has('AWSCURRENT')) return version.value.password;
    }
    return undefined;
  }

  public port() {
    return {
      pending: async (secretId: string) => {
        for (const [versionId, version] of this.versions(secretId)) {
          if (version.stages.has('AWSPENDING') && !version.stages.has('AWSCURRENT')) {
            return { versionId, password: version.value.password };
          }
        }
        return null;
      },
      stagePending: async (secretId: string, value: { username: string; password: string }) => {
        this.staged += 1;
        const versionId = randomUUID();
        for (const version of this.versions(secretId).values()) version.stages.delete('AWSPENDING');
        this.versions(secretId).set(versionId, { value, stages: new Set(['AWSPENDING']) });
        return versionId;
      },
      promote: async (secretId: string, versionId: string) => {
        if (
          this.failNext?.operation === 'promote' &&
          (!this.failNext.secretId || this.failNext.secretId === secretId)
        ) {
          this.failNext = undefined;
          throw new Error('SECRETS_MANAGER_UNAVAILABLE');
        }
        const target = this.versions(secretId).get(versionId)!;
        if (target.stages.has('AWSCURRENT')) return false;
        for (const version of this.versions(secretId).values()) version.stages.delete('AWSCURRENT');
        target.stages.add('AWSCURRENT');
        target.stages.delete('AWSPENDING');
        return true;
      },
    };
  }
}

function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

async function canLogin(database: string, user: string, password: string): Promise<boolean> {
  const client = new Client(urlFor(database, user, password));
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe.skipIf(!databaseUrl)('D-11 · bootstrap recuperable contra PostgreSQL real', () => {
  const database = `qapaq_boot_${process.pid}_${Date.now()}`.toLowerCase();
  let sql: string;

  const applyRoles = async (passwords: Record<string, string>) => {
    const client = new Client(urlFor(database));
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('qapaq.migrator_password', $1, true), set_config('qapaq.runtime_password', $2, true)",
        [passwords['qapaq_migrator'], passwords['qapaq_soc_runtime']],
      );
      await client.query(sql);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  };

  const run = (secrets: FakeSecrets, events: string[] = []) =>
    runBootstrapProtocol({
      secrets: secrets.port(),
      roles: ROLES,
      applyRoles,
      generatePassword: () => randomBytes(32).toString('base64url'),
      log: (event: string) => events.push(event),
    });

  /** La garantía: la contraseña vigente de cada secreto abre sesión en la base. */
  async function currentCredentialsWork(secrets: FakeSecrets): Promise<boolean> {
    for (const { role, secretId } of ROLES) {
      const password = secrets.current(secretId);
      if (!password || !(await canLogin(database, role, password))) return false;
    }
    return true;
  }

  beforeAll(async () => {
    sql = await readFile(new URL('../bootstrap/roles.sql', import.meta.url), 'utf8');
    const admin = new Client(urlFor('postgres'));
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();
  });

  afterAll(async () => {
    const admin = new Client(urlFor('postgres'));
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });

  it('una corrida limpia deja secretos vigentes que coinciden con la base', async () => {
    const secrets = new FakeSecrets();
    await run(secrets);

    expect(await currentCredentialsWork(secrets)).toBe(true);
  });

  it('fallo después del COMMIT: el reintento reutiliza la candidata y completa', async () => {
    const secrets = new FakeSecrets();
    await run(secrets);
    const before = secrets.staged;

    // Rotación que cae al promover el primer secreto, con la base ya cambiada.
    secrets.failNext = { operation: 'promote' };
    await expect(run(secrets)).rejects.toThrow('SECRETS_MANAGER_UNAVAILABLE');
    expect(await currentCredentialsWork(secrets)).toBe(false);

    const events: string[] = [];
    await run(secrets, events);

    expect(secrets.staged).toBe(before + 2);
    expect(events.filter((event) => event === 'bootstrap.candidate_reused')).toHaveLength(2);
    expect(await currentCredentialsWork(secrets)).toBe(true);
  });

  it('fallo entre las dos promociones: el reintento completa solo lo que falta', async () => {
    const secrets = new FakeSecrets();
    await run(secrets);

    secrets.failNext = { operation: 'promote', secretId: 'postgres/soc-runtime' };
    await expect(run(secrets)).rejects.toThrow('SECRETS_MANAGER_UNAVAILABLE');

    const events: string[] = [];
    await run(secrets, events);

    // El migrator ya estaba promovido y no se genera una tercera contraseña.
    expect(events).toContain('bootstrap.candidate_reused');
    expect(await currentCredentialsWork(secrets)).toBe(true);
  });

  it('una rotación completa invalida las contraseñas anteriores', async () => {
    const secrets = new FakeSecrets();
    await run(secrets);
    const previous = secrets.current('postgres/soc-runtime')!;

    await run(secrets);

    expect(await canLogin(database, 'qapaq_soc_runtime', previous)).toBe(false);
    expect(await currentCredentialsWork(secrets)).toBe(true);
  });
});

describe('D-12 · la salida del migrator no expone credenciales', () => {
  it('un fallo de conexión no imprime la contraseña ni la URL', async () => {
    const canary = `CANARY${randomBytes(12).toString('hex')}`;
    const entrypoint = fileURLToPath(new URL('../migrator/entrypoint.mjs', import.meta.url));
    const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(process.execPath, [entrypoint, 'migrate'], {
        env: {
          ...process.env,
          QAPAQ_POSTGRES_HOST: '127.0.0.1',
          QAPAQ_POSTGRES_PORT: '1',
          QAPAQ_POSTGRES_DATABASE: 'qapaq_canary',
          QAPAQ_POSTGRES_TLS: 'false',
          QAPAQ_MIGRATOR_PASSWORD: canary,
        },
      });
      let text = '';
      child.stdout.on('data', (chunk) => (text += String(chunk)));
      child.stderr.on('data', (chunk) => (text += String(chunk)));
      child.on('exit', (code) => resolve({ code, text }));
    });

    expect(output.code).not.toBe(0);
    expect(output.text).toContain('"event":"failed"');
    expect(output.text).not.toContain(canary);
    expect(output.text).not.toMatch(/postgres(?:ql)?:\/\/[^[]/iu);
  }, 120_000);
});
