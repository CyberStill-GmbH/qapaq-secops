/**
 * Puerto de C-16. La unicidad por `idempotencyKey` la impone la base, no este contrato:
 * `insertIfAbsent` devuelve `false` cuando la fila ya existía, de modo que dos workers
 * que promuevan el mismo evento a la vez terminen con un único candidato.
 */

import type { DetectionCandidate } from './promotion.js';

export interface DetectionCandidateStore {
  byIdempotencyKey(tenantId: string, key: string): Promise<DetectionCandidate | undefined>;
  insertIfAbsent(candidate: DetectionCandidate): Promise<boolean>;
}
