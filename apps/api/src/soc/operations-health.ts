/**
 * Observabilidad operativa visible en la consola: `GET /api/operations/health`.
 *
 * Qué responde y a quién (contrato publicado en la coordinación con Codex):
 *
 * - `summary` (`alerts.read`: analista, líder, admin): frescura de alertas y cobertura de
 *   fuentes. La cobertura queda `NO_DATA` hasta que exista la salud por dataset (C-5); no
 *   se infiere "sano" de la mera ausencia de alertas.
 * - `soc` (`observability.read_soc`: líder, admin): persistencia, despacho y cola del
 *   outbox e inbox push, e intentos de notificación por estado.
 * - `platform` (`observability.read_platform`: admin): proceso del API y latencia de base.
 *
 * Una sección sin capability no aparece en la respuesta (no viaja como `null`): el cliente
 * no puede distinguir "no autorizado" de "no existe". Todo es agregado: sin UPN, IP,
 * títulos de alerta ni texto de error crudo.
 */

import type { WazuhPushInboxMetrics } from '@qapaq/soc';
import type { ProviderAcceptanceLatency } from '@qapaq/soar';

export const HEALTH_STATUSES = ['OK', 'NO_DATA', 'STALE', 'DEGRADED'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const CORRELATOR_FEEDBACK_STATUSES = [
  'ready',
  'pending',
  'failed',
  'stale',
  'unavailable',
  'unconfigured',
] as const;
export type CorrelatorFeedbackStatus = (typeof CORRELATOR_FEEDBACK_STATUSES)[number];

export interface CorrelatorHealth {
  readonly status: HealthStatus;
  readonly ready: boolean | null;
  readonly feedbackStatus: CorrelatorFeedbackStatus;
  readonly feedbackAgeSeconds: number | null;
  readonly lastFeedbackSuccess: string | null;
}

interface CorrelatorReadResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Validates the small readiness projection and discards every unrecognized field. `undefined`
 * means no read link was configured; `null` means a configured link could not be read safely.
 */
export function correlatorHealth(
  response: CorrelatorReadResult | null | undefined,
): CorrelatorHealth {
  if (response === undefined) {
    return {
      status: 'NO_DATA',
      ready: null,
      feedbackStatus: 'unconfigured',
      feedbackAgeSeconds: null,
      lastFeedbackSuccess: null,
    };
  }
  if (response === null) return unavailableCorrelator();

  const body = recordOf(response.body);
  const feedbackStatus = body['feedbackStatus'];
  const feedbackReady = body['feedbackReady'];
  const ready = body['ready'];
  const status = body['status'];
  const age = body['feedbackAgeSeconds'];
  const lastSuccess = body['lastFeedbackSuccess'];
  const allowedFeedbackStatuses = new Set<string>(CORRELATOR_FEEDBACK_STATUSES.slice(0, 4));
  const validAge =
    age === undefined || (typeof age === 'number' && Number.isFinite(age) && age >= 0);
  const validTimestamp =
    lastSuccess === undefined ||
    (typeof lastSuccess === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(lastSuccess) &&
      Number.isFinite(Date.parse(lastSuccess)));
  const hasAge = typeof age === 'number';
  const hasTimestamp = typeof lastSuccess === 'string';
  const validState =
    typeof ready === 'boolean' &&
    typeof feedbackReady === 'boolean' &&
    typeof status === 'string' &&
    ['ready', 'degraded', 'backfilling'].includes(status) &&
    typeof feedbackStatus === 'string' &&
    allowedFeedbackStatuses.has(feedbackStatus) &&
    feedbackReady === (feedbackStatus === 'ready') &&
    (ready ? status === 'ready' && feedbackReady : status !== 'ready') &&
    validAge &&
    validTimestamp &&
    hasAge === hasTimestamp &&
    (feedbackStatus !== 'pending' || (!hasAge && !hasTimestamp)) &&
    (!['ready', 'stale'].includes(feedbackStatus) || (hasAge && hasTimestamp));
  const expectedHttpStatus = ready === true ? 200 : ready === false ? 503 : 0;
  if (!validState || response.status !== expectedHttpStatus) return unavailableCorrelator();

  return {
    status: ready ? 'OK' : 'DEGRADED',
    ready,
    feedbackStatus: feedbackStatus as CorrelatorFeedbackStatus,
    feedbackAgeSeconds: hasAge ? (age as number) : null,
    lastFeedbackSuccess: hasTimestamp ? (lastSuccess as string) : null,
  };
}

function unavailableCorrelator(): CorrelatorHealth {
  return {
    status: 'DEGRADED',
    ready: null,
    feedbackStatus: 'unavailable',
    feedbackAgeSeconds: null,
    lastFeedbackSuccess: null,
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Umbrales operativos. Cambiarlos es una decisión del SOC, no un ajuste de UI. */
export const HEALTH_THRESHOLDS = Object.freeze({
  /** Un pendiente más viejo que esto indica que el despacho no avanza. */
  outboxOldestPendingSeconds: 300,
  /** Un lease vencido indica que una pasada no cerró el claim antes de perderlo. */
  outboxExpiredProcessingIsDegraded: true,
  /** Una receipt terminal fue aceptada por API pero no llegó a promoverse por el fast path. */
  pushInboxTerminalFailureIsDegraded: true,
  /** Latencia de base de datos que ya degrada la operación de la consola. */
  databaseLatencyMs: 1_000,
  /** Ventana fija de los conteos de notificaciones. */
  notificationWindowHours: 24,
});

/**
 * Estados de intento que indican que un crítico no llegó por el canal primario. Cualquiera
 * dentro de la ventana degrada la sección: un P1 sin entregar es exactamente lo que el SOC
 * debe ver primero.
 */
const NOTIFICATION_DEGRADING: Readonly<Record<string, string>> = Object.freeze({
  failed: 'NOTIFICATION_FAILED',
  indeterminate: 'NOTIFICATION_INDETERMINATE',
  fallback: 'NOTIFICATION_FALLBACK',
});

/** El peor estado manda. `NO_DATA` no degrada: es ausencia de señal, no falla. */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  const rank: Readonly<Record<HealthStatus, number>> = { OK: 0, NO_DATA: 1, STALE: 2, DEGRADED: 3 };
  return statuses.reduce<HealthStatus>(
    (worst, status) => (rank[status] > rank[worst] ? status : worst),
    'OK',
  );
}

export interface SummaryInput {
  readonly lastAlertAt: Date | null;
  /** Current source coverage when the caller can read its health; unknown/disabled is NO_DATA. */
  readonly sourceStatus?: HealthStatus;
}

export function summarySection(input: SummaryInput, at: Date) {
  return {
    // Sin alertas no hay señal: puede ser un tenant tranquilo o una fuente muda.
    status: input.sourceStatus ?? (input.lastAlertAt ? 'OK' : 'NO_DATA'),
    checkedAt: at.toISOString(),
    lastAlertAt: input.lastAlertAt?.toISOString() ?? null,
    alertFreshnessSeconds: input.lastAlertAt
      ? Math.max(0, Math.round((at.getTime() - input.lastAlertAt.getTime()) / 1_000))
      : null,
    // C-5 (salud por dataset) todavía no está implementada: se declara, no se adivina.
    sourceCoverage: input.sourceStatus ?? ('NO_DATA' as const),
  };
}

export interface SocSectionInput {
  readonly persistence: 'memory' | 'postgres';
  readonly dispatcherRunning: boolean;
  readonly outbox: {
    readonly pending: number;
    readonly processing: number;
    readonly oldestPendingAt: Date | null;
    readonly expiredProcessing: number;
    readonly oldestExpiredProcessingLeaseUntil: Date | null;
  };
  readonly notificationsByStatus: Readonly<Record<string, number>>;
  readonly providerAcceptanceLatency?: ProviderAcceptanceLatency | null;
  readonly wazuhPushInbox?: WazuhPushInboxMetrics | null;
  readonly correlator?: CorrelatorHealth;
  /**
   * Estado de los canales de aviso (sin destino ni secreto). Ausente = el runtime no tiene
   * registro de canales y no se opina sobre ellos.
   */
  readonly notificationChannels?: readonly NotificationChannelHealth[];
}

export interface NotificationChannelHealth {
  readonly id: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly setup: string;
}

/**
 * Problemas de puesta en marcha de los canales. Un P1 sale por Teams y, si Teams no confirma,
 * por correo; el push a navegadores es complementario y no cuenta como entrega de un P1.
 */
export function notificationChannelIssues(
  channels: readonly NotificationChannelHealth[] | undefined,
): readonly string[] {
  if (!channels) return [];
  const teams = channels.find((channel) => channel.id === 'teams');
  const delivers = channels.some(
    (channel) =>
      (channel.id === 'teams' || channel.id === 'email') && channel.configured && channel.enabled,
  );
  return [
    ...(teams && !teams.configured ? ['NOTIFICATION_TEAMS_NOT_CONFIGURED'] : []),
    ...(delivers ? [] : ['NOTIFICATION_NO_P1_CHANNEL']),
  ];
}

export function socSection(input: SocSectionInput, at: Date) {
  const correlator = input.correlator ?? correlatorHealth(undefined);
  const oldestPendingAgeSeconds = input.outbox.oldestPendingAt
    ? Math.max(0, Math.round((at.getTime() - input.outbox.oldestPendingAt.getTime()) / 1_000))
    : null;
  const stuck =
    oldestPendingAgeSeconds !== null &&
    oldestPendingAgeSeconds > HEALTH_THRESHOLDS.outboxOldestPendingSeconds;
  const oldestExpiredLeaseAgeSeconds = ageSeconds(
    input.outbox.oldestExpiredProcessingLeaseUntil,
    at,
  );
  const degradedReasons = [
    ...(input.dispatcherRunning ? [] : ['DISPATCHER_STOPPED']),
    ...(stuck ? ['OUTBOX_BACKLOG'] : []),
    ...(HEALTH_THRESHOLDS.outboxExpiredProcessingIsDegraded && input.outbox.expiredProcessing > 0
      ? ['OUTBOX_LEASE_EXPIRED']
      : []),
    // Memoria en un ambiente que debería ser durable se reporta, no se esconde.
    ...(input.persistence === 'memory' ? ['PERSISTENCE_EPHEMERAL'] : []),
    ...(input.wazuhPushInbox?.terminalFailuresRecent ? ['WAZUH_PUSH_TERMINAL_FAILURES'] : []),
    ...(input.wazuhPushInbox?.expiredProcessing ? ['WAZUH_PUSH_LEASE_EXPIRED'] : []),
    ...Object.entries(NOTIFICATION_DEGRADING)
      .filter(([status]) => (input.notificationsByStatus[status] ?? 0) > 0)
      .map(([, reason]) => reason),
    ...notificationChannelIssues(input.notificationChannels),
    ...(correlator.feedbackStatus === 'unavailable' ? ['CORRELATOR_UNREACHABLE'] : []),
    ...(correlator.ready === false ? ['CORRELATOR_NOT_READY'] : []),
  ];
  return {
    status: (degradedReasons.length > 0 ? 'DEGRADED' : 'OK') as HealthStatus,
    checkedAt: at.toISOString(),
    degradedReasons,
    persistence: input.persistence,
    dispatcherRunning: input.dispatcherRunning,
    correlator,
    outbox: {
      pending: input.outbox.pending,
      processing: input.outbox.processing,
      oldestPendingAgeSeconds,
      expiredProcessing: input.outbox.expiredProcessing,
      oldestExpiredLeaseAgeSeconds,
    },
    notifications: {
      windowHours: HEALTH_THRESHOLDS.notificationWindowHours,
      since: new Date(
        at.getTime() - HEALTH_THRESHOLDS.notificationWindowHours * 3_600_000,
      ).toISOString(),
      byStatus: input.notificationsByStatus,
      channels: input.notificationChannels ?? null,
    },
    outboxToProviderAcceptanceMs: {
      status: input.providerAcceptanceLatency?.sampleCount ? 'OK' : 'NO_DATA',
      windowHours: input.providerAcceptanceLatency?.windowHours ?? 24,
      sampleCount: input.providerAcceptanceLatency?.sampleCount ?? 0,
      excludedClockSkewCount: input.providerAcceptanceLatency?.excludedClockSkewCount ?? 0,
      sampleCapReached: input.providerAcceptanceLatency?.sampleCapReached ?? false,
      p50: input.providerAcceptanceLatency?.p50 ?? null,
      p95: input.providerAcceptanceLatency?.p95 ?? null,
      p99: input.providerAcceptanceLatency?.p99 ?? null,
      acceptanceMeans:
        'Percentiles use the outbox creation time to the Teams HTTP 2xx response time. Historical records without a response timestamp are excluded. HTTP 2xx means Microsoft accepted the request; it does not mean a person read it or that a workflow posted a card.',
    },
    wazuhPushInbox: input.wazuhPushInbox
      ? {
          counts: input.wazuhPushInbox.counts,
          oldestPendingAgeSeconds: ageSeconds(input.wazuhPushInbox.oldestPendingAt, at),
          oldestProcessingAgeSeconds: ageSeconds(input.wazuhPushInbox.oldestProcessingAt, at),
          oldestUnresolvedAgeSeconds: ageSeconds(input.wazuhPushInbox.oldestUnresolvedAt, at),
          oldestTerminalAgeSeconds: ageSeconds(input.wazuhPushInbox.oldestTerminalAt, at),
          lastProcessedAt: input.wazuhPushInbox.lastProcessedAt?.toISOString() ?? null,
          expiredProcessing: input.wazuhPushInbox.expiredProcessing,
          terminalFailuresRecent: input.wazuhPushInbox.terminalFailuresRecent,
          terminalWindowHours: input.wazuhPushInbox.terminalWindowHours,
          sourceToReceiptMs: input.wazuhPushInbox.sourceToReceiptMs,
          receiptToHandlerMs: input.wazuhPushInbox.receiptToHandlerMs,
        }
      : null,
  };
}

function ageSeconds(value: Date | null, at: Date): number | null {
  return value ? Math.max(0, Math.round((at.getTime() - value.getTime()) / 1_000)) : null;
}

/**
 * Métricas del proceso. Solo el entrypoint puede leer `process` (regla de C-02), así que
 * llegan inyectadas; sin proveedor, la sección las reporta como `null`.
 */
export interface ProcessInfo {
  readonly uptimeSeconds: number;
  readonly memoryRssBytes: number;
  readonly nodeVersion: string;
}

export interface PlatformSectionInput {
  readonly processMetrics: ProcessInfo | null;
  /** `null` si la base no respondió. */
  readonly databaseLatencyMs: number | null;
}

export function platformSection(input: PlatformSectionInput, at: Date) {
  const degradedReasons = [
    ...(input.databaseLatencyMs === null ? ['DATABASE_UNAVAILABLE'] : []),
    ...(input.databaseLatencyMs !== null &&
    input.databaseLatencyMs > HEALTH_THRESHOLDS.databaseLatencyMs
      ? ['DATABASE_SLOW']
      : []),
  ];
  return {
    status: (degradedReasons.length > 0 ? 'DEGRADED' : 'OK') as HealthStatus,
    checkedAt: at.toISOString(),
    degradedReasons,
    uptimeSeconds: input.processMetrics ? Math.round(input.processMetrics.uptimeSeconds) : null,
    memoryRssMb: input.processMetrics
      ? Math.round(input.processMetrics.memoryRssBytes / (1024 * 1024))
      : null,
    databaseLatencyMs: input.databaseLatencyMs,
    nodeVersion: input.processMetrics?.nodeVersion ?? null,
  };
}
