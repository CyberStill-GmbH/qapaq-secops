/**
 * C-1 / D-6 — roles de mínimo privilegio contra PostgreSQL real.
 *
 * Aplica `bootstrap/roles.sql` como lo haría la tarea `bootstrap-roles` (con un usuario
 * administrador), migra como `qapaq_migrator`, reaplica `post-migrate.sql` y comprueba con
 * conexiones reales lo que cada rol puede y no puede hacer. Un `GRANT` mal escrito solo se
 * detecta así: el SQL puede ser válido y aun así conceder de más.
 *
 * Usa nombres de rol globales del clúster: corre contra una base efímera de pruebas, nunca
 * contra un clúster compartido.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../', import.meta.url));
const migratorPassword = randomBytes(32).toString('base64url');
const runtimePassword = randomBytes(32).toString('base64url');

function urlFor(base: string, database: string, user?: string, password?: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

async function run(url: string, sql: string, params: readonly unknown[] = []) {
  const client = new Client(url);
  await client.connect();
  try {
    return await client.query(sql, [...params]);
  } finally {
    await client.end();
  }
}

async function bootstrap(url: string) {
  const sql = await readFile(new URL('../bootstrap/roles.sql', import.meta.url), 'utf8');
  const client = new Client(url);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('qapaq.migrator_password', $1, true), set_config('qapaq.runtime_password', $2, true)",
      [migratorPassword, runtimePassword],
    );
    await client.query(sql);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

describe.skipIf(!databaseUrl)('C-1 · roles de mínimo privilegio', () => {
  const name = `qapaq_roles_${process.pid}_${Date.now()}`.toLowerCase();
  let adminUrl: string;
  let migratorUrl: string;
  let runtimeUrl: string;

  beforeAll(async () => {
    const admin = urlFor(databaseUrl!, 'postgres');
    await run(admin, `CREATE DATABASE "${name}"`);
    adminUrl = urlFor(databaseUrl!, name);
    migratorUrl = urlFor(databaseUrl!, name, 'qapaq_migrator', migratorPassword);
    runtimeUrl = urlFor(databaseUrl!, name, 'qapaq_soc_runtime', runtimePassword);

    // Orden real del rollout: roles → migración como migrator → endurecimiento.
    await bootstrap(adminUrl);
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: migratorUrl },
        shell: process.platform === 'win32',
      },
    );
    const hardening = await readFile(
      new URL('../bootstrap/post-migrate.sql', import.meta.url),
      'utf8',
    );
    await run(migratorUrl, hardening);
  });

  afterAll(async () => {
    await run(urlFor(databaseUrl!, 'postgres'), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  it('el bootstrap es idempotente: aplicarlo de nuevo no falla', async () => {
    await expect(bootstrap(adminUrl)).resolves.toBeUndefined();
  });

  it('el runtime lee y escribe datos SOC', async () => {
    await expect(run(runtimeUrl, 'SELECT count(*) FROM soc_alerts')).resolves.toBeDefined();
    await expect(
      run(runtimeUrl, 'SELECT count(*) FROM soc_outbox_messages'),
    ).resolves.toBeDefined();
  });

  it('las tablas de migraciones posteriores (sesiones) heredan DML sin DELETE', async () => {
    await expect(run(runtimeUrl, 'SELECT count(*) FROM access_sessions')).resolves.toBeDefined();
    await expect(run(runtimeUrl, 'DELETE FROM access_sessions')).rejects.toThrow(/permission/iu);
  });

  it('el runtime no puede DDL', async () => {
    await expect(run(runtimeUrl, 'CREATE TABLE intruso (id int)')).rejects.toThrow(/permission/iu);
    await expect(run(runtimeUrl, 'ALTER TABLE soc_alerts ADD COLUMN x int')).rejects.toThrow(
      /owner|permission/iu,
    );
    await expect(run(runtimeUrl, 'DROP TABLE soc_alerts')).rejects.toThrow(/owner|permission/iu);
  });

  it('el runtime no puede borrar ni truncar', async () => {
    await expect(run(runtimeUrl, 'DELETE FROM soc_alerts')).rejects.toThrow(/permission/iu);
    await expect(run(runtimeUrl, 'TRUNCATE soc_incidents')).rejects.toThrow(/permission/iu);
  });

  it('el runtime no puede modificar auditoría ni el historial de migraciones', async () => {
    await expect(run(runtimeUrl, "UPDATE audit_events SET outcome = 'denied'")).rejects.toThrow(
      /permission/iu,
    );
    await expect(run(runtimeUrl, "UPDATE _prisma_migrations SET logs = 'x'")).rejects.toThrow(
      /permission/iu,
    );
    await expect(run(runtimeUrl, 'SELECT count(*) FROM _prisma_migrations')).resolves.toBeDefined();
  });

  it('la bitácora de incidente es append-only también por permiso (S5-D8)', async () => {
    await expect(run(runtimeUrl, 'SELECT count(*) FROM incident_notes')).resolves.toBeDefined();
    await expect(run(runtimeUrl, "UPDATE incident_notes SET body = 'x'")).rejects.toThrow(
      /permission/iu,
    );
    await expect(run(runtimeUrl, 'SELECT count(*) FROM incident_tasks')).resolves.toBeDefined();
    await expect(
      run(runtimeUrl, "UPDATE source_health_transitions SET reason = 'X'"),
    ).rejects.toThrow(/permission/iu);
    await expect(
      run(runtimeUrl, 'SELECT count(*) FROM source_poll_observations'),
    ).resolves.toBeDefined();
  });

  it('ninguno de los dos roles puede crear roles ni bases', async () => {
    const attributes = await run(
      adminUrl,
      `SELECT rolname, rolcreaterole, rolcreatedb, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname IN ('qapaq_migrator', 'qapaq_soc_runtime') ORDER BY rolname`,
    );
    for (const row of attributes.rows) {
      expect(row).toMatchObject({
        rolcreaterole: false,
        rolcreatedb: false,
        rolsuper: false,
        rolbypassrls: false,
      });
    }
  });

  it('las tablas pertenecen al migrator, no al administrador', async () => {
    const owners = await run(
      adminUrl,
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(owners.rows.map((row) => row.owner)).toEqual(['qapaq_migrator']);
  });
});
