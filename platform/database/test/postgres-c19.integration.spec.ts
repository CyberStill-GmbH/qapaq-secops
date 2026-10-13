/**
 * C-17/C-19/C-20 — specs contra PostgreSQL real.
 *
 * Lo que solo se puede demostrar aquí, y no con un doble en memoria:
 * que la base rechaza modificar auditoría, que la unicidad resuelve la carrera por la
 * secuencia, y que un fallo a mitad de la transacción no deja estado, auditoría ni
 * mensaje de outbox a medias.
 *
 * Se ejecuta cuando hay `DATABASE_URL`; sin Docker, queda declarada como BLOCKED en la
 * matriz de C-22 en lugar de pasar en silencio.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabaseClient, createDatabaseClient } from '../src/client.js';
import { PrismaSocUnitOfWork, type AlertRow, type SealedAuditRow } from '../src/soc-stores.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../', import.meta.url));

const TENANT = 'tenant-c19';
const CANDIDATE_ID = '0199c190-0000-7000-8000-000000000001';
const ALERT_ID = '0199c190-0000-7000-8000-000000000002';

function auditEvent(sequence: bigint, previousHash: string, suffix: string): SealedAuditRow {
  return {
    id: `0199c190-0000-7000-8000-0000000001${suffix.padStart(2, '0')}`,
    tenantId: TENANT,
    sequence,
    occurredAt: new Date('2026-10-08T09:00:00.000Z'),
    actor: { id: 'analyst-1', type: 'user', sessionId: 'sess-1', ip: '10.20.5.9' },
    action: 'soc.alert.triage',
    resource: { type: 'alert', id: ALERT_ID },
    outcome: 'succeeded',
    correlationId: `corr-${suffix}`,
    metadata: { from: 'acknowledged', to: 'triaged' },
    previousHash,
    hash: `${suffix.padStart(2, '0')}${'c'.repeat(62)}`,
  };
}

function alertRow(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: ALERT_ID,
    tenantId: TENANT,
    candidateId: CANDIDATE_ID,
    eventRecordId: '0199c190-0000-7000-8000-000000000003',
    title: 'Acceso sospechoso',
    priority: 'P1',
    score: 95,
    reasons: [{ code: 'BASE_SEVERITY', delta: 80, detail: 'crítico' }],
    status: 'new',
    assigneeId: null,
    verdict: null,
    triageNote: null,
    incidentId: null,
    occurredAt: new Date('2026-10-08T09:00:00.000Z'),
    createdAt: new Date('2026-10-08T09:00:01.000Z'),
    updatedAt: new Date('2026-10-08T09:00:01.000Z'),
    revision: 1,
    entityKeys: ['user:analista@qapaq-lab.example'],
    entityRefs: ['ent_AAAAAAAAAAAAAAAAAAAAAA'],
    signal: 'credential_access',
    ruleId: '100502',
    relatedAlertIds: [],
    ...overrides,
  };
}

async function provisionDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for C-19 PostgreSQL integration');
  const parsed = new URL(databaseUrl);
  const name = `qapaq_c19_${process.pid}_${Date.now()}`.toLowerCase();
  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const admin = new Client(adminUrl.toString());
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  parsed.pathname = `/${name}`;
  const url = parsed.toString();
  try {
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: url },
        shell: process.platform === 'win32',
      },
    );
    return { admin, name, url };
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('C-19 · auditoría append-only sobre PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof provisionDatabase>> | undefined;
  let client: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    database = await provisionDatabase();
    client = createDatabaseClient({ connectionString: database.url, maxConnections: 6 });
    await client.detectionCandidate.create({
      data: {
        id: CANDIDATE_ID,
        tenantId: TENANT,
        eventRecordId: '0199c190-0000-7000-8000-000000000003',
        eventUid: 'siem:alerts:evt-1',
        idempotencyKey: 'key-1',
        priority: 'P1',
        score: 95,
        reasons: [{ code: 'BASE_SEVERITY', delta: 80, detail: 'crítico' }],
        rulesetId: 'qapaq.detection.prioritization',
        rulesetVersion: '1.0.0',
        title: 'Acceso sospechoso',
        occurredAt: new Date('2026-10-08T09:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    if (!database) return;
    await closeDatabaseClient(client);
    await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end();
  });

  it('inserta la cadena y la devuelve en orden de secuencia', async () => {
    const work = new PrismaSocUnitOfWork(client);
    await work.run(async ({ audit }) => {
      await audit.append(auditEvent(1n, '0'.repeat(64), '1'));
      await audit.append(auditEvent(2n, `01${'c'.repeat(62)}`, '2'));
    });

    const rows = await work.run(({ audit }) => audit.range(TENANT, 1n, 10));

    expect(rows.map((row) => row.sequence)).toEqual([1n, 2n]);
    expect(rows[1]?.previousHash).toBe(rows[0]?.hash);
  });

  it('rechaza UPDATE sobre una fila de auditoría', async () => {
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "audit_events" SET "outcome" = 'denied' WHERE "tenant_id" = $1`,
        TENANT,
      ),
    ).rejects.toThrow(/append-only/u);
  });

  it('rechaza DELETE y TRUNCATE sobre auditoría', async () => {
    await expect(
      client.$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "tenant_id" = $1`, TENANT),
    ).rejects.toThrow(/append-only/u);
    await expect(client.$executeRawUnsafe('TRUNCATE "audit_events"')).rejects.toThrow(
      /append-only/u,
    );
  });

  it('resuelve la carrera por la secuencia con la unicidad de la base', async () => {
    const work = new PrismaSocUnitOfWork(client);
    const results = await Promise.allSettled([
      work.run(({ audit }) => audit.append(auditEvent(3n, `02${'c'.repeat(62)}`, '3'))),
      work.run(({ audit }) => audit.append(auditEvent(3n, `02${'c'.repeat(62)}`, '4'))),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('no deja alerta ni auditoría si la transacción falla', async () => {
    const work = new PrismaSocUnitOfWork(client);
    const before = await work.run(({ audit }) => audit.range(TENANT, 1n, 100));

    await expect(
      work.run(async ({ alerts, audit }) => {
        await alerts.insertIfAbsent(alertRow());
        await audit.append(auditEvent(99n, `02${'c'.repeat(62)}`, '9'));
        throw new Error('FALLO_DELIBERADO');
      }),
    ).rejects.toThrow('FALLO_DELIBERADO');

    const after = await work.run(({ audit }) => audit.range(TENANT, 1n, 100));
    const alert = await work.run(({ alerts }) => alerts.byId(TENANT, ALERT_ID));

    expect(after).toHaveLength(before.length);
    expect(alert).toBeUndefined();
  });

  it('aplica compare-and-set sobre la revisión de la alerta', async () => {
    const work = new PrismaSocUnitOfWork(client);
    await work.run(({ alerts }) => alerts.insertIfAbsent(alertRow()));

    const [first, second] = await Promise.all([
      work.run(({ alerts }) =>
        alerts.update({ ...alertRow(), status: 'acknowledged', revision: 2 }, 1),
      ),
      work.run(({ alerts }) => alerts.update({ ...alertRow(), status: 'closed', revision: 2 }, 1)),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('impide un triaje sin veredicto ni nota mediante CHECK', async () => {
    const work = new PrismaSocUnitOfWork(client);

    await expect(
      work.run(({ alerts }) => alerts.update({ ...alertRow(), status: 'triaged', revision: 3 }, 2)),
    ).rejects.toThrow(/soc_alerts_triage_complete/u);
  });

  it('no admite dos alertas para el mismo candidato', async () => {
    const work = new PrismaSocUnitOfWork(client);
    const inserted = await work.run(({ alerts }) =>
      alerts.insertIfAbsent(alertRow({ id: '0199c190-0000-7000-8000-00000000000f' })),
    );

    expect(inserted).toBe(false);
  });
});
