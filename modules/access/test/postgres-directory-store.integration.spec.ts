/**
 * Sprint 5 · fase 3 — padrón en PostgreSQL real.
 *
 * Fija lo que solo la base demuestra: un único claim concurrente, el fencing del commit, las
 * bajas por lectura completa como cambio de estado (el runtime no tiene DELETE) y el reemplazo
 * de dueños sin borrar filas.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDirectoryStore } from '../src/infrastructure/postgres-directory-store.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../../../platform/database/', import.meta.url));
const TENANT = 'tenant-dir-pg';
const GROUP = '99999999-9999-4999-8999-999999999999';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';
const DUENO = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-10-12T21:00:00.000Z');
const person = (oid: string) => ({
  oid,
  displayName: oid.slice(0, 4),
  upn: null,
  accountEnabled: true,
});

describe.skipIf(!databaseUrl)('S5 · fase 3 · padrón en PostgreSQL', () => {
  const name = `qapaq_dir_${process.pid}_${Date.now()}`.toLowerCase();
  let url: string;
  let store: PostgresDirectoryStore;

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
    store = PostgresDirectoryStore.connect({ connectionString: url, maxConnections: 4 });
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

  it('un solo claim concurrente; un claim ajeno no confirma nada', async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claimSync(TENANT, GROUP, AT, 60_000)),
    );
    const winners = claims.filter((claim) => claim !== undefined);
    expect(winners).toHaveLength(1);
    const stale = { ...winners[0]!, claimId: '00000000-0000-4000-8000-000000000000' };
    expect(
      await store.commitSync(stale, {
        at: AT,
        changes: [{ kind: 'upsert', person: person(ANA) }],
        fullRead: true,
        owners: [],
        deltaLink: 'https://graph.microsoft.com/d0',
      }),
    ).toBe(false);
    expect(await store.members(TENANT, GROUP)).toEqual([]);

    expect(
      await store.commitSync(winners[0]!, {
        at: AT,
        changes: [
          { kind: 'upsert', person: person(ANA) },
          { kind: 'upsert', person: person(BETO) },
        ],
        fullRead: true,
        owners: [person(DUENO)],
        deltaLink: 'https://graph.microsoft.com/d1',
      }),
    ).toBe(true);
    expect(await store.syncState(TENANT, GROUP)).toMatchObject({
      status: 'ok',
      deltaLink: 'https://graph.microsoft.com/d1',
    });
  });

  it('lectura completa: bajas y reemplazo de dueños como estado, sin borrar filas', async () => {
    const claim = await store.claimSync(TENANT, GROUP, new Date(AT.getTime() + 1), 60_000);
    expect(
      await store.commitSync(claim!, {
        at: AT,
        changes: [{ kind: 'upsert', person: person(ANA) }],
        fullRead: true,
        owners: [person(ANA)],
        deltaLink: 'https://graph.microsoft.com/d2',
      }),
    ).toBe(true);
    expect((await store.member(TENANT, GROUP, BETO))?.membership).toBe('removed');
    expect((await store.owners(TENANT, GROUP)).map((owner) => owner.oid)).toEqual([ANA]);

    const client = new Client(url);
    await client.connect();
    try {
      const rows = await client.query('SELECT count(*)::int AS n FROM directory_owners');
      expect(rows.rows[0].n).toBe(2);
      // El enlace delta solo puede apuntar al proveedor.
      await expect(
        client.query(`UPDATE directory_sync_state SET delta_link = 'https://otro.example/x'`),
      ).rejects.toThrow(/directory_sync_state_delta_link_origin/u);
    } finally {
      await client.end();
    }
  });

  it('un ciclo fallido con delta vencido limpia el enlace y libera el lease', async () => {
    const claim = await store.claimSync(TENANT, GROUP, new Date(AT.getTime() + 2), 60_000);
    await store.failSync(claim!, 'DIRECTORY_DELTA_EXPIRED', AT, true);
    expect(await store.syncState(TENANT, GROUP)).toMatchObject({
      status: 'failed',
      deltaLink: null,
      lastErrorClass: 'DIRECTORY_DELTA_EXPIRED',
    });
    expect(await store.claimSync(TENANT, GROUP, new Date(AT.getTime() + 3), 60_000)).toBeDefined();
  });
});
