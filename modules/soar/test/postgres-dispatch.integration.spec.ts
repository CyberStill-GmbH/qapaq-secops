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

import { drainOutbox, type DispatchDependencies } from '../src/dispatcher.js';
import { ConsoleFallbackChannel } from '../src/memory-stores.js';
import { PostgresNotificationAttemptStore } from '../src/infrastructure/postgres-attempt-store.js';
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

  function dispatchDependencies(transport: NotificationTransport, now: Date): DispatchDependencies {
    return {
      outbox: {
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
      attempts,
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

    // Una alerta P1 escalada por un analista genera el hecho que exige notificación.
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
    await expect(drainOutbox(dispatchDependencies(crashing, AT))).rejects.toThrow(
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

    expect(critical.map((result) => result.code)).toEqual(['delivered']);
    expect(healthy.sent).toBe(1);

    // Ya publicado: otra pasada no encuentra nada y no vuelve a enviar.
    expect(await drainOutbox(dispatchDependencies(healthy, later))).toHaveLength(0);
    expect(healthy.sent).toBe(1);
  });

  it('el intento entregado queda persistido y visible en la bandeja del tenant', async () => {
    const listed = await attempts.listByTenant(TENANT, 10);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: 'sent', channel: 'teams', attemptCount: 2 });
  });
});
