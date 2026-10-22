/**
 * Roles concedidos por QAPAQ desde la administración (entra-soc-user-admin.md).
 *
 * Es la tercera fuente de roles, separada a propósito de las otras dos: las asignaciones del
 * deploy (`QAPAQ_ROLE_BINDINGS`) y los dueños del grupo de admisión siguen saliendo de
 * configuración y del padrón, y este store nunca las lee ni las escribe. Así, retirar un grant
 * dinámico no puede quitar un rol que el deploy declara, ni un administrador puede, desde la
 * consola, tocar el admin que deriva de ser dueño del grupo.
 *
 * Un grant es el conjunto completo de roles dinámicos de una persona (`tenantId`, `oid`): cada
 * cambio lo reemplaza entero bajo compare-and-set sobre `revision`. Sin fila, la revisión es 0.
 * Retirar todos los roles deja la fila con el conjunto vacío: no hay DELETE, y la historia
 * queda en la auditoría.
 */

export interface RoleGrant {
  readonly tenantId: string;
  /** Object ID de Entra en minúsculas. */
  readonly oid: string;
  readonly roles: readonly string[];
  /** Avanza en cada reemplazo; 0 significa «sin grant todavía». */
  readonly revision: number;
  readonly updatedAt: Date | null;
  /** `subjectId` de quien hizo el último cambio. */
  readonly updatedBy: string | null;
}

export interface RoleGrantChange {
  readonly roles: readonly string[];
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly at: Date;
}

/** Persistencia de los grants dinámicos. Todas las operaciones filtran por tenant. */
export interface RoleGrantStore {
  /** Grant vigente; sin fila devuelve uno vacío con `revision: 0`. */
  current(tenantId: string, oid: string): Promise<RoleGrant>;
  /** Grants con al menos un rol, para la vista del padrón. */
  list(tenantId: string): Promise<readonly RoleGrant[]>;
  /**
   * Reemplaza el conjunto de roles si la revisión guardada es `expectedRevision`. Devuelve el
   * grant nuevo, o `undefined` si otra escritura se adelantó (no escribe nada).
   */
  replace(tenantId: string, oid: string, change: RoleGrantChange): Promise<RoleGrant | undefined>;
}

export function emptyRoleGrant(tenantId: string, oid: string): RoleGrant {
  return {
    tenantId,
    oid: oid.toLowerCase(),
    roles: [],
    revision: 0,
    updatedAt: null,
    updatedBy: null,
  };
}

/** Orden estable y sin duplicados: dos reemplazos con los mismos roles guardan lo mismo. */
export function normalizeGrantRoles(roles: readonly string[]): string[] {
  return [...new Set(roles)].sort();
}

export class InMemoryRoleGrantStore implements RoleGrantStore {
  private grants = new Map<string, RoleGrant>();

  /** Copia para deshacer una unidad de trabajo en memoria. */
  public snapshot(): ReadonlyMap<string, RoleGrant> {
    return new Map(this.grants);
  }

  public restore(snapshot: ReadonlyMap<string, RoleGrant>): void {
    this.grants = new Map(snapshot);
  }

  private static key(tenantId: string, oid: string): string {
    return `${tenantId}\u0000${oid.toLowerCase()}`;
  }

  public current(tenantId: string, oid: string): Promise<RoleGrant> {
    return Promise.resolve(
      this.grants.get(InMemoryRoleGrantStore.key(tenantId, oid)) ?? emptyRoleGrant(tenantId, oid),
    );
  }

  public list(tenantId: string): Promise<readonly RoleGrant[]> {
    return Promise.resolve(
      [...this.grants.values()].filter(
        (grant) => grant.tenantId === tenantId && grant.roles.length > 0,
      ),
    );
  }

  public replace(
    tenantId: string,
    oid: string,
    change: RoleGrantChange,
  ): Promise<RoleGrant | undefined> {
    const key = InMemoryRoleGrantStore.key(tenantId, oid);
    const stored = this.grants.get(key) ?? emptyRoleGrant(tenantId, oid);
    if (stored.revision !== change.expectedRevision) return Promise.resolve(undefined);
    const next: RoleGrant = {
      tenantId,
      oid: oid.toLowerCase(),
      roles: normalizeGrantRoles(change.roles),
      revision: stored.revision + 1,
      updatedAt: change.at,
      updatedBy: change.actorId,
    };
    this.grants.set(key, next);
    return Promise.resolve(next);
  }
}
