/**
 * C-13 — cuarentena con linaje y reproceso.
 *
 * Un evento en cuarentena conserva la referencia exacta al objeto crudo que lo originó.
 * Sin ese linaje la cuarentena es un cementerio: se sabe que algo falló, no qué era ni
 * cómo repararlo. Con él, reprocesar es volver al original, no reconstruirlo.
 */

import type { NormalizationReason, QuarantinedRecord } from './wazuh-normalization.js';

export interface QuarantineLineage {
  readonly sourceId: string;
  readonly manifestId: string;
  readonly inboxId: string;
  readonly rawEventReferenceId: string;
  readonly recordId: string;
}

export interface QuarantineEntry {
  readonly lineage: QuarantineLineage;
  readonly errorCode: string;
  readonly errorPath: string | null;
  readonly contractVersion: string | null;
  readonly parserVersion: string | null;
  readonly status: QuarantineStatus;
  readonly attemptCount: number;
  readonly quarantinedAt: Date;
  readonly lastReprocessedAt: Date | null;
}

export const QUARANTINE_STATUSES = [
  'quarantined',
  'reprocessing',
  'resolved',
  'discarded',
] as const;
export type QuarantineStatus = (typeof QUARANTINE_STATUSES)[number];

export interface QuarantineRequest {
  readonly lineage: QuarantineLineage;
  readonly reason: NormalizationReason | { readonly code: string; readonly path?: string };
  readonly contractVersion?: string;
  readonly parserVersion?: string;
  readonly at: Date;
}

/** Construye la entrada de cuarentena. El linaje es obligatorio y se valida aquí. */
export function buildQuarantineEntry(request: QuarantineRequest): QuarantineEntry {
  const missing = (Object.keys(request.lineage) as (keyof QuarantineLineage)[]).filter(
    (key) => !request.lineage[key],
  );
  if (missing.length > 0) {
    throw new TypeError(`Linaje de cuarentena incompleto: falta ${missing.join(', ')}.`);
  }

  return {
    lineage: request.lineage,
    errorCode: request.reason.code,
    errorPath: request.reason.path ?? null,
    contractVersion: request.contractVersion ?? null,
    parserVersion: request.parserVersion ?? null,
    status: 'quarantined',
    attemptCount: 0,
    quarantinedAt: request.at,
    lastReprocessedAt: null,
  };
}

/**
 * Traduce la cuarentena que produce el normalizador (C-12), que trabaja con referencias al
 * crudo, a la entrada persistible de C-13, que trabaja con identidades de la base. La
 * correspondencia entre `rawRef` y `rawEventReferenceId` la aporta la admisión.
 */
export function fromNormalizationQuarantine(
  record: QuarantinedRecord,
  lineage: QuarantineLineage,
  at: Date,
): QuarantineEntry {
  return buildQuarantineEntry({
    lineage,
    reason: record.reason,
    parserVersion: record.mappingVersion,
    at,
  });
}

export type ReprocessDecision =
  | { readonly effect: 'reprocess'; readonly attemptCount: number }
  | { readonly effect: 'reject'; readonly reason: ReprocessRejectReason };

export type ReprocessRejectReason =
  'NOT_REPROCESSABLE' | 'ALREADY_REPROCESSING' | 'ATTEMPT_BUDGET_EXHAUSTED';

export interface ReprocessPolicy {
  readonly maximumAttempts: number;
}

export const DEFAULT_REPROCESS_POLICY: ReprocessPolicy = Object.freeze({ maximumAttempts: 3 });

/**
 * Un evento resuelto o descartado no se reabre, y uno ya en reproceso no se duplica. El
 * presupuesto evita que un poison permanente consuma la cola de reproceso para siempre.
 */
export function decideReprocess(
  entry: QuarantineEntry,
  policy: ReprocessPolicy = DEFAULT_REPROCESS_POLICY,
): ReprocessDecision {
  if (entry.status === 'reprocessing') {
    return { effect: 'reject', reason: 'ALREADY_REPROCESSING' };
  }
  if (entry.status !== 'quarantined') {
    return { effect: 'reject', reason: 'NOT_REPROCESSABLE' };
  }
  if (entry.attemptCount >= policy.maximumAttempts) {
    return { effect: 'reject', reason: 'ATTEMPT_BUDGET_EXHAUSTED' };
  }
  return { effect: 'reprocess', attemptCount: entry.attemptCount + 1 };
}

/** El linaje sobrevive a cualquier transición: reprocesar no lo reescribe. */
export function applyReprocess(entry: QuarantineEntry, at: Date): QuarantineEntry {
  const decision = decideReprocess(entry);
  if (decision.effect === 'reject') {
    throw new Error(`No se puede reprocesar: ${decision.reason}`);
  }
  return {
    ...entry,
    status: 'reprocessing',
    attemptCount: decision.attemptCount,
    lastReprocessedAt: at,
  };
}

export function resolveQuarantine(entry: QuarantineEntry): QuarantineEntry {
  if (entry.status !== 'reprocessing') {
    throw new Error('Solo una cuarentena en reproceso puede resolverse.');
  }
  return { ...entry, status: 'resolved' };
}
