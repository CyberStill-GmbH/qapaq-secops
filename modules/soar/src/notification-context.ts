/**
 * Contexto explicativo de un aviso: qué pasó, por qué importa y qué hacer, con la entidad
 * enmascarada. Lo arma el enriquecedor del composition root (alerta, catálogo de detecciones,
 * correlador) y, si no puede, `contextFromMessage` con lo mínimo del outbox: el aviso nunca
 * deja de salir por falta de contexto.
 *
 * Redacción (docs/16, N2): un canal de chat o un buzón no aplican autorización. Correos e IPs se
 * enmascaran siempre (también dentro del título); el detalle completo vive detrás de la sesión
 * QAPAQ, a un clic.
 */

import { createHash } from 'node:crypto';

import type { OutboxMessageDraft } from '@qapaq/soc';

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type NotificationPriority = (typeof PRIORITIES)[number];

export interface NotificationEntity {
  readonly kind: 'user' | 'host' | 'ip' | 'cloud' | 'service';
  /** Valor ya enmascarado. */
  readonly display: string;
}

export interface CorrelationSummary {
  readonly patternId: string;
  readonly candidateId: string | null;
  readonly narrative: string | null;
  /** Etapas en orden, ya redactadas («Etapa 1: …»). */
  readonly stages: readonly string[];
  /** Entidades enmascaradas que participan. */
  readonly entities: readonly string[];
}

export interface NotificationContext {
  readonly kind: 'alert' | 'incident';
  readonly alertId: string | null;
  readonly incidentId: string | null;
  /** Título enmascarado. */
  readonly title: string;
  readonly priority: NotificationPriority | null;
  /** Severidad del incidente (`critical`…) cuando el aviso es de incidente. */
  readonly severity: string | null;
  readonly source: { readonly id: string; readonly vendor: string } | null;
  readonly entity: NotificationEntity | null;
  readonly ruleId: string | null;
  /** Qué pasó, en una frase. */
  readonly summary: string;
  /** Por qué importa: motivo de la regla / caso de uso. */
  readonly whyItMatters: string | null;
  readonly mitre: readonly { readonly id: string; readonly name: string | null }[];
  readonly correlation: CorrelationSummary | null;
  readonly score: number | null;
  readonly reasons: readonly string[];
  readonly relatedAlertCount: number;
  readonly occurredAt: string;
  readonly nextStep: string | null;
  readonly runbook: { readonly title: string; readonly path: string } | null;
  /** Aviso sintético de verificación: se rotula «PRUEBA» en todas partes. */
  readonly test: boolean;
}

/** Proveedor por prefijo del título QAPAQ («QAPAQ M365: …») o por id de fuente. */
const VENDORS: Readonly<Record<string, string>> = Object.freeze({
  m365: 'Microsoft 365',
  office365: 'Microsoft 365',
  exchange: 'Microsoft 365 · Exchange Online',
  entra: 'Microsoft Entra ID',
  sharepoint: 'Microsoft 365 · SharePoint/OneDrive',
  aws: 'Amazon Web Services',
  cloudtrail: 'AWS CloudTrail',
  guardduty: 'AWS GuardDuty',
  cloudflare: 'Cloudflare',
  bitdefender: 'Bitdefender GravityZone',
  snyk: 'Snyk',
  sophos: 'Sophos',
  linux: 'Linux (agente Wazuh)',
  ad: 'Active Directory',
  edge: 'Portal QAPAQ (proxy de borde)',
  plataforma: 'Plataforma QAPAQ (monitor)',
  platform: 'Plataforma QAPAQ (monitor)',
  correlador: 'Correlador QAPAQ',
  'qapaq-correlator': 'Correlador QAPAQ',
  wazuh: 'Wazuh',
  red: 'Red (Wazuh)',
  network: 'Red (Wazuh)',
});

export function vendorFor(id: string): string {
  return VENDORS[id.toLowerCase()] ?? id;
}

/** Fuente por el prefijo del título (`QAPAQ M365: …`) o por la regla del correlador. */
export function sourceFromTitle(
  title: string,
  ruleId: string | null,
): { readonly id: string; readonly vendor: string } | null {
  if (ruleId?.startsWith('qapaq-correlator:')) return { id: 'qapaq-correlator', vendor: vendorFor('qapaq-correlator') };
  const match = /^QAPAQ\s+([A-Za-zÁÉÍÓÚáéíóú0-9 ._-]{2,40}?):/u.exec(title.trim());
  if (!match) return null;
  const raw = match[1]!.trim();
  const key = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .split(/\s+/u)[0]!;
  return { id: key, vendor: VENDORS[key] ?? raw };
}

const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/gu;
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b/gu;

function maskLocal(local: string): string {
  if (local.length <= 2) return `${local[0] ?? ''}***`;
  return `${local.slice(0, 2)}***`;
}

/** Enmascara correos e IPs en un texto libre (títulos, motivos, narrativa). */
export function maskText(text: string): string {
  return text
    .replace(EMAIL, (_all, local: string, domain: string) => `${maskLocal(local)}@${domain}`)
    .replace(IPV4, (_all, a: string, b: string) => `${a}.${b}.x.x`)
    .replace(IPV6, (value) => `${value.split(':').slice(0, 2).join(':')}:…`);
}

/** Entidad principal de una alerta a partir de sus claves (`user:`, `host:`, `ip:`, `cloud:`). */
export function entityFromKeys(keys: readonly string[]): NotificationEntity | null {
  const order = ['user', 'host', 'cloud', 'ip'] as const;
  for (const kind of order) {
    const key = keys.find((candidate) => candidate.startsWith(`${kind}:`));
    if (key) return { kind, display: maskText(key.slice(kind.length + 1)).slice(0, 120) };
  }
  return null;
}

export const ENTITY_LABELS: Readonly<Record<NotificationEntity['kind'], string>> = Object.freeze({
  user: 'Usuario',
  host: 'Equipo',
  ip: 'IP',
  cloud: 'Recurso cloud',
  service: 'Servicio',
});

/** Entidad que «hace» la actividad: usuario, equipo, servicio o recurso cloud (nunca solo IP). */
const ACTOR_KINDS = ['user', 'host', 'service', 'cloud'] as const;

export function actorKeyOf(entityKeys: readonly string[] | undefined): string | null {
  const keys = (entityKeys ?? []).map((key) => key.trim().toLowerCase()).filter(Boolean);
  for (const kind of ACTOR_KINDS) {
    const match = keys.filter((key) => key.startsWith(`${kind}:`)).sort()[0];
    if (match) return match;
  }
  return null;
}

/**
 * Clave de agrupación de ruido. Orden de preferencia: escalada humana → incidente → cadena del
 * correlador + entidades → **actividad** (actor + fuente + nivel de prioridad) → regla +
 * entidades → título (plataforma sin regla). Se guarda como hash: la clave no debe llevar UPN
 * ni IP a la base de avisos.
 *
 * Actividad (incidente 2026-11-13): una sola acción genera varias reglas a la vez (un
 * consentimiento en Entra registra «Consent to application», «Add app role» y «Add delegated
 * permission»; una regla de bandeja, alta + modificación). Agrupar por regla mandaba un aviso
 * por operación al canal de Teams y, por la suscripción del grupo M365, un correo por miembro.
 * El nivel P1/P2 forma parte de la clave para que una P1 nueva del mismo actor sí avise
 * aunque ya hubiera salido una P2 (escalada), y varias P1 del mismo actor se agrupen.
 */
export function groupKeyFor(input: {
  /** Una escalada es una decisión humana: nunca se agrupa con la creación de la alerta. */
  readonly messageType?: string;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly incidentId?: string | null;
  readonly ruleId?: string | null;
  readonly entityKeys?: readonly string[];
  readonly title?: string;
  /** Fuente normalizada (`sourceFromTitle(...).id`): entra, m365, aws, qapaq-platform… */
  readonly sourceId?: string | null;
  readonly priority?: string | null;
}): string {
  let raw: string;
  const actor = actorKeyOf(input.entityKeys);
  if (input.messageType === 'soc.alert.escalated') raw = `escalated:${input.aggregateId}`;
  else if (input.aggregateType === 'incident') raw = `incident:${input.aggregateId}`;
  else if (input.incidentId) raw = `incident:${input.incidentId}`;
  else if (input.ruleId && !input.ruleId.startsWith('corr:') && actor) {
    const tier = input.priority === 'P1' ? 'P1' : 'P2+';
    raw = `activity:${(input.sourceId ?? 'unknown').toLowerCase()}|${actor}|${tier}`;
  } else if (input.ruleId) {
    const entities = [...(input.entityKeys ?? [])].sort().join(',');
    raw = `rule:${input.ruleId}|${entities}`;
  } else {
    // Sin regla ni incidente: el título sin cifras es la mejor aproximación a «lo mismo».
    raw = `title:${(input.title ?? input.aggregateId).toLowerCase().replace(/\d+/gu, '#').slice(0, 120)}`;
  }
  return `g_${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 24)}`;
}

function payloadText(message: OutboxMessageDraft, key: string): string | null {
  const value = message.payload[key];
  return value === undefined || value === null || value === '' ? null : String(value);
}

function priorityOf(value: string | null): NotificationPriority | null {
  return PRIORITIES.find((priority) => priority === value) ?? null;
}

/** Contexto mínimo desde el outbox, para cuando no hay enriquecedor o este falla. */
export function contextFromMessage(message: OutboxMessageDraft): NotificationContext {
  const rawTitle = payloadText(message, 'title') ?? message.messageType;
  const ruleId = payloadText(message, 'ruleId');
  const title = maskText(rawTitle).slice(0, 300);
  const isIncident = message.aggregateType === 'incident';
  return {
    kind: isIncident ? 'incident' : 'alert',
    alertId: isIncident ? null : message.aggregateId,
    incidentId: isIncident ? message.aggregateId : payloadText(message, 'incidentId'),
    title,
    priority: priorityOf(payloadText(message, 'priority')),
    severity: payloadText(message, 'severity'),
    source: sourceFromTitle(rawTitle, ruleId),
    entity: null,
    ruleId,
    summary: title,
    whyItMatters: null,
    mitre: [],
    correlation: null,
    score: typeof message.payload['score'] === 'number' ? message.payload['score'] : null,
    reasons: (payloadText(message, 'reasonCodes') ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
    relatedAlertCount:
      typeof message.payload['relatedAlertCount'] === 'number'
        ? message.payload['relatedAlertCount']
        : 0,
    occurredAt: message.availableAt.toISOString(),
    nextStep: null,
    runbook: null,
    test: /\bPRUEBA\b/u.test(rawTitle),
  };
}

/** Puerto del enriquecedor (lo implementa el composition root). */
export interface NotificationEnricher {
  contextFor(message: OutboxMessageDraft): Promise<{
    readonly context: NotificationContext;
    /** Claves de entidad sin enmascarar: solo para agrupar, nunca salen del proceso. */
    readonly entityKeys: readonly string[];
    readonly occurredAt: Date;
  }>;
}
