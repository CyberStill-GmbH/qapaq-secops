/**
 * C-13 — avance de cursor de fuente.
 *
 * Dominio puro. El cursor nunca retrocede y nunca se adelanta a lo efectivamente
 * procesado: ésas son las dos formas de perder eventos en silencio. La tercera —
 * adelantarlo tras un fallo— se evita porque el avance solo se decide con la página
 * confirmada, no con la leída.
 */

export interface CheckpointPosition {
  /** Instante del último registro confirmado. */
  readonly lastOccurredAt: Date;
  /** Desempate estable cuando dos registros comparten instante. */
  readonly lastTieBreaker: string;
}

export interface CheckpointState extends CheckpointPosition {
  readonly cursor: string;
  readonly revision: bigint;
  /**
   * Identidad de la generación de la fuente. Si la fuente se reinicia o se recrea, cambia,
   * y un cursor de la generación anterior deja de ser comparable.
   */
  readonly sourceGeneration: string | null;
}

export interface CheckpointCandidate extends CheckpointPosition {
  readonly cursor: string;
  readonly sourceGeneration: string | null;
  /** Revisión que el llamante leyó. El avance es compare-and-set sobre ella. */
  readonly expectedRevision: bigint;
}

export type CheckpointDecision =
  | { readonly effect: 'advance'; readonly cursor: string; readonly revision: bigint }
  | { readonly effect: 'ignore'; readonly reason: CheckpointIgnoreReason }
  | { readonly effect: 'conflict'; readonly reason: CheckpointConflictReason };

export type CheckpointIgnoreReason = 'ALREADY_AT_POSITION' | 'WOULD_REGRESS';
export type CheckpointConflictReason = 'REVISION_STALE' | 'SOURCE_GENERATION_CHANGED';

/** Orden total: primero el instante, luego el desempate. */
export function comparePositions(left: CheckpointPosition, right: CheckpointPosition): number {
  const byTime = left.lastOccurredAt.getTime() - right.lastOccurredAt.getTime();
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  if (left.lastTieBreaker === right.lastTieBreaker) return 0;
  return left.lastTieBreaker < right.lastTieBreaker ? -1 : 1;
}

export function decideCheckpointAdvance(
  current: CheckpointState,
  candidate: CheckpointCandidate,
): CheckpointDecision {
  // Una escritura concurrente ya movió el cursor: el llamante debe releer y recalcular.
  if (candidate.expectedRevision !== current.revision) {
    return { effect: 'conflict', reason: 'REVISION_STALE' };
  }

  // La fuente cambió de generación: comparar posiciones entre generaciones distintas no
  // significa nada, y avanzar a ciegas saltaría eventos. Se escala, no se adivina.
  if (
    current.sourceGeneration !== null &&
    candidate.sourceGeneration !== null &&
    current.sourceGeneration !== candidate.sourceGeneration
  ) {
    return { effect: 'conflict', reason: 'SOURCE_GENERATION_CHANGED' };
  }

  const order = comparePositions(candidate, current);
  if (order === 0) return { effect: 'ignore', reason: 'ALREADY_AT_POSITION' };
  if (order < 0) return { effect: 'ignore', reason: 'WOULD_REGRESS' };

  return {
    effect: 'advance',
    cursor: candidate.cursor,
    revision: current.revision + 1n,
  };
}

/**
 * Posición máxima de una página confirmada. Devuelve `undefined` para una página vacía:
 * sin registros confirmados no hay nada que avanzar.
 */
export function highWaterMark(
  positions: readonly CheckpointPosition[],
): CheckpointPosition | undefined {
  let maximum: CheckpointPosition | undefined;
  for (const position of positions) {
    if (maximum === undefined || comparePositions(position, maximum) > 0) maximum = position;
  }
  return maximum;
}
