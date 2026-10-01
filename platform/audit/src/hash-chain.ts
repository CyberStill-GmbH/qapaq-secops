/**
 * C-19 — verificación de la cadena. Distingue tres fallos que no se tratan igual:
 *
 * - `TAMPERED`: el contenido ya no produce el hash almacenado. Alguien editó la fila.
 * - `FORKED`: el hash existe pero no encadena con el anterior. Se insertó o reemplazó.
 * - `GAP`: falta al menos una secuencia. Puede ser borrado o una ventana incompleta.
 *
 * La diferencia importa: un `GAP` sobre una página consultada es esperable; sobre un
 * segmento de archivo cerrado es un incidente.
 */

import {
  auditHash,
  AUDIT_CHAIN_GENESIS,
  type AuditChainHead,
  type SealedAuditEvent,
} from './audit-event.js';

export const CHAIN_VIOLATIONS = ['TAMPERED', 'FORKED', 'GAP', 'OUT_OF_ORDER'] as const;
export type ChainViolationCode = (typeof CHAIN_VIOLATIONS)[number];

export interface ChainViolation {
  readonly code: ChainViolationCode;
  readonly tenantId: string;
  readonly sequence: bigint;
  readonly eventId?: string;
  readonly detail: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly head?: AuditChainHead;
  readonly violations: readonly ChainViolation[];
}

export interface VerifyOptions {
  /** Cabeza previa cuando se verifica una página que no empieza en la secuencia 1. */
  readonly from?: AuditChainHead;
  /** `true` exige que la ventana sea contigua; el archivo cerrado siempre lo exige. */
  readonly requireContiguous?: boolean;
}

export function verifyChain(
  events: readonly SealedAuditEvent[],
  options: VerifyOptions = {},
): ChainVerification {
  const violations: ChainViolation[] = [];
  let previous: AuditChainHead | undefined = options.from;
  for (const event of events) {
    const expectedSequence = (previous?.sequence ?? 0n) + 1n;
    const expectedPrevious = previous?.hash ?? AUDIT_CHAIN_GENESIS;
    if (event.sequence < expectedSequence) {
      violations.push({
        code: 'OUT_OF_ORDER',
        tenantId: event.tenantId,
        sequence: event.sequence,
        eventId: event.id,
        detail: `La secuencia ${event.sequence} no avanza respecto de ${expectedSequence - 1n}.`,
      });
    } else if (event.sequence > expectedSequence) {
      const missing = event.sequence - expectedSequence;
      if (options.requireContiguous !== false) {
        violations.push({
          code: 'GAP',
          tenantId: event.tenantId,
          sequence: expectedSequence,
          detail: `Faltan ${missing} evento(s) antes de la secuencia ${event.sequence}.`,
        });
      }
    }
    if (event.hash !== auditHash(event, event.sequence, event.previousHash)) {
      violations.push({
        code: 'TAMPERED',
        tenantId: event.tenantId,
        sequence: event.sequence,
        eventId: event.id,
        detail: 'El contenido no reproduce el hash almacenado.',
      });
    } else if (event.sequence === expectedSequence && event.previousHash !== expectedPrevious) {
      violations.push({
        code: 'FORKED',
        tenantId: event.tenantId,
        sequence: event.sequence,
        eventId: event.id,
        detail: 'El enlace previo no corresponde con la cabeza verificada.',
      });
    }
    previous = { sequence: event.sequence, hash: event.hash };
  }
  return {
    ok: violations.length === 0,
    checked: events.length,
    ...(previous ? { head: previous } : {}),
    violations,
  };
}
