/**
 * C-14 — proyección de `SecurityEvent` hacia el índice de consulta.
 *
 * Dominio puro: construye el documento proyectable y decide si una proyección debe
 * escribirse. No habla con OpenSearch; el adaptador que lo haga debe satisfacer
 * `testing/event-projection-store.contract.ts`.
 *
 * La proyección es idempotente por construcción: el identificador del documento es el
 * `recordId` del evento, de modo que reproyectar el mismo evento sobrescribe en lugar de
 * duplicar. Una caída a mitad de página no deja copias.
 */

import type { SecurityEvent } from '@qapaq/contracts';

/** Versión del esquema de proyección. Un cambio obliga a reindexar, y por eso viaja en el documento. */
export const PROJECTION_VERSION = '1.0.0' as const;

export interface ProjectionDocument {
  readonly id: string;
  readonly projectionVersion: string;
  readonly tenantId: string;
  readonly eventUid: string;
  readonly kind: SecurityEvent['kind'];
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly severity: SecurityEvent['severity']['normalized'];
  readonly severityScore: number | null;
  readonly category: readonly string[];
  readonly outcome: SecurityEvent['outcome'];
  readonly action: string | null;
  readonly sourceKind: SecurityEvent['source']['kind'];
  readonly sourceVendor: string;
  readonly sourceProduct: string;
  readonly dataset: string;
  readonly instanceId: string;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly principals: readonly string[];
  readonly resources: readonly string[];
  /** Solo la referencia y la huella. El contenido crudo nunca entra al índice de consulta. */
  readonly rawRef: string;
  readonly rawSha256: string;
  readonly mappingVersion: string;
}

export function buildProjectionDocument(event: SecurityEvent): ProjectionDocument {
  return {
    id: event.recordId,
    projectionVersion: PROJECTION_VERSION,
    tenantId: event.tenant.id,
    eventUid: event.eventUid,
    kind: event.kind,
    occurredAt: event.occurredAt,
    observedAt: event.observedAt,
    receivedAt: event.receivedAt,
    severity: event.severity.normalized,
    severityScore: event.severity.score ?? null,
    category: [...event.category],
    outcome: event.outcome,
    action: event.action ?? null,
    sourceKind: event.source.kind,
    sourceVendor: event.source.vendor,
    sourceProduct: event.source.product,
    dataset: event.source.dataset,
    instanceId: event.source.instanceId,
    ruleId: event.detection?.rule.id ?? null,
    ruleName: event.detection?.rule.name ?? null,
    principals: event.entities.identities
      .map((identity) => identity.principal)
      .filter((principal): principal is string => typeof principal === 'string'),
    resources: event.entities.resources
      .map((resource) => resource.name)
      .filter((name): name is string => typeof name === 'string'),
    rawRef: event.raw.ref,
    rawSha256: event.raw.sha256,
    mappingVersion: event.provenance.mappingVersion,
  };
}

export type ProjectionDecision =
  | { readonly effect: 'index'; readonly document: ProjectionDocument }
  | { readonly effect: 'skip'; readonly reason: 'ALREADY_CURRENT' }
  | { readonly effect: 'reindex'; readonly document: ProjectionDocument; readonly from: string };

export interface ProjectedState {
  readonly id: string;
  readonly projectionVersion: string;
}

/**
 * Decide si una proyección debe escribirse. Reproyectar un documento ya al día no cuesta
 * una escritura; un documento de versión anterior se reindexa explícitamente, para que la
 * migración sea observable y no un efecto colateral.
 */
export function decideProjection(
  event: SecurityEvent,
  existing: ProjectedState | undefined,
): ProjectionDecision {
  const document = buildProjectionDocument(event);
  if (existing === undefined) return { effect: 'index', document };
  if (existing.projectionVersion === PROJECTION_VERSION) {
    return { effect: 'skip', reason: 'ALREADY_CURRENT' };
  }
  return { effect: 'reindex', document, from: existing.projectionVersion };
}
