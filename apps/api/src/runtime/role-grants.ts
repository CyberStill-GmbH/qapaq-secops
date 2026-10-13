/**
 * Sprint 5 — roles concedidos por QAPAQ a una identidad de Entra al iniciar sesión.
 *
 * Une tres fuentes; los app roles del token se siguen respetando aparte:
 * 1. asignaciones explícitas del deploy (`QAPAQ_ROLE_BINDINGS`);
 * 2. dueños del grupo de admisión declarados en el deploy (`QAPAQ_GROUP_OWNER_OIDS`), con
 *    `qapaq.platform.admin`;
 * 3. dueños leídos del grupo en Microsoft Graph (`GroupOwnerSource`), cuando hay consentimiento.
 *
 * Quien no aparece en ninguna fuente ni trae app roles no recibe nada: el inicio de sesión lo
 * rechaza como hoy (sin acceso asignado). Una caída de Graph no quita los roles del deploy;
 * solo deja de sumar los dueños leídos hasta la siguiente lectura válida.
 */

import { GROUP_OWNER_ROLE, type RoleGrantsConfig } from '@qapaq/configuration';

/** Dueños del grupo vistos en el directorio; OID en minúsculas. */
export interface GroupOwnerSource {
  owners(): Promise<ReadonlySet<string>>;
}

export type RoleGrantResolver = (oid: string | undefined) => Promise<readonly string[]>;

export function createRoleGrantResolver(
  config: RoleGrantsConfig,
  directory?: GroupOwnerSource,
): RoleGrantResolver {
  const deployOwners = new Set(config.groupOwnerOids);
  return async (oid) => {
    if (!oid) return [];
    const key = oid.toLowerCase();
    const roles = new Set<string>(config.bindings[key] ?? []);
    let owner = deployOwners.has(key);
    if (!owner && directory) {
      try {
        owner = (await directory.owners()).has(key);
      } catch {
        // Sin directorio disponible se conservan los roles del deploy.
        owner = false;
      }
    }
    if (owner) roles.add(GROUP_OWNER_ROLE);
    return [...roles];
  };
}

export type RoleOrigin = 'group_owner' | 'deploy_binding' | 'entra_app_role' | 'none';

/**
 * Origen principal del rol para la vista de administración. El inicio de sesión une todas las
 * fuentes; aquí se muestra la de mayor precedencia: dueño del grupo (admin) > asignación del
 * deploy > app role observado en la última sesión. Sin ninguna: «sin acceso asignado».
 */
export function explainRole(
  config: RoleGrantsConfig,
  directoryOwners: ReadonlySet<string>,
  oid: string,
  observedRoles: readonly string[],
): { readonly roles: readonly string[]; readonly origin: RoleOrigin } {
  const key = oid.toLowerCase();
  if (config.groupOwnerOids.includes(key) || directoryOwners.has(key)) {
    return { roles: [GROUP_OWNER_ROLE], origin: 'group_owner' };
  }
  const bound = config.bindings[key];
  if (bound && bound.length > 0) return { roles: bound, origin: 'deploy_binding' };
  if (observedRoles.length > 0) return { roles: observedRoles, origin: 'entra_app_role' };
  return { roles: [], origin: 'none' };
}
