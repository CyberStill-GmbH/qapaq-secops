/**
 * Sprint 5 · fase 3 — sincronización del padrón del grupo de admisión.
 *
 * `QAPAQ_DIRECTORY_SYNC`:
 * - `disabled` (por defecto): no hay padrón; los dueños salen solo de `QAPAQ_GROUP_OWNER_OIDS` y
 *   la vista de usuarios informa la sincronización deshabilitada, sin padrón inventado.
 * - `graph`: el API lee el grupo de admisión con permisos de aplicación de solo lectura. El
 *   grupo se identifica por `QAPAQ_DIRECTORY_GROUP_ID` (object ID) o, si no se conoce, por
 *   `QAPAQ_DIRECTORY_GROUP_NAME` (nombre exacto); el nombre se resuelve una vez al arrancar y
 *   debe identificar un solo grupo. Requiere consentimiento de administrador en Entra; sin él, cada ciclo falla con
 *   `DIRECTORY_FORBIDDEN` y la vista lo muestra.
 */

import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { optionalString, parseInteger } from './environment.schema.js';

export type DirectoryConfig =
  | { readonly mode: 'disabled' }
  | {
      readonly mode: 'graph';
      /** Uno de los dos: el ID si se conoce; si no, el nombre a resolver al arrancar. */
      readonly groupId?: string;
      readonly groupName?: string;
      readonly intervalMs: number;
    };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Nombre de grupo: texto simple, sin comillas ni operadores de filtro. */
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,255}$/u;

export function parseDirectoryConfig(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): DirectoryConfig {
  const mode = optionalString(environment, profile, 'QAPAQ_DIRECTORY_SYNC') ?? 'disabled';
  if (mode === 'disabled') return { mode: 'disabled' };
  if (mode !== 'graph') {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_DIRECTORY_SYNC', profile.name);
  }
  const groupId = optionalString(environment, profile, 'QAPAQ_DIRECTORY_GROUP_ID');
  const groupName = optionalString(environment, profile, 'QAPAQ_DIRECTORY_GROUP_NAME');
  if (!groupId && !groupName) {
    throw configurationError(
      'CONFIG_REQUIRED_VALUE_MISSING',
      'QAPAQ_DIRECTORY_GROUP_ID',
      profile.name,
    );
  }
  if (groupId && !GUID.test(groupId)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_DIRECTORY_GROUP_ID', profile.name);
  }
  if (!groupId && !GROUP_NAME.test(groupName!)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_DIRECTORY_GROUP_NAME', profile.name);
  }
  const minutes =
    optionalString(environment, profile, 'QAPAQ_DIRECTORY_SYNC_INTERVAL_MINUTES') === undefined
      ? 15
      : parseInteger(environment, profile, 'QAPAQ_DIRECTORY_SYNC_INTERVAL_MINUTES', 5, 1_440);
  return {
    mode: 'graph',
    ...(groupId ? { groupId: groupId.toLowerCase() } : { groupName: groupName! }),
    intervalMs: minutes * 60_000,
  };
}
