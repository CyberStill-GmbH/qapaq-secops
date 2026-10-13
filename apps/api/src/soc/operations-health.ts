/**
 * Observabilidad operativa visible en la consola: `GET /api/operations/health`.
 *
 * Qué responde y a quién (contrato publicado en la coordinación con Codex):
 *
 * - `summary` (`alerts.read`: analista, líder, admin): frescura de alertas y cobertura de
 *   fuentes. La cobertura queda `NO_DATA` hasta que exista la salud por dataset (C-5); no
 *   se infiere "sano" de la mera ausencia de alertas.
 * - `soc` (`observability.read_soc`: líder, admin): persistencia, despacho y cola del
 *   outbox, e intentos de notificación por estado.
 * - `platform` (`observability.read_platform`: admin): proceso del API y latencia de base.
 *
 * Una sección sin capability no aparece en la respuesta (no viaja como `null`): el cliente
 * no puede distinguir "no autorizado" de "no existe". Todo es agregado: sin UPN, IP,
 * títulos de alerta ni texto de error crudo.
 */

export const HEALTH_STATUSES = ['OK', 'NO_DATA', 'STALE', 'DEGRADED'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Umbrales operativos. Cambiarlos es una decisión del SOC, no un ajuste de UI. */
export const HEALTH_THRESHOLDS = Object.freeze({
  /** Un pendiente más viejo que esto indica que el despacho no avanza. */
  outboxOldestPendingSeconds: 300,
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
}

export function summarySection(input: SummaryInput, at: Date) {
  return {
    // Sin alertas no hay señal: puede ser un tenant tranquilo o una fuente muda.
    status: (input.lastAlertAt ? 'OK' : 'NO_DATA') as HealthStatus,
    checkedAt: at.toISOString(),
    lastAlertAt: input.lastAlertAt?.toISOString() ?? null,
    alertFreshnessSeconds: input.lastAlertAt
      ? Math.max(0, Math.round((at.getTime() - input.lastAlertAt.getTime()) / 1_000))
      : null,
    // C-5 (salud por dataset) todavía no está implementada: se declara, no se adivina.
    sourceCoverage: 'NO_DATA' as const,
  };
}

export interface SocSectionInput {
  readonly persistence: 'memory' | 'postgres';
  readonly dispatcherRunning: boolean;
  readonly outbox: {
    readonly pending: number;
    readonly processing: number;
    readonly oldestPendingAt: Date | null;
  };
  readonly notificationsByStatus: Readonly<Record<string, number>>;
}

export function socSection(input: SocSectionInput, at: Date) {
  const oldestPendingAgeSeconds = input.outbox.oldestPendingAt
    ? Math.max(0, Math.round((at.getTime() - input.outbox.oldestPendingAt.getTime()) / 1_000))
    : null;
  const stuck =
    oldestPendingAgeSeconds !== null &&
    oldestPendingAgeSeconds > HEALTH_THRESHOLDS.outboxOldestPendingSeconds;
  const degradedReasons = [
    ...(input.dispatcherRunning ? [] : ['DISPATCHER_STOPPED']),
    ...(stuck ? ['OUTBOX_BACKLOG'] : []),
    // Memoria en un ambiente que debería ser durable se reporta, no se esconde.
    ...(input.persistence === 'memory' ? ['PERSISTENCE_EPHEMERAL'] : []),
    ...Object.entries(NOTIFICATION_DEGRADING)
      .filter(([status]) => (input.notificationsByStatus[status] ?? 0) > 0)
      .map(([, reason]) => reason),
  ];
  return {
    status: (degradedReasons.length > 0 ? 'DEGRADED' : 'OK') as HealthStatus,
    checkedAt: at.toISOString(),
    degradedReasons,
    persistence: input.persistence,
    dispatcherRunning: input.dispatcherRunning,
    outbox: {
      pending: input.outbox.pending,
      processing: input.outbox.processing,
      oldestPendingAgeSeconds,
    },
    notifications: {
      windowHours: HEALTH_THRESHOLDS.notificationWindowHours,
      since: new Date(
        at.getTime() - HEALTH_THRESHOLDS.notificationWindowHours * 3_600_000,
      ).toISOString(),
      byStatus: input.notificationsByStatus,
    },
  };
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
