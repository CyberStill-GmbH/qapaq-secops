/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { Priority } from './api_contract';
import { PRIORITIES } from './api_contract';
import type { HealthTone } from './catalog';
import {
  AI_ACTION_KIND_LABEL,
  AI_ACTION_KINDS,
  AI_ACTION_REF_KINDS,
  AI_ACTION_STATES,
  AI_INFERENCE_TIERS,
  AI_MODE_NAME,
  AI_RUN_STATUSES,
  AiActionKind,
  AiActionRefKind,
  AiActionState,
  AiInference,
  AiRunStatusView,
  parseMode,
} from './ai_investigations';

/**
 * Panel «Actividad» del Analista IA (`GET /api/ai-investigations/activity`): cómo está actuando
 * ahora. Mismas reglas que `ai_investigations.ts`: un número ausente queda `null` («Sin dato»,
 * nunca 0), un enum desconocido queda `unknown` y el costo es siempre una estimación.
 *
 * El estado del host es el del proceso API que respondió (en memoria); los conteos de «hoy» usan
 * el día de Lima en curso (`today.from`–`today.to`).
 */

export interface AiActivityHost {
  /** Habilitado en el despliegue (`QAPAQ_ANALYST_ENABLED`). */
  readonly enabled: boolean | null;
  /** Bucles en marcha en el proceso que respondió. */
  readonly running: boolean | null;
  /** Ajustes de la consola: `false` = pausado en «Configuración». */
  readonly settingsEnabled: boolean | null;
  readonly mode: string | null;
  readonly lastTickAt: string | null;
  readonly lastProcessedAt: string | null;
  readonly inFlight: number | null;
  readonly concurrency: number | null;
  readonly lastErrorCode: string | null;
}

export interface AiActivityQueue {
  readonly queued: number | null;
  readonly running: number | null;
  readonly oldestQueuedAt: string | null;
  readonly byPriority: Readonly<Record<Priority, number | null>>;
}

export interface AiActivityToday {
  /** Día de Lima `AAAA-MM-DD` y su ventana UTC. */
  readonly day: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly runs: number | null;
  readonly withoutInference: number | null;
  readonly economy: number | null;
  readonly advanced: number | null;
  readonly escalated: number | null;
  readonly incidentsCreated: number | null;
  readonly incidentsAttached: number | null;
  readonly closedBenign: number | null;
  readonly acknowledged: number | null;
  readonly reviewRequested: number | null;
  readonly reviewImmediate: number | null;
  readonly reviewDigest: number | null;
  readonly failed: number | null;
  readonly estimatedMicroUsd: number | null;
}

export interface AiActivityBacklog {
  readonly openAlertsWithoutCaseFile: number | null;
  readonly openIncidentsWithoutCaseFile: number | null;
}

export const AI_FEED_KINDS = ['run_started', 'run_finished', 'action'] as const;
export type AiFeedKind = (typeof AI_FEED_KINDS)[number];

export interface AiActivityFeedItem {
  /** Clave estable para la lista (instante + trabajo + tipo + acción). */
  readonly key: string;
  readonly at: string;
  readonly jobId: string;
  readonly priority: Priority | null;
  readonly subjectTitle: string;
  readonly kind: AiFeedKind | 'unknown';
  readonly status: AiRunStatusView | null;
  readonly inference: AiInference | 'unknown' | null;
  readonly actionKind: AiActionKind | 'unknown' | null;
  readonly actionState: AiActionState | 'unknown' | null;
  readonly reason: string | null;
  readonly urgency: 'immediate' | 'digest' | null;
  readonly disposition: 'created' | 'attached' | null;
  readonly ref: { readonly kind: AiActionRefKind | 'unknown'; readonly id: string } | null;
}

export interface AiActivity {
  readonly host: AiActivityHost;
  readonly queue: AiActivityQueue;
  readonly today: AiActivityToday;
  readonly backlog: AiActivityBacklog;
  readonly feed: readonly AiActivityFeedItem[];
}

export const AI_ACTIVITY_FEED_MAX = 50;

// ------------------------------------------------------------------ Normalizador

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Bag)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function enumOrUnknown<T extends string>(allowed: readonly T[], value: unknown): T | 'unknown' | null {
  if (value === null || value === undefined) return null;
  return oneOf(allowed, value) ?? 'unknown';
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value, 64);
  if (!raw) return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;

function code(value: unknown): string | null {
  const raw = text(value, 64);
  return raw && CODE.test(raw) ? raw : null;
}

function normalizeFeedItem(raw: unknown): AiActivityFeedItem | null {
  const value = bag(raw);
  if (!value) return null;
  const at = isoOrNull(value.at);
  const jobId = text(value.jobId, 128);
  if (!at || !jobId) return null;
  const kind = oneOf(AI_FEED_KINDS, value.kind) ?? 'unknown';
  const ref = bag(value.ref);
  const refId = ref ? text(ref.id, 200) : null;
  const actionKind = enumOrUnknown(AI_ACTION_KINDS, value.actionKind);
  return {
    key: `${at}|${jobId}|${kind}|${text(value.actionKind, 64) ?? ''}`,
    at,
    jobId,
    priority: oneOf(PRIORITIES, value.priority),
    subjectTitle: text(value.subjectTitle, 500) ?? '',
    kind,
    status: enumOrUnknown(AI_RUN_STATUSES, value.status),
    inference: enumOrUnknown(AI_INFERENCE_TIERS, value.inference),
    actionKind,
    actionState: enumOrUnknown(AI_ACTION_STATES, value.actionState),
    reason: code(value.reason),
    urgency: oneOf(['immediate', 'digest'] as const, value.urgency),
    disposition: oneOf(['created', 'attached'] as const, value.disposition),
    ref:
      ref && refId ? { kind: oneOf(AI_ACTION_REF_KINDS, ref.kind) ?? 'unknown', id: refId } : null,
  };
}

/** `null`: la respuesta no tiene la forma del panel (dependencia degradada). */
export function normalizeActivity(raw: unknown): AiActivity | null {
  const value = bag(raw);
  if (!value) return null;
  const host = bag(value.host);
  const queue = bag(value.queue);
  const today = bag(value.today);
  if (!host && !queue && !today) return null;
  const h = host ?? {};
  const q = queue ?? {};
  const t = today ?? {};
  const byPriority = bag(q.byPriority) ?? {};
  const backlog = bag(value.backlog) ?? {};
  const feed: AiActivityFeedItem[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value.feed) ? value.feed.slice(0, AI_ACTIVITY_FEED_MAX) : []) {
    const parsed = normalizeFeedItem(item);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    feed.push(parsed);
  }
  return {
    host: {
      enabled: flag(h.enabled),
      running: flag(h.running),
      settingsEnabled: flag(h.settingsEnabled),
      mode: text(h.mode, 32),
      lastTickAt: isoOrNull(h.lastTickAt),
      lastProcessedAt: isoOrNull(h.lastProcessedAt),
      inFlight: count(h.inFlight),
      concurrency: count(h.concurrency),
      lastErrorCode: code(h.lastErrorCode),
    },
    queue: {
      queued: count(q.queued),
      running: count(q.running),
      oldestQueuedAt: isoOrNull(q.oldestQueuedAt),
      byPriority: {
        P1: count(byPriority.P1),
        P2: count(byPriority.P2),
        P3: count(byPriority.P3),
        P4: count(byPriority.P4),
      },
    },
    today: {
      day: text(t.day, 32),
      from: isoOrNull(t.from),
      to: isoOrNull(t.to),
      runs: count(t.runs),
      withoutInference: count(t.withoutInference),
      economy: count(t.economy),
      advanced: count(t.advanced),
      escalated: count(t.escalated),
      incidentsCreated: count(t.incidentsCreated),
      incidentsAttached: count(t.incidentsAttached),
      closedBenign: count(t.closedBenign),
      acknowledged: count(t.acknowledged),
      reviewRequested: count(t.reviewRequested),
      reviewImmediate: count(t.reviewImmediate),
      reviewDigest: count(t.reviewDigest),
      failed: count(t.failed),
      estimatedMicroUsd: count(t.estimatedMicroUsd),
    },
    backlog: {
      openAlertsWithoutCaseFile: count(backlog.openAlertsWithoutCaseFile),
      openIncidentsWithoutCaseFile: count(backlog.openIncidentsWithoutCaseFile),
    },
    feed,
  };
}

// ------------------------------------------------------------------ Estado del analista

export interface AiHostState {
  readonly state: 'active' | 'off' | 'stopped' | 'unknown';
  readonly label: string;
  /** Por qué no está activo, o el modo cuando sí. */
  readonly detail: string | null;
  readonly tone: HealthTone;
  /** Punto que late: solo con los bucles en marcha. */
  readonly pulsing: boolean;
}

/** Estado legible del analista; nunca supone lo que el backend no dijo. */
export function hostState(host: AiActivityHost): AiHostState {
  if (host.enabled === false) {
    return {
      state: 'off',
      label: 'Apagado',
      detail: 'El despliegue no habilita el analista en este entorno.',
      tone: 'neutral',
      pulsing: false,
    };
  }
  if (host.running === false) {
    return {
      state: 'stopped',
      label: 'Detenido',
      detail: 'El proceso que respondió no tiene el analista en marcha (arranque o apagado).',
      tone: 'warn',
      pulsing: false,
    };
  }
  if (host.running === true && host.settingsEnabled === false) {
    return {
      state: 'stopped',
      label: 'Detenido',
      detail: 'Pausado en «Configuración»: no toma alertas nuevas.',
      tone: 'neutral',
      pulsing: false,
    };
  }
  if (host.running === true) {
    const mode = parseMode(host.mode);
    return {
      state: 'active',
      label: 'Activo',
      detail: mode ? `modo ${AI_MODE_NAME[mode]}` : 'modo sin dato',
      tone: 'ok',
      pulsing: true,
    };
  }
  return {
    state: 'unknown',
    label: 'Estado desconocido',
    detail: 'El servicio no informó si el analista está en marcha.',
    tone: 'neutral',
    pulsing: false,
  };
}

/** Porción de las investigaciones de hoy resueltas sin modelo; `null` si no se puede calcular. */
export function todayShareWithoutInference(today: AiActivityToday): number | null {
  const { runs, withoutInference } = today;
  if (runs === null || withoutInference === null || runs <= 0 || withoutInference > runs) return null;
  return withoutInference / runs;
}

// ------------------------------------------------------------------ Feed

/** Motivo determinista en forma breve para la frase del feed. */
export const AI_FEED_REASON_SHORT: Record<string, string> = {
  KNOWN_BENIGN_PATTERN: 'patrón benigno conocido',
  DUPLICATE_OF_OPEN_INCIDENT: 'duplica un incidente abierto',
  ISOLATED_LOW_SIGNAL: 'señal aislada de baja relevancia',
  EVIDENCE_INCOMPLETE: 'evidencia incompleta',
  NOT_ELIGIBLE: 'no elegible para análisis con modelo',
  OUT_OF_SCOPE: 'fuera del alcance configurado',
  BELOW_INFERENCE_PRIORITY: 'prioridad por debajo del umbral de IA',
};

const FINISHED_SENTENCE: Record<AiRunStatusView, string> = {
  queued: 'Volvió a la cola',
  running: 'Sigue investigando',
  completed: 'Terminó la investigación',
  requires_review: 'Terminó: requiere revisión humana',
  partial: 'Terminó con evidencia incompleta',
  budget_exhausted: 'Se detuvo: presupuesto diario de IA agotado',
  usage_unreconciled: 'Terminó con uso del modelo por conciliar',
  cancelled: 'Investigación detenida',
  failed: 'La investigación falló',
  unknown: 'Terminó (estado desconocido)',
};

const INFERENCE_NAME: Record<string, string> = { economy: 'modelo económico', advanced: 'modelo avanzado' };

export interface AiFeedSentence {
  readonly text: string;
  /** Código sin rótulo propio (se muestra en mono junto a la frase). */
  readonly code: string | null;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Frase corta en español a partir de los campos estructurados (sin texto del modelo). */
export function feedSentence(item: AiActivityFeedItem): AiFeedSentence {
  if (item.kind === 'run_started') return { text: 'Empezó a investigar', code: null };
  if (item.kind === 'run_finished') {
    const status = item.status ?? 'unknown';
    if (status === 'completed' && item.inference === 'none') {
      const short = item.reason ? AI_FEED_REASON_SHORT[item.reason] : undefined;
      if (short) return { text: `Resolvió sin IA: ${short}`, code: null };
      return { text: 'Resolvió sin IA', code: item.reason };
    }
    if (status === 'completed' && item.inference && INFERENCE_NAME[item.inference]) {
      return { text: `Terminó la investigación con ${INFERENCE_NAME[item.inference]}`, code: null };
    }
    const failed = status === 'failed' || status === 'usage_unreconciled';
    return { text: FINISHED_SENTENCE[status], code: failed ? item.reason : null };
  }
  if (item.kind === 'action') {
    const kind = item.actionKind ?? 'unknown';
    const label = lowerFirst(AI_ACTION_KIND_LABEL[kind]);
    switch (item.actionState) {
      case 'executed':
        switch (kind) {
          case 'escalate':
            return {
              text:
                item.disposition === 'created'
                  ? 'Escaló a incidente nuevo'
                  : item.disposition === 'attached'
                    ? 'Adjuntó a incidente existente'
                    : 'Escaló a incidente',
              code: null,
            };
          case 'close_benign':
            return { text: 'Cerró como benigno conocido', code: null };
          case 'acknowledge':
            return { text: 'Reconoció la alerta', code: null };
          case 'request_review':
            return {
              text:
                item.urgency === 'immediate'
                  ? 'Pidió revisión humana (inmediata)'
                  : item.urgency === 'digest'
                    ? 'Pidió revisión humana (en el resumen)'
                    : 'Pidió revisión humana',
              code: null,
            };
          case 'report':
            return { text: 'Adjuntó el informe', code: null };
          default:
            return { text: 'Ejecutó una acción desconocida', code: null };
        }
      case 'failed':
        return { text: `Falló al ${label}`, code: null };
      case 'skipped':
        return { text: `Omitió ${label}`, code: item.reason };
      case 'planned':
        return { text: `Propuso ${label}`, code: null };
      default:
        return { text: `${AI_ACTION_KIND_LABEL[kind]} (estado desconocido)`, code: null };
    }
  }
  return { text: 'Actividad no reconocida por esta consola', code: null };
}
