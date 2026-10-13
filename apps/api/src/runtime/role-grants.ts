/**
 * Sprint 5 — roles concedidos por QAPAQ a una identidad de Entra al iniciar sesión.
 *
 * Une cuatro fuentes; los app roles del token se siguen respetando aparte:
 * 1. asignaciones explícitas del deploy (`QAPAQ_ROLE_BINDINGS`);
 * 2. dueños del grupo de admisión declarados en el deploy (`QAPAQ_GROUP_OWNER_OIDS`), con
 *    `qapaq.platform.admin`;
 * 3. dueños leídos del grupo en Microsoft Graph (`GroupOwnerSource`), cuando hay consentimiento;
 * 4. miembros de un grupo admin (`QAPAQ_ADMIN_GROUP_IDS`), con `qapaq.platform.admin`: por el
 *    claim `groups` del token o, si el grupo es el de admisión sincronizado, por el padrón.
 *
 * Quien no aparece en ninguna fuente ni trae app roles no recibe nada: el inicio de sesión lo
 * rechaza como hoy (sin acceso asignado). Una caída de Graph no quita los roles del deploy;
 * solo deja de sumar los dueños leídos hasta la siguiente lectura válida.
 */

import { GROUP_OWNER_ROLE, type RoleGrantsConfig } from '@qapaq/configuration';

/** Dueños del grupo vistos en el directorio; OID en minúsculas. */
export interface GroupOwnerSource {
  owners(): Promise<ReadonlySet<string>>;
  /** Miembros vigentes del grupo sincronizado; solo cuenta si ese grupo es admin. */
  isMember?(oid: string): Promise<boolean>;
  /** Object ID del grupo sincronizado, en minúsculas. */
  readonly groupId?: string;
}

export type RoleGrantResolver = (
  oid: string | undefined,
  groups?: readonly string[],
) => Promise<readonly string[]>;

export function createRoleGrantResolver(
  config: RoleGrantsConfig,
  directory?: GroupOwnerSource,
): RoleGrantResolver {
  const deployOwners = new Set(config.groupOwnerOids);
  const adminGroups = new Set(config.adminGroupIds);
  const directoryIsAdmin =
    directory?.groupId !== undefined && adminGroups.has(directory.groupId.toLowerCase());
  return async (oid, groups = []) => {
    if (!oid) return [];
    const key = oid.toLowerCase();
    const roles = new Set<string>(config.bindings[key] ?? []);
    let admin =
      deployOwners.has(key) || groups.some((group) => adminGroups.has(group.toLowerCase()));
    if (!admin && directory) {
      try {
        admin =
          (await directory.owners()).has(key) ||
          (directoryIsAdmin && (await directory.isMember?.(key)) === true);
      } catch {
        // Sin directorio disponible se conservan los roles del deploy y del token.
        admin = false;
      }
    }
    if (admin) roles.add(GROUP_OWNER_ROLE);
    return [...roles];
  };
}

export type RoleOrigin =
  'group_owner' | 'admin_group' | 'deploy_binding' | 'entra_app_role' | 'none';

/**
 * Origen principal del rol para la vista de administración. El inicio de sesión une todas las
 * fuentes; aquí se muestra la de mayor precedencia: dueño del grupo (admin) > miembro de un
 * grupo admin > asignación del deploy > app role observado en la última sesión. Sin ninguna:
 * «sin acceso asignado».
 */
export function explainRole(
  config: RoleGrantsConfig,
  directoryOwners: ReadonlySet<string>,
  oid: string,
  observedRoles: readonly string[],
  adminGroupMember = false,
): { readonly roles: readonly string[]; readonly origin: RoleOrigin } {
  const key = oid.toLowerCase();
  if (config.groupOwnerOids.includes(key) || directoryOwners.has(key)) {
    return { roles: [GROUP_OWNER_ROLE], origin: 'group_owner' };
  }
  if (adminGroupMember) return { roles: [GROUP_OWNER_ROLE], origin: 'admin_group' };
  const bound = config.bindings[key];
  if (bound && bound.length > 0) return { roles: bound, origin: 'deploy_binding' };
  if (observedRoles.length > 0) return { roles: observedRoles, origin: 'entra_app_role' };
  return { roles: [], origin: 'none' };
}
