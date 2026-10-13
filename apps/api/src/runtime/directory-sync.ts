/**
 * Sprint 5 · fase 3 — sincronización del padrón del grupo de admisión (S5-D7).
 *
 * Una pasada:
 * 1. toma el lease del estado de sincronización; si otra réplica lo tiene, no hace nada;
 * 2. lee los cambios de miembros desde el `deltaLink` guardado (o desde cero si no hay),
 *    página a página hasta `MAXIMUM_PAGES`;
 * 3. lee los dueños completos;
 * 4. confirma el ciclo entero en una transacción cercada por el claim.
 *
 * Fallas: cualquier error deja el padrón como estaba (una lectura parcial nunca da de baja a
 * nadie) y registra el código. Un `deltaLink` vencido borra el delta para que el próximo ciclo
 * sea una lectura completa. Un 429 cierra el ciclo; el siguiente llega por intervalo, que es
 * mayor que cualquier `Retry-After` razonable del proveedor.
 *
 * Además, `cachedOwnerSource` expone los dueños persistidos al inicio de sesión con una caché
 * corta (cache-aside): iniciar sesión nunca llama al directorio.
 */

import {
  DirectoryError,
  type DirectoryPerson,
  type DirectoryReader,
  type DirectoryStore,
  type MemberChange,
} from '@qapaq/access';

import type { GroupOwnerSource } from './role-grants.js';

/** Páginas de delta por ciclo: un grupo SOC cabe holgado; más indica un grupo equivocado. */
const MAXIMUM_PAGES = 50;
/** Lease de la sincronización: cubre un ciclo completo con reintentos. */
export const DIRECTORY_LEASE_MS = 5 * 60_000;

export interface DirectorySyncOptions {
  readonly tenantId: string;
  readonly groupId: string;
  readonly reader: DirectoryReader;
  readonly store: DirectoryStore;
  readonly now: () => Date;
  /**
   * Observer tras un ciclo confirmado (Sprint 5 · fase 3): quita el acceso de quien lo perdió.
   * - `removedMembers`: todas las bajas del padrón. Es una reconciliación idempotente, se envía en
   *   cada ciclo; si alguien dado de baja vuelve a entrar, se le corta de nuevo.
   * - `formerOwners`: dueños del ciclo anterior que ya no lo son. Se envía una sola vez.
   */
  readonly reconcileAccess?: (input: {
    readonly removedMembers: readonly string[];
    readonly formerOwners: readonly string[];
  }) => Promise<void>;
}

/** Pasada de sincronización para el motor de bucle; siempre devuelve 0 (sin encadenar). */
export function createDirectorySyncPass(options: DirectorySyncOptions): () => Promise<number> {
  return async () => {
    const at = options.now();
    const claim = await options.store.claimSync(
      options.tenantId,
      options.groupId,
      at,
      DIRECTORY_LEASE_MS,
    );
    if (!claim) return 0;
    const fullRead = claim.state.deltaLink === null;
    try {
      const changes: MemberChange[] = [];
      let cursor: string | null = claim.state.deltaLink;
      let deltaLink: string | undefined;
      for (let page = 0; page < MAXIMUM_PAGES && !deltaLink; page += 1) {
        const result = await options.reader.readMemberDelta(options.groupId, cursor);
        changes.push(...result.changes);
        if (result.deltaLink) deltaLink = result.deltaLink;
        else if (result.nextLink) cursor = result.nextLink;
        else throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
      }
      // Sin `deltaLink` tras el tope de páginas el ciclo no terminó: no se aplica nada.
      if (!deltaLink) throw new DirectoryError('DIRECTORY_RESPONSE_INVALID');
      const owners = await options.reader.readOwners(options.groupId);
      const previousOwners = await options.store.owners(options.tenantId, options.groupId);
      const committed = await options.store.commitSync(claim, {
        at: options.now(),
        changes,
        fullRead,
        owners,
        deltaLink,
      });
      if (!committed) throw new DirectoryError('DIRECTORY_UNAVAILABLE');
      if (options.reconcileAccess) {
        const current = new Set(owners.map((owner) => owner.oid.toLowerCase()));
        const members = await options.store.members(options.tenantId, options.groupId);
        await options.reconcileAccess({
          removedMembers: members
            .filter((member) => member.membership === 'removed')
            .map((member) => member.oid),
          formerOwners: previousOwners
            .map((owner) => owner.oid.toLowerCase())
            .filter((oid) => !current.has(oid)),
        });
      }
      return 0;
    } catch (error) {
      const code = error instanceof DirectoryError ? error.code : 'DIRECTORY_UNAVAILABLE';
      await options.store.failSync(claim, code, options.now(), code === 'DIRECTORY_DELTA_EXPIRED');
      throw error instanceof DirectoryError ? error : new DirectoryError('DIRECTORY_UNAVAILABLE');
    }
  };
}

/** Dueños persistidos con caché corta para el inicio de sesión. */
export function cachedOwnerSource(
  store: DirectoryStore,
  tenantId: string,
  groupId: string,
  ttlMs = 60_000,
  now: () => number = Date.now,
): GroupOwnerSource {
  let cached: { readonly owners: ReadonlySet<string>; readonly until: number } | undefined;
  return {
    async owners() {
      if (cached && cached.until > now()) return cached.owners;
      const owners: readonly DirectoryPerson[] = await store.owners(tenantId, groupId);
      cached = {
        owners: new Set(owners.map((owner) => owner.oid.toLowerCase())),
        until: now() + ttlMs,
      };
      return cached.owners;
    },
  };
}
