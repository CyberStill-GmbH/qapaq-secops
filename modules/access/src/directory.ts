/**
 * Sprint 5 · fase 3 — padrón del grupo de admisión (entra-soc-user-admin.md, S5-D6, S5-D7).
 *
 * Entra decide **quién puede entrar** (miembros del grupo) y **quién es dueño** del grupo; QAPAQ
 * decide **qué puede hacer** cada uno. Este módulo modela el padrón sin nombrar al proveedor
 * (C-23): el adapter de Microsoft Graph vive en el composition root.
 *
 * Sincronización (S5-D7):
 * - Miembros por consulta delta: cada ciclo trae solo altas, cambios y bajas desde el último
 *   `deltaLink`, que se persiste. Un `deltaLink` vencido obliga a una lectura completa desde
 *   cero; en ese caso, y solo cuando la lectura terminó entera, quien no apareció se marca
 *   como baja. **Una lectura parcial nunca da de baja a nadie.**
 * - Dueños: lectura completa en cada ciclo (son pocos y el delta de grupos no los sigue).
 *   El conjunto se reemplaza solo si la lectura terminó entera.
 * - Un lease con fencing (`claimId`) evita dos sincronizaciones a la vez entre réplicas.
 *
 * Los datos guardados son los mínimos para la vista de administración: OID (clave estable),
 * nombre, UPN y si la cuenta está habilitada. Nada de tokens ni encabezados del proveedor.
 */

export interface DirectoryPerson {
  /** Object ID de Entra: clave estable. Nombre y UPN son descriptores mutables. */
  readonly oid: string;
  readonly displayName: string | null;
  readonly upn: string | null;
  /** `null` si el permiso concedido no permite leerlo: se muestra como desconocido. */
  readonly accountEnabled: boolean | null;
}

export type MemberChange =
  | { readonly kind: 'upsert'; readonly person: DirectoryPerson }
  | { readonly kind: 'removed'; readonly oid: string };

export interface MemberDeltaPage {
  readonly changes: readonly MemberChange[];
  /** Presente en la última página: punto de partida del próximo ciclo. */
  readonly deltaLink?: string;
  /** Presente si hay más páginas en este ciclo. */
  readonly nextLink?: string;
}

export const DIRECTORY_ERROR_CODES = [
  'DIRECTORY_THROTTLED',
  'DIRECTORY_DELTA_EXPIRED',
  'DIRECTORY_FORBIDDEN',
  'DIRECTORY_UNAVAILABLE',
  'DIRECTORY_RESPONSE_INVALID',
] as const;
export type DirectoryErrorCode = (typeof DIRECTORY_ERROR_CODES)[number];

export class DirectoryError extends Error {
  public constructor(
    public readonly code: DirectoryErrorCode,
    /** Espera pedida por el proveedor (429), en milisegundos. */
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'DirectoryError';
  }
}

/** Lector del directorio; lo implementa el adapter del proveedor. */
export interface DirectoryReader {
  /**
   * Una página de cambios de miembros. Sin `cursor` empieza una lectura completa desde cero;
   * con el `deltaLink` del ciclo anterior trae solo los cambios; con un `nextLink` sigue el
   * ciclo en curso. Lanza `DirectoryError`.
   */
  readMemberDelta(groupId: string, cursor: string | null): Promise<MemberDeltaPage>;
  /** Todos los dueños del grupo (pagina internamente). Lanza `DirectoryError`. */
  readOwners(groupId: string): Promise<readonly DirectoryPerson[]>;
}

export const DIRECTORY_SYNC_STATUSES = ['never', 'ok', 'failed'] as const;
export type DirectorySyncStatus = (typeof DIRECTORY_SYNC_STATUSES)[number];

export interface DirectorySyncState {
  readonly tenantId: string;
  readonly groupId: string;
  readonly deltaLink: string | null;
  readonly status: DirectorySyncStatus;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorClass: string | null;
}

export interface DirectoryMemberRecord extends DirectoryPerson {
  readonly membership: 'member' | 'removed';
  readonly syncedAt: Date;
}

export interface DirectoryClaim {
  readonly tenantId: string;
  readonly groupId: string;
  readonly claimId: string;
  readonly state: DirectorySyncState;
}

/** Persistencia del padrón. Todas las lecturas filtran por tenant y grupo. */
export interface DirectoryStore {
  /** Lease del estado de sincronización; `undefined` si otra réplica lo tiene vigente. */
  claimSync(
    tenantId: string,
    groupId: string,
    at: Date,
    leaseMs: number,
  ): Promise<DirectoryClaim | undefined>;
  /**
   * Aplica un ciclo terminado en una sola transacción, cercada por el claim: cambios de
   * miembros, bajas por lectura completa, reemplazo de dueños, `deltaLink` y estado `ok`.
   * `false` si el claim ya no es el vigente (no escribe nada).
   */
  commitSync(claim: DirectoryClaim, cycle: DirectorySyncCycle): Promise<boolean>;
  /** Registra un ciclo fallido (sin tocar el padrón) y libera el lease. */
  failSync(claim: DirectoryClaim, errorClass: string, at: Date, resetDelta: boolean): Promise<void>;
  syncState(tenantId: string, groupId: string): Promise<DirectorySyncState | undefined>;
  members(tenantId: string, groupId: string): Promise<readonly DirectoryMemberRecord[]>;
  member(
    tenantId: string,
    groupId: string,
    oid: string,
  ): Promise<DirectoryMemberRecord | undefined>;
  owners(tenantId: string, groupId: string): Promise<readonly DirectoryPerson[]>;
}

export interface DirectorySyncCycle {
  readonly at: Date;
  readonly changes: readonly MemberChange[];
  /** Lectura completa desde cero: quien no apareció en `changes` pasa a baja. */
  readonly fullRead: boolean;
  readonly owners: readonly DirectoryPerson[];
  readonly deltaLink: string;
}

/**
 * Padrón resultante de aplicar un ciclo (función pura; la usan el store en memoria y las
 * pruebas del adapter PostgreSQL como referencia).
 */
export function applyMemberCycle(
  current: ReadonlyMap<string, DirectoryMemberRecord>,
  cycle: DirectorySyncCycle,
): Map<string, DirectoryMemberRecord> {
  const next = new Map(current);
  const seen = new Set<string>();
  for (const change of cycle.changes) {
    if (change.kind === 'upsert') {
      const oid = change.person.oid.toLowerCase();
      seen.add(oid);
      next.set(oid, { ...change.person, oid, membership: 'member', syncedAt: cycle.at });
    } else {
      const oid = change.oid.toLowerCase();
      const existing = next.get(oid);
      if (existing) next.set(oid, { ...existing, membership: 'removed', syncedAt: cycle.at });
    }
  }
  if (cycle.fullRead) {
    for (const [oid, record] of next) {
      if (!seen.has(oid) && record.membership === 'member') {
        next.set(oid, { ...record, membership: 'removed', syncedAt: cycle.at });
      }
    }
  }
  return next;
}
