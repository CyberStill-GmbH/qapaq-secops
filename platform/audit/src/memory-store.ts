/**
 * Store en memoria de C-19, para unit specs y para el harness E2E.
 *
 * No es un adapter productivo y no pretende serlo: no hay transacción ni durabilidad.
 * Lo que sí reproduce son las dos reglas que el adapter real debe cumplir, porque son
 * las que el dominio asume: unicidad por `(tenant, sequence)` y ausencia total de
 * actualización o borrado.
 */

import type { AuditChainHead, SealedAuditEvent } from './audit-event.js';
import type { AuditQuery } from './audit-query.js';
import type { AuditStore } from './ports.js';

export class AuditAppendConflictError extends Error {
  public constructor(
    public readonly tenantId: string,
    public readonly sequence: bigint,
  ) {
    super(`La secuencia ${sequence} ya existe para ${tenantId}.`);
    this.name = 'AuditAppendConflictError';
  }
}

export class InMemoryAuditStore implements AuditStore {
  private readonly byTenant = new Map<string, SealedAuditEvent[]>();

  private chain(tenantId: string): SealedAuditEvent[] {
    const existing = this.byTenant.get(tenantId);
    if (existing) return existing;
    const created: SealedAuditEvent[] = [];
    this.byTenant.set(tenantId, created);
    return created;
  }

  public head(tenantId: string): Promise<AuditChainHead | undefined> {
    const last = this.chain(tenantId).at(-1);
    return Promise.resolve(last ? { sequence: last.sequence, hash: last.hash } : undefined);
  }

  public append(event: SealedAuditEvent): Promise<void> {
    const chain = this.chain(event.tenantId);
    if (chain.some((existing) => existing.sequence === event.sequence)) {
      return Promise.reject(new AuditAppendConflictError(event.tenantId, event.sequence));
    }
    chain.push(event);
    return Promise.resolve();
  }

  public read(query: AuditQuery): Promise<{
    readonly events: readonly SealedAuditEvent[];
    readonly nextCursor: string | null;
  }> {
    const after = query.cursor ? BigInt(query.cursor) : 0n;
    const matching = this.chain(query.tenantId).filter(
      (event) =>
        event.sequence > after &&
        event.occurredAt >= query.from &&
        event.occurredAt <= query.to &&
        (query.action === null || event.action === query.action) &&
        (query.actorId === null || event.actor.id === query.actorId) &&
        (query.resourceType === null || event.resource.type === query.resourceType) &&
        (query.resourceId === null || event.resource.id === query.resourceId) &&
        (query.outcome.length === 0 || query.outcome.includes(event.outcome)),
    );
    const page = matching.slice(0, query.pageSize);
    const last = page.at(-1);
    return Promise.resolve({
      events: page,
      nextCursor: matching.length > page.length && last ? last.sequence.toString() : null,
    });
  }

  public range(
    tenantId: string,
    fromSequence: bigint,
    limit: number,
  ): Promise<readonly SealedAuditEvent[]> {
    return Promise.resolve(
      this.chain(tenantId)
        .filter((event) => event.sequence >= fromSequence)
        .slice(0, limit),
    );
  }

  /** Utilidad de specs y de harness: tenants con cadena iniciada en este store. */
  public tenants(): readonly string[] {
    return [...this.byTenant.keys()];
  }

  /** Solo para specs de manipulación: reproduce una fila editada fuera del contrato. */
  public forceReplaceForTamperSpec(tenantId: string, event: SealedAuditEvent): void {
    const chain = this.chain(tenantId);
    const index = chain.findIndex((existing) => existing.sequence === event.sequence);
    if (index >= 0) chain[index] = event;
  }

  /** Solo para specs de hueco: reproduce un borrado que el adapter real no permite. */
  public forceDeleteForGapSpec(tenantId: string, sequence: bigint): void {
    const chain = this.chain(tenantId);
    const index = chain.findIndex((existing) => existing.sequence === sequence);
    if (index >= 0) chain.splice(index, 1);
  }
}
