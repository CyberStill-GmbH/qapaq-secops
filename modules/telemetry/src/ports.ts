/**
 * Puertos de C-13 y C-14. Solo tipos: la dirección de la dependencia apunta hacia adentro
 * y el dominio no conoce PostgreSQL, Redis ni OpenSearch.
 *
 * Ningún adaptador existe todavía. Estos contratos fijan qué debe cumplir el que se
 * escriba, y la suite de conformidad que los verifique corre contra dependencias reales,
 * no contra dobles (Definition of Done, sección Specs automatizadas).
 */

import type { SecurityEvent } from '@qapaq/contracts';

import type { CheckpointCandidate, CheckpointState } from './checkpoint-advance.js';
import type { InboxEntry, InboxStatus } from './inbox-lifecycle.js';
import type { ProjectionDocument, ProjectedState } from './event-projection.js';
import type { EventQuery, EventPage } from './event-query.js';
import type { QuarantineEntry } from './quarantine-reprocess.js';

/** C-13 — bandeja de entrada. La unicidad por `(sourceId, idempotencyKey)` la impone la base. */
export interface EventInboxStore {
  /** Devuelve las claves ya conocidas de un lote, para planificar el replay sin insertar. */
  knownIdempotencyKeys(sourceId: string, keys: readonly string[]): Promise<ReadonlySet<string>>;
  /** Toma el lease de forma atómica; `undefined` si otro trabajador se adelantó. */
  acquireLease(
    sourceId: string,
    limit: number,
    now: Date,
    leaseMs: number,
  ): Promise<readonly InboxEntry[]>;
  transition(
    entry: InboxEntry,
    to: InboxStatus,
    attemptCount: number,
    availableAt: Date,
    lastErrorCode?: string,
  ): Promise<void>;
}

/** C-13 — cuarentena. El linaje es una clave foránea, no una convención. */
export interface QuarantineStore {
  record(entry: QuarantineEntry): Promise<void>;
  listReprocessable(sourceId: string, limit: number): Promise<readonly QuarantineEntry[]>;
  save(entry: QuarantineEntry): Promise<void>;
}

/** C-13 — cursor de fuente, con compare-and-set sobre `revision`. */
export interface CheckpointStore {
  read(sourceId: string, dataset: string): Promise<CheckpointState | undefined>;
  /** `false` si la revisión esperada ya no es la vigente; el llamante relee y recalcula. */
  compareAndSet(
    sourceId: string,
    dataset: string,
    candidate: CheckpointCandidate,
    nextRevision: bigint,
  ): Promise<boolean>;
}

/** C-14 — proyección al índice de consulta. La escritura es idempotente por `document.id`. */
export interface EventProjectionStore {
  current(ids: readonly string[]): Promise<readonly ProjectedState[]>;
  index(documents: readonly ProjectionDocument[]): Promise<void>;
}

/** C-14 — lectura. El puerto recibe una consulta ya autorizada y acotada. */
export interface EventQueryStore {
  search(query: EventQuery): Promise<{
    readonly events: readonly SecurityEvent[];
    readonly nextCursor: string | null;
  }>;
}

export type { EventPage };
