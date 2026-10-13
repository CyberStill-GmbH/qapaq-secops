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
import { capabilitiesForRoles } from '@qapaq/access';

import { openIncident } from '../src/incident.js';
import {
  addIncidentNote,
  createIncidentTask,
  executeIncidentCommand,
  executeTaskCommand,
  ingestCandidate,
  type SocDependencies,
} from '../src/use-cases.js';

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

  it('S5 · tareas con compare-and-set, cierre bloqueado y bitácora append-only', async () => {
    const lead = {
      subjectId: 'sub-lider',
      tenantId: TENANT,
      sessionId: 'session-s5',
      capabilities: capabilitiesForRoles(['qapaq.soc.lead']),
    };
    const incidentId = randomUUID();
    await persistence.run((context) =>
      context.incidents.insert({
        ...openIncident({
          id: incidentId,
          tenantId: TENANT,
          title: 'Caso sintético S5',
          severity: 'high',
          ownerId: 'sub-lider',
          summary: 'Tareas y bitácora sobre PostgreSQL.',
          alertIds: [],
          openedAt: new Date('2026-10-11T12:00:00.000Z'),
        }),
        status: 'resolved',
      }),
    );
    const deps = dependencies(persistence);
    const created = await createIncidentTask(deps, {
      actor: lead,
      incidentId,
      correlationId: 'corr-s5-1',
      title: 'Eliminar la regla de reenvío',
      required: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const closeBlocked = await executeIncidentCommand(deps, {
      actor: lead,
      incidentId,
      correlationId: 'corr-s5-2',
      command: { name: 'close', expectedRevision: 1, closureReason: 'Contenido y verificado.' },
    });
    expect(closeBlocked).toMatchObject({ ok: false, reason: 'REQUIRED_TASKS_OPEN' });

    const [first, second] = await Promise.all([
      executeTaskCommand(deps, {
        actor: lead,
        incidentId,
        taskId: created.value.id,
        correlationId: 'corr-s5-3',
        command: { name: 'start', expectedRevision: 1 },
      }),
      executeTaskCommand(deps, {
        actor: lead,
        incidentId,
        taskId: created.value.id,
        correlationId: 'corr-s5-4',
        command: { name: 'complete', expectedRevision: 1 },
      }),
    ]);
    // Dos escrituras sobre la misma revisión: exactamente una gana.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    const note = await addIncidentNote(deps, {
      actor: lead,
      incidentId,
      correlationId: 'corr-s5-5',
      body: 'Usuario confirmó que no creó la regla.',
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    expect(await persistence.listIncidentNotes(TENANT, incidentId)).toHaveLength(1);
    expect((await persistence.listIncidentTasks(TENANT, incidentId))[0]?.revision).toBe(2);
    // Lectura en bloque de alertas vinculadas: un caso sin alertas devuelve total 0.
    expect(await persistence.listIncidentAlerts(TENANT, incidentId, 200)).toEqual({
      items: [],
      total: 0,
    });
    expect(await persistence.listIncidentAlerts(TENANT, 'no-es-uuid', 200)).toEqual({
      items: [],
      total: 0,
    });

    const admin = new Client(database!.url);
    await admin.connect();
    try {
      await expect(
        admin.query(`UPDATE incident_notes SET body = 'editada' WHERE id = $1`, [note.value.id]),
      ).rejects.toThrow(/append-only/u);
      await expect(
        admin.query(`DELETE FROM incident_notes WHERE id = $1`, [note.value.id]),
      ).rejects.toThrow(/append-only/u);
      // Cancelar una obligatoria sin motivo tampoco pasa en la base.
      await expect(
        admin.query(
          `UPDATE incident_tasks SET status = 'cancelled', cancellation_reason = NULL, completed_at = NULL WHERE id = $1`,
          [created.value.id],
        ),
      ).rejects.toThrow(/incident_tasks_required_cancel_reason/u);
    } finally {
      await admin.end();
    }
  });

  it('S5 · cursor de ingesta: un solo claim concurrente, fencing y marca que no retrocede', async () => {
    const key = { tenantId: TENANT, sourceId: 'wazuh-indexer', dataset: 'wazuh-alerts' };
    const at = new Date('2026-10-12T18:00:00.000Z');
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => persistence.ingestion.claimCursor(key, at, 60_000)),
    );
    const winners = claims.filter((claim) => claim !== undefined);
    expect(winners).toHaveLength(1);
    const claim = winners[0]!;
    expect(claim.watermark).toBeNull();

    const later = new Date('2026-10-12T17:30:00.000Z');
    const earlier = new Date('2026-10-12T17:00:00.000Z');
    expect(await persistence.ingestion.advanceCursor(claim, later, at)).toBe(true);
    expect(await persistence.ingestion.advanceCursor(claim, earlier, at)).toBe(true);
    // Un claim ajeno no avanza.
    expect(
      await persistence.ingestion.advanceCursor({ ...claim, claimId: randomUUID() }, at, at),
    ).toBe(false);
    await persistence.ingestion.releaseCursor(claim);

    const next = await persistence.ingestion.claimCursor(key, at, 60_000);
    expect(next?.watermark?.toISOString()).toBe(later.toISOString());
    await persistence.ingestion.releaseCursor(next!);

    const observation = {
      id: randomUUID(),
      ...key,
      attemptedAt: at,
      completedAt: at,
      outcome: 'success' as const,
      recordsSeen: 0,
      promoted: 0,
      quarantined: 0,
      newestEventAt: null,
      errorClass: null,
    };
    await persistence.ingestion.recordObservation(observation);
    await persistence.ingestion.recordObservation(observation);
    expect(await persistence.ingestion.recentObservations(key, 10)).toHaveLength(1);
    // Un error sin código viola la coherencia de la tabla.
    await expect(
      persistence.ingestion.recordObservation({
        ...observation,
        id: randomUUID(),
        outcome: 'retryable_error',
      }),
    ).rejects.toThrow();
  });

  it('S5 · la bitácora de salud por fuente es append-only e idempotente', async () => {
    const key = { tenantId: TENANT, sourceId: 'wazuh-indexer', dataset: 'wazuh-alerts' };
    const transition = {
      id: randomUUID(),
      ...key,
      fromState: null,
      toState: 'unknown' as const,
      reason: 'NO_OBSERVATIONS' as const,
      at: new Date('2026-10-12T20:00:00.000Z'),
    };
    await persistence.ingestion.appendTransition(transition);
    await persistence.ingestion.appendTransition(transition);
    expect(await persistence.ingestion.recentTransitions(key, 10)).toEqual([transition]);

    const admin = new Client(database!.url);
    await admin.connect();
    try {
      await expect(
        admin.query(`UPDATE source_health_transitions SET to_state = 'healthy' WHERE id = $1`, [
          transition.id,
        ]),
      ).rejects.toThrow(/append-only/u);
      // Una «transición» sin cambio de estado no es una transición.
      await expect(
        admin.query(
          `INSERT INTO source_health_transitions VALUES ($1, $2, 'wazuh-indexer', 'wazuh-alerts', 'unknown', 'unknown', 'NO_OBSERVATIONS', now())`,
          [randomUUID(), TENANT],
        ),
      ).rejects.toThrow(/source_health_transitions_is_change/u);
    } finally {
      await admin.end();
    }
  });

  it('S5 · actividad por stream: los no medidos quedan en cero y conservan su último evento', async () => {
    const key = { tenantId: TENANT, sourceId: 'wazuh-indexer', dataset: 'wazuh-alerts' };
    const first = new Date('2026-10-12T20:00:00.000Z');
    await persistence.ingestion.saveActivity(key, [
      {
        stream: 'Audit.Exchange',
        lastEventAt: new Date('2026-10-12T19:00:00.000Z'),
        eventsInWindow: 4,
        windowHours: 24,
        measuredAt: first,
      },
      {
        stream: 'Audit.General',
        lastEventAt: null,
        eventsInWindow: 0,
        windowHours: 24,
        measuredAt: first,
      },
    ]);
    const second = new Date('2026-10-12T20:10:00.000Z');
    await persistence.ingestion.saveActivity(key, [
      {
        stream: 'Audit.General',
        lastEventAt: new Date('2026-10-12T20:05:00.000Z'),
        eventsInWindow: 1,
        windowHours: 24,
        measuredAt: second,
      },
    ]);
    expect(await persistence.ingestion.activity(key)).toEqual([
      {
        stream: 'Audit.Exchange',
        lastEventAt: new Date('2026-10-12T19:00:00.000Z'),
        eventsInWindow: 0,
        windowHours: 24,
        measuredAt: second,
      },
      {
        stream: 'Audit.General',
        lastEventAt: new Date('2026-10-12T20:05:00.000Z'),
        eventsInWindow: 1,
        windowHours: 24,
        measuredAt: second,
      },
    ]);
  });
});
