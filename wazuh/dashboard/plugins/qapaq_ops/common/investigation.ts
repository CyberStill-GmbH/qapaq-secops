/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { VendorId } from './vendors';

/**
 * Investigación de una alerta: el evento de origen en `wazuh-alerts-*`, sus entidades y la línea
 * de tiempo de eventos relacionados (misma entidad). El servidor del plugin consulta el Indexer
 * con la identidad de quien mira (proxy auth QAPAQ); nunca como administrador.
 */

export const INVESTIGATION_ROUTES = {
  source: '/api/qapaq_ops/investigation/source',
  related: '/api/qapaq_ops/investigation/related',
  event: '/api/qapaq_ops/investigation/event',
} as const;

export const ENTITY_KINDS = ['host', 'user', 'ip', 'project', 'zone', 'account'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_KIND_LABEL: Readonly<Record<EntityKind, string>> = {
  host: 'Equipo',
  user: 'Usuario',
  ip: 'IP',
  project: 'Proyecto',
  zone: 'Zona',
  account: 'Cuenta',
};

/**
 * Campos de `wazuh-alerts-*` (todos `keyword` en la plantilla de Wazuh) por tipo de entidad.
 * Orden = preferencia al extraer. Normalización de los collectors QAPAQ (wazuh/provider-ingestion).
 */
export const ENTITY_FIELDS: Readonly<Record<EntityKind, readonly string[]>> = {
  host: [
    'agent.name',
    'data.bitdefender.endpoint.name',
    'data.bitdefender.endpoint.fqdn',
    'data.win.system.computer',
    'data.hostname',
  ],
  user: [
    'data.office365.UserId',
    'data.office365.MailboxOwnerUPN',
    'data.office365.recipientList.Address',
    'data.srcuser',
    'data.dstuser',
    'data.cloudflare.audit.actor_email',
    'data.aws.principal',
    'data.win.eventdata.targetUserName',
    'data.win.eventdata.subjectUserName',
  ],
  ip: [
    'data.srcip',
    'data.office365.ClientIP',
    'data.cloudflare.firewall.client_ip',
    'data.cloudflare.audit.actor_ip',
    'data.aws.source_ip',
    'data.bitdefender.endpoint.ip',
    'agent.ip',
  ],
  project: ['data.snyk.project.name'],
  zone: ['data.cloudflare.zone_name', 'data.cloudflare.audit.zone_name'],
  account: ['data.aws.account', 'data.cloudflare.account_id'],
};

/** Valores que no identifican nada (el manager recibe todos los eventos de proveedores). */
const NOISE_VALUES = new Set(['wazuh.manager', '-', '', 'unknown', 'n/a', 'null', 'system']);

export interface InvestigationEntity {
  readonly kind: EntityKind;
  readonly value: string;
  /** Campo del que salió (para el enlace a Discover y la consulta). */
  readonly field: string;
}

export interface MitreInfo {
  readonly ids: readonly string[];
  readonly tactics: readonly string[];
  readonly techniques: readonly string[];
}

export interface InvestigationEventSummary {
  readonly id: string;
  readonly index: string;
  readonly at: string;
  readonly level: number;
  readonly ruleId: string;
  readonly description: string;
  readonly groups: readonly string[];
  readonly vendor: VendorId;
  readonly agent: string | null;
  /** Optional Exchange/Defender message metadata; absence is common and is not inferred. */
  readonly email?: {
    readonly internetMessageId?: string;
    readonly networkMessageId?: string;
    readonly mailboxOwnerUpn?: string;
    readonly recipients?: readonly string[];
    readonly recipientCount?: number;
    readonly recipientsTruncated?: boolean;
    readonly operation?: string;
  };
  readonly mitre: MitreInfo;
  /** Entidades de la consulta que aparecen en este evento (`kind:value`). */
  readonly matched: readonly string[];
}

export interface ExactEmailMessageGroup {
  readonly idType: 'NetworkMessageId' | 'InternetMessageId';
  readonly id: string;
  readonly events: readonly InvestigationEventSummary[];
}

export type EmailMessageDirection = 'Salida' | 'Dirección no determinada';

export interface ExactEmailMessageEvidence {
  /** Direction is derived only from an explicit, recognized audit operation. */
  readonly direction: string;
  readonly operations: readonly string[];
  /** MailboxOwnerUPN is an audited mailbox, not necessarily the human actor. */
  readonly auditedMailboxes: readonly string[];
  /** At most `EXACT_EMAIL_GROUP_RECIPIENT_LIMIT` unique addresses are retained for export. */
  readonly recipients: readonly string[];
  /** Minimum distinct addresses observed; capped at the display limit plus one overflow sentinel. */
  readonly recipientCount: number;
  readonly recipientsTruncated: boolean;
}

/** Bound report and DOM size when many events share one message identifier. */
export const EXACT_EMAIL_GROUP_RECIPIENT_LIMIT = 100;

/** Conservative mapping: unknown operations never imply a message direction. */
export function emailOperationDirection(operation: string | undefined): EmailMessageDirection {
  const normalized = operation
    ?.trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_-]/gu, '');
  if (normalized === 'send' || normalized === 'sendas' || normalized === 'sendonbehalf') {
    return 'Salida';
  }
  return 'Dirección no determinada';
}

/** Aggregate only metadata already present in the allowlisted investigation DTO. */
export function summarizeExactEmailMessageGroup(
  group: ExactEmailMessageGroup,
): ExactEmailMessageEvidence {
  const distinct = (values: readonly (string | undefined)[]) =>
    [
      ...new Set(
        values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
      ),
    ].sort((left, right) => left.localeCompare(right, 'es'));
  const operations = distinct(group.events.map((event) => event.email?.operation));
  const directions = new Set(
    group.events.map((event) => emailOperationDirection(event.email?.operation)),
  );
  const hasUnknown = directions.has('Dirección no determinada');
  const known = (['Salida'] as const).filter((direction) => directions.has(direction));
  const direction = [
    ...known,
    ...(hasUnknown || known.length === 0 ? ['Dirección no determinada'] : []),
  ].join('; ');
  const auditedMailboxes = distinct(group.events.map((event) => event.email?.mailboxOwnerUpn));
  const recipients = new Set<string>();
  const sourceTruncated = group.events.some((event) => event.email?.recipientsTruncated === true);
  let recipientLimitExceeded = false;
  for (const event of group.events) {
    for (const value of event.email?.recipients ?? []) {
      const recipient = value?.trim();
      if (!recipient || recipients.has(recipient)) continue;
      if (recipients.size >= EXACT_EMAIL_GROUP_RECIPIENT_LIMIT) {
        recipientLimitExceeded = true;
        break;
      }
      recipients.add(recipient);
    }
    if (recipientLimitExceeded) break;
  }
  const recipientCount = recipients.size + (recipientLimitExceeded ? 1 : 0);
  return {
    direction: direction || 'Dirección no determinada',
    operations,
    auditedMailboxes,
    recipients: [...recipients].sort((left, right) => left.localeCompare(right, 'es')),
    recipientCount,
    recipientsTruncated: recipientLimitExceeded || sourceTruncated,
  };
}

/** Groups only events that share an explicit message identifier; time or user never forms a group. */
export function groupExactEmailMessages(
  events: readonly InvestigationEventSummary[],
): ExactEmailMessageGroup[] {
  const groups = new Map<
    string,
    { idType: ExactEmailMessageGroup['idType']; id: string; events: InvestigationEventSummary[] }
  >();
  for (const event of events) {
    const networkMessageId = event.email?.networkMessageId?.trim().toLowerCase();
    const internetMessageId = event.email?.internetMessageId?.trim();
    const idType = networkMessageId
      ? 'NetworkMessageId'
      : internetMessageId
        ? 'InternetMessageId'
        : undefined;
    const id = networkMessageId || internetMessageId;
    if (!idType || !id) continue;
    const key = `${idType}:${id}`;
    const group = groups.get(key) ?? { idType, id, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.events.length > 1)
    .map((group) => ({ ...group, events: [...group.events] }));
}

export interface InvestigationEvent extends InvestigationEventSummary {
  readonly location: string | null;
  readonly entities: readonly InvestigationEntity[];
  /** `_source` del documento (recortado si excede el límite). */
  readonly raw: unknown;
  readonly rawTruncated: boolean;
}

export type IndexerAccess = 'ok' | 'forbidden' | 'error';

export interface SourceResponse {
  readonly access: IndexerAccess;
  /** `exact` (por id), `matched` (regla + hora) o `none`. */
  readonly match: 'exact' | 'matched' | 'none';
  readonly event: InvestigationEvent | null;
}

export interface RelatedResponse {
  readonly access: IndexerAccess;
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly events: readonly InvestigationEventSummary[];
  /** Cursor opaco para continuar exactamente la misma consulta; null cuando no quedan filas. */
  readonly nextCursor: string | null;
  readonly pageSize: number;
  /** Eventos por entidad (`kind:value` → total en la ventana). */
  readonly perEntity: Readonly<Record<string, number>>;
}

export interface EventResponse {
  readonly access: IndexerAccess;
  readonly event: InvestigationEvent | null;
}

export const RELATED_WINDOWS = ['1h', '24h', '7d'] as const;
export type RelatedWindow = (typeof RELATED_WINDOWS)[number];
export const RELATED_WINDOW_MS: Readonly<Record<RelatedWindow, number>> = {
  '1h': 3600000,
  '24h': 86400000,
  '7d': 7 * 86400000,
};
export const RELATED_WINDOW_LABEL: Readonly<Record<RelatedWindow, string>> = {
  '1h': '±1 h',
  '24h': '±24 h',
  '7d': '±7 días',
};

export const MAX_ENTITY_VALUE = 256;
export const MAX_QUERY_ENTITIES = 8;

/**
 * Apply the UI's visible selection and server query limit from the same entity list.
 * Hidden entities must never remain silently active in an investigation query.
 */
export function selectQueryEntities<T extends { kind: string; value: string }>(
  entities: readonly T[],
  selectedKeys?: readonly string[] | null,
): T[] {
  const candidates = entities.slice(0, MAX_QUERY_ENTITIES);
  if (selectedKeys == null) return candidates;
  const selected = new Set(selectedKeys);
  return candidates.filter((entity) => selected.has(entityKey(entity)));
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const IPV6 = /^[0-9a-f:]{2,39}$/iu;

/** Valor aceptable para pivotar (longitud, sin controles; las IP deben parecer IP). */
export function validEntity(kind: string, value: string): kind is EntityKind {
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) return false;
  if (!value || value.length > MAX_ENTITY_VALUE || /[\u0000-\u001f]/u.test(value)) return false;
  if (kind === 'ip') return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
  return !NOISE_VALUES.has(value.trim().toLowerCase());
}

/** `kind:value` ⇄ entidad (el valor puede contener `:`, p. ej. IPv6 o ARN). */
export function entityKey(entity: { kind: string; value: string }): string {
  return `${entity.kind}:${entity.value}`;
}

export function parseEntityKey(key: string): { kind: EntityKind; value: string } | null {
  const at = key.indexOf(':');
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const value = key.slice(at + 1);
  return validEntity(kind, value) ? { kind, value } : null;
}

function read(source: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

/** Entidades de un documento de `wazuh-alerts-*` (sin duplicados ni ruido). */
export function extractEntities(source: unknown): InvestigationEntity[] {
  const out: InvestigationEntity[] = [];
  const seen = new Set<string>();
  const managerAgent = String(read(source, 'agent.id') ?? '') === '000';
  for (const kind of ENTITY_KINDS) {
    for (const field of ENTITY_FIELDS[kind]) {
      if (managerAgent && (field === 'agent.name' || field === 'agent.ip')) continue;
      const raw =
        field === 'data.office365.recipientList.Address'
          ? read(source, 'data.office365.recipientList')
          : read(source, field);
      const values = Array.isArray(raw)
        ? field === 'data.office365.recipientList.Address'
          ? raw.slice(0, 50)
          : raw
        : [raw];
      for (const item of values) {
        const candidate =
          field === 'data.office365.recipientList.Address'
            ? item && typeof item === 'object' && !Array.isArray(item)
              ? (item as Record<string, unknown>).Address
              : undefined
            : item;
        if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
        const value = String(candidate).trim();
        if (!validEntity(kind, value)) continue;
        const key = entityKey({ kind, value });
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, value, field });
      }
    }
  }
  return out;
}

/** Cláusula `should` del Indexer: cualquier campo de cada entidad con su valor exacto. */
export function entityClauses(
  entities: ReadonlyArray<{ kind: EntityKind; value: string }>,
): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [];
  for (const entity of entities) {
    for (const field of ENTITY_FIELDS[entity.kind]) {
      clauses.push({ term: { [field]: entity.value } });
    }
  }
  return clauses;
}

/** Consulta KQL equivalente (Discover / Threat Hunting) para una o varias entidades. */
export function entityKql(entities: ReadonlyArray<{ kind: EntityKind; value: string }>): string {
  const quote = (value: string) => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
  const parts: string[] = [];
  for (const entity of entities) {
    for (const field of ENTITY_FIELDS[entity.kind]) {
      parts.push(`${field}:${quote(entity.value)}`);
    }
  }
  return parts.join(' or ');
}
