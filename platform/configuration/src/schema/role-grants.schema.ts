/**
 * Sprint 5 — roles concedidos por QAPAQ además de los app roles del token de Entra.
 *
 * - `QAPAQ_ROLE_BINDINGS`: asignaciones explícitas `oid=rol` separadas por coma (p. ej. la
 *   persona que entra como analista en el demo). Permanentes hasta que el deploy las cambie.
 * - `QAPAQ_GROUP_OWNER_OIDS`: dueños del grupo de admisión, que reciben `qapaq.platform.admin`.
 *   Es el respaldo mientras la lectura del grupo por Microsoft Graph no tenga consentimiento;
 *   con Graph activo, los dueños leídos se suman a estos.
 * - `QAPAQ_ADMIN_GROUP_IDS`: grupos de Entra cuyos miembros reciben `qapaq.platform.admin`.
 *   La pertenencia sale del claim `groups` del token o, si el grupo es el de admisión
 *   sincronizado, del padrón de Graph.
 *
 * Los OID son identificadores de Entra, no secretos, pero sí datos internos: llegan por
 * variables del deploy (GitHub Actions → Terraform), no se versionan en el repositorio y no se
 * registran en logs. Un valor mal formado detiene el arranque en lugar de ignorarse.
 */

import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { optionalString } from './environment.schema.js';

export const GRANTABLE_ROLES = [
  'qapaq.soc.analyst',
  'qapaq.soc.lead',
  'qapaq.auditor',
  'qapaq.platform.admin',
] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/** Rol que reciben los dueños del grupo de admisión. */
export const GROUP_OWNER_ROLE: GrantableRole = 'qapaq.platform.admin';

export interface RoleGrantsConfig {
  /** `oid` en minúsculas → roles concedidos. */
  readonly bindings: Readonly<Record<string, readonly GrantableRole[]>>;
  /** OID en minúsculas de los dueños declarados en el deploy. */
  readonly groupOwnerOids: readonly string[];
  /** Object ID en minúsculas de los grupos cuyos miembros son admin. */
  readonly adminGroupIds: readonly string[];
}

const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GROUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAXIMUM_ENTRIES = 50;

function entries(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseRoleGrants(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): RoleGrantsConfig {
  const bindingEntries = entries(optionalString(environment, profile, 'QAPAQ_ROLE_BINDINGS'));
  const ownerEntries = entries(optionalString(environment, profile, 'QAPAQ_GROUP_OWNER_OIDS'));
  const adminGroupEntries = entries(optionalString(environment, profile, 'QAPAQ_ADMIN_GROUP_IDS'));
  if (bindingEntries.length > MAXIMUM_ENTRIES) {
    throw configurationError('CONFIG_LIMIT_INVALID', 'QAPAQ_ROLE_BINDINGS', profile.name, {
      maximum: MAXIMUM_ENTRIES,
    });
  }
  if (ownerEntries.length > MAXIMUM_ENTRIES) {
    throw configurationError('CONFIG_LIMIT_INVALID', 'QAPAQ_GROUP_OWNER_OIDS', profile.name, {
      maximum: MAXIMUM_ENTRIES,
    });
  }
  if (adminGroupEntries.length > MAXIMUM_ENTRIES) {
    throw configurationError('CONFIG_LIMIT_INVALID', 'QAPAQ_ADMIN_GROUP_IDS', profile.name, {
      maximum: MAXIMUM_ENTRIES,
    });
  }
  const bindings: Record<string, GrantableRole[]> = {};
  for (const entry of bindingEntries) {
    const [oid, role, extra] = entry.split('=');
    if (
      extra !== undefined ||
      !oid ||
      !OID_PATTERN.test(oid) ||
      !(GRANTABLE_ROLES as readonly string[]).includes(role ?? '')
    ) {
      throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ROLE_BINDINGS', profile.name);
    }
    const key = oid.toLowerCase();
    bindings[key] = [...new Set([...(bindings[key] ?? []), role as GrantableRole])];
  }
  for (const oid of ownerEntries) {
    if (!OID_PATTERN.test(oid)) {
      throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_GROUP_OWNER_OIDS', profile.name);
    }
  }
  for (const groupId of adminGroupEntries) {
    if (!GROUP_ID_PATTERN.test(groupId)) {
      throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ADMIN_GROUP_IDS', profile.name);
    }
  }
  return {
    bindings,
    groupOwnerOids: [...new Set(ownerEntries.map((oid) => oid.toLowerCase()))],
    adminGroupIds: [...new Set(adminGroupEntries.map((id) => id.toLowerCase()))],
  };
}
