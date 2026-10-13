/**
 * Sprint 5 · fase 2 — composición de la salud por fuente en el API.
 *
 * - `SourceHealthMonitor` describe la fuente que el runtime vigila (clave, política y si está
 *   habilitada). Sin ingesta, la fuente existe igual como `disabled`: la UI muestra una
 *   exclusión declarada, no un hueco.
 * - `recordSourceHealth` corre al terminar cada pasada de ingesta (Observer sobre la pasada):
 *   evalúa con las observaciones recientes y, solo si el estado cambió, agrega la transición a
 *   la bitácora y deja un AuditEvent `source.health.changed`. El feed `/api/changes` lo anuncia
 *   a la UI sin endpoint adicional.
 *
 * La evaluación se repite al leer (`GET /api/sources/health`) con la hora actual: si la
 * ingesta deja de correr, nadie escribe transiciones, pero la lectura sí ve la fuente
 * degradada o caída.
 */

import { randomUUID } from 'node:crypto';

import { recordAudit, type AuditStore } from '@qapaq/audit';
import type { ActivityQuery, StreamActivity } from '@qapaq/connectors';
import {
  DEFAULT_SOURCE_HEALTH_POLICY,
  evaluateSourceHealth,
  type IngestionCursorKey,
  type IngestionStateStore,
  type SourceHealthEvaluation,
  type SourceHealthPolicy,
} from '@qapaq/soc';

/** Observaciones que alcanzan para decidir: cubren varias ventanas de falla. */
export const SOURCE_HEALTH_OBSERVATION_WINDOW = 50;

export interface SourceHealthMonitor {
  readonly key: IngestionCursorKey;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly policy: SourceHealthPolicy;
}

export function sourceHealthMonitor(input: {
  readonly key: IngestionCursorKey;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly intervalMs: number;
}): SourceHealthMonitor {
  return {
    key: input.key,
    displayName: input.displayName,
    enabled: input.enabled,
    policy: { intervalMs: input.intervalMs, ...DEFAULT_SOURCE_HEALTH_POLICY },
  };
}

export async function evaluateMonitor(
  monitor: SourceHealthMonitor,
  state: IngestionStateStore,
  now: Date,
): Promise<SourceHealthEvaluation> {
  const observations = monitor.enabled
    ? await state.recentObservations(monitor.key, SOURCE_HEALTH_OBSERVATION_WINDOW)
    : [];
  return evaluateSourceHealth(observations, monitor.policy, now, monitor.enabled);
}

/** Registra la transición si el estado cambió respecto de la última registrada. */
export async function recordSourceHealth(
  monitor: SourceHealthMonitor,
  state: IngestionStateStore,
  audit: AuditStore,
  now: Date,
): Promise<void> {
  const evaluation = await evaluateMonitor(monitor, state, now);
  const [last] = await state.recentTransitions(monitor.key, 1);
  if (last?.toState === evaluation.state) return;
  const transition = {
    id: randomUUID(),
    ...monitor.key,
    fromState: last?.toState ?? null,
    toState: evaluation.state,
    reason: evaluation.reason,
    at: now,
  };
  await state.appendTransition(transition);
  await recordAudit(audit, {
    id: randomUUID(),
    tenantId: monitor.key.tenantId,
    occurredAt: now,
    actor: { id: 'system:source-health', type: 'service' },
    action: 'source.health.changed',
    resource: { type: 'source', id: `${monitor.key.sourceId}/${monitor.key.dataset}` },
    outcome: 'succeeded',
    correlationId: randomUUID(),
    reason: evaluation.reason,
    metadata: { from: transition.fromState ?? 'none', to: transition.toState },
  });
}

/** Ventana de la medición de actividad y frecuencia máxima con que se repite. */
export const ACTIVITY_WINDOW_HOURS = 24;
export const ACTIVITY_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Mide la actividad por stream de la fuente y la guarda (fase 2). Informativa: nunca cambia el
 * estado de salud. Se ejecuta al terminar una pasada de ingesta, como máximo cada
 * `ACTIVITY_MIN_INTERVAL_MS`; los streams esperados que no aparecen quedan con cero eventos, así
 * un stream callado se ve en lugar de desaparecer.
 *
 * @returns `false` si no midió porque la última medición es reciente.
 */
export async function measureSourceActivity(input: {
  readonly monitor: SourceHealthMonitor;
  readonly state: IngestionStateStore;
  readonly readActivity: (query: ActivityQuery) => Promise<readonly StreamActivity[]>;
  readonly expectedStreams: readonly string[];
  readonly now: Date;
}): Promise<boolean> {
  const previous = await input.state.activity(input.monitor.key);
  const lastMeasured = previous.reduce<number>(
    (latest, record) => Math.max(latest, record.measuredAt.getTime()),
    0,
  );
  if (input.now.getTime() - lastMeasured < ACTIVITY_MIN_INTERVAL_MS) return false;
  const from = new Date(input.now.getTime() - ACTIVITY_WINDOW_HOURS * 3_600_000);
  const measured = await input.readActivity({
    sourceId: input.monitor.key.sourceId,
    dataset: input.monitor.key.dataset,
    from: from.toISOString(),
    to: input.now.toISOString(),
  });
  const byStream = new Map(measured.map((item) => [item.stream, item]));
  const streams = [...new Set([...input.expectedStreams, ...byStream.keys()])];
  const known = new Map(previous.map((record) => [record.stream, record]));
  await input.state.saveActivity(
    input.monitor.key,
    streams.map((stream) => {
      const item = byStream.get(stream);
      return {
        stream,
        // Sin eventos en la ventana se conserva el último evento conocido, si lo hubo.
        lastEventAt: item?.lastEventAt
          ? new Date(item.lastEventAt)
          : (known.get(stream)?.lastEventAt ?? null),
        eventsInWindow: item?.count ?? 0,
        windowHours: ACTIVITY_WINDOW_HOURS,
        measuredAt: input.now,
      };
    }),
  );
  return true;
}
