import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/client/client.js';
import { runDatabaseTransaction } from './transaction.js';

export type AdmissionErrorCode =
  | 'PERSISTENCE_UNAVAILABLE'
  | 'PERSISTENCE_CONSTRAINT_VIOLATION'
  | 'PERSISTENCE_DUPLICATE'
  | 'PERSISTENCE_NOT_FOUND'
  | 'PERSISTENCE_CONCURRENCY_CONFLICT'
  | 'PERSISTENCE_TRANSACTION_FAILED';

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code);
    this.name = 'AdmissionError';
  }
}
export interface RawObjectProof {
  readonly id: string;
  readonly objectRef: string;
  readonly objectVersion?: string | null;
  readonly sha256: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly receivedAt: Date;
}

export interface AdmissionQuarantine {
  readonly id: string;
  readonly errorCode: string;
  readonly errorPath?: string | null;
  readonly contractVersion?: string | null;
  readonly parserVersion?: string | null;
}

export interface AdmissionEvent {
  readonly id: string;
  readonly recordId: string;
  readonly providerEventId?: string | null;
  readonly idempotencyKey: string;
  readonly rawReferenceId: string;
  readonly quarantine?: AdmissionQuarantine | null;
}

export interface AdmissionCommand {
  readonly sourceId: string;
  readonly dataset: string;
  readonly manifestKey: string;
  readonly manifestId: string;
  readonly outboxId: string;
  readonly messageId: string;
  readonly outboxIdempotencyKey: string;
  readonly events: readonly AdmissionEvent[];
  readonly newRawObjects: readonly RawObjectProof[];
  readonly receivedAt: Date;
  readonly expectedRevision?: bigint;
  readonly cursor?: {
    readonly from: string | null;
    readonly to: string;
    readonly version: string;
    readonly sourceGeneration?: string | null;
    readonly lastOccurredAt?: Date | null;
    readonly lastTieBreaker?: string | null;
  } | null;
}

export interface AdmissionReceipt {
  readonly manifestId: string;
  readonly eventCount: number;
  readonly acceptedCount: number;
  readonly quarantinedCount: number;
  readonly duplicateCount: 0;
  readonly checkpointRevision: bigint | null;
}

const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex256 = /^[0-9a-f]{64}$/u;
const maxBatchBytes = 5 * 1024 * 1024;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new AdmissionError('PERSISTENCE_CONSTRAINT_VIOLATION');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value));
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString(10));
  if (value instanceof Date) {
    requireValue(Number.isFinite(value.getTime()));
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  requireValue(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) requireValue(/^[\x20-\x7e]+$/u.test(key));
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(',')}}`;
}

function validate(command: AdmissionCommand): void {
  requireValue(uuid7.test(command.sourceId) && uuid7.test(command.manifestId));
  requireValue(uuid7.test(command.outboxId) && uuid7.test(command.messageId));
  requireValue(command.events.length >= 1 && command.events.length <= 500);
  requireValue(command.newRawObjects.length <= command.events.length);
  requireValue(command.expectedRevision === undefined || command.expectedRevision >= 0n);
  requireValue(
    (command.cursor === undefined || command.cursor === null) ===
      (command.expectedRevision === undefined),
  );
  const events = new Set<string>();
  const records = new Set<string>();
  const idempotency = new Set<string>();
  for (const event of command.events) {
    requireValue(
      uuid7.test(event.id) && uuid7.test(event.recordId) && uuid7.test(event.rawReferenceId),
    );
    requireValue(
      !events.has(event.id) &&
        !records.has(event.recordId) &&
        !idempotency.has(event.idempotencyKey),
    );
    events.add(event.id);
    records.add(event.recordId);
    idempotency.add(event.idempotencyKey);
    requireValue(
      typeof event.idempotencyKey === 'string' &&
        event.idempotencyKey.length > 0 &&
        event.idempotencyKey.length <= 128,
    );
    if (event.quarantine) requireValue(uuid7.test(event.quarantine.id));
  }
  const rawIds = new Set<string>();
  let bytes = 0;
  for (const raw of command.newRawObjects) {
    requireValue(
      uuid7.test(raw.id) &&
        raw.objectRef.startsWith('raw:') &&
        uuid7.test(raw.objectRef.slice(4)) &&
        hex256.test(raw.sha256),
    );
    requireValue(Number.isInteger(raw.sizeBytes) && raw.sizeBytes >= 0 && raw.sizeBytes <= 262144);
    requireValue(raw.mediaType.length >= 3 && raw.mediaType.length <= 128);
    requireValue(!rawIds.has(raw.id));
    rawIds.add(raw.id);
    bytes += raw.sizeBytes;
  }
  for (const event of command.events)
    requireValue(rawIds.has(event.rawReferenceId) || uuid7.test(event.rawReferenceId));
  requireValue(bytes <= maxBatchBytes);
  if (command.cursor) {
    requireValue(command.cursor.to.length > 0 && command.cursor.to.length <= 8192);
    requireValue(command.cursor.version.length > 0 && command.cursor.version.length <= 64);
  }
  canonical(command);
}

function receipt(row: {
  id: string;
  eventCount: number;
  acceptedCount: number;
  quarantinedCount: number;
  duplicateCount: number;
  checkpointRevision: bigint | null;
}): AdmissionReceipt {
  return {
    manifestId: row.id,
    eventCount: row.eventCount,
    acceptedCount: row.acceptedCount,
    quarantinedCount: row.quarantinedCount,
    duplicateCount: 0,
    checkpointRevision: row.checkpointRevision,
  };
}

/**
 * Admite un lote durable con outbox y avance CAS del checkpoint en una sola TX.
 * La escritura de objetos raw ocurre antes y fuera de PostgreSQL; este comando
 * acepta únicamente los comprobantes de esa escritura.
 */
export async function commitAdmission(
  client: PrismaClient,
  command: AdmissionCommand,
): Promise<AdmissionReceipt> {
  validate(command);
  const digestCommand = {
    ...command,
    events: [...command.events].sort((a, b) => a.id.localeCompare(b.id)),
    newRawObjects: [...command.newRawObjects].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const digest = createHash('sha256').update(canonical(digestCommand), 'utf8').digest('hex');
  const quarantinedCount = command.events.filter((event) => event.quarantine != null).length;
  const acceptedCount = command.events.length - quarantinedCount;
  const now = new Date();
  const cursorRevision = command.cursor ? command.expectedRevision! + 1n : null;
  try {
    return await runDatabaseTransaction(client, async (tx) => {
      const source = await tx.source.findUnique({ where: { id: command.sourceId } });
      if (!source || source.dataset !== command.dataset)
        throw new AdmissionError('PERSISTENCE_NOT_FOUND');
      const existing = await tx.ingestionManifest.findUnique({
        where: {
          sourceId_manifestKey: { sourceId: command.sourceId, manifestKey: command.manifestKey },
        },
      });
      if (existing) {
        if (existing.admissionDigest !== digest || existing.admissionFormatVersion !== '1')
          throw new AdmissionError('PERSISTENCE_CONSTRAINT_VIOLATION');
        return receipt(existing);
      }
      const manifest = await tx.ingestionManifest.create({
        data: {
          id: command.manifestId,
          sourceId: command.sourceId,
          dataset: command.dataset,
          manifestKey: command.manifestKey,
          admissionDigest: digest,
          receivedAt: command.receivedAt,
          durableAt: now,
          eventCount: command.events.length,
          acceptedCount,
          duplicateCount: 0,
          quarantinedCount,
          cursorFrom: command.cursor?.from ?? null,
          cursorTo: command.cursor?.to ?? null,
          cursorVersion: command.cursor?.version ?? null,
          sourceGeneration: command.cursor?.sourceGeneration ?? null,
          checkpointRevision: cursorRevision,
          updatedAt: now,
        },
      });
      for (const raw of command.newRawObjects)
        await tx.rawEventReference.create({
          data: {
            id: raw.id,
            sourceId: command.sourceId,
            manifestId: manifest.id,
            objectRef: raw.objectRef,
            objectVersion: raw.objectVersion ?? null,
            sha256: raw.sha256,
            mediaType: raw.mediaType,
            sizeBytes: raw.sizeBytes,
            receivedAt: raw.receivedAt,
          },
        });
      const rawRefs = await tx.rawEventReference.findMany({
        where: {
          sourceId: command.sourceId,
          id: { in: command.events.map((event) => event.rawReferenceId) },
        },
        select: { id: true, sizeBytes: true },
      });
      if (rawRefs.length !== new Set(command.events.map((event) => event.rawReferenceId)).size)
        throw new AdmissionError('PERSISTENCE_NOT_FOUND');
      const sizeById = new Map(rawRefs.map((raw) => [raw.id, raw.sizeBytes]));
      const receivedBytes = command.events.reduce(
        (total, event) => total + sizeById.get(event.rawReferenceId)!,
        0,
      );
      if (receivedBytes > maxBatchBytes)
        throw new AdmissionError('PERSISTENCE_CONSTRAINT_VIOLATION');
      for (const event of command.events) {
        await tx.eventInbox.create({
          data: {
            id: event.id,
            sourceId: command.sourceId,
            manifestId: manifest.id,
            rawEventReferenceId: event.rawReferenceId,
            recordId: event.recordId,
            providerEventId: event.providerEventId ?? null,
            idempotencyKey: event.idempotencyKey,
            availableAt: now,
            updatedAt: now,
          },
        });
        if (event.quarantine)
          await tx.quarantinedEvent.create({
            data: {
              id: event.quarantine.id,
              sourceId: command.sourceId,
              manifestId: manifest.id,
              inboxId: event.id,
              rawEventReferenceId: event.rawReferenceId,
              recordId: event.recordId,
              errorCode: event.quarantine.errorCode,
              errorPath: event.quarantine.errorPath ?? null,
              contractVersion: event.quarantine.contractVersion ?? null,
              parserVersion: event.quarantine.parserVersion ?? null,
              quarantinedAt: now,
              updatedAt: now,
            },
          });
      }
      const payload = { manifestId: manifest.id };
      requireValue(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 4096);
      await tx.outboxMessage.create({
        data: {
          id: command.outboxId,
          messageId: command.messageId,
          sourceId: command.sourceId,
          aggregateId: manifest.id,
          aggregateType: 'IngestionManifest',
          messageType: 'AdmissionDurable',
          schemaVersion: '1',
          idempotencyKey: command.outboxIdempotencyKey,
          payload,
          availableAt: now,
        },
      });
      if (command.cursor) {
        const checkpoint = await tx.sourceCheckpoint.findUnique({
          where: { sourceId_dataset: { sourceId: command.sourceId, dataset: command.dataset } },
        });
        if ((checkpoint?.revision ?? 0n) !== command.expectedRevision)
          throw new AdmissionError('PERSISTENCE_CONCURRENCY_CONFLICT');
        if (
          (checkpoint?.cursor ?? null) !== command.cursor.from ||
          (checkpoint?.cursorVersion ?? command.cursor.version) !== command.cursor.version ||
          (checkpoint?.sourceGeneration ?? null) !== (command.cursor.sourceGeneration ?? null)
        ) {
          throw new AdmissionError('PERSISTENCE_CONCURRENCY_CONFLICT');
        }
        if (checkpoint) {
          const update = await tx.sourceCheckpoint.updateMany({
            where: { id: checkpoint.id, revision: command.expectedRevision! },
            data: {
              cursor: command.cursor.to,
              revision: cursorRevision!,
              committedAt: now,
              lastOccurredAt: command.cursor.lastOccurredAt ?? null,
              lastTieBreaker: command.cursor.lastTieBreaker ?? null,
              updatedAt: now,
            },
          });
          if (update.count !== 1) throw new AdmissionError('PERSISTENCE_CONCURRENCY_CONFLICT');
        } else {
          if (command.expectedRevision !== 0n)
            throw new AdmissionError('PERSISTENCE_CONCURRENCY_CONFLICT');
          await tx.sourceCheckpoint.create({
            data: {
              id: command.manifestId,
              sourceId: command.sourceId,
              dataset: command.dataset,
              cursor: command.cursor.to,
              cursorVersion: command.cursor.version,
              sourceGeneration: command.cursor.sourceGeneration ?? null,
              revision: cursorRevision!,
              committedAt: now,
              lastOccurredAt: command.cursor.lastOccurredAt ?? null,
              lastTieBreaker: command.cursor.lastTieBreaker ?? null,
              updatedAt: now,
            },
          });
        }
      }
      return receipt(manifest);
    });
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    if (prismaError?.code === 'P2002') {
      const existing = await client.ingestionManifest
        .findUnique({
          where: {
            sourceId_manifestKey: { sourceId: command.sourceId, manifestKey: command.manifestKey },
          },
        })
        .catch(() => null);
      if (existing) {
        const retryDigestCommand = {
          ...command,
          events: [...command.events].sort((a, b) => a.id.localeCompare(b.id)),
          newRawObjects: [...command.newRawObjects].sort((a, b) => a.id.localeCompare(b.id)),
        };
        const retryDigest = createHash('sha256')
          .update(canonical(retryDigestCommand), 'utf8')
          .digest('hex');
        if (existing.admissionDigest === retryDigest && existing.admissionFormatVersion === '1')
          return receipt(existing);
      }
      throw new AdmissionError('PERSISTENCE_DUPLICATE');
    }
    if (
      prismaError?.code === 'P2003' ||
      prismaError?.code === 'P2004' ||
      prismaError?.code === 'P2000'
    )
      throw new AdmissionError('PERSISTENCE_CONSTRAINT_VIOLATION');
    if (prismaError?.code === 'P2025') throw new AdmissionError('PERSISTENCE_NOT_FOUND');
    throw new AdmissionError('PERSISTENCE_TRANSACTION_FAILED');
  }
}
