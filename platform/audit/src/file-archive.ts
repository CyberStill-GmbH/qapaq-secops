/**
 * Adapter de archivo en sistema de ficheros para C-19.
 *
 * El segmento se escribe como JSONL inmutable más un manifiesto con su sha256. Se
 * escribe primero en un temporal y se renombra: un corte a mitad de escritura deja un
 * segmento completo o ninguno, nunca uno truncado que después pase por íntegro.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CanonicalValue } from './canonical-json.js';
import type { AuditActorType, AuditOutcome, SealedAuditEvent } from './audit-event.js';
import type { AuditArchive, AuditArchiveSegmentRef } from './ports.js';

interface SerializedEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly id: string;
    readonly type: AuditActorType;
    readonly sessionId?: string;
    readonly ip?: string;
  };
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, CanonicalValue>>;
  readonly previousHash: string;
  readonly hash: string;
}

function serialize(event: SealedAuditEvent): SerializedEvent {
  return {
    id: event.id,
    tenantId: event.tenantId,
    sequence: event.sequence.toString(),
    occurredAt: event.occurredAt.toISOString(),
    actor: {
      id: event.actor.id,
      type: event.actor.type,
      ...(event.actor.sessionId === undefined ? {} : { sessionId: event.actor.sessionId }),
      ...(event.actor.ip === undefined ? {} : { ip: event.actor.ip }),
    },
    action: event.action,
    resource: { type: event.resource.type, id: event.resource.id },
    outcome: event.outcome,
    correlationId: event.correlationId,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.metadata === undefined ? {} : { metadata: { ...event.metadata } }),
    previousHash: event.previousHash,
    hash: event.hash,
  };
}

function deserialize(line: SerializedEvent): SealedAuditEvent {
  return {
    id: line.id,
    tenantId: line.tenantId,
    sequence: BigInt(line.sequence),
    occurredAt: new Date(line.occurredAt),
    actor: line.actor,
    action: line.action,
    resource: line.resource,
    outcome: line.outcome,
    correlationId: line.correlationId,
    ...(line.reason === undefined ? {} : { reason: line.reason }),
    ...(line.metadata === undefined ? {} : { metadata: line.metadata }),
    previousHash: line.previousHash,
    hash: line.hash,
  };
}

export type AuditArchiveErrorCode = 'EMPTY_SEGMENT' | 'SEGMENT_CORRUPT' | 'SEGMENT_MISSING';

export class AuditArchiveError extends Error {
  public constructor(
    public readonly code: AuditArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuditArchiveError';
  }
}

const pad = (value: bigint) => value.toString().padStart(20, '0');

export class FileAuditArchive implements AuditArchive {
  public constructor(private readonly root: string) {}

  private segmentPath(tenantId: string, fromSequence: bigint, toSequence: bigint): string {
    return join(
      this.root,
      encodeURIComponent(tenantId),
      `${pad(fromSequence)}-${pad(toSequence)}.jsonl`,
    );
  }

  public async write(
    tenantId: string,
    events: readonly SealedAuditEvent[],
  ): Promise<AuditArchiveSegmentRef> {
    const first = events[0];
    const last = events.at(-1);
    if (!first || !last) {
      throw new AuditArchiveError('EMPTY_SEGMENT', 'Un segmento de archivo no puede ir vacío.');
    }
    const body = `${events.map((event) => JSON.stringify(serialize(event))).join('\n')}\n`;
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    const path = this.segmentPath(tenantId, first.sequence, last.sequence);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, path);
    const ref: AuditArchiveSegmentRef = {
      tenantId,
      fromSequence: first.sequence,
      toSequence: last.sequence,
      objectRef: path,
      sha256,
      eventCount: events.length,
      headHash: last.hash,
    };
    await writeFile(
      `${path}.manifest.json`,
      JSON.stringify(
        {
          ...ref,
          fromSequence: ref.fromSequence.toString(),
          toSequence: ref.toSequence.toString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    return ref;
  }

  public async list(tenantId: string): Promise<readonly AuditArchiveSegmentRef[]> {
    const directory = join(this.root, encodeURIComponent(tenantId));
    let names: readonly string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const refs = await Promise.all(
      names
        .filter((name) => name.endsWith('.manifest.json'))
        .map(async (name) => {
          const parsed = JSON.parse(await readFile(join(directory, name), 'utf8')) as Omit<
            AuditArchiveSegmentRef,
            'fromSequence' | 'toSequence'
          > & { readonly fromSequence: string; readonly toSequence: string };
          return {
            ...parsed,
            fromSequence: BigInt(parsed.fromSequence),
            toSequence: BigInt(parsed.toSequence),
          } satisfies AuditArchiveSegmentRef;
        }),
    );
    return [...refs].sort((left, right) => (left.fromSequence < right.fromSequence ? -1 : 1));
  }

  public async read(ref: AuditArchiveSegmentRef): Promise<readonly SealedAuditEvent[]> {
    let body: string;
    try {
      body = await readFile(ref.objectRef, 'utf8');
    } catch {
      throw new AuditArchiveError('SEGMENT_MISSING', `Segmento ausente: ${ref.objectRef}.`);
    }
    // El digest se comprueba antes de interpretar: un segmento alterado no se parsea.
    if (createHash('sha256').update(body, 'utf8').digest('hex') !== ref.sha256) {
      throw new AuditArchiveError('SEGMENT_CORRUPT', `Digest distinto en ${ref.objectRef}.`);
    }
    return body
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => deserialize(JSON.parse(line) as SerializedEvent));
  }
}
