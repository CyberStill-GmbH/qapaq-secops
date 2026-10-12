/**
 * C-16/C-17 — adapter `PostgresSocPersistence` contra PostgreSQL real.
 *
 * Lo que solo se demuestra aquí y no con el adapter en memoria:
 *
 * - el estado SOC sobrevive a cerrar y reabrir la conexión (equivalente a reiniciar el BFF);
 * - candidato y alerta respetan la FK y la idempotencia de la base;
 * - la ventana de correlación usa `entity_keys` (`&&` sobre el índice GIN);
 * - la cola del outbox reclama con lease: sin doble claim concurrente, recuperación al
 *   vencer el lease y publicación definitiva;
 * - la cadena de auditoría no se bifurca con escritores concurrentes fuera de transacción;
 * - una fila con un valor fuera de catálogo se reporta como error de integridad.
 *
 * Se ejecuta con `DATABASE_URL` (base administrativa); sin ella queda omitida y la matriz
 * de C-22 la declara BLOCKED en lugar de darla por buena.
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAudit } from '@qapaq/audit';
import { candidateId, promotionKey, type DetectionCandidate } from '@qapaq/detection';

import { PostgresSocPersistence, SocIntegrityError } from '../src/infrastructure/postgres-soc.js';
import { ingestCandidate, type SocDependencies } from '../src/use-cases.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../../../platform/database/', import.meta.url));

const TENANT = 'tenant-c17-pg';
const USER_KEY = 'user:usuario.sintetico@qapaq-lab.example';
const IP_KEY = 'ip:203.0.113.24';

async function provisionDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL es obligatorio para esta spec.');
  const parsed = new URL(databaseUrl);
  const name = `qapaq_c17_${process.pid}_${Date.now()}`.toLowerCase();
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

function candidate(
  sequence: number,
  overrides: Partial<DetectionCandidate> = {},
): DetectionCandidate {
  const eventRecordId = `0199c170-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
  const occurredAt = new Date(Date.UTC(2026, 9, 11, 12, sequence));
  const key = promotionKey(TENANT, eventRecordId, '1.1.0');
  return {
    id: candidateId(key, occurredAt),
    tenantId: TENANT,
    eventRecordId,
    eventUid: `siem-qapaq-lab:alerts:evt-${sequence}`,
    idempotencyKey: key,
    priority: 'P2',
    score: 70,
    reasons: [{ code: 'BASE_SEVERITY', delta: 60, detail: 'Severidad alta.' }],
    rulesetId: 'qapaq.detection.prioritization',
    rulesetVersion: '1.1.0',
    occurredAt,
    createdAt: new Date(occurredAt.getTime() + 1_000),
    title: `Regla de bandeja ${sequence}`,
    entityKeys: [IP_KEY, USER_KEY],
    signal: 'persistence',
    ruleId: '100510',
    relatedAlertIds: [],
    ...overrides,
  };
}

function refOf(tenantId: string, entityKey: string): string {
  return `ent_${createHash('sha256').update(`${tenantId}|${entityKey}`).digest('base64url').slice(0, 22)}`;
}

function dependencies(persistence: PostgresSocPersistence): SocDependencies {
  return {
    unitOfWork: persistence,
    clock: { now: () => new Date('2026-10-11T13:00:00.000Z') },
    ids: { next: () => randomUUID() },
    // Referencia opaca determinista de prueba (en el API es un HMAC con clave secreta).
    entityRefs: refOf,
  };
}

describe.skipIf(!databaseUrl)('C-17 · persistencia SOC sobre PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof provisionDatabase>> | undefined;
  let persistence: PostgresSocPersistence;

  const connect = () =>
    PostgresSocPersistence.connect({ connectionString: database!.url, maxConnections: 6 });

  beforeAll(async () => {
    database = await provisionDatabase();
    persistence = connect();
    await persistence.ready();
  });

  afterAll(async () => {
    if (!database) return;
    await persistence.close();
    await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end();
  });

  it('materializa candidato y alerta, y la alerta sobrevive a reabrir la conexión', async () => {
    const first = candidate(1);
    const result = await ingestCandidate(dependencies(persistence), first);
    expect(result.ok && result.value.created).toBe(true);

    // Reabrir la conexión es lo que ocurre al reiniciar el BFF.
    await persistence.close();
    persistence = connect();

    const alert = await persistence.alertById(TENANT, first.id);
    expect(alert).toMatchObject({
      id: first.id,
      status: 'new',
      priority: 'P2',
      entityKeys: [IP_KEY, USER_KEY],
      signal: 'persistence',
      ruleId: '100510',
    });
    expect(await persistence.alertByEventRecordId(TENANT, first.eventRecordId)).toBeDefined();
  });

  it('repetir la ingesta no crea una segunda alerta ni un segundo candidato', async () => {
    const again = await ingestCandidate(dependencies(persistence), candidate(1));
    const listing = await persistence.listAlerts({ tenantId: TENANT });

    expect(again.ok && again.value.created).toBe(false);
    expect(listing.total).toBe(1);
  });

  it('la ventana de correlación encuentra alertas por clave compartida y respeta el horizonte', async () => {
    await ingestCandidate(
      dependencies(persistence),
      candidate(2, { entityKeys: ['ip:198.51.100.9', USER_KEY] }),
    );
    await ingestCandidate(
      dependencies(persistence),
      candidate(3, { entityKeys: ['user:otra@qapaq-lab.example'] }),
    );

    const byUser = await persistence.recentByEntities(
      TENANT,
      [USER_KEY],
      new Date('2026-10-11T00:00:00.000Z'),
      50,
    );
    const afterHorizon = await persistence.recentByEntities(
      TENANT,
      [USER_KEY],
      new Date('2026-10-11T12:02:30.000Z'),
      50,
    );

    expect(byUser.map((alert) => alert.ruleId)).toEqual(['100510', '100510']);
    expect(byUser).toHaveLength(2);
    expect(afterHorizon).toHaveLength(0);
  });

  it('filtra el listado por entidad, estado y búsqueda', async () => {
    const byEntity = await persistence.listAlerts({
      tenantId: TENANT,
      entityRef: refOf(TENANT, USER_KEY),
    });
    const bySearch = await persistence.listAlerts({ tenantId: TENANT, search: 'bandeja 3' });
    const closed = await persistence.listAlerts({ tenantId: TENANT, status: 'closed' });

    expect(byEntity.total).toBe(2);
    expect(bySearch.items.map((alert) => alert.title)).toEqual(['Regla de bandeja 3']);
    expect(closed.total).toBe(0);
  });

  it('dos despachadores concurrentes nunca reclaman el mismo mensaje', async () => {
    const at = new Date('2026-10-11T14:00:00.000Z');
    const other = connect();
    try {
      const [left, right] = await Promise.all([
        persistence.claimOutbox(at, 100, 60_000),
        other.claimOutbox(at, 100, 60_000),
      ]);
      const leftIds = new Set(left.map((message) => message.messageId));

      expect(left.length + right.length).toBeGreaterThanOrEqual(3);
      expect(right.some((message) => leftIds.has(message.messageId))).toBe(false);
      // Mientras dura el lease nadie más los toma.
      expect(await persistence.claimOutbox(at, 100, 60_000)).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('el lease vencido devuelve el mensaje a la cola; publicar lo cierra para siempre', async () => {
    const expired = new Date('2026-10-11T14:05:00.000Z');
    const reclaimed = await persistence.claimOutbox(expired, 100, 60_000);
    expect(reclaimed.length).toBeGreaterThanOrEqual(3);

    // Fencing: el lease de este claim vence a las 14:06. Otro despachador reclama a las 14:07
    // con tokens nuevos; el primero, si "revive", ya no puede cerrar nada.
    const stale = reclaimed;
    const current = await persistence.claimOutbox(
      new Date('2026-10-11T14:07:00.000Z'),
      100,
      60_000,
    );
    expect(current.map((message) => message.messageId).sort()).toEqual(
      stale.map((message) => message.messageId).sort(),
    );
    for (const message of stale) {
      expect(
        await persistence.markOutboxPublished(message.messageId, message.claimToken, expired),
      ).toBe(false);
    }

    const [first, ...rest] = current;
    expect(
      await persistence.markOutboxPublished(first!.messageId, first!.claimToken, expired),
    ).toBe(true);
    // Publicar de nuevo con el mismo token no tiene efecto: el claim ya se cerró.
    expect(
      await persistence.markOutboxPublished(first!.messageId, first!.claimToken, expired),
    ).toBe(false);
    for (const message of rest) {
      expect(
        await persistence.scheduleOutboxRetry(
          message.messageId,
          message.claimToken,
          new Date('2026-10-11T15:00:00.000Z'),
          'TEAMS_TIMEOUT',
        ),
      ).toBe(true);
    }

    // Antes de la nueva disponibilidad no hay nada; después vuelven solo los reprogramados.
    expect(
      await persistence.claimOutbox(new Date('2026-10-11T14:30:00.000Z'), 100, 60_000),
    ).toHaveLength(0);
    const retried = await persistence.claimOutbox(
      new Date('2026-10-11T15:00:00.000Z'),
      100,
      60_000,
    );
    expect(retried.map((message) => message.messageId).sort()).toEqual(
      rest.map((message) => message.messageId).sort(),
    );

    const admin = new Client(database!.url);
    await admin.connect();
    try {
      const state = await admin.query(
        `SELECT status, attempt_count, published_at IS NOT NULL AS published
           FROM soc_outbox_messages WHERE message_id = $1`,
        [first!.messageId],
      );
      expect(state.rows[0]).toMatchObject({
        status: 'published',
        attempt_count: 3,
        published: true,
      });
    } finally {
      await admin.end();
    }
  });

  it('las consultas de salud cuentan la cola y la última alerta del tenant', async () => {
    const health = await persistence.outboxHealth(TENANT);
    const other = await persistence.outboxHealth('otro-tenant');

    expect(health.pending + health.processing).toBeGreaterThan(0);
    expect(other).toEqual({ pending: 0, processing: 0, oldestPendingAt: null });
    expect(await persistence.lastAlertAt(TENANT)).toEqual(new Date(Date.UTC(2026, 9, 11, 12, 3)));
    expect(await persistence.lastAlertAt('otro-tenant')).toBeNull();
  });

  it('la cadena de auditoría no se bifurca con escritores concurrentes', async () => {
    const writes = Array.from({ length: 8 }, (_, index) =>
      recordAudit(persistence.audit, {
        id: randomUUID(),
        tenantId: `${TENANT}-audit`,
        occurredAt: new Date('2026-10-11T15:00:00.000Z'),
        actor: { id: `analista-${index}`, type: 'user' },
        action: 'access.sign_in',
        resource: { type: 'session', id: `analista-${index}` },
        outcome: 'succeeded',
        correlationId: `corr-${index}`,
      }),
    );
    await Promise.all(writes);

    const chain = await persistence.audit.range(`${TENANT}-audit`, 1n, 100);
    expect(chain.map((event) => event.sequence)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    for (let index = 1; index < chain.length; index += 1) {
      expect(chain[index]?.previousHash).toBe(chain[index - 1]?.hash);
    }
  });

  it('reporta como error de integridad una fila fuera de catálogo', async () => {
    const target = candidate(1);
    const admin = new Client(database!.url);
    await admin.connect();
    try {
      // Simula una divergencia entre base y código: se quita el CHECK y se escribe un valor
      // que el dominio no conoce.
      await admin.query('ALTER TABLE soc_alerts DROP CONSTRAINT soc_alerts_priority_allowed');
      await admin.query(`UPDATE soc_alerts SET priority = 'P9' WHERE id = $1`, [target.id]);
      await expect(persistence.alertById(TENANT, target.id)).rejects.toBeInstanceOf(
        SocIntegrityError,
      );
    } finally {
      await admin.query(`UPDATE soc_alerts SET priority = 'P2' WHERE id = $1`, [target.id]);
      await admin.end();
    }
  });
});
