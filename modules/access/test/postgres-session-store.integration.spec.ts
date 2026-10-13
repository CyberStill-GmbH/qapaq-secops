/**
 * C-18/C-25 — sesiones del BFF contra PostgreSQL real.
 *
 * Además del ciclo de vida (crear, leer, compare-and-set, sesión única por persona), fija las
 * dos garantías de seguridad del adapter:
 * - la base nunca contiene el identificador de la cookie, solo su SHA-256;
 * - el hash no sirve como cookie: `byId('h:<hash>')` no devuelve la sesión.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresSessionStore,
  sessionIdHash,
} from '../src/infrastructure/postgres-session-store.js';
import { revokeSession, type Session } from '../src/session.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../../../platform/database/', import.meta.url));
const AT = new Date('2026-10-12T15:00:00.000Z');

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: randomBytes(32).toString('base64url'),
    subjectId: 'sub-analista-1',
    displayName: 'Analista Sintética',
    email: 'analista@qapaq-lab.example',
    tenantId: 'tenant-sessions',
    state: 'active',
    roles: ['qapaq.soc.analyst'],
    scopes: ['soc.read'],
    capabilities: new Set(['alerts.read', 'incidents.read']),
    amr: ['pwd', 'mfa'],
    createdAt: AT,
    lastSeenAt: AT,
    absoluteExpiresAt: new Date(AT.getTime() + 8 * 3_600_000),
    clientIp: '10.20.0.15',
    revision: 1,
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)('C-18 · sesiones en PostgreSQL', () => {
  const name = `qapaq_sess_${process.pid}_${Date.now()}`.toLowerCase();
  let url: string;
  let store: PostgresSessionStore;

  beforeAll(async () => {
    const admin = new URL(databaseUrl!);
    admin.pathname = '/postgres';
    const client = new Client(admin.toString());
    await client.connect();
    await client.query(`CREATE DATABASE "${name}"`);
    await client.end();
    const target = new URL(databaseUrl!);
    target.pathname = `/${name}`;
    url = target.toString();
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: url },
        shell: process.platform === 'win32',
      },
    );
    store = PostgresSessionStore.connect({ connectionString: url, maxConnections: 4 });
  });

  afterAll(async () => {
    await store?.close();
    const admin = new URL(databaseUrl!);
    admin.pathname = '/postgres';
    const client = new Client(admin.toString());
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.end();
  });

  it('crea y lee la sesión por el valor de la cookie, y sobrevive a reabrir la conexión', async () => {
    const created = session();
    await store.create(created);
    await store.close();
    store = PostgresSessionStore.connect({ connectionString: url, maxConnections: 4 });

    const read = await store.byId(created.id);
    expect(read).toMatchObject({ id: created.id, subjectId: 'sub-analista-1', state: 'active' });
    expect([...read!.capabilities].sort()).toEqual(['alerts.read', 'incidents.read']);
  });

  it('la base guarda solo el SHA-256 del identificador', async () => {
    const created = session();
    await store.create(created);
    const client = new Client(url);
    await client.connect();
    try {
      const dump = await client.query('SELECT row_to_json(s)::text AS row FROM access_sessions s');
      const text = dump.rows.map((row) => row.row as string).join('\n');
      expect(text).not.toContain(created.id);
      expect(text).toContain(sessionIdHash(created.id));
    } finally {
      await client.end();
    }
  });

  it('el hash no funciona como cookie', async () => {
    const created = session();
    await store.create(created);

    expect(await store.byId(`h:${sessionIdHash(created.id)}`)).toBeUndefined();
  });

  it('aplica compare-and-set sobre la revisión', async () => {
    const created = session();
    await store.create(created);
    const touched = { ...created, lastSeenAt: new Date(AT.getTime() + 60_000), revision: 2 };

    expect(await store.update(touched, 1)).toBe(true);
    expect(await store.update({ ...touched, revision: 3 }, 1)).toBe(false);
  });

  it('activeBySubject permite revocar sin conocer los ids originales', async () => {
    const subjectId = 'sub-lider-1';
    const first = session({ subjectId });
    await store.create(first);

    const active = await store.activeBySubject('tenant-sessions', subjectId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id.startsWith('h:')).toBe(true);
    expect(active[0]!.id).not.toContain(first.id);

    const revoked = revokeSession(active[0]!, 'superseded', AT);
    expect(await store.update(revoked, active[0]!.revision)).toBe(true);
    expect(await store.activeBySubject('tenant-sessions', subjectId)).toHaveLength(0);
    expect((await store.byId(first.id))?.state).toBe('superseded');
  });

  it('la administración lista por tenant y resuelve por referencia, no por cookie', async () => {
    const created = session({ tenantId: 'tenant-admin', subjectId: 'sub-admin-view' });
    await store.create(created);

    const recent = await store.recentByTenant('tenant-admin', new Date(AT.getTime() - 1), 10);
    const reference = recent[0]!.id;

    expect(recent).toHaveLength(1);
    expect(reference).toBe(`h:${sessionIdHash(created.id)}`);
    expect((await store.byReference(reference))?.subjectId).toBe('sub-admin-view');
    // Una cookie no sirve como referencia ni una referencia como cookie.
    expect(await store.byReference(created.id)).toBeUndefined();
    expect(await store.byId(reference)).toBeUndefined();
    expect(await store.recentByTenant('otro-tenant', new Date(0), 10)).toHaveLength(0);
  });

  it('S5 · busca sesiones activas por OID de Entra, sin distinguir mayúsculas', async () => {
    const oid = '44444444-4444-4444-8444-444444444444';
    const created = session({
      tenantId: 'tenant-oid',
      subjectId: 'sub-oid',
      oid: oid.toUpperCase(),
    });
    await store.create(created);
    const active = await store.activeByOid('tenant-oid', oid);
    expect(active).toHaveLength(1);
    expect(active[0]!.oid).toBe(oid);
    expect(active[0]!.id).toBe(`h:${sessionIdHash(created.id)}`);
    expect(await store.activeByOid('otro-tenant', oid)).toHaveLength(0);
  });
});
