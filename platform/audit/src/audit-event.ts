/**
 * C-19 — AuditEvent append-only con cadena de hash por tenant.
 *
 * Tres decisiones que la implementación no puede relajar:
 *
 * 1. **Append-only**: no existe función de actualización ni de borrado. El rol de
 *    runtime tampoco tiene esos privilegios (ver migración `c19_audit_events`).
 * 2. **Encadenamiento por tenant**: cada evento referencia el hash del anterior de su
 *    propio tenant. Un tenant no puede sellar ni invalidar la cadena de otro.
 * 3. **El hash cubre la carga completa**, incluida la metadata. Redactar en consulta
 *    no altera el hash: se redacta la proyección, nunca el registro sellado.
 */

import { createHash } from 'node:crypto';
import { canonicalize, type CanonicalValue } from './canonical-json.js';

export const AUDIT_HASH_ALGORITHM = 'sha256' as const;

/** Raíz de la cadena de cada tenant. 64 ceros: no es un hash alcanzable por sha256. */
export const AUDIT_CHAIN_GENESIS = '0'.repeat(64);

export const AUDIT_ACTOR_TYPES = ['user', 'service', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ['allowed', 'denied', 'succeeded', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditActor {
  readonly id: string;
  readonly type: AuditActorType;
  readonly sessionId?: string;
  readonly ip?: string;
}

export interface AuditResource {
  readonly type: string;
  readonly id: string;
}

/** Lo que el caso de uso declara. El sellado añade secuencia, hash y encadenamiento. */
export interface AuditEventDraft {
  readonly id: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resource: AuditResource;
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, CanonicalValue>>;
}

export interface SealedAuditEvent extends AuditEventDraft {
  readonly sequence: bigint;
  readonly previousHash: string;
  readonly hash: string;
}

/** Cabeza de cadena de un tenant. `undefined` significa cadena vacía, no cadena rota. */
export interface AuditChainHead {
  readonly sequence: bigint;
  readonly hash: string;
}

export const AUDIT_LIMITS = Object.freeze({
  maximumActionLength: 128,
  maximumReasonLength: 512,
  /** Tamaño canónico de la metadata. La auditoría no es un almacén de documentos. */
  maximumMetadataBytes: 8 * 1024,
});

export const AUDIT_DRAFT_ERROR_CODES = [
  'ACTION_REQUIRED',
  'ACTION_TOO_LONG',
  'ACTOR_REQUIRED',
  'CORRELATION_REQUIRED',
  'METADATA_TOO_LARGE',
  'OCCURRED_AT_INVALID',
  'REASON_TOO_LONG',
  'RESOURCE_REQUIRED',
  'TENANT_REQUIRED',
] as const;
export type AuditDraftErrorCode = (typeof AUDIT_DRAFT_ERROR_CODES)[number];

export class AuditDraftError extends Error {
  public constructor(
    public readonly code: AuditDraftErrorCode,
    public readonly field: string,
  ) {
    super(`AuditEvent inválido: ${code} (${field}).`);
    this.name = 'AuditDraftError';
  }
}

function assertDraft(draft: AuditEventDraft): void {
  if (!draft.tenantId) throw new AuditDraftError('TENANT_REQUIRED', 'tenantId');
  if (!draft.actor?.id) throw new AuditDraftError('ACTOR_REQUIRED', 'actor.id');
  if (!draft.action) throw new AuditDraftError('ACTION_REQUIRED', 'action');
  if (draft.action.length > AUDIT_LIMITS.maximumActionLength) {
    throw new AuditDraftError('ACTION_TOO_LONG', 'action');
  }
  if (!draft.resource?.type || !draft.resource.id) {
    throw new AuditDraftError('RESOURCE_REQUIRED', 'resource');
  }
  if (!draft.correlationId) throw new AuditDraftError('CORRELATION_REQUIRED', 'correlationId');
  if (Number.isNaN(draft.occurredAt?.getTime?.() ?? Number.NaN)) {
    throw new AuditDraftError('OCCURRED_AT_INVALID', 'occurredAt');
  }
  if (draft.reason && draft.reason.length > AUDIT_LIMITS.maximumReasonLength) {
    throw new AuditDraftError('REASON_TOO_LONG', 'reason');
  }
  if (
    draft.metadata &&
    Buffer.byteLength(canonicalize(draft.metadata), 'utf8') > AUDIT_LIMITS.maximumMetadataBytes
  ) {
    throw new AuditDraftError('METADATA_TOO_LARGE', 'metadata');
  }
}

/** Contenido exacto sobre el que se calcula el hash. Cambiarlo invalida cadenas previas. */
export function auditDigestInput(
  draft: AuditEventDraft,
  sequence: bigint,
  previousHash: string,
): string {
  assertDraft(draft);
  return canonicalize({
    v: 1,
    id: draft.id,
    tenantId: draft.tenantId,
    sequence: sequence.toString(),
    previousHash,
    occurredAt: draft.occurredAt.toISOString(),
    actor: {
      id: draft.actor.id,
      type: draft.actor.type,
      sessionId: draft.actor.sessionId,
      ip: draft.actor.ip,
    },
    action: draft.action,
    resource: { type: draft.resource.type, id: draft.resource.id },
    outcome: draft.outcome,
    correlationId: draft.correlationId,
    reason: draft.reason,
    metadata: draft.metadata ?? null,
  });
}

export function auditHash(draft: AuditEventDraft, sequence: bigint, previousHash: string): string {
  return createHash(AUDIT_HASH_ALGORITHM)
    .update(auditDigestInput(draft, sequence, previousHash), 'utf8')
    .digest('hex');
}

/** Sella el borrador contra la cabeza de cadena recibida. No escribe: eso es del store. */
export function sealAuditEvent(
  draft: AuditEventDraft,
  head: AuditChainHead | undefined,
): SealedAuditEvent {
  const sequence = (head?.sequence ?? 0n) + 1n;
  const previousHash = head?.hash ?? AUDIT_CHAIN_GENESIS;
  return { ...draft, sequence, previousHash, hash: auditHash(draft, sequence, previousHash) };
}
