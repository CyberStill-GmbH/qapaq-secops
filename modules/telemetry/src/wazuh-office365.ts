import { isIP } from 'node:net';

import type { Identity, JsonValue, Resource, SecurityEventCategory } from '@qapaq/contracts';

/**
 * C-12 — sub-mapping de los registros de Office 365 Management Activity API que Wazuh
 * deja bajo `data.office365` (módulo `office365` del manager).
 *
 * Sin estos campos el analista ve "Wazuh · regla 91532" y nada más: no sabe qué
 * operación ocurrió, desde qué IP ni sobre qué objeto, y QAPAQ no puede correlacionar
 * por usuario o por IP. Por eso el sub-mapping extrae únicamente lo que el triaje y la
 * correlación necesitan, campo por campo y con límites del contrato:
 *
 * - `action`: la operación de Microsoft como slug del contrato
 *   (`New-InboxRule` → `office365.new-inboxrule`); el texto original viaja en la
 *   extensión.
 * - identidad: UPN (`UserId`), dominio y `UserKey` como identificador opaco.
 * - recursos: IP de cliente validada, workload y objeto afectado.
 * - resultado: `ResultStatus` u operación de inicio de sesión cuando los grupos de la
 *   regla no lo determinan.
 * - extensión `microsoft.office365`: valores escalares declarados aquí y nada más.
 *
 * `Parameters`, `ModifiedProperties` y cualquier otro campo libre **no** se copian: pueden
 * contener direcciones de reenvío, contenido de reglas o datos personales que el contrato
 * no necesita para priorizar. Quedan en el crudo, referenciado por `raw.ref`.
 */

/** Namespace de extensión: cumple el patrón `vendor.producto` del contrato. */
export const OFFICE365_EXTENSION_NAMESPACE = 'microsoft.office365' as const;

/**
 * `UserType` de la Management Activity API. Se traduce a etiqueta para que el analista
 * no tenga que memorizar la tabla de Microsoft.
 */
const USER_TYPE_LABELS: Readonly<Record<number, string>> = Object.freeze({
  0: 'regular',
  1: 'reserved',
  2: 'admin',
  3: 'datacenter_admin',
  4: 'system',
  5: 'application',
  6: 'service_principal',
  7: 'custom_policy',
  8: 'system_policy',
});

/** Workload de Microsoft a categoría del contrato. Lo desconocido no añade categoría. */
const CATEGORY_BY_WORKLOAD: Readonly<Record<string, SecurityEventCategory>> = Object.freeze({
  azureactivedirectory: 'iam',
  exchange: 'email',
  sharepoint: 'file',
  onedrive: 'file',
  securitycompliancecenter: 'configuration',
});

/** Operaciones de inicio de sesión: determinan categoría y resultado aunque falte `ResultStatus`. */
const LOGIN_SUCCESS_OPERATIONS = new Set(['userloggedin']);
const LOGIN_FAILURE_OPERATIONS = new Set(['userloginfailed']);

const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'true', 'partiallysucceeded']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'false']);

export interface Office365Projection {
  readonly action?: string;
  readonly identities: readonly Identity[];
  readonly resources: readonly Resource[];
  readonly outcome?: 'success' | 'failure';
  readonly categories: readonly SecurityEventCategory[];
  readonly extension: Readonly<Record<string, JsonValue>>;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;
}

function readText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maximum);
}

/** Wazuh entrega números del JSON original a veces como número y a veces como texto. */
function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,6}$/u.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * `ClientIP` llega en formatos heterogéneos según el workload: `203.0.113.7`,
 * `203.0.113.7:51544`, `[2001:db8::1]:443` o `2001:db8::1`. Solo se acepta lo que
 * `isIP` reconoce; un valor que no es una IP no se convierte en recurso, porque una
 * correlación por IP con basura produciría agrupaciones falsas.
 */
export function normalizeClientIp(value: unknown): string | undefined {
  const text = readText(value, 128);
  if (text === undefined) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/u.exec(text);
  if (bracketed) return isIP(bracketed[1]!) === 6 ? bracketed[1]!.toLowerCase() : undefined;
  if (isIP(text) !== 0) return text.toLowerCase();
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u.exec(text);
  if (withPort && isIP(withPort[1]!) === 4) return withPort[1]!;
  return undefined;
}

/**
 * El contrato exige `action` en minúsculas con separadores `.`, `_` o `-`. Las operaciones
 * de Microsoft mezclan mayúsculas, espacios y puntos finales (`Add member to role.`), así
 * que se reducen a un slug estable con prefijo de la fuente. Se devuelve `undefined` si no
 * queda nada utilizable.
 */
export function office365ActionSlug(operation: string): string | undefined {
  const slug = operation
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
    .replace(/-+$/u, '');
  if (!/^[a-z0-9]/u.test(slug)) return undefined;
  return `office365.${slug}`;
}

function domainOf(principal: string): string | undefined {
  const at = principal.lastIndexOf('@');
  if (at <= 0 || at === principal.length - 1) return undefined;
  return principal.slice(at + 1).toLowerCase();
}

/**
 * Proyecta `data.office365`. Devuelve `undefined` si el documento no es de Office 365,
 * de modo que el mapping general no cambia para otras fuentes Wazuh.
 */
export function projectOffice365(
  data: Readonly<Record<string, unknown>> | undefined,
): Office365Projection | undefined {
  const record = readObject(data?.['office365']);
  if (!record) return undefined;

  const operation = readText(record['Operation'], 128);
  const workload = readText(record['Workload'], 64);
  const principal = readText(record['UserId'], 320);
  const userKey = readText(record['UserKey'], 256);
  const userType = readInteger(record['UserType']);
  const recordType = readInteger(record['RecordType']);
  const resultStatus = readText(record['ResultStatus'], 64);
  const organizationId = readText(record['OrganizationId'], 64);
  const clientIp = normalizeClientIp(record['ClientIP'] ?? record['ActorIpAddress']);
  const objectId = readText(record['ObjectId'], 256);

  const identities: Identity[] = [];
  if (principal !== undefined) {
    const domain = domainOf(principal);
    identities.push({
      kind: 'user',
      principal,
      ...(userKey === undefined ? {} : { id: userKey }),
      ...(domain === undefined ? {} : { domain }),
    });
  }

  const resources: Resource[] = [];
  if (clientIp !== undefined) resources.push({ kind: 'ip', id: clientIp, type: 'client' });
  if (workload !== undefined) {
    resources.push({ kind: 'service', name: workload, type: 'microsoft365.workload' });
  }
  if (objectId !== undefined) {
    resources.push({ kind: 'object', name: objectId, type: 'microsoft365.object' });
  }

  const loweredOperation = operation?.toLowerCase();
  const loweredStatus = resultStatus?.toLowerCase();
  let outcome: Office365Projection['outcome'];
  if (loweredOperation && LOGIN_FAILURE_OPERATIONS.has(loweredOperation)) outcome = 'failure';
  else if (loweredOperation && LOGIN_SUCCESS_OPERATIONS.has(loweredOperation)) outcome = 'success';
  else if (loweredStatus && FAILURE_STATUSES.has(loweredStatus)) outcome = 'failure';
  else if (loweredStatus && SUCCESS_STATUSES.has(loweredStatus)) outcome = 'success';

  const categories: SecurityEventCategory[] = [];
  if (
    loweredOperation &&
    (LOGIN_SUCCESS_OPERATIONS.has(loweredOperation) ||
      LOGIN_FAILURE_OPERATIONS.has(loweredOperation))
  ) {
    categories.push('authentication');
  }
  const workloadCategory = workload ? CATEGORY_BY_WORKLOAD[workload.toLowerCase()] : undefined;
  if (workloadCategory && !categories.includes(workloadCategory)) {
    categories.push(workloadCategory);
  }

  // Solo escalares declarados. Un `undefined` no se serializa como clave vacía.
  const extension: Record<string, JsonValue> = {};
  if (operation !== undefined) extension['operation'] = operation;
  if (workload !== undefined) extension['workload'] = workload;
  if (recordType !== undefined) extension['recordType'] = recordType;
  if (resultStatus !== undefined) extension['resultStatus'] = resultStatus;
  if (userType !== undefined) {
    extension['userType'] = USER_TYPE_LABELS[userType] ?? `unknown_${userType}`;
  }
  if (organizationId !== undefined) extension['organizationId'] = organizationId;
  if (clientIp !== undefined) extension['clientIp'] = clientIp;

  const action = operation === undefined ? undefined : office365ActionSlug(operation);
  return {
    ...(action === undefined ? {} : { action }),
    identities,
    resources,
    ...(outcome === undefined ? {} : { outcome }),
    categories,
    extension,
  };
}
