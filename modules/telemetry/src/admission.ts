import { createHash } from 'node:crypto';
import type {
  AdmissionCommand,
  AdmissionReceipt,
  RawObjectProof,
} from '@qapaq/database/admission-contract';

/** Structural subset of the public C-10 ProviderRecord; intentionally provider-neutral. */
export interface TelemetryProviderRecord {
  readonly sourceRecordId: string;
  readonly dataset: string;
  readonly collectedAt: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

const MAX_RECORDS = 500;
const MAX_RAW_BYTES = 262_144;
const MAX_BATCH_BYTES = 5 * 1024 * 1024;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type AdmissionFailureCode =
  | 'INVALID_ADMISSION'
  | 'RAW_PERSISTENCE_FAILED'
  | 'RAW_INTEGRITY_FAILED'
  | 'CHECKPOINT_CONFLICT'
  | 'DATABASE_ADMISSION_FAILED';

export class TelemetryAdmissionError extends Error {
  constructor(
    readonly code: AdmissionFailureCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'TelemetryAdmissionError';
  }
}

export class RawObjectIntegrityError extends Error {
  constructor(message = 'Stored raw object differs from expected bytes') {
    super(message);
    this.name = 'RawObjectIntegrityError';
  }
}

export interface DurableRawStore {
  /** Create-if-absent; an existing object is accepted only after byte/hash verification. */
  putIfAbsent(ref: string, bytes: Uint8Array, sha256: string): Promise<{ version?: string | null }>;
  /** Read only for verification/retry. The implementation must bound the response size. */
  get(ref: string, maximumBytes: number): Promise<Uint8Array>;
}

export interface AdmissionRepository {
  /** Must map to C-04 commitAdmission; transaction includes manifest, inbox, outbox and CAS checkpoint. */
  commit(command: AdmissionCommand): Promise<AdmissionReceipt>;
}

export interface AdmissionRequest {
  readonly sourceId: string;
  readonly dataset: string;
  /** Stable identity for retries of this exact source page; new physical reads use a new value. */
  readonly manifestKey: string;
  /** Stable UUIDv7 for retries. All child identities are deterministically derived from it. */
  readonly manifestId: string;
  readonly receivedAt: Date;
  readonly records: readonly TelemetryProviderRecord[];
  readonly cursor?: AdmissionCommand['cursor'];
  readonly expectedRevision?: bigint;
  readonly sourceGeneration?: string | null;
  readonly lastOccurredAt?: Date | null;
  readonly lastTieBreaker?: string | null;
}

export interface AdmissionResult {
  readonly receipt: AdmissionReceipt;
  readonly sha256: readonly string[];
  readonly byteCount: number;
}

function canonicalBytes(value: unknown): Buffer {
  const chunks: string[] = [];
  let size = 0;
  const append = (part: string) => {
    size += Buffer.byteLength(part, 'utf8');
    if (size > MAX_RAW_BYTES) throw new TelemetryAdmissionError('INVALID_ADMISSION');
    chunks.push(part);
  };
  const write = (current: unknown, depth: number): void => {
    if (depth > 64) throw new TelemetryAdmissionError('INVALID_ADMISSION');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      append(JSON.stringify(current));
      return;
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      append(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      append('[');
      for (let index = 0; index < current.length; index++) {
        if (!(index in current)) throw new TelemetryAdmissionError('INVALID_ADMISSION');
        if (index > 0) append(',');
        write(current[index], depth + 1);
      }
      append(']');
      return;
    }
    if (typeof current !== 'object' || Object.getPrototypeOf(current) !== Object.prototype)
      throw new TelemetryAdmissionError('INVALID_ADMISSION');
    const object = current as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (
      keys.length > MAX_RAW_BYTES / 2 ||
      keys.some(
        (key) =>
          key === '__proto__' ||
          [...key].some((character) => {
            const code = character.codePointAt(0)!;
            return code < 0x20 || code === 0x7f;
          }),
      )
    )
      throw new TelemetryAdmissionError('INVALID_ADMISSION');
    append('{');
    keys.forEach((key, index) => {
      if (index > 0) append(',');
      append(JSON.stringify(key));
      append(':');
      write(object[key], depth + 1);
    });
    append('}');
  };
  write(value, 0);
  return Buffer.from(chunks.join(''), 'utf8');
}

function deterministicUuid7(namespace: string, label: string, timestamp: Date): string {
  const millis = timestamp.getTime();
  if (!Number.isSafeInteger(millis) || millis < 0 || millis >= 2 ** 48)
    throw new TelemetryAdmissionError('INVALID_ADMISSION');
  const digest = createHash('sha256').update(`${namespace}\0${label}`, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const time = BigInt(millis);
  for (let i = 5; i >= 0; i--) bytes[i] = Number((time >> BigInt((5 - i) * 8)) & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateRequest(request: AdmissionRequest): void {
  if (
    !UUID7.test(request.sourceId) ||
    !UUID7.test(request.manifestId) ||
    !request.dataset ||
    request.dataset.length > 128 ||
    !request.manifestKey ||
    request.manifestKey.length > 128 ||
    !Number.isFinite(request.receivedAt.getTime()) ||
    request.records.length < 1 ||
    request.records.length > MAX_RECORDS ||
    (request.cursor != null) !== (request.expectedRevision !== undefined) ||
    (request.expectedRevision !== undefined && request.expectedRevision < 0n)
  )
    throw new TelemetryAdmissionError('INVALID_ADMISSION');
  if (
    request.cursor &&
    (!request.cursor.to ||
      Buffer.byteLength(request.cursor.to, 'utf8') > 8192 ||
      !request.cursor.version ||
      request.cursor.version.length > 64)
  )
    throw new TelemetryAdmissionError('INVALID_ADMISSION');
  for (const record of request.records) {
    if (
      !record.sourceRecordId ||
      record.sourceRecordId.length > 512 ||
      record.dataset !== request.dataset ||
      !record.raw ||
      !Number.isFinite(Date.parse(record.collectedAt))
    )
      throw new TelemetryAdmissionError('INVALID_ADMISSION');
  }
}

/**
 * Durable, at-least-once admission. No checkpoint is changed unless all raw bytes
 * have been verified and the C-04 PostgreSQL transaction commits.
 */
export async function admitPage(
  request: AdmissionRequest,
  rawStore: DurableRawStore,
  repository: AdmissionRepository,
): Promise<AdmissionResult> {
  validateRequest(request);
  const bytes: Buffer[] = [];
  let totalBytes = 0;
  for (const record of request.records) {
    const raw = canonicalBytes(record.raw);
    totalBytes += raw.byteLength;
    if (totalBytes > MAX_BATCH_BYTES) throw new TelemetryAdmissionError('INVALID_ADMISSION');
    bytes.push(raw);
  }

  const rawProofs: RawObjectProof[] = [];
  const events: AdmissionCommand['events'][number][] = [];
  for (const [index, record] of request.records.entries()) {
    const rawId = deterministicUuid7(request.manifestId, `raw:${index}`, request.receivedAt);
    const digest = sha256(bytes[index]!);
    const objectRef = `raw:${rawId}`;
    let version: string | null | undefined;
    try {
      const stored = await rawStore.putIfAbsent(objectRef, bytes[index]!, digest);
      version = stored.version;
      const verified = await rawStore.get(objectRef, MAX_RAW_BYTES);
      if (
        verified.byteLength !== bytes[index]!.byteLength ||
        sha256(verified) !== digest ||
        !Buffer.from(verified).equals(bytes[index]!)
      )
        throw new RawObjectIntegrityError();
    } catch (error) {
      if (error instanceof TelemetryAdmissionError) throw error;
      if (error instanceof RawObjectIntegrityError)
        throw new TelemetryAdmissionError('RAW_INTEGRITY_FAILED', { cause: error });
      throw new TelemetryAdmissionError('RAW_PERSISTENCE_FAILED', { cause: error });
    }
    rawProofs.push({
      id: rawId,
      objectRef,
      ...(version === undefined ? {} : { objectVersion: version }),
      sha256: digest,
      mediaType: 'application/json',
      sizeBytes: bytes[index]!.byteLength,
      receivedAt: request.receivedAt,
    });
    events.push({
      id: deterministicUuid7(request.manifestId, `inbox:${index}`, request.receivedAt),
      recordId: deterministicUuid7(request.manifestId, `record:${index}`, request.receivedAt),
      providerEventId: record.sourceRecordId,
      idempotencyKey: deterministicUuid7(request.manifestId, `idem:${index}`, request.receivedAt),
      rawReferenceId: rawId,
    });
  }

  const command: AdmissionCommand = {
    sourceId: request.sourceId,
    dataset: request.dataset,
    manifestKey: request.manifestKey,
    manifestId: request.manifestId,
    outboxId: deterministicUuid7(request.manifestId, 'outbox', request.receivedAt),
    messageId: deterministicUuid7(request.manifestId, 'message', request.receivedAt),
    outboxIdempotencyKey: deterministicUuid7(request.manifestId, 'outbox-idem', request.receivedAt),
    receivedAt: request.receivedAt,
    events,
    newRawObjects: rawProofs,
    ...(request.expectedRevision === undefined
      ? {}
      : { expectedRevision: request.expectedRevision }),
    ...(request.cursor == null
      ? {}
      : {
          cursor: {
            ...request.cursor,
            ...(request.sourceGeneration === undefined
              ? {}
              : { sourceGeneration: request.sourceGeneration }),
            ...(request.lastOccurredAt === undefined
              ? {}
              : { lastOccurredAt: request.lastOccurredAt }),
            ...(request.lastTieBreaker === undefined
              ? {}
              : { lastTieBreaker: request.lastTieBreaker }),
          },
        }),
  };
  try {
    const receipt = await repository.commit(command);
    return { receipt, sha256: rawProofs.map((proof) => proof.sha256), byteCount: totalBytes };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'PERSISTENCE_CONCURRENCY_CONFLICT')
      throw new TelemetryAdmissionError('CHECKPOINT_CONFLICT', { cause: error });
    throw new TelemetryAdmissionError('DATABASE_ADMISSION_FAILED', { cause: error });
  }
}

export const TELEMETRY_ADMISSION_LIMITS = Object.freeze({
  maxRecords: MAX_RECORDS,
  maxRawBytes: MAX_RAW_BYTES,
  maxBatchBytes: MAX_BATCH_BYTES,
});
