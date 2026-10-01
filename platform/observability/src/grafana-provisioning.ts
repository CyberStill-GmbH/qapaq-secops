/**
 * C-26 — generación y verificación del provisioning de Grafana.
 *
 * Los dashboards y las reglas se **generan** desde el catálogo de señales y se escriben
 * a disco; la spec comprueba que lo versionado coincide con lo generado. Así un panel no
 * puede quedar huérfano tras renombrar una métrica, y un dashboard editado a mano en la
 * interfaz no se convierte en la verdad sin pasar por revisión.
 *
 * El hardening que se verifica aquí —autenticación obligatoria, sin registro abierto,
 * sin acceso anónimo, red privada, retención declarada y alertas hacia un destino
 * externo— es el conjunto que un Grafana OSS recién instalado **no** trae por defecto.
 */

import { SOC_METRICS, type MetricSpec } from './soc-signals.js';

export interface GrafanaPanel {
  readonly id: number;
  readonly title: string;
  readonly type: 'timeseries' | 'stat' | 'heatmap';
  readonly datasource: { readonly type: 'prometheus'; readonly uid: string };
  readonly targets: readonly { readonly expr: string; readonly legendFormat: string }[];
}

export interface GrafanaDashboard {
  readonly uid: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly timezone: 'utc';
  readonly refresh: string;
  readonly panels: readonly GrafanaPanel[];
}

export const PROMETHEUS_UID = 'qapaq-prometheus';
export const LOKI_UID = 'qapaq-loki';

function panelFor(metric: MetricSpec, id: number): GrafanaPanel {
  const grouping = metric.labels.length > 0 ? ` by (${metric.labels.join(', ')})` : '';
  const expr =
    metric.type === 'counter'
      ? `sum(rate(${metric.name}[5m]))${grouping}`
      : metric.type === 'histogram'
        ? `histogram_quantile(0.95, sum(rate(${metric.name}_bucket[5m])) by (le${metric.labels.length > 0 ? `, ${metric.labels.join(', ')}` : ''}))`
        : `sum(${metric.name})${grouping}`;
  return {
    id,
    title: metric.help,
    type: metric.type === 'gauge' ? 'stat' : 'timeseries',
    datasource: { type: 'prometheus', uid: PROMETHEUS_UID },
    targets: [
      {
        expr,
        legendFormat:
          metric.labels.length > 0
            ? metric.labels.map((label) => `{{${label}}}`).join(' · ')
            : metric.name,
      },
    ],
  };
}

export function buildDashboards(
  metrics: readonly MetricSpec[] = SOC_METRICS,
): readonly GrafanaDashboard[] {
  const soc = metrics.filter(
    (metric) => metric.name.startsWith('qapaq_soc_') || metric.name.startsWith('qapaq_soar_'),
  );
  const access = metrics.filter(
    (metric) => metric.name.startsWith('qapaq_access_') || metric.name.startsWith('qapaq_audit_'),
  );
  return [
    {
      uid: 'qapaq-soc-operations',
      title: 'QAPAQ SecOps · Operación SOC',
      tags: ['qapaq', 'soc'],
      timezone: 'utc',
      refresh: '1m',
      panels: soc.map((metric, index) => panelFor(metric, index + 1)),
    },
    {
      uid: 'qapaq-access-audit',
      title: 'QAPAQ SecOps · Acceso y auditoría',
      tags: ['qapaq', 'acceso'],
      timezone: 'utc',
      refresh: '1m',
      panels: access.map((metric, index) => panelFor(metric, index + 1)),
    },
  ];
}

export interface AlertRule {
  readonly uid: string;
  readonly title: string;
  readonly expr: string;
  readonly forDuration: string;
  readonly severity: 'critical' | 'warning';
  readonly summary: string;
  /** Destino fuera del propio stack: una alerta que solo llega a Grafana no avisa. */
  readonly receiver: string;
}

export const EXTERNAL_RECEIVER = 'qapaq-oncall-external';

export const ALERT_RULES: readonly AlertRule[] = Object.freeze([
  {
    uid: 'qapaq-critical-notification-failed',
    title: 'Notificación crítica sin entregar',
    expr: 'sum(rate(qapaq_soar_notifications_total{result="fallback"}[15m])) > 0',
    forDuration: '5m',
    severity: 'critical',
    summary: 'Un crítico salió por el canal de respaldo: Teams no aceptó la entrega.',
    receiver: EXTERNAL_RECEIVER,
  },
  {
    uid: 'qapaq-p1-untriaged',
    title: 'Alerta P1 sin triar',
    expr: 'sum(qapaq_soc_alerts_open{priority="p1", status="new"}) > 0',
    forDuration: '15m',
    severity: 'critical',
    summary: 'Hay una alerta P1 sin tomar por ningún analista.',
    receiver: EXTERNAL_RECEIVER,
  },
  {
    uid: 'qapaq-audit-chain-broken',
    title: 'Cadena de auditoría comprometida',
    expr: 'sum(rate(qapaq_audit_chain_verifications_total{result!="ok"}[30m])) > 0',
    forDuration: '0m',
    severity: 'critical',
    summary: 'Una verificación de la cadena de auditoría falló.',
    receiver: EXTERNAL_RECEIVER,
  },
  {
    uid: 'qapaq-access-denial-burst',
    title: 'Ráfaga de denegaciones de acceso',
    expr: 'sum(rate(qapaq_access_sign_in_total{decision="denied"}[5m])) > 1',
    forDuration: '10m',
    severity: 'warning',
    summary: 'Tasa inusual de accesos denegados.',
    receiver: EXTERNAL_RECEIVER,
  },
  {
    uid: 'qapaq-pipeline-stale',
    title: 'Pipeline sin ciclos exitosos',
    expr: 'max(qapaq_pipeline_last_success_age_seconds) > 1800',
    forDuration: '5m',
    severity: 'critical',
    summary: 'El pipeline lleva más de 30 minutos sin un ciclo exitoso.',
    receiver: EXTERNAL_RECEIVER,
  },
]);

export interface RetentionPolicy {
  readonly signal: 'metrics' | 'logs' | 'traces';
  readonly retentionDays: number;
  readonly justification: string;
}

/**
 * La retención no es un ajuste de capacidad: fija cuánto tiempo hay evidencia operativa.
 * La auditoría (C-19) tiene su propio archivo y no depende de estos plazos.
 */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = Object.freeze([
  { signal: 'metrics', retentionDays: 90, justification: 'Tendencia trimestral de capacidad.' },
  { signal: 'logs', retentionDays: 30, justification: 'Diagnóstico de incidentes recientes.' },
  { signal: 'traces', retentionDays: 7, justification: 'Depuración de latencia puntual.' },
]);

export interface HardeningCheck {
  readonly id: string;
  readonly requirement: string;
  readonly settingPath: string;
  readonly expected: string;
}

export const GRAFANA_HARDENING: readonly HardeningCheck[] = Object.freeze([
  {
    id: 'no-anonymous',
    requirement: 'Sin acceso anónimo.',
    settingPath: 'auth.anonymous.enabled',
    expected: 'false',
  },
  {
    id: 'no-signup',
    requirement: 'Sin autorregistro de usuarios.',
    settingPath: 'users.allow_sign_up',
    expected: 'false',
  },
  {
    id: 'no-org-create',
    requirement: 'Sin creación de organizaciones por usuarios.',
    settingPath: 'users.allow_org_create',
    expected: 'false',
  },
  {
    id: 'viewer-not-editor',
    requirement: 'El rol por defecto es solo lectura.',
    settingPath: 'users.auto_assign_org_role',
    expected: 'Viewer',
  },
  {
    id: 'cookie-secure',
    requirement: 'Cookie de sesión marcada Secure.',
    settingPath: 'security.cookie_secure',
    expected: 'true',
  },
  {
    id: 'no-embedding',
    requirement: 'Sin incrustación en marcos externos.',
    settingPath: 'security.allow_embedding',
    expected: 'false',
  },
  {
    id: 'private-network',
    requirement: 'Escucha únicamente en la red interna.',
    settingPath: 'server.http_addr',
    expected: '127.0.0.1',
  },
]);

export interface RecoveryStep {
  readonly order: number;
  readonly action: string;
  readonly verification: string;
}

/** Procedimiento mínimo de respaldo y restauración, verificable paso a paso. */
export const BACKUP_RECOVERY_PLAN: readonly RecoveryStep[] = Object.freeze([
  {
    order: 1,
    action: 'Respaldar la base de Grafana y el provisioning versionado.',
    verification: 'El digest del respaldo coincide con el registrado.',
  },
  {
    order: 2,
    action: 'Respaldar los bloques de Prometheus y los chunks de Loki.',
    verification: 'El tamaño y el rango temporal del respaldo cubren la retención declarada.',
  },
  {
    order: 3,
    action: 'Restaurar en una instancia limpia desde el respaldo.',
    verification: 'Los dashboards aparecen con el mismo uid y sin ediciones manuales.',
  },
  {
    order: 4,
    action: 'Reproducir una alerta de prueba tras la restauración.',
    verification: 'El destino externo recibe la notificación.',
  },
]);

export function serializeDashboard(dashboard: GrafanaDashboard): string {
  return `${JSON.stringify(dashboard, null, 2)}\n`;
}
