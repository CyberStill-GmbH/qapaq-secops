/**
 * C-19 — escritura atómica de auditoría.
 *
 * El contrato con C-17 y C-20 es que el cambio de estado, su AuditEvent y su mensaje de
 * outbox entran o no entran juntos. `recordAudit` sella contra la cabeza leída dentro de
 * la misma unidad de trabajo y reintenta una vez si otra transacción ganó la carrera por
 * la secuencia: la colisión es legítima y no debe propagarse como error de negocio.
 */

import { sealAuditEvent, type AuditEventDraft, type SealedAuditEvent } from './audit-event.js';
import type { AuditStore } from './ports.js';

export const AUDIT_APPEND_MAX_ATTEMPTS = 8;

export class AuditAppendExhaustedError extends Error {
  public constructor(public readonly attempts: number) {
    super(`No se pudo encadenar el AuditEvent tras ${attempts} intentos.`);
    this.name = 'AuditAppendExhaustedError';
  }
}

export async function recordAudit(
  store: AuditStore,
  draft: AuditEventDraft,
): Promise<SealedAuditEvent> {
  for (let attempt = 1; attempt <= AUDIT_APPEND_MAX_ATTEMPTS; attempt += 1) {
    const sealed = sealAuditEvent(draft, await store.head(draft.tenantId));
    try {
      await store.append(sealed);
      return sealed;
    } catch (error) {
      // Un conflicto de secuencia significa que la cabeza cambió; releerla es la respuesta
      // correcta. Cualquier otro fallo es del adapter y debe salir tal cual.
      if (attempt === AUDIT_APPEND_MAX_ATTEMPTS || !isSequenceConflict(error)) throw error;
    }
  }
  throw new AuditAppendExhaustedError(AUDIT_APPEND_MAX_ATTEMPTS);
}

function isSequenceConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AuditAppendConflictError') return true;
  // PostgreSQL: violación de unicidad sobre `(tenant_id, sequence)`.
  const code = (error as { code?: unknown }).code;
  return code === '23505' || code === 'P2002';
}
