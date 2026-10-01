/**
 * Puertos de C-19. Solo tipos: el dominio no conoce PostgreSQL ni el sistema de archivos.
 *
 * `AuditStore` no declara `update` ni `delete`. La ausencia es intencional y se refuerza
 * en la base con privilegios revocados y un trigger (migración `c19_audit_events`); un
 * adapter que los añada incumple el contrato aunque compile.
 */

import type { AuditChainHead, SealedAuditEvent } from './audit-event.js';
import type { AuditQuery } from './audit-query.js';

export interface AuditStore {
  /** La cabeza se lee dentro de la misma transacción que sella y escribe. */
  head(tenantId: string): Promise<AuditChainHead | undefined>;
  /** Falla si `sequence` ya existe: la unicidad por `(tenant, sequence)` la impone la base. */
  append(event: SealedAuditEvent): Promise<void>;
  read(query: AuditQuery): Promise<{
    readonly events: readonly SealedAuditEvent[];
    readonly nextCursor: string | null;
  }>;
  /** Rango contiguo por secuencia, para verificación y archivo. */
  range(
    tenantId: string,
    fromSequence: bigint,
    limit: number,
  ): Promise<readonly SealedAuditEvent[]>;
}

export interface AuditArchiveSegmentRef {
  readonly tenantId: string;
  readonly fromSequence: bigint;
  readonly toSequence: bigint;
  readonly objectRef: string;
  readonly sha256: string;
  readonly eventCount: number;
  readonly headHash: string;
}

export interface AuditArchive {
  write(tenantId: string, events: readonly SealedAuditEvent[]): Promise<AuditArchiveSegmentRef>;
  list(tenantId: string): Promise<readonly AuditArchiveSegmentRef[]>;
  read(ref: AuditArchiveSegmentRef): Promise<readonly SealedAuditEvent[]>;
}
