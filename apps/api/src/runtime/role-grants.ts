/**
 * Roles concedidos por fuentes QAPAQ y Entra al iniciar sesión.
 *
 * Los grants dinámicos de la consola se leen aparte y solo cuentan para miembros vigentes del
 * padrón. Una caída de Graph o del store dinámico nunca concede privilegios adicionales.
 */

import { ACCESS_APPROVER_ROLE, SECURITY_APPROVER_ROLE, type RoleGrantStore } from '@qapaq/access';
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
  const accessApprovers = new Set(config.accessApproverOids ?? []);
  const securityApprovers = new Set(config.securityApproverOids ?? []);
  const directoryIsAdmin =
    directory?.groupId !== undefined && adminGroups.has(directory.groupId.toLowerCase());

  return async (oid, groups = []) => {
    if (!oid) return [];
    const key = oid.toLowerCase();
    const roles = new Set<string>(config.bindings[key] ?? []);
    // Aprobadores: solo por declaración explícita del deploy, nunca derivados de otro rol.
    if (accessApprovers.has(key)) roles.add(ACCESS_APPROVER_ROLE);
    if (securityApprovers.has(key)) roles.add(SECURITY_APPROVER_ROLE);

    let admin =
      deployOwners.has(key) || groups.some((group) => adminGroups.has(group.toLowerCase()));
    if (!admin && directory) {
      try {
        admin =
          (await directory.owners()).has(key) ||
          (directoryIsAdmin && (await directory.isMember?.(key)) === true);
      } catch {
        // Sin directorio disponible se conservan los roles estáticos del deploy/token.
        admin = false;
      }
    }
    if (admin) roles.add(GROUP_OWNER_ROLE);
    return [...roles];
  };
}

/**
 * Suma los grants dinámicos a lo que resuelve `base` (deploy, Entra y dueños).
 *
 * Un grant guardado no concede acceso si el usuario salió del grupo o fue deshabilitado. Si el
 * padrón o el store falla, el login conserva únicamente las fuentes estáticas ya resueltas.
 */
export function withDynamicGrants(
  base: RoleGrantResolver,
  dynamic: {
    readonly store: RoleGrantStore;
    readonly tenantId: string;
    /** `true` solo para miembro vigente con `accountEnabled === true`. */
    readonly isActiveMember: (oid: string) => Promise<boolean>;
  },
): RoleGrantResolver {
  return async (oid, groups = []) => {
    const roles = await base(oid, groups);
    if (!oid) return roles;
    try {
      const key = oid.toLowerCase();
      if (!(await dynamic.isActiveMember(key))) return roles;
      const grant = await dynamic.store.current(dynamic.tenantId, key);
      return [...new Set([...roles, ...grant.roles])];
    } catch {
      return roles;
    }
  };
}

export type RoleOrigin =
  | 'group_owner'
  | 'admin_group'
  | 'qapaq_assignment'
  | 'deploy_binding'
  | 'entra_app_role'
  | 'none';

/** Origen principal del rol mostrado en el padrón administrativo. */
export function explainRole(
  config: RoleGrantsConfig,
  directoryOwners: ReadonlySet<string>,
  oid: string,
  observedRoles: readonly string[],
  adminGroupMember = false,
  dynamicGrantRoles: readonly string[] = [],
): { readonly roles: readonly string[]; readonly origin: RoleOrigin } {
  const key = oid.toLowerCase();
  if (config.groupOwnerOids.includes(key) || directoryOwners.has(key)) {
    return { roles: [GROUP_OWNER_ROLE], origin: 'group_owner' };
  }
  if (adminGroupMember) return { roles: [GROUP_OWNER_ROLE], origin: 'admin_group' };
  if (dynamicGrantRoles.length > 0) {
    return { roles: dynamicGrantRoles, origin: 'qapaq_assignment' };
  }
  const bound = config.bindings[key];
  if (bound && bound.length > 0) return { roles: bound, origin: 'deploy_binding' };
  if (observedRoles.length > 0) return { roles: observedRoles, origin: 'entra_app_role' };
  return { roles: [], origin: 'none' };
}
