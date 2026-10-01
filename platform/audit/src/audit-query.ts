/**
 * C-19 — consulta autorizada y redactada de auditoría.
 *
 * La auditoría contiene exactamente lo que la observabilidad no debe contener: quién,
 * sobre qué y con qué resultado. Por eso leerla es una capability propia y distinta de
 * leer eventos de seguridad, y por eso la proyección se redacta por defecto. Redactar
 * no modifica el registro sellado: solo lo que sale hacia el lector.
 */

import type { CanonicalValue } from './canonical-json.js';
import type { SealedAuditEvent } from './audit-event.js';

export const AUDIT_READ = 'audit.read' as const;
/** Permite ver IP, sesión y metadata sin enmascarar. Se concede por separado. */
export const AUDIT_READ_SENSITIVE = 'audit.read_sensitive' as const;
export const AUDIT_VERIFY = 'audit.verify' as const;

export const AUDIT_QUERY_LIMITS = Object.freeze({
  defaultPageSize: 50,
  maximumPageSize: 200,
  maximumRangeDays: 365,
});

export const AUDIT_QUERY_ERROR_CODES = [
  'UNAUTHORIZED',
  'TENANT_REQUIRED',
  'PAGE_SIZE_INVALID',
  'PAGE_SIZE_EXCEEDED',
  'RANGE_REQUIRED',
  'RANGE_INVERTED',
  'RANGE_TOO_WIDE',
  'FILTER_VALUE_UNKNOWN',
] as const;
export type AuditQueryErrorCode = (typeof AUDIT_QUERY_ERROR_CODES)[number];

export interface AuditReaderContext {
  readonly tenantId: string;
  readonly capabilities: ReadonlySet<string>;
}

export interface RawAuditQuery {
  readonly from?: string;
  readonly to?: string;
  readonly pageSize?: number;
  readonly cursor?: string;
  readonly action?: string;
  readonly actorId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: readonly string[];
}

export interface AuditQuery {
  readonly tenantId: string;
  readonly from: Date;
  readonly to: Date;
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly action: string | null;
  readonly actorId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly outcome: readonly string[];
  readonly includeSensitive: boolean;
}

export type AuditQueryPlan =
  | { readonly ok: true; readonly query: AuditQuery }
  | {
      readonly ok: false;
      readonly rejection: { readonly code: AuditQueryErrorCode; readonly field: string };
    };

const OUTCOMES = new Set(['allowed', 'denied', 'succeeded', 'failed']);

function reject(code: AuditQueryErrorCode, field: string): AuditQueryPlan {
  return { ok: false, rejection: { code, field } };
}

export function planAuditQuery(raw: RawAuditQuery, reader: AuditReaderContext): AuditQueryPlan {
  if (!reader.capabilities.has(AUDIT_READ)) return reject('UNAUTHORIZED', 'capabilities');
  if (!reader.tenantId) return reject('TENANT_REQUIRED', 'tenantId');
  const pageSize = raw.pageSize ?? AUDIT_QUERY_LIMITS.defaultPageSize;
  if (!Number.isInteger(pageSize) || pageSize <= 0) return reject('PAGE_SIZE_INVALID', 'pageSize');
  if (pageSize > AUDIT_QUERY_LIMITS.maximumPageSize) {
    return reject('PAGE_SIZE_EXCEEDED', 'pageSize');
  }
  if (!raw.from || !raw.to) return reject('RANGE_REQUIRED', 'from');
  const from = new Date(raw.from);
  const to = new Date(raw.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return reject('RANGE_REQUIRED', Number.isNaN(from.getTime()) ? 'from' : 'to');
  }
  if (from.getTime() > to.getTime()) return reject('RANGE_INVERTED', 'from');
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > AUDIT_QUERY_LIMITS.maximumRangeDays) return reject('RANGE_TOO_WIDE', 'to');
  for (const value of raw.outcome ?? []) {
    if (!OUTCOMES.has(value)) return reject('FILTER_VALUE_UNKNOWN', 'outcome');
  }
  return {
    ok: true,
    query: {
      tenantId: reader.tenantId,
      from,
      to,
      pageSize,
      cursor: raw.cursor ?? null,
      action: raw.action ?? null,
      actorId: raw.actorId ?? null,
      resourceType: raw.resourceType ?? null,
      resourceId: raw.resourceId ?? null,
      outcome: raw.outcome ? [...raw.outcome] : [],
      includeSensitive: reader.capabilities.has(AUDIT_READ_SENSITIVE),
    },
  };
}

export const REDACTED = '[REDACTED]' as const;

/** Claves cuyo valor nunca sale sin capability sensible, venga de donde venga. */
const SENSITIVE_KEY =
  /pass(word|phrase)|secret|token|authorization|cookie|credential|api[-_]?key/iu;

function redactMetadata(value: CanonicalValue, depth = 0): CanonicalValue {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1));
  const entries = Object.entries(value as Record<string, CanonicalValue>).map(([key, item]) =>
    SENSITIVE_KEY.test(key) ? [key, REDACTED] : [key, redactMetadata(item, depth + 1)],
  );
  return Object.fromEntries(entries) as CanonicalValue;
}

export interface AuditProjection {
  readonly id: string;
  readonly tenantId: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly id: string;
    readonly type: string;
    readonly sessionId?: string;
    readonly ip?: string;
  };
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly outcome: string;
  readonly correlationId: string;
  readonly reason?: string;
  readonly metadata: CanonicalValue;
  readonly hash: string;
  readonly previousHash: string;
}

export function projectAuditEvent(
  event: SealedAuditEvent,
  options: { readonly includeSensitive: boolean },
): AuditProjection {
  const sensitive = options.includeSensitive;
  return {
    id: event.id,
    tenantId: event.tenantId,
    sequence: event.sequence.toString(),
    occurredAt: event.occurredAt.toISOString(),
    actor: {
      id: event.actor.id,
      type: event.actor.type,
      ...(event.actor.sessionId ? { sessionId: sensitive ? event.actor.sessionId : REDACTED } : {}),
      ...(event.actor.ip ? { ip: sensitive ? event.actor.ip : REDACTED } : {}),
    },
    action: event.action,
    resource: { type: event.resource.type, id: event.resource.id },
    outcome: event.outcome,
    correlationId: event.correlationId,
    ...(event.reason ? { reason: event.reason } : {}),
    metadata: sensitive
      ? ((event.metadata ?? null) as CanonicalValue)
      : redactMetadata((event.metadata ?? null) as CanonicalValue),
    hash: event.hash,
    previousHash: event.previousHash,
  };
}
