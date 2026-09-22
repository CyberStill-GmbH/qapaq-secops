import type { Prisma } from '../generated/client/client.js';

let sequence = 0;

// UUIDv7 sintético y determinista: exclusivo del corpus de pruebas.
export function fixtureId(): string {
  sequence += 1;
  return `01996000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

export function admissionFixture() {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const source = {
    id: fixtureId(),
    tenantId: 'tenant-pruebas',
    provider: 'wazuh',
    product: 'manager',
    dataset: 'alerts',
    instanceKey: fixtureId(),
    updatedAt: now,
  } satisfies Prisma.SourceUncheckedCreateInput;
  const manifest = {
    id: fixtureId(),
    sourceId: source.id,
    dataset: source.dataset,
    manifestKey: fixtureId(),
    admissionDigest: 'a'.repeat(64),
    receivedAt: now,
    durableAt: now,
    eventCount: 1,
    acceptedCount: 0,
    quarantinedCount: 1,
    updatedAt: now,
    cursorTo: 'cursor-1',
    cursorVersion: '1',
    checkpointRevision: 1n,
  } satisfies Prisma.IngestionManifestUncheckedCreateInput;
  const raw = {
    id: fixtureId(),
    sourceId: source.id,
    manifestId: manifest.id,
    objectRef: `raw:${fixtureId()}`,
    sha256: 'b'.repeat(64),
    mediaType: 'application/json',
    sizeBytes: 128,
    receivedAt: now,
  } satisfies Prisma.RawEventReferenceUncheckedCreateInput;
  const inbox = {
    id: fixtureId(),
    sourceId: source.id,
    manifestId: manifest.id,
    rawEventReferenceId: raw.id,
    recordId: fixtureId(),
    providerEventId: 'evento-proveedor',
    idempotencyKey: fixtureId(),
    availableAt: now,
    updatedAt: now,
  } satisfies Prisma.EventInboxUncheckedCreateInput;
  const outbox = {
    id: fixtureId(),
    messageId: fixtureId(),
    sourceId: source.id,
    aggregateId: manifest.id,
    aggregateType: 'IngestionManifest',
    messageType: 'AdmissionDurable',
    schemaVersion: '1',
    idempotencyKey: fixtureId(),
    payload: { manifestId: manifest.id },
    availableAt: now,
  } satisfies Prisma.OutboxMessageUncheckedCreateInput;
  const quarantine = {
    id: fixtureId(),
    sourceId: source.id,
    manifestId: manifest.id,
    inboxId: inbox.id,
    rawEventReferenceId: raw.id,
    recordId: inbox.recordId,
    errorCode: 'TEST_INVALID_EVENT',
    quarantinedAt: now,
    updatedAt: now,
  } satisfies Prisma.QuarantinedEventUncheckedCreateInput;
  const checkpoint = {
    id: fixtureId(),
    sourceId: source.id,
    dataset: source.dataset,
    cursor: 'cursor-1',
    cursorVersion: '1',
    revision: 1n,
    committedAt: now,
    updatedAt: now,
  } satisfies Prisma.SourceCheckpointUncheckedCreateInput;
  return { source, manifest, raw, inbox, outbox, quarantine, checkpoint };
}

export type AdmissionFixture = ReturnType<typeof admissionFixture>;

// Secuencia de prueba del schema; no sustituye al comando de aplicación C-04.
export async function insertFixture(
  tx: Prisma.TransactionClient,
  fixture: AdmissionFixture,
  failAfter?: number,
): Promise<void> {
  const steps = [
    () => tx.source.create({ data: fixture.source }),
    () => tx.ingestionManifest.create({ data: fixture.manifest }),
    () => tx.rawEventReference.create({ data: fixture.raw }),
    () => tx.eventInbox.create({ data: fixture.inbox }),
    () => tx.quarantinedEvent.create({ data: fixture.quarantine }),
    () => tx.outboxMessage.create({ data: fixture.outbox }),
    () => tx.sourceCheckpoint.create({ data: fixture.checkpoint }),
  ];
  for (const [index, insert] of steps.entries()) {
    await insert();
    if (failAfter === index + 1) throw new Error('Fallo inyectado de prueba');
  }
}
