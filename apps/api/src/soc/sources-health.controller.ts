/**
 * Sprint 5 · fase 2 — `GET /api/sources/health`: salud por fuente.
 *
 * Exige `sources.health.read` (lead, auditor, admin). Evalúa con la hora actual sobre las
 * observaciones de poll, así una fuente cuya ingesta dejó de correr se ve degradada o caída
 * aunque nadie haya escrito una transición. Devuelve además las últimas transiciones de la
 * bitácora append-only.
 *
 * `subscriptions` es la actividad medida por suscripción de Office 365 en las últimas 24 h
 * (cuándo fue el último evento y cuántos hubo). Es informativa: un stream callado puede ser
 * normal y no decide el estado. `null` si todavía no hubo medición.
 */

import { Controller, Get, Inject, Req } from '@nestjs/common';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import { evaluateMonitor } from '../runtime/source-health.js';
import { readingActor } from './session-actor.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

/** Transiciones recientes por fuente en la respuesta. */
const TRANSITIONS_SHOWN = 20;

const iso = (value: Date | null) => value?.toISOString() ?? null;

@Controller('api/sources')
export class SourcesHealthController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('health')
  public async health(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('sources.health.read')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const monitor = this.runtime.sourceHealth;
    // Una fuente de otro tenant no existe para este lector.
    if (!monitor || monitor.key.tenantId !== actor.tenantId) {
      return { correlationId, checkedAt: this.runtime.now().toISOString(), sources: [] };
    }
    const now = this.runtime.now();
    const state = this.runtime.soc.ingestion;
    const [evaluation, transitions, activity] = await Promise.all([
      evaluateMonitor(monitor, state, now),
      state.recentTransitions(monitor.key, TRANSITIONS_SHOWN),
      monitor.enabled ? state.activity(monitor.key) : Promise.resolve([]),
    ]);
    const measuredAt = activity.reduce<Date | null>(
      (latest, record) => (!latest || record.measuredAt > latest ? record.measuredAt : latest),
      null,
    );
    return {
      correlationId,
      checkedAt: now.toISOString(),
      sources: [
        {
          sourceId: monitor.key.sourceId,
          dataset: monitor.key.dataset,
          displayName: monitor.displayName,
          enabled: monitor.enabled,
          state: evaluation.state,
          reason: evaluation.reason,
          lastAttemptAt: iso(evaluation.lastAttemptAt),
          lastSuccessAt: iso(evaluation.lastSuccessAt),
          lastEventAt: iso(evaluation.lastEventAt),
          consecutiveFailures: evaluation.consecutiveFailures,
          lastErrorClass: evaluation.lastErrorClass,
          policy: {
            intervalMs: monitor.policy.intervalMs,
            degradeAfterMs: monitor.policy.degradeAfterIntervals * monitor.policy.intervalMs,
            failAfterMs: monitor.policy.failAfterIntervals * monitor.policy.intervalMs,
          },
          subscriptions: measuredAt
            ? {
                measuredAt: measuredAt.toISOString(),
                windowHours: activity[0]!.windowHours,
                items: activity.map((record) => ({
                  stream: record.stream,
                  lastEventAt: iso(record.lastEventAt),
                  eventsInWindow: record.eventsInWindow,
                })),
              }
            : null,
          transitions: transitions.map((transition) => ({
            id: transition.id,
            fromState: transition.fromState,
            toState: transition.toState,
            reason: transition.reason,
            at: transition.at.toISOString(),
          })),
        },
      ],
    };
  }
}
