/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  HealthTone,
  IntegrationConfig,
  OverviewResponse,
  PLATFORM_SOURCE_LABEL,
  PlatformSourceHealth,
  ProviderId,
  SERVICE_HEALTH_SOURCE,
  serviceSourceState,
  SourceHealth,
} from '../../common';

/**
 * Estado visible de cada servicio. Una sola tabla de decisión para «Resumen del SOC» e
 * «Integraciones», guiada por los datos:
 *
 * 1. Override explícito de `qapaq_ops.integrations.<id>.state` (≠ `auto`, que es el defecto).
 * 2. Monitor de plataforma (docs/20): último `source_status` de la fuente, si tiene ≤ 2 h.
 *    `failing` con error de permisos → «Requiere permiso»; `failing` → «Fallando»;
 *    `silent` → «Silencioso»; `disabled` → «Deshabilitado»; `ok` → «Operativo».
 * 3. Eventos en 24 h con el último dentro del ritmo esperado → «Operativo» (ganan a un
 *    «silencioso»/«deshabilitado» del monitor que quedó atrás; no a un collector que falla).
 *    Sin eventos en 24 h pero dentro del ritmo → «Recibiendo datos»; más viejo → «Silencioso».
 *
 * «Requiere permiso» solo sale cuando el monitor o el collector reportan un error de permisos;
 * nunca de una configuración estática que quedó vieja mientras los eventos fluyen.
 */
export interface ServiceStatus {
  readonly tone: HealthTone;
  readonly label: string;
  /** Una línea con el porqué (permiso faltante, último evento, error). */
  readonly detail: string | null;
}

export const STATUS_LABEL = {
  operational: 'Operativo',
  receiving: 'Recibiendo datos',
  silent: 'Silencioso',
  failing: 'Fallando',
  disabled: 'Deshabilitado',
  permission: 'Requiere permiso',
} as const;

/** Horas sin eventos a partir de las cuales un proveedor se considera callado. */
export const STALE_AFTER_HOURS: Readonly<Record<ProviderId, number>> = {
  office365: 2,
  sharepoint: 24,
  bitdefender: 24,
  // Snyk emite un evento por cambio de issue: días sin cambios son normales.
  snyk: 24 * 7,
  cloudflare: 24,
  aws: 24,
};

/** Texto de un error de permisos (Graph/Entra, API de proveedor, HTTP 401/403). */
const PERMISSION_ERROR =
  /permis|permission|forbidden|unauthori[sz]ed|access denied|consent|\b40[13]\b|AF10001|ActivityFeed|insufficient/iu;

export function isPermissionError(text: string | null | undefined): boolean {
  return !!text && PERMISSION_ERROR.test(text);
}

/** Override explícito por configuración; `auto` (el defecto) deja decidir a los datos. */
export function declaredStatus(config: IntegrationConfig | undefined): ServiceStatus | null {
  if (!config || config.state === 'auto') return null;
  const permissions = config.missingPermissions.join(', ');
  if (config.state === 'blocked') {
    return {
      tone: 'warn',
      label: STATUS_LABEL.permission,
      detail: [permissions, config.note].filter(Boolean).join(' · ') || null,
    };
  }
  if (config.state === 'disabled') {
    return { tone: 'neutral', label: STATUS_LABEL.disabled, detail: config.note || null };
  }
  return { tone: 'info', label: 'Pendiente', detail: config.note || null };
}

/** Problema abierto del monitor con error de permisos para las fuentes del servicio. */
function permissionProblem(serviceId: string, overview: OverviewResponse | null): string | null {
  const sources = SERVICE_HEALTH_SOURCE[serviceId] ?? [serviceId];
  const problem = overview?.platformHealth?.problems.find(
    (item) => sources.includes(item.source) && isPermissionError(`${item.check} ${item.summary}`),
  );
  return problem ? problem.summary || problem.check : null;
}

/** Estado según el monitor de plataforma (≤ 2 h). `null` si no hay dato reciente. */
export function monitorStatus(
  serviceId: string,
  overview: OverviewResponse | null,
  now: number = Date.now(),
): ServiceStatus | null {
  const item: PlatformSourceHealth | null = serviceSourceState(
    overview?.platformHealth,
    serviceId,
    now,
  );
  if (!item || item.state === 'unknown') return null;
  const who = PLATFORM_SOURCE_LABEL[item.source] ?? item.source;
  if (item.state === 'failing') {
    const permission = isPermissionError(item.summary)
      ? item.summary
      : permissionProblem(serviceId, overview);
    if (permission) return { tone: 'warn', label: STATUS_LABEL.permission, detail: permission };
    return {
      tone: 'fail',
      label: STATUS_LABEL.failing,
      detail: item.summary || `${who}: el collector falla.`,
    };
  }
  if (item.state === 'silent') {
    return {
      tone: 'warn',
      label: STATUS_LABEL.silent,
      detail: item.summary || `${who} no envía eventos.`,
    };
  }
  if (item.state === 'disabled') {
    return { tone: 'neutral', label: STATUS_LABEL.disabled, detail: item.summary || null };
  }
  return { tone: 'ok', label: STATUS_LABEL.operational, detail: null };
}

export function providerStatus(
  id: ProviderId,
  overview: OverviewResponse | null,
  now: number = Date.now(),
): ServiceStatus {
  const declared = declaredStatus(overview?.integrations[id]);
  if (declared) return declared;
  if (!overview) return { tone: 'neutral', label: 'Consultando…', detail: null };
  if (overview.alertsAccess === 'forbidden') {
    return {
      tone: 'neutral',
      label: 'Sin permiso de lectura',
      detail: 'Tu rol no puede leer wazuh-alerts-*.',
    };
  }
  const monitored = monitorStatus(id, overview, now);
  const stats = overview.providers?.[id];
  const ageHours = stats?.lastEventAt
    ? (now - new Date(stats.lastEventAt).getTime()) / 3600000
    : Number.POSITIVE_INFINITY;
  const fresh = (stats?.events24h ?? 0) > 0 && ageHours <= STALE_AFTER_HOURS[id];
  // Eventos frescos ganan a un «silencioso»/«deshabilitado» del monitor que quedó atrás: la
  // fuente está operativa. Un collector que falla (o sin permisos) sí se muestra aunque haya datos.
  if (
    fresh &&
    (!monitored || (monitored.tone !== 'fail' && monitored.label !== STATUS_LABEL.permission))
  ) {
    return { tone: 'ok', label: STATUS_LABEL.operational, detail: null };
  }
  if (monitored) return monitored;
  if (!stats) {
    return { tone: 'fail', label: 'Sin respuesta del Indexer', detail: null };
  }
  if (!stats.lastEventAt) {
    const permission = permissionProblem(id, overview);
    if (permission) return { tone: 'warn', label: STATUS_LABEL.permission, detail: permission };
    return { tone: 'neutral', label: 'Sin datos', detail: 'Todavía no llegó ningún evento.' };
  }
  if (ageHours > STALE_AFTER_HOURS[id]) {
    const permission = permissionProblem(id, overview);
    if (permission) return { tone: 'warn', label: STATUS_LABEL.permission, detail: permission };
    return {
      tone: 'warn',
      label: STATUS_LABEL.silent,
      detail: `Sin eventos en ${Math.round(ageHours)} h (se esperan cada ${STALE_AFTER_HOURS[id]} h).`,
    };
  }
  return { tone: 'ok', label: STATUS_LABEL.receiving, detail: null };
}

export function wazuhStatus(
  overview: OverviewResponse | null,
  source: SourceHealth | null,
  now: number = Date.now(),
): ServiceStatus {
  const declared = declaredStatus(overview?.integrations.wazuh);
  if (declared) return declared;
  if (!overview) return { tone: 'neutral', label: 'Consultando…', detail: null };
  if (overview.alertsAccess === 'error') {
    return { tone: 'fail', label: 'Indexer sin respuesta', detail: null };
  }
  if (source && (source.state === 'failed' || source.state === 'degraded')) {
    return {
      tone: source.state === 'failed' ? 'fail' : 'warn',
      label: source.state === 'failed' ? STATUS_LABEL.failing : 'Ingesta degradada',
      detail: 'La lectura de alertas hacia la cola QAPAQ tiene fallos.',
    };
  }
  const monitored = monitorStatus('wazuh', overview, now);
  if (monitored && monitored.tone !== 'ok') return monitored;
  const agents = overview.agents;
  if (agents && agents.total > 0 && agents.disconnected > 0) {
    return {
      tone: 'warn',
      label: 'Agentes desconectados',
      detail: `${agents.disconnected} de ${agents.total} sin conexión.`,
    };
  }
  if (agents && agents.total === 0) {
    return { tone: 'warn', label: 'Sin agentes', detail: 'No hay agentes enrolados.' };
  }
  return { tone: 'ok', label: STATUS_LABEL.operational, detail: null };
}
