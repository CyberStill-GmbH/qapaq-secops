import {
  SECURITY_EVENT_LIMITS,
  SECURITY_EVENT_SCHEMA_VERSION,
  validateSecurityEvent,
  type Identity,
  type Raw,
  type Resource,
  type SecurityEvent,
  type SecurityEventCategory,
  type SecurityEventValidationError,
} from '@qapaq/contracts';

import { deterministicUuid7 } from './deterministic-id.js';
import type { TelemetryProviderRecord } from './admission.js';
import {
  normalizeClientIp,
  OFFICE365_EXTENSION_NAMESPACE,
  projectOffice365,
  type Office365Projection,
} from './wazuh-office365.js';

/**
 * C-12 — mapping versionado de una alerta Wazuh al contrato `SecurityEvent` (C-05).
 *
 * Reglas que el mapping sostiene y que sus specs verifican:
 *
 * 1. El evento se construye campo por campo desde rutas declaradas. El documento crudo
 *    nunca se difunde al evento: lo que no está en este archivo no llega a la salida.
 * 2. Severidad y categoría salen de catálogos fijos, no del texto del proveedor.
 * 3. La versión del mapping viaja en el propio evento (`provenance.mappingVersion` y
 *    `severity.mappingVersion`), de modo que un evento almacenado dice con qué reglas
 *    fue construido.
 * 4. Un documento que no cumple se aísla en cuarentena con causa y linaje al crudo; no
 *    aborta la página. Ésa es la precondición de C-13.
 *
 * Historial del mapping:
 *
 * - 1.0.0: regla, severidad, categoría por grupo, agente e identidad mínima.
 * - 1.1.0: sub-mapping de Office 365 (`wazuh-office365.ts`): operación, IP de cliente,
 *   workload, objeto, resultado y extensión `microsoft.office365`; además `data.srcip`
 *   como recurso IP para cualquier alerta. Un evento 1.0.0 almacenado sigue siendo válido:
 *   el cambio es aditivo dentro del contrato 1.0.0.
 */

export const WAZUH_MAPPING_ID = 'wazuh.alerts' as const;
export const WAZUH_MAPPING_VERSION = '1.1.0' as const;
export const WAZUH_PARSER_VERSION = '1.1.0' as const;
export const WAZUH_SEVERITY_MAPPING_ID = 'wazuh.alerts.severity' as const;
export const WAZUH_SEVERITY_SCALE = 'provider-level-0-15' as const;

export const NORMALIZATION_ERROR_CODES = [
  'RAW_TOO_LARGE',
  'RAW_NOT_OBJECT',
  'MISSING_TIMESTAMP',
  'INVALID_TIMESTAMP',
  'MISSING_RULE',
  'INVALID_RULE_LEVEL',
  'INVALID_RULE_IDENTITY',
  'CONTRACT_VALIDATION_FAILED',
] as const;

export type NormalizationErrorCode = (typeof NORMALIZATION_ERROR_CODES)[number];

export interface NormalizationReason {
  readonly code: NormalizationErrorCode;
  readonly message: string;
  readonly path: string;
}

/** Linaje obligatorio: toda cuarentena apunta al objeto crudo que la originó. */
export interface QuarantinedRecord {
  readonly sourceRecordId: string;
  readonly dataset: string;
  readonly rawRef: string;
  readonly rawSha256: string;
  readonly reason: NormalizationReason;
  readonly mappingId: string;
  readonly mappingVersion: string;
  readonly quarantinedAt: string;
}

export interface WazuhAlertInput {
  readonly record: TelemetryProviderRecord;
  /** Prueba del objeto crudo producida por la admisión durable (C-11). */
  readonly raw: Raw;
}

export interface WazuhNormalizationContext {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly connector: string;
  readonly connectorVersion: string;
  readonly receivedAt: Date;
}

export type NormalizationOutcome =
  | { readonly status: 'normalized'; readonly event: SecurityEvent }
  | { readonly status: 'quarantined'; readonly quarantined: QuarantinedRecord };

export interface PageNormalizationResult {
  readonly normalized: readonly SecurityEvent[];
  readonly quarantined: readonly QuarantinedRecord[];
  readonly counts: {
    readonly received: number;
    readonly normalized: number;
    readonly quarantined: number;
  };
}

const RFC3339_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * `Date.parse` acepta fechas imposibles y las desplaza en silencio: `2026-02-31` se
 * convierte en el 3 de marzo. Una marca temporal desplazada corrompe el orden del
 * incremento y la ventana de reproceso, así que el calendario se verifica aparte del
 * parseo.
 */
function isRealCalendarInstant(value: string): boolean {
  const match = RFC3339_WITH_ZONE.exec(value);
  if (!match) return false;

  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maximumDay = month === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= maximumDay;
}

/**
 * Nivel Wazuh (0–15) a severidad normalizada. La tabla es fija: el proveedor puede
 * cambiar el texto de una regla, pero no la severidad con que la registramos.
 */
const SEVERITY_BY_LEVEL: readonly {
  readonly max: number;
  readonly normalized: SecurityEvent['severity']['normalized'];
  readonly score: number;
}[] = [
  { max: 0, normalized: 'informational', score: 0 },
  { max: 3, normalized: 'low', score: 25 },
  { max: 7, normalized: 'medium', score: 50 },
  { max: 11, normalized: 'high', score: 75 },
  { max: 15, normalized: 'critical', score: 95 },
];

/** Grupo Wazuh a categoría del contrato. Lo que no está aquí cae en `unclassified`. */
const CATEGORY_BY_GROUP: Readonly<Record<string, SecurityEventCategory>> = Object.freeze({
  authentication: 'authentication',
  authentication_failed: 'authentication',
  authentication_failures: 'authentication',
  authentication_success: 'authentication',
  invalid_login: 'authentication',
  pam: 'authentication',
  sshd: 'authentication',
  win_authentication: 'authentication',
  account_changed: 'iam',
  adduser: 'iam',
  azure_ad: 'iam',
  office365: 'iam',
  policy_changed: 'iam',
  firewall: 'network',
  iptables: 'network',
  netscreen: 'network',
  pix: 'network',
  attack: 'intrusion_detection',
  attacks: 'intrusion_detection',
  exploit_attempt: 'intrusion_detection',
  ids: 'intrusion_detection',
  recon: 'intrusion_detection',
  web_scan: 'intrusion_detection',
  malware: 'malware',
  rootcheck: 'malware',
  trojan: 'malware',
  virus: 'malware',
  agent: 'host',
  linux: 'host',
  syslog: 'host',
  windows: 'host',
  syscheck: 'file',
  syscheck_entry_added: 'file',
  syscheck_entry_deleted: 'file',
  syscheck_file: 'file',
  process_monitor: 'process',
  config_changed: 'configuration',
  sca: 'configuration',
  exchange: 'email',
  mail: 'email',
  postfix: 'email',
  apache: 'web',
  iis: 'web',
  nginx: 'web',
  web: 'web',
  vulnerability: 'vulnerability',
  'vulnerability-detector': 'vulnerability',
  mssql: 'database',
  mysql: 'database',
  postgresql: 'database',
});

const SUCCESS_GROUPS = new Set(['authentication_success']);
const FAILURE_GROUPS = new Set([
  'authentication_failed',
  'authentication_failures',
  'invalid_login',
]);

function reason(code: NormalizationErrorCode, message: string, path: string): NormalizationReason {
  return { code, message, path };
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;
}

function readShortText(value: unknown, maximum = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maximum);
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return readShortText(value, 256);
}

function mapSeverity(level: number): {
  normalized: SecurityEvent['severity']['normalized'];
  score: number;
} {
  for (const band of SEVERITY_BY_LEVEL) {
    if (level <= band.max) return { normalized: band.normalized, score: band.score };
  }
  return { normalized: 'critical', score: 95 };
}

function mapCategories(groups: readonly string[]): SecurityEvent['category'] {
  const mapped: SecurityEventCategory[] = [];
  for (const group of groups) {
    const category = CATEGORY_BY_GROUP[group.toLowerCase()];
    if (category && !mapped.includes(category)) mapped.push(category);
    if (mapped.length === 16) break;
  }
  if (mapped.length === 0) return ['unclassified'];
  return mapped as unknown as SecurityEvent['category'];
}

function mapOutcome(groups: readonly string[]): SecurityEvent['outcome'] {
  const lowered = groups.map((group) => group.toLowerCase());
  if (lowered.some((group) => FAILURE_GROUPS.has(group))) return 'failure';
  if (lowered.some((group) => SUCCESS_GROUPS.has(group))) return 'success';
  return 'unknown';
}

/**
 * IP de origen genérica de Wazuh (`data.srcip`). Se valida igual que la de Office 365:
 * una correlación por IP solo es útil si la IP es real.
 */
function mapSourceIp(raw: Readonly<Record<string, unknown>>): Resource[] {
  const ip = normalizeClientIp(readObject(raw['data'])?.['srcip']);
  return ip === undefined ? [] : [{ kind: 'ip', id: ip, type: 'source' }];
}

function mapResources(raw: Readonly<Record<string, unknown>>): Resource[] {
  const agent = readObject(raw['agent']);
  if (!agent) return [];
  const id = readIdentifier(agent['id']);
  const name = readShortText(agent['name']);
  if (id === undefined && name === undefined) return [];
  return [
    {
      kind: 'host',
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      type: 'endpoint',
    },
  ];
}

/**
 * Las categorías del workload de Office 365 complementan las del grupo de la regla: el
 * grupo `office365` solo dice "IAM", el workload dice si fue correo, archivo o login.
 * `unclassified` se descarta en cuanto existe una categoría real.
 */
function mergeCategories(
  fromGroups: SecurityEvent['category'],
  office365: Office365Projection | undefined,
): SecurityEvent['category'] {
  if (!office365 || office365.categories.length === 0) return fromGroups;
  const merged: SecurityEventCategory[] = fromGroups.filter(
    (category) => category !== 'unclassified',
  );
  for (const category of office365.categories) {
    if (!merged.includes(category) && merged.length < 16) merged.push(category);
  }
  return merged as unknown as SecurityEvent['category'];
}

/** El grupo de la regla manda; Office 365 solo resuelve lo que el grupo deja en `unknown`. */
function resolveOutcome(
  fromGroups: SecurityEvent['outcome'],
  office365: Office365Projection | undefined,
): SecurityEvent['outcome'] {
  if (fromGroups !== 'unknown') return fromGroups;
  return office365?.outcome ?? 'unknown';
}

/** Un mismo recurso declarado dos veces inflaría la correlación por entidad. */
function dedupeResources(resources: readonly Resource[]): Resource[] {
  const seen = new Set<string>();
  const unique: Resource[] = [];
  for (const resource of resources) {
    const key = `${resource.kind}|${resource.type ?? ''}|${resource.id ?? ''}|${resource.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resource);
    if (unique.length === 64) break;
  }
  return unique;
}

function mapIdentities(raw: Readonly<Record<string, unknown>>): Identity[] {
  const data = readObject(raw['data']);
  if (!data) return [];
  const principal =
    readShortText(data['srcuser']) ??
    readShortText(data['dstuser']) ??
    readShortText(readObject(data['office365'])?.['UserId']);
  if (principal === undefined) return [];
  return [{ kind: 'user', principal }];
}

/**
 * Normaliza una alerta Wazuh. Nunca lanza por un documento malo: devuelve cuarentena con
 * causa y linaje, para que la página pueda continuar.
 */
export function normalizeWazuhAlert(
  input: WazuhAlertInput,
  context: WazuhNormalizationContext,
): NormalizationOutcome {
  const { record, raw } = input;
  const quarantine = (cause: NormalizationReason): NormalizationOutcome => ({
    status: 'quarantined',
    quarantined: {
      sourceRecordId: record.sourceRecordId,
      dataset: record.dataset,
      rawRef: raw.ref,
      rawSha256: raw.sha256,
      reason: cause,
      mappingId: WAZUH_MAPPING_ID,
      mappingVersion: WAZUH_MAPPING_VERSION,
      quarantinedAt: context.receivedAt.toISOString(),
    },
  });

  // Límite de tamaño antes de construir nada: un documento desproporcionado se rechaza
  // sin recorrerlo.
  if (raw.sizeBytes > SECURITY_EVENT_LIMITS.rawSizeBytes) {
    return quarantine(
      reason(
        'RAW_TOO_LARGE',
        'El documento crudo supera el límite del contrato.',
        '/raw/sizeBytes',
      ),
    );
  }

  const source = readObject(record.raw);
  if (!source) {
    return quarantine(
      reason('RAW_NOT_OBJECT', 'El documento crudo no es un objeto JSON plano.', '/raw'),
    );
  }

  const timestamp = source['timestamp'];
  if (timestamp === undefined) {
    return quarantine(
      reason('MISSING_TIMESTAMP', 'La alerta no declara instante de ocurrencia.', '/timestamp'),
    );
  }
  if (
    typeof timestamp !== 'string' ||
    !isRealCalendarInstant(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    return quarantine(
      reason(
        'INVALID_TIMESTAMP',
        'El instante de la alerta no es una marca RFC3339 con zona horaria.',
        '/timestamp',
      ),
    );
  }

  const rule = readObject(source['rule']);
  if (!rule) {
    return quarantine(
      reason('MISSING_RULE', 'La alerta no declara la regla que la originó.', '/rule'),
    );
  }

  const level = rule['level'];
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 15) {
    return quarantine(
      reason(
        'INVALID_RULE_LEVEL',
        'El nivel de la regla está fuera de la escala declarada del proveedor.',
        '/rule/level',
      ),
    );
  }

  const ruleId = readIdentifier(rule['id']);
  const ruleName = readShortText(rule['description']);
  if (ruleId === undefined || ruleName === undefined) {
    return quarantine(
      reason(
        'INVALID_RULE_IDENTITY',
        'La regla no declara identificador y descripción utilizables.',
        '/rule',
      ),
    );
  }

  const groups = Array.isArray(rule['groups'])
    ? rule['groups'].filter((group): group is string => typeof group === 'string').slice(0, 32)
    : [];

  const severity = mapSeverity(level);
  const office365 = projectOffice365(readObject(source['data']));
  const occurredAt = new Date(timestamp).toISOString();
  const observedAt = new Date(record.collectedAt).toISOString();
  const receivedAt = context.receivedAt.toISOString();

  const event: SecurityEvent = {
    schemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
    recordId: deterministicUuid7(raw.sha256, `event:${record.sourceRecordId}`, context.receivedAt),
    eventUid: `${context.instanceId}:${record.dataset}:${record.sourceRecordId}`,
    eventUidType: 'native',
    kind: 'alert',
    occurredAt,
    observedAt,
    receivedAt,
    source: {
      kind: 'siem',
      vendor: 'Wazuh, Inc.',
      product: 'Wazuh',
      dataset: record.dataset,
      instanceId: context.instanceId,
      nativeEventId: record.sourceRecordId,
    },
    tenant: { id: context.tenantId },
    severity: {
      normalized: severity.normalized,
      score: severity.score,
      originalValue: level,
      originalLabel: String(level),
      originalScale: WAZUH_SEVERITY_SCALE,
      mappingId: WAZUH_SEVERITY_MAPPING_ID,
      mappingVersion: WAZUH_MAPPING_VERSION,
    },
    category: mergeCategories(mapCategories(groups), office365),
    outcome: resolveOutcome(mapOutcome(groups), office365),
    action: office365?.action ?? 'alert.created',
    entities: {
      identities: office365 ? [...office365.identities] : mapIdentities(source),
      resources: dedupeResources([
        ...mapResources(source),
        ...(office365 ? office365.resources : mapSourceIp(source)),
      ]),
    },
    detection: {
      rule: { id: ruleId, name: ruleName, provider: 'wazuh', groups },
    },
    raw,
    provenance: {
      connector: context.connector,
      connectorVersion: context.connectorVersion,
      parserVersion: WAZUH_PARSER_VERSION,
      mappingVersion: WAZUH_MAPPING_VERSION,
      timestampQuality: 'source',
      ingestionPath: [
        {
          kind: 'collector',
          vendor: 'Wazuh, Inc.',
          product: 'Wazuh',
          instanceId: context.instanceId,
        },
        { kind: 'adapter', vendor: 'QAPAQ', product: 'QAPAQ SecOps' },
      ],
    },
    ...(office365 && Object.keys(office365.extension).length > 0
      ? { extensions: { [OFFICE365_EXTENSION_NAMESPACE]: office365.extension } }
      : {}),
  };

  // El contrato es el árbitro final: si el documento construido no valida, no sale.
  const validation = validateSecurityEvent(event);
  if (!validation.valid) {
    const first: SecurityEventValidationError | undefined = validation.errors[0];
    return quarantine(
      reason(
        'CONTRACT_VALIDATION_FAILED',
        'El evento construido no cumple el contrato SecurityEvent.',
        first?.path ?? '/',
      ),
    );
  }

  return { status: 'normalized', event: validation.value };
}

/**
 * Normaliza una página completa. Un documento inválido se aísla y la página continúa:
 * nada se pierde y nada se detiene.
 */
export function normalizeWazuhPage(
  inputs: readonly WazuhAlertInput[],
  context: WazuhNormalizationContext,
): PageNormalizationResult {
  const normalized: SecurityEvent[] = [];
  const quarantined: QuarantinedRecord[] = [];

  for (const input of inputs) {
    const outcome = normalizeWazuhAlert(input, context);
    if (outcome.status === 'normalized') normalized.push(outcome.event);
    else quarantined.push(outcome.quarantined);
  }

  return {
    normalized: Object.freeze(normalized),
    quarantined: Object.freeze(quarantined),
    counts: {
      received: inputs.length,
      normalized: normalized.length,
      quarantined: quarantined.length,
    },
  };
}

/* ------------------------------------------------- Traducción inversa (fase 1) */

/**
 * Sprint 5 · fase 1 — inversa de las tablas de normalización, para que el explorador de
 * eventos filtre en el Indexer con los mismos criterios con que normalizamos. Vive junto a las
 * tablas a propósito: si cambia una banda o un grupo, la inversa cambia en el mismo archivo.
 *
 * Límite declarado: la categoría y el resultado que la proyección de Office 365 agrega a partir
 * del registro (p. ej. `email` por `Workload`, `failure` por `ResultStatus`) no se pueden
 * empujar al Indexer como filtro sobre `rule.groups`. El filtro cubre lo que deriva de grupos;
 * la UI lo declara y no promete exhaustividad.
 */

/** Rangos de `rule.level` (inclusivos) que producen las severidades pedidas. */
export function wazuhLevelRangesFor(
  severities: readonly SecurityEvent['severity']['normalized'][],
): readonly { readonly gte: number; readonly lte: number }[] {
  const ranges: { gte: number; lte: number }[] = [];
  let lower = 0;
  for (const band of SEVERITY_BY_LEVEL) {
    if (severities.includes(band.normalized)) ranges.push({ gte: lower, lte: band.max });
    lower = band.max + 1;
  }
  return ranges;
}

/**
 * Grupos Wazuh que producen las categorías pedidas. `unclassified` no tiene grupos (es la
 * ausencia de todos), así que no se puede empujar: devuelve `undefined` y el llamador rechaza
 * el filtro en lugar de devolver un resultado engañoso.
 */
export function wazuhGroupsForCategories(
  categories: readonly SecurityEventCategory[],
): readonly string[] | undefined {
  if (categories.includes('unclassified')) return undefined;
  return Object.entries(CATEGORY_BY_GROUP)
    .filter(([, category]) => categories.includes(category))
    .map(([group]) => group)
    .sort();
}

/** Grupos Wazuh que producen el resultado pedido; `unknown` no se puede empujar. */
export function wazuhGroupsForOutcome(
  outcome: SecurityEvent['outcome'],
): readonly string[] | undefined {
  if (outcome === 'success') return [...SUCCESS_GROUPS].sort();
  if (outcome === 'failure') return [...FAILURE_GROUPS].sort();
  return undefined;
}
