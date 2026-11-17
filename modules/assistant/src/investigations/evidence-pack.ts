/**
 * Analista IA — paquete de evidencia compacto para el prompt (puro).
 *
 * Proyección por allowlist: cada objeto se construye campo por campo, de modo que un campo no
 * previsto del lector (cuerpo crudo, `full_log`, claves de entidad) no puede llegar al modelo.
 * Lleva IDs, tiempos, conteos, señales del correlador y pocos ejemplares por categoría; lo que
 * se omite queda contado en `omitted` y marcado con `truncated`, nunca en silencio.
 */

import { createHash } from 'node:crypto';

import type { Citation } from '../ports.js';
import { Pseudonymizer } from '../pseudonymizer.js';
import type { EvidenceAlert, EvidenceBundle } from './types.js';

export interface EvidencePackConfig {
  /** Presupuesto de tokens estimados para el texto del paquete. */
  readonly maxInputTokens: number;
  readonly maxAlerts: number;
  readonly maxRelatedAlerts: number;
  readonly maxEvents: number;
  readonly maxSources: number;
  readonly maxListItems: number;
  readonly maxTitleChars: number;
  readonly maxExplanationChars: number;
  /** Divisor conservador para estimar tokens a partir de caracteres. */
  readonly charsPerToken: number;
}

export const EVIDENCE_PACK_DEFAULTS: EvidencePackConfig = Object.freeze({
  maxInputTokens: 3_000,
  maxAlerts: 20,
  maxRelatedAlerts: 20,
  maxEvents: 40,
  maxSources: 12,
  maxListItems: 10,
  maxTitleChars: 120,
  maxExplanationChars: 300,
  charsPerToken: 3.5,
});

export interface EvidencePack {
  /** JSON compacto y seudonimizado. */
  readonly text: string;
  /** IDs citables tal como aparecen en `text`. */
  readonly citableIds: ReadonlySet<string>;
  /** Catálogo de los IDs citables (con el ID real) para armar las citas del expediente. */
  readonly citations: ReadonlyMap<string, Citation>;
  readonly estimatedInputTokens: number;
  /** Se omitieron ejemplares o campos (por tope o por presupuesto). */
  readonly truncated: boolean;
  readonly omitted: {
    readonly alerts: number;
    readonly relatedAlerts: number;
    readonly events: number;
    readonly sources: number;
  };
}

/** Estimación conservadora: caracteres / 3,5, hacia arriba. */
export function estimateTokens(text: string, charsPerToken = 3.5): number {
  return Math.ceil(text.length / charsPerToken);
}

/** Texto de terceros en una línea, sin caracteres de control, recortado. */
function clean(text: string, max: number): string {
  const flat = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

const ID_MAX = 128;
const short = (value: string | null | undefined, max = 80): string | null =>
  value === null || value === undefined ? null : clean(String(value), max);
const list = (values: readonly string[] | undefined, max: number): string[] =>
  (values ?? []).slice(0, max).map((value) => clean(String(value), 80));
/** Top 12 de un conteo, valores saneados (los agregados son baratos y no se recortan por tokens). */
const counts = (values: readonly { value: string; count: number }[]) =>
  values.slice(0, 12).map((entry) => ({ value: clean(entry.value, 60), count: entry.count }));

function alertView(alert: EvidenceAlert, config: EvidencePackConfig, withTitle: boolean) {
  return {
    id: clean(alert.id, ID_MAX),
    ...(withTitle ? { title: clean(alert.title, config.maxTitleChars) } : {}),
    priority: alert.priority,
    status: short(alert.status, 24),
    ruleId: short(alert.ruleId),
    signal: short(alert.signal),
    score: Number.isFinite(alert.score) ? alert.score : 0,
    reasons: list(alert.reasonCodes, config.maxListItems),
    at: short(alert.occurredAt, 40),
    entities: list(alert.entityRefs, config.maxListItems),
    verdict: short(alert.verdict, 24),
    related: list(alert.relatedAlertIds, config.maxListItems),
    incidentId: short(alert.incidentId, ID_MAX),
    source: short(alert.source, 40),
  };
}

/**
 * Arma el paquete y lo reduce (eventos → relacionadas → alertas → títulos y explicación) hasta
 * caber en `maxInputTokens`. Si ni el mínimo cabe, lo devuelve igual con `truncated: true`: quien
 * llama compara `estimatedInputTokens` con su límite y no despacha.
 */
export function buildEvidencePack(
  bundle: EvidenceBundle,
  options: {
    readonly pseudonymizer?: Pseudonymizer;
    readonly config?: Partial<EvidencePackConfig>;
  } = {},
): EvidencePack {
  const config: EvidencePackConfig = { ...EVIDENCE_PACK_DEFAULTS, ...options.config };
  const pseudonymizer = options.pseudonymizer ?? new Pseudonymizer(true);
  const caps = {
    alerts: Math.min(config.maxAlerts, bundle.alerts.length),
    related: Math.min(config.maxRelatedAlerts, bundle.relatedAlerts.length),
    events: Math.min(config.maxEvents, bundle.events.length),
    sources: Math.min(config.maxSources, bundle.sourceHealth.length),
    /** Contexto ampliado: 2 = completo, 1 = listas cortas, 0 = omitido (antes que alertas). */
    context: bundle.context ? 2 : 0,
    text: true,
  };

  const render = () => {
    const alerts = bundle.alerts.slice(0, caps.alerts);
    const related = bundle.relatedAlerts.slice(0, caps.related);
    const events = bundle.events.slice(0, caps.events);
    const sources = bundle.sourceHealth.slice(0, caps.sources);
    const omitted = {
      alerts: bundle.alerts.length - alerts.length,
      relatedAlerts: bundle.relatedAlerts.length - related.length,
      events: bundle.events.length - events.length,
      sources: bundle.sourceHealth.length - sources.length,
    };
    const candidate = bundle.candidate;
    const context = bundle.context ?? null;
    const contextLists = caps.context >= 2 ? config.maxListItems : 2;
    const truncated =
      !caps.text ||
      Object.values(omitted).some((count) => count > 0) ||
      (context !== null && caps.context < 2);
    const pack = {
      v: 1,
      watermark: clean(bundle.watermark, ID_MAX),
      completeness: {
        complete: bundle.completeness.complete === true,
        truncated: bundle.completeness.truncated === true,
        alertsScanned: bundle.completeness.alertsScanned,
        eventsScanned: bundle.completeness.eventsScanned,
        gaps: bundle.completeness.gaps.slice(0, config.maxListItems).map((gap) => clean(gap, 160)),
      },
      alerts: alerts.map((alert) => alertView(alert, config, caps.text)),
      relatedAlerts: related.map((alert) => alertView(alert, config, false)),
      candidate: candidate
        ? {
            id: clean(candidate.id, ID_MAX),
            patternId: short(candidate.patternId),
            score: candidate.score,
            riskScore: candidate.riskScore,
            memberCount: candidate.memberCount,
            sources: list(candidate.sources, config.maxListItems),
            tactics: list(candidate.tactics, config.maxListItems),
            stages: list(candidate.stages, config.maxListItems),
            ...(caps.text
              ? { explanation: clean(candidate.explanation, config.maxExplanationChars) }
              : {}),
          }
        : null,
      history30d: {
        total: bundle.history.total,
        falsePositive: bundle.history.falsePositive,
        truePositive: bundle.history.truePositive,
        open: bundle.history.open,
      },
      events: events.map((event) => ({
        id: clean(event.id, ID_MAX),
        at: short(event.occurredAt, 40),
        source: short(event.source, 40),
        category: short(event.category),
        action: short(event.action),
        outcome: short(event.outcome, 40),
        entities: list(event.entityRefs, config.maxListItems),
      })),
      // Agregados de TODOS los eventos leídos: la muestra de arriba nunca oculta volumen.
      eventSummary: bundle.eventSummary
        ? {
            window: {
              from: short(bundle.eventSummary.window.from, 40),
              to: short(bundle.eventSummary.window.to, 40),
              scanned: bundle.eventSummary.window.scanned,
              matching: bundle.eventSummary.window.matching,
            },
            day: bundle.eventSummary.day,
            entityScoped: bundle.eventSummary.entityScoped,
            firstAt: short(bundle.eventSummary.firstAt, 40),
            lastAt: short(bundle.eventSummary.lastAt, 40),
            bySource: counts(bundle.eventSummary.bySource),
            byAction: counts(bundle.eventSummary.byAction),
            byOutcome: counts(bundle.eventSummary.byOutcome),
            byCategory: counts(bundle.eventSummary.byCategory),
            sampled: { shown: events.length, kept: bundle.events.length },
          }
        : null,
      sources: sources.map((source) => ({
        id: clean(source.id, ID_MAX),
        label: clean(source.label, 60),
        state: short(source.state, 24),
        fresh: source.fresh === true,
      })),
      // Proyección por allowlist del contexto ampliado (nunca notas ni metadatos libres).
      context:
        context && caps.context > 0
          ? {
              rule: context.rule
                ? {
                    id: clean(context.rule.id, 64),
                    level: context.rule.level,
                    ...(caps.text ? { description: clean(context.rule.description, 160) } : {}),
                    mitre: context.rule.mitre.slice(0, contextLists).map((technique) => ({
                      id: clean(technique.id, 24),
                      name: clean(technique.name, 60),
                      tactics: list(technique.tactics, 4),
                    })),
                    runbooks: list(context.rule.runbooks, contextLists),
                    knownFalsePositives: context.rule.knownFalsePositives
                      .slice(0, caps.text ? contextLists : 0)
                      .map((entry) => clean(entry, 240)),
                    escalateWhen: (context.rule.escalateWhen ?? [])
                      .slice(0, caps.text ? contextLists : 0)
                      .map((entry) => clean(entry, 240)),
                    priorityHint: short(context.rule.priorityHint ?? null, 8),
                  }
                : null,
              incidents: context.incidents.slice(0, contextLists).map((incident) => ({
                id: clean(incident.id, ID_MAX),
                ...(caps.text ? { title: clean(incident.title, config.maxTitleChars) } : {}),
                status: short(incident.status, 24),
                severity: short(incident.severity, 24),
                alerts: incident.alertCount,
                tasks: incident.taskCount,
                notes: incident.noteCount,
                openedAt: short(incident.openedAt, 40),
              })),
              entityRisk: context.entityRisk
                ? {
                    entity: clean(context.entityRisk.entityRef, ID_MAX),
                    score: context.entityRisk.score,
                    peak: context.entityRisk.peak,
                    observations: context.entityRisk.observations,
                    tactics: list(context.entityRisk.tactics, contextLists),
                    sources: list(context.entityRisk.sources, contextLists),
                  }
                : null,
              activity: context.activity
                ? {
                    entity: clean(context.activity.entityRef, ID_MAX),
                    alerts7d: context.activity.alerts7d,
                    events24h: context.activity.events24h,
                    eventsScanned: context.activity.eventsScanned,
                    complete: context.activity.complete === true,
                  }
                : null,
              notifications: context.notifications.slice(0, contextLists).map((entry) => ({
                status: short(entry.status, 24),
                channel: short(entry.channel, 24),
                at: short(entry.at, 40),
              })),
              audit: context.audit.slice(0, contextLists).map((entry) => ({
                action: short(entry.action, 64),
                outcome: short(entry.outcome, 16),
                actor: short(entry.actorType, 16),
                at: short(entry.at, 40),
              })),
            }
          : null,
      omitted,
      truncated,
    };
    const masked = pseudonymizer.maskJson(pack) as typeof pack;
    const citations = new Map<string, Citation>();
    const add = (kind: Citation['kind'], shown: string, real: string, label: string) => {
      if (shown.length > 0 && !citations.has(shown))
        citations.set(shown, { kind, id: real, label });
    };
    masked.alerts.forEach((view, index) =>
      add('alert', view.id, alerts[index]!.id, clean(alerts[index]!.title, 80)),
    );
    masked.relatedAlerts.forEach((view, index) =>
      add('alert', view.id, related[index]!.id, clean(related[index]!.title, 80)),
    );
    masked.alerts.forEach((view, index) => {
      const real = alerts[index]!.incidentId;
      if (view.incidentId && real) add('incident', view.incidentId, real, `Incidente ${real}`);
    });
    if (masked.candidate && candidate) {
      add('alert', masked.candidate.id, candidate.id, `Candidato ${candidate.patternId}`);
    }
    masked.events.forEach((view, index) =>
      add('event', view.id, events[index]!.id, `Evento ${events[index]!.source}`),
    );
    masked.sources.forEach((view, index) =>
      add('source', view.id, sources[index]!.id, clean(sources[index]!.label, 80)),
    );
    if (masked.context && context) {
      masked.context.incidents.forEach((view, index) => {
        const real = context.incidents[index]!;
        add('incident', view.id, real.id, `Incidente ${clean(real.title, 60)}`);
      });
    }
    const text = JSON.stringify(masked);
    return { text, citations, omitted, truncated };
  };

  let current = render();
  const over = () => estimateTokens(current.text, config.charsPerToken) > config.maxInputTokens;
  while (over()) {
    if (caps.events > 0) caps.events -= 1;
    else if (caps.related > 0) caps.related -= 1;
    else if (caps.context > 0) caps.context -= 1;
    else if (caps.alerts > 1) caps.alerts -= 1;
    else if (caps.sources > 0) caps.sources -= 1;
    else if (caps.text) caps.text = false;
    else break;
    current = render();
  }

  return {
    text: current.text,
    citableIds: new Set(current.citations.keys()),
    citations: current.citations,
    estimatedInputTokens: estimateTokens(current.text, config.charsPerToken),
    truncated: current.truncated,
    omitted: current.omitted,
  };
}

/**
 * Huella estable de la evidencia: tenant + alertas (ordenadas, sin duplicados) + watermark +
 * versión de política. La misma huella nunca se factura dos veces.
 */
export function fingerprintOf(
  tenantId: string,
  alertIds: readonly string[],
  watermark: string,
  policyVersion: string,
): string {
  const canonical = JSON.stringify([
    'qapaq-investigation-fingerprint/v1',
    tenantId,
    [...new Set(alertIds)].sort(),
    watermark,
    policyVersion,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
