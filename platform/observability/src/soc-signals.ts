/**
 * C-26 — catálogo de señales del flujo SOC y del borde de acceso.
 *
 * El catálogo es la fuente: los dashboards y las reglas de alerta se generan desde aquí,
 * de modo que no puede existir un panel que consulte una métrica que nadie emite, ni una
 * métrica con etiquetas fuera de la allowlist de C-15.
 *
 * Ninguna señal lleva identidad, IP ni identificador de recurso. La observabilidad
 * responde "cuánto y de qué tipo"; "quién hizo qué" es auditoría (C-19) y tiene otro
 * control de acceso.
 */

import { checkLabels, type AllowedLabelKey } from './label-guard.js';

export const METRIC_TYPES = ['counter', 'gauge', 'histogram'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export interface MetricSpec {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labels: readonly AllowedLabelKey[];
  /** Valores admitidos por etiqueta: la cardinalidad se acota por diseño, no por suerte. */
  readonly labelValues: Readonly<Partial<Record<AllowedLabelKey, readonly string[]>>>;
}

export const SOC_METRICS: readonly MetricSpec[] = Object.freeze([
  {
    name: 'qapaq_soc_alerts_total',
    type: 'counter',
    help: 'Alertas promovidas por prioridad.',
    labels: ['priority'],
    labelValues: { priority: ['p1', 'p2', 'p3', 'p4'] },
  },
  {
    name: 'qapaq_soc_alerts_open',
    type: 'gauge',
    help: 'Alertas sin cerrar por estado.',
    labels: ['status', 'priority'],
    labelValues: {
      status: ['new', 'acknowledged', 'triaged', 'escalated'],
      priority: ['p1', 'p2', 'p3', 'p4'],
    },
  },
  {
    name: 'qapaq_soc_triage_seconds',
    type: 'histogram',
    help: 'Tiempo entre la promoción de una alerta y su triaje.',
    labels: ['priority', 'verdict'],
    labelValues: {
      priority: ['p1', 'p2', 'p3', 'p4'],
      verdict: ['true_positive', 'false_positive', 'benign', 'duplicate'],
    },
  },
  {
    name: 'qapaq_soc_incidents_open',
    type: 'gauge',
    help: 'Incidentes abiertos por severidad.',
    labels: ['severity'],
    labelValues: { severity: ['critical', 'high', 'medium', 'low'] },
  },
  {
    name: 'qapaq_soar_notifications_total',
    type: 'counter',
    help: 'Intentos de notificación crítica por canal y resultado.',
    labels: ['channel', 'result', 'failure_class'],
    labelValues: {
      channel: ['teams', 'fallback_email', 'manual_console'],
      result: ['sent', 'retried', 'fallback', 'indeterminate'],
      failure_class: ['transient', 'permanent', 'ambiguous', 'none'],
    },
  },
  {
    name: 'qapaq_access_sign_in_total',
    type: 'counter',
    help: 'Intentos de acceso por decisión y zona de red.',
    labels: ['decision', 'network_zone'],
    labelValues: {
      decision: ['admitted', 'denied', 'locked_out', 'rate_limited'],
      network_zone: ['inside', 'outside', 'untrusted_chain'],
    },
  },
  {
    name: 'qapaq_access_sessions_active',
    type: 'gauge',
    help: 'Sesiones activas del BFF.',
    labels: [],
    labelValues: {},
  },
  {
    name: 'qapaq_audit_chain_verifications_total',
    type: 'counter',
    help: 'Verificaciones de la cadena de auditoría por resultado.',
    labels: ['result'],
    labelValues: { result: ['ok', 'tampered', 'gap', 'forked'] },
  },
]);

export const CARDINALITY_BUDGET_PER_METRIC = 64;

export interface SignalValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Comprueba el catálogo contra la allowlist de etiquetas y el presupuesto de series. */
export function validateSocMetrics(metrics: readonly MetricSpec[] = SOC_METRICS): SignalValidation {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const metric of metrics) {
    if (names.has(metric.name)) problems.push(`${metric.name}: nombre duplicado.`);
    names.add(metric.name);
    if (!metric.name.startsWith('qapaq_')) {
      problems.push(`${metric.name}: falta el prefijo del producto.`);
    }
    if (metric.help.trim().length === 0) problems.push(`${metric.name}: sin descripción.`);
    let series = 1;
    for (const label of metric.labels) {
      const values = metric.labelValues[label] ?? [];
      if (values.length === 0) {
        problems.push(`${metric.name}: la etiqueta ${label} no declara valores.`);
        continue;
      }
      series *= values.length;
      for (const value of values) {
        const check = checkLabels({ [label]: value });
        if (check.ok) continue;
        for (const rejection of check.rejections) {
          problems.push(`${metric.name}.${label}=${value}: ${rejection.violation}`);
        }
      }
    }
    if (series > CARDINALITY_BUDGET_PER_METRIC) {
      problems.push(`${metric.name}: ${series} series exceden el presupuesto.`);
    }
  }
  return { ok: problems.length === 0, problems };
}
