/**
 * C-20 / D-7 — despacho durable de extremo a extremo contra PostgreSQL real.
 *
 * Recorrido: alerta SOC escalada a P1 → mensaje en `soc_outbox_messages` → claim con lease
 * → transporte → intento en `notification_attempts` → publicación.
 *
 * Lo que esta spec demuestra y una en memoria no puede:
 * - un despachador que muere a mitad de envío no pierde el crítico: al vencer el lease
 *   otro proceso lo reclama;
 * - si el primero alcanzó a entregar, el segundo no vuelve a notificar (`already_delivered`)
 *   gracias al intento persistido;
 * - todo sobrevive a cerrar y reabrir las conexiones.
 *
 * El transporte es un doble guionado: aquí se prueba la cola y el estado, no Teams. La
 * entrega real a Teams sigue siendo un gate con destino autorizado.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryAuditStore } from '@qapaq/audit';
import { candidateId, promotionKey } from '@qapaq/detection';
import { ingestCandidate, executeAlertCommand, type SocDependencies } from '@qapaq/soc';
import { PostgresSocPersistence } from '@qapaq/soc/postgres';

import { dispatchMessage, drainOutbox, type DispatchDependencies } from '../src/dispatcher.js';
import { ConsoleFallbackChannel } from '../src/memory-stores.js';
import { createAttempt } from '../src/notification.js';
import { PostgresNotificationAttemptStore } from '../src/infrastructure/postgres-attempt-store.js';
import type { OutboxMessageDraft } from '@qapaq/soc';
import type { NotificationTransport } from '../src/teams-adapter.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../../../platform/database/', import.meta.url));
const TENANT = 'tenant-c20-dispatch';
const AT = new Date('2026-10-12T10:00:00.000Z');

async function provisionDatabase() {
  if (!databaseUrl) throw new Error('DATABASE_URL es obligatorio para esta spec.');
  const parsed = new URL(databaseUrl);
  const name = `qapaq_c20d_${process.pid}_${Date.now()}`.toLowerCase();
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

/** Transporte que cuenta envíos y puede "morir" justo después de entregar. */
class CountingTransport implements NotificationTransport {
  public readonly destinationRef = 'teams:spec';
  public sent = 0;
  public constructor(private readonly crashAfterDelivery = false) {}

  public send() {
    this.sent += 1;
    if (this.crashAfterDelivery) {
      // Simula la caída del proceso después de que Teams aceptó el mensaje, antes de que el
      // despachador alcance a guardar el resultado y publicar.
      return Promise.reject(new Error('PROCESS_CRASHED_AFTER_DELIVERY'));
    }
    return Promise.resolve({ delivered: true, httpStatus: 202 });
  }
}

describe.skipIf(!databaseUrl)('C-20 · despacho durable sobre PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof provisionDatabase>> | undefined;
  let soc: PostgresSocPersistence;
  let attempts: PostgresNotificationAttemptStore;

  const socDependencies = (): SocDependencies => ({
    unitOfWork: soc,
    clock: { now: () => AT },
    ids: { next: () => randomUUID() },
  });

  const tokens = new Map<string, string>();

  function dispatchDependencies(
    transport: NotificationTransport,
    now: Date,
    attemptStore = attempts,
    outboxReader?: DispatchDependencies['outbox'],
  ): DispatchDependencies {
    return {
      outbox: outboxReader ?? {
        // Igual que el runtime: guarda el token de cada claim para cerrarlo con fencing.
        claimPending: async (limit, at) => {
          const claimed = await soc.claimOutbox(at, limit, 120_000);
          for (const message of claimed) tokens.set(message.messageId, message.claimToken);
          return claimed;
        },
        markPublished: async (id, at) => {
          const token = tokens.get(id);
          if (token) await soc.markOutboxPublished(id, token, at);
        },
        scheduleRetry: async (id, availableAt, code) => {
          const token = tokens.get(id);
          if (token) await soc.scheduleOutboxRetry(id, token, availableAt, code);
        },
      },
      attempts: attemptStore,
      transport,
      fallback: new ConsoleFallbackChannel(),
      audit: new InMemoryAuditStore(),
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
      consoleBaseUrl: 'https://soc.qapaq-lab.example',
    };
  }

  beforeAll(async () => {
    database = await provisionDatabase();
    soc = PostgresSocPersistence.connect({ connectionString: database.url, maxConnections: 4 });
    attempts = PostgresNotificationAttemptStore.connect({
      connectionString: database.url,
      maxConnections: 2,
    });

    // Una alerta P1 avisa dos veces por política (Sprint 5): al crearse, para el triage
    // (analista y lead), y al escalarse, para la decisión de caso (lead y admin).
    const eventRecordId = '0199c20d-0000-7000-8000-000000000001';
    const key = promotionKey(TENANT, eventRecordId, '1.1.0');
    const id = candidateId(key, AT);
    await ingestCandidate(socDependencies(), {
      id,
      tenantId: TENANT,
      eventRecordId,
      eventUid: 'siem:alerts:c20d-1',
      idempotencyKey: key,
      priority: 'P1',
      score: 100,
      reasons: [{ code: 'BREAK_GLASS_IDENTITY', delta: 100, detail: 'Cuenta de emergencia.' }],
      rulesetId: 'qapaq.detection.prioritization',
      rulesetVersion: '1.1.0',
      occurredAt: AT,
      createdAt: AT,
      title: 'Login de cuenta de emergencia',
      entityKeys: ['user:bg-01@qapaq-lab.example'],
      signal: 'initial_access',
      ruleId: '100530',
      relatedAlertIds: [],
    });
    const actor = {
      subjectId: 'analista-1',
      tenantId: TENANT,
      sessionId: 'sess-1',
      capabilities: new Set(['alerts.read', 'alerts.triage', 'alerts.assign']),
      roles: ['qapaq.soc.analyst'],
    } as const;
    let revision = 1;
    for (const command of [
      { name: 'acknowledge' as const },
      { name: 'triage' as const, verdict: 'true_positive' as const, note: 'Uso no autorizado.' },
      { name: 'escalate' as const },
    ]) {
      const result = await executeAlertCommand(socDependencies(), {
        actor: actor as never,
        alertId: id,
        correlationId: randomUUID(),
        command: { ...command, expectedRevision: revision },
      });
      if (!result.ok) throw new Error(`no se pudo ejecutar ${command.name}: ${result.code}`);
      revision = result.value.revision;
    }
  });

  afterAll(async () => {
    if (!database) return;
    await soc.close();
    await attempts.close();
    await database.admin.query(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end();
  });

  it('un despachador que cae después de entregar no provoca una segunda notificación', async () => {
    const crashing = new CountingTransport(true);
    // El primer proceso reclama y entrega, pero muere antes de registrar el resultado.
    // Dispatch only the first notification: a process death stops all workers, whereas
    // drainOutbox now isolates a per-message exception and finishes the remaining claims.
    const crashedDependencies = dispatchDependencies(crashing, AT);
    const claimed = await crashedDependencies.outbox.claimPending(5, AT);
    const firstNotification = claimed.find(
      (message) => message.messageType === 'soc.alert.created',
    );
    expect(firstNotification).toBeDefined();
    await expect(dispatchMessage(crashedDependencies, firstNotification!)).rejects.toThrow(
      'PROCESS_CRASHED_AFTER_DELIVERY',
    );
    expect(crashing.sent).toBe(1);

    // Simula un reinicio: conexiones nuevas, nada en memoria.
    await soc.close();
    await attempts.close();
    soc = PostgresSocPersistence.connect({ connectionString: database!.url, maxConnections: 4 });
    attempts = PostgresNotificationAttemptStore.connect({
      connectionString: database!.url,
      maxConnections: 2,
    });

    // Mientras el lease sigue vigente, otro despachador no toma el mensaje.
    const healthy = new CountingTransport();
    expect(await drainOutbox(dispatchDependencies(healthy, AT))).toHaveLength(0);

    // Vencido el lease, se recupera. El intento quedó en `sending`: el contrato es "al menos
    // una vez" y el reenvío lleva el mismo `clientRequestId` para que Teams deduplique.
    const later = new Date(AT.getTime() + 180_000);
    const recovered = await drainOutbox(dispatchDependencies(healthy, later));
    const critical = recovered.filter((result) => result.code !== 'skipped_not_critical');

    // El aviso de alta (el que cayó) se reenvía con su mismo `clientRequestId` y el de escalada
    // se entrega por primera vez: dos entregas, una por mensaje, ninguna duplicada.
    expect(critical.map((result) => result.code)).toEqual(['delivered', 'delivered']);
    expect(healthy.sent).toBe(2);

    // Ya publicados: otra pasada no encuentra nada y no vuelve a enviar.
    expect(await drainOutbox(dispatchDependencies(healthy, later))).toHaveLength(0);
    expect(healthy.sent).toBe(2);
  });

  it('el intento entregado queda persistido y visible en la bandeja del tenant', async () => {
    const listed = await attempts.listByTenant(TENANT, 10);

    // Un intento por mensaje: el de alta tuvo dos intentos (caída y recuperación).
    expect(listed).toHaveLength(2);
    expect(
      listed.every((attempt) => attempt.status === 'sent' && attempt.channel === 'teams'),
    ).toBe(true);
    expect(listed.map((attempt) => attempt.attemptCount).sort()).toEqual([1, 2]);
  });

  it('hace CAS del acuse con el AuditEvent y protege frente a snapshots stale', async () => {
    const id = randomUUID();
    const at = new Date();
    const attempt = {
      ...createAttempt({
        id,
        tenantId: TENANT,
        messageId: randomUUID(),
        idempotencyKey: `ack-${id}`,
        at,
      }),
      status: 'sent' as const,
      sentAt: at,
    };
    await attempts.save(attempt);
    const replica = PostgresNotificationAttemptStore.connect({
      connectionString: database!.url,
      maxConnections: 2,
    });
    const eventDraft = (previousStatus: string) => ({
      id: randomUUID(),
      tenantId: TENANT,
      occurredAt: at,
      actor: { id: 'analyst-1', type: 'user' as const },
      action: 'soar.notification.acknowledged',
      resource: { type: 'notification', id },
      outcome: 'succeeded' as const,
      correlationId: randomUUID(),
      metadata: { previousStatus },
    });
    const call = (store: PostgresNotificationAttemptStore) =>
      store.acknowledgeWithAudit(TENANT, id, 'analyst-1', at, eventDraft);

    try {
      const results = await Promise.all([call(attempts), call(replica)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await attempts.save(attempt); // a stale dispatcher save cannot revert the acknowledgement
      await expect(attempts.byId(TENANT, id)).resolves.toMatchObject({
        status: 'acknowledged',
        acknowledgedBy: 'analyst-1',
      });

      const verifier = new Client(database!.url);
      await verifier.connect();
      try {
        const rows = await verifier.query(
          `SELECT action, actor_id, resource_type, resource_id, correlation_id, metadata
             FROM audit_events
            WHERE tenant_id = $1 AND resource_type = 'notification' AND resource_id = $2
              AND action = 'soar.notification.acknowledged'`,
          [TENANT, id],
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({
          action: 'soar.notification.acknowledged',
          actor_id: 'analyst-1',
          resource_type: 'notification',
          resource_id: id,
          metadata: { previousStatus: 'sent' },
        });
        expect(rows.rows[0]?.correlation_id).toBeTruthy();
      } finally {
        await verifier.end();
      }
    } finally {
      await replica.close();
    }
  });

  it('serializa el cupo P2 entre instancias Postgres y conserva idempotencia', async () => {
    const replica = PostgresNotificationAttemptStore.connect({
      connectionString: database!.url,
      maxConnections: 4,
    });
    const tenantId = 'tenant-c20-p2-quota';
    const at = new Date();
    try {
      const results = await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          (index % 2 === 0 ? attempts : replica).reserveP2ImmediateSlot(
            tenantId,
            `p2-${index}`,
            at,
            10,
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
      await expect(attempts.reserveP2ImmediateSlot(tenantId, 'p2-0', at, 10)).resolves.toBe(true);
      await expect(replica.reserveP2ImmediateSlot(tenantId, 'p2-overflow', at, 10)).resolves.toBe(
        false,
      );
    } finally {
      await replica.close();
    }
  });

  it('serializa el mismo grupo entre réplicas y deja el perdedor en la bandeja de digest', async () => {
    const replica = PostgresNotificationAttemptStore.connect({
      connectionString: database!.url,
      maxConnections: 4,
    });
    const tenantId = 'tenant-c20-group-window';
    const at = new Date('2026-10-12T10:00:00.000Z');
    const messages: OutboxMessageDraft[] = [
      {
        messageId: randomUUID(),
        tenantId,
        aggregateType: 'alert',
        aggregateId: randomUUID(),
        messageType: 'soc.alert.created',
        schemaVersion: '1.0.0',
        idempotencyKey: randomUUID(),
        payload: { title: 'Alerta regla 101701', priority: 'P1', ruleId: '101701' },
        availableAt: at,
      },
      {
        messageId: randomUUID(),
        tenantId,
        aggregateType: 'alert',
        aggregateId: randomUUID(),
        messageType: 'soc.alert.created',
        schemaVersion: '1.0.0',
        idempotencyKey: randomUUID(),
        payload: { title: 'Alerta regla 101701', priority: 'P1', ruleId: '101701' },
        availableAt: at,
      },
    ];
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => (startedResolve = resolve));
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => (releaseResolve = resolve));
    let sends = 0;
    const blockedTransport: NotificationTransport = {
      destinationRef: 'teams:group-race-spec',
      async send() {
        sends += 1;
        startedResolve();
        await release;
        return { delivered: true, httpStatus: 202 };
      },
    };
    const published: string[] = [];
    const outboxReader: DispatchDependencies['outbox'] = {
      claimPending: async () => [],
      markPublished: async (messageId) => {
        published.push(messageId);
      },
      scheduleRetry: async () => undefined,
    };
    try {
      const firstTask = dispatchMessage(
        dispatchDependencies(blockedTransport, at, attempts, outboxReader),
        messages[0]!,
      );
      await started;
      const second = await dispatchMessage(
        dispatchDependencies(blockedTransport, at, replica, outboxReader),
        messages[1]!,
      );
      expect(second.code).toBe('suppressed');
      expect(second.attempt).toMatchObject({ status: 'suppressed', suppressionReason: 'grouped' });
      expect(second.attempt?.supersededBy).toBeTruthy();
      expect(sends).toBe(1);
      releaseResolve();
      const first = await firstTask;
      expect(first.code).toBe('delivered');
      const undigested = await replica.listUndigested(tenantId, 10);
      expect(undigested).toHaveLength(1);
      expect(undigested[0]).toMatchObject({
        idempotencyKey: messages[1]!.idempotencyKey,
        status: 'suppressed',
        suppressionReason: 'grouped',
        digestId: null,
      });
      expect(published).toContain(messages[1]!.messageId);
    } finally {
      releaseResolve();
      await replica.close();
    }
  });
});
