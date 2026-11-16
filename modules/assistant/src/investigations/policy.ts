/**
 * Analista IA — política determinista de triaje (pura y versionada).
 *
 * Decide, SIN modelo, si un trabajo se resuelve con reglas o si merece una inferencia y de qué
 * nivel. Solo lee campos estructurados (prioridad, conteos, fuentes, tácticas, historial,
 * cobertura): el título u otro texto de la alerta no puede cambiar el nivel ni el presupuesto.
 *
 * Nada aquí cierra, suprime ni rebaja una alerta: un patrón benigno conocido produce
 * `likely_false_positive` en `requires_review`, y nunca se aplica a P1.
 */

import type { Citation } from '../ports.js';
import { assessEvidence } from './assessment.js';
import type {
  EvidenceBundle,
  InferenceTier,
  InvestigationConfidence,
  InvestigationPriority,
  InvestigationResult,
  InvestigationSubject,
  InvestigationVerdict,
} from './types.js';

/** Cambiar umbrales, razones o el prompt exige una versión nueva. */
// 2026-11-14.1: el paquete incluye el contexto ampliado del SOC (`EvidenceBundle.context`).
// 2026-11-15.2: el expediente determinista concluye con la valoración por reglas (assessment.ts).
// 2026-11-15.3: explicación por dominio (vulnerabilidad, plataforma, FIM, rootcheck) y datos del evento.
// 2026-11-15.4: unos pocos eventos sin normalizar ya no vuelven parcial la evidencia.
export const POLICY_VERSION = 'qapaq-analyst-2026-11-15.4';

export interface TriageConfig {
  /** Cierres `false_positive` de la misma regla+entidad (30 d) para considerar el patrón benigno. */
  readonly knownBenignMinFalsePositives: number;
  /** Fuentes o tácticas distintas que vuelven ambiguo un P2. */
  readonly ambiguousMinSources: number;
  readonly ambiguousMinTactics: number;
  /** Estados de fuente que invalidan la cobertura (además de `fresh: false`). */
  readonly unhealthySourceStates: readonly string[];
  /** Tope de tokens de salida por nivel (el runner aplica además su límite global). */
  readonly maxOutputTokens: Readonly<Record<InferenceTier, number>>;
}

export const TRIAGE_CONFIG: TriageConfig = Object.freeze({
  knownBenignMinFalsePositives: 5,
  ambiguousMinSources: 2,
  ambiguousMinTactics: 2,
  unhealthySourceStates: Object.freeze(['degraded', 'failed', 'unknown']),
  maxOutputTokens: Object.freeze({ economy: 700, advanced: 1200 }),
});

export const TRIAGE_REASON_CODES = [
  'NOT_ELIGIBLE',
  'ISOLATED_LOW_SIGNAL',
  'DUPLICATE_OF_OPEN_INCIDENT',
  'EVIDENCE_INCOMPLETE',
  'KNOWN_BENIGN_PATTERN',
  'P1_ALWAYS_ANALYZED',
  'P2_ROUTINE',
  'P2_MULTI_SOURCE',
  'P2_MULTI_TACTIC',
  'P2_CONTRADICTORY_HISTORY',
  'P3_CORRELATED',
  'OUT_OF_SCOPE',
  'BELOW_INFERENCE_PRIORITY',
] as const;
export type TriageReasonCode = (typeof TRIAGE_REASON_CODES)[number];

/** Códigos que agrega el runner a `result.deterministic.reasons`. */
export const RUNNER_REASON_CODES = [
  'INFERENCE_DISABLED',
  'MODEL_UNAVAILABLE',
  'TIER_DOWNGRADED',
  'EVIDENCE_PACK_OVER_BUDGET',
  'REUSED_PRIOR_RESULT',
  'PRIOR_INFERENCE_SETTLED',
  'DAILY_CAP',
  'RUN_CAP',
  'USAGE_UNRECONCILED',
  'MODEL_REFUSED',
  'INVALID_MODEL_OUTPUT',
  'UNVERIFIED_OUTPUT',
  'ANALYST_DISABLED',
] as const;
export type RunnerReasonCode = (typeof RUNNER_REASON_CODES)[number];

export interface TriageInput {
  readonly priority: InvestigationPriority;
  readonly bundle: EvidenceBundle;
  /** Alcance fijado por el administrador (`AnalystSettings.scope`). Sin él, todo es elegible. */
  readonly scope?: {
    readonly priorities: readonly InvestigationPriority[];
    readonly inferenceMinPriority: InvestigationPriority;
  };
}

export interface TriageDecision {
  readonly decision: 'deterministic' | 'infer';
  /** Solo con `decision: 'infer'`. */
  readonly tier?: InferenceTier;
  readonly reasons: readonly TriageReasonCode[];
  /** 0 cuando no hay inferencia. */
  readonly maxOutputTokens: number;
  /** La evidencia está incompleta: el estado final no puede ser `completed`. */
  readonly partial: boolean;
  /** Estado final del expediente determinista (también el respaldo si la inferencia no ocurre). */
  readonly status: 'completed' | 'requires_review' | 'partial';
  readonly verdict: InvestigationVerdict;
  readonly confidence: InvestigationConfidence;
}

function distinct(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function isCorrelatedEvidence(bundle: EvidenceBundle): boolean {
  return isCorrelated(bundle);
}

export function evidenceSources(bundle: EvidenceBundle): string[] {
  return distinct([
    ...bundle.alerts.map((alert) => alert.source),
    ...bundle.relatedAlerts.map((alert) => alert.source),
    ...(bundle.candidate?.sources ?? []),
  ]);
}

export function unhealthySources(bundle: EvidenceBundle, config: TriageConfig = TRIAGE_CONFIG) {
  return bundle.sourceHealth.filter(
    (source) =>
      source.state !== 'disabled' &&
      (!source.fresh || config.unhealthySourceStates.includes(source.state)),
  );
}

function isCorrelated(bundle: EvidenceBundle): boolean {
  return (
    bundle.alerts.length > 1 ||
    bundle.relatedAlerts.length > 0 ||
    bundle.alerts.some((alert) => alert.relatedAlertIds.length > 0) ||
    (bundle.candidate?.memberCount ?? 0) > 1
  );
}

/** Decisión determinista. Pura: misma entrada estructurada ⇒ misma salida. */
export function triagePolicy(
  input: TriageInput,
  config: TriageConfig = TRIAGE_CONFIG,
): TriageDecision {
  const { priority, bundle } = input;
  const deterministic = (
    reasons: readonly TriageReasonCode[],
    status: TriageDecision['status'],
    verdict: InvestigationVerdict = 'inconclusive',
    confidence: InvestigationConfidence = 'low',
  ): TriageDecision => ({
    decision: 'deterministic',
    reasons,
    maxOutputTokens: 0,
    partial: status === 'partial',
    status,
    verdict,
    confidence,
  });

  if (input.scope && !input.scope.priorities.includes(priority)) {
    return deterministic(['OUT_OF_SCOPE'], 'completed');
  }

  const { history } = bundle;
  const incomplete =
    !bundle.completeness.complete ||
    bundle.completeness.truncated ||
    bundle.alerts.length === 0 ||
    unhealthySources(bundle, config).length > 0;
  const sources = evidenceSources(bundle);
  const correlated = isCorrelated(bundle);
  const tactics = distinct([
    ...(bundle.candidate?.tactics ?? []),
    ...(bundle.context?.entityRisk?.tactics ?? []),
  ]);
  // History is scoped to the primary rule/entity, not every member of a case.
  const primary = bundle.alerts[0];
  const sameHistoricalScope =
    !!primary?.ruleId &&
    primary.entityRefs.length > 0 &&
    [...bundle.alerts, ...bundle.relatedAlerts].every(
      (alert) =>
        alert.ruleId === primary.ruleId &&
        alert.entityRefs.length === primary.entityRefs.length &&
        alert.entityRefs.every((entity) => primary.entityRefs.includes(entity)),
    );
  // Historical FP labels do not explain a new, corroborated or unresolved episode.
  const benignHistory =
    sameHistoricalScope &&
    history.truePositive === 0 &&
    history.open === 0 &&
    history.falsePositive >= config.knownBenignMinFalsePositives &&
    sources.length < config.ambiguousMinSources &&
    tactics.length < config.ambiguousMinTactics;
  // Coverage takes precedence over cheap low-priority/duplicate paths.
  if (incomplete && priority !== 'P1') return deterministic(['EVIDENCE_INCOMPLETE'], 'partial');
  /** Baja prioridad sin modelo; si además el historial es benigno y completo, lo deja dicho. */
  const lowSignal = (reason: TriageReasonCode): TriageDecision =>
    benignHistory && !incomplete
      ? deterministic(
          [reason, 'KNOWN_BENIGN_PATTERN'],
          'completed',
          'likely_false_positive',
          'medium',
        )
      : deterministic([reason], 'completed');

  if (priority === 'P4') return lowSignal('NOT_ELIGIBLE');

  if (priority === 'P3' && !correlated) {
    return lowSignal(sources.length <= 1 ? 'ISOLATED_LOW_SIGNAL' : 'NOT_ELIGIBLE');
  }

  // Ya hay personas trabajando el incidente: el expediente solo apunta a él.
  if (
    priority !== 'P1' &&
    !correlated &&
    bundle.alerts.length > 0 &&
    bundle.alerts.every((alert) => !!alert.incidentId)
  ) {
    return deterministic(['DUPLICATE_OF_OPEN_INCIDENT'], 'completed');
  }

  if (priority !== 'P1' && benignHistory) {
    // Nunca autocierre: la recomendación queda para revisión humana.
    return deterministic(
      ['KNOWN_BENIGN_PATTERN'],
      'requires_review',
      'likely_false_positive',
      'medium',
    );
  }

  // 'P1' < 'P2' < 'P3' < 'P4' en orden lexicográfico: mayor cadena, menor prioridad.
  if (input.scope && priority > input.scope.inferenceMinPriority) {
    return deterministic(['BELOW_INFERENCE_PRIORITY'], incomplete ? 'partial' : 'completed');
  }

  const reasons: TriageReasonCode[] = [];
  let tier: InferenceTier = 'economy';
  if (priority === 'P1') {
    tier = 'advanced';
    reasons.push('P1_ALWAYS_ANALYZED');
    if (incomplete) reasons.push('EVIDENCE_INCOMPLETE');
  } else if (priority === 'P2') {
    if (sources.length >= config.ambiguousMinSources) reasons.push('P2_MULTI_SOURCE');
    if (tactics.length >= config.ambiguousMinTactics) {
      reasons.push('P2_MULTI_TACTIC');
    }
    if (history.truePositive > 0 && history.falsePositive > 0) {
      reasons.push('P2_CONTRADICTORY_HISTORY');
    }
    if (reasons.length > 0) tier = 'advanced';
    else reasons.push('P2_ROUTINE');
  } else {
    reasons.push('P3_CORRELATED');
  }

  return {
    decision: 'infer',
    tier,
    reasons,
    maxOutputTokens: config.maxOutputTokens[tier],
    partial: incomplete,
    // Respaldo si la inferencia no llega a ocurrir: P1/P2/P3 correlado sin análisis ⇒ revisión.
    status: incomplete ? 'partial' : 'requires_review',
    verdict: 'inconclusive',
    confidence: 'low',
  };
}

const MAX_CITED = 12;

/**
 * Expediente determinista (sin modelo), armado solo con conteos e IDs de la evidencia. Es el
 * resultado final de la vía determinista y el respaldo cuando la inferencia no se hace.
 */
export function buildDeterministicResult(input: {
  readonly subject: InvestigationSubject;
  readonly priority: InvestigationPriority;
  readonly bundle: EvidenceBundle;
  readonly decision: TriageDecision;
  /** Códigos del runner que explican por qué no hubo inferencia. */
  readonly extraReasons?: readonly string[];
}): InvestigationResult {
  const { bundle, decision, priority } = input;
  const reasons = [...decision.reasons, ...(input.extraReasons ?? [])];
  const alertIds = bundle.alerts.slice(0, MAX_CITED).map((alert) => alert.id);
  const incidentIds = distinct(bundle.alerts.map((alert) => alert.incidentId));
  const unhealthy = unhealthySources(bundle);
  const citations: Citation[] = [
    ...bundle.alerts
      .slice(0, MAX_CITED)
      .map((alert): Citation => ({ kind: 'alert', id: alert.id, label: `Alerta ${alert.id}` })),
    ...incidentIds
      .slice(0, MAX_CITED)
      .map((id): Citation => ({ kind: 'incident', id, label: `Incidente ${id}` })),
    ...unhealthy
      .slice(0, MAX_CITED)
      .map((source): Citation => ({ kind: 'source', id: source.id, label: source.label })),
  ];

  const facts: { text: string; citations: string[] }[] = [];
  if (alertIds.length > 0) {
    facts.push({
      text: `El expediente agrupa ${bundle.alerts.length} alerta(s) de prioridad ${priority} y ${bundle.relatedAlerts.length} alerta(s) relacionada(s).`,
      citations: alertIds,
    });
    facts.push({
      text: `Historial de la misma regla y entidad en 30 días: ${bundle.history.total} en total, ${bundle.history.falsePositive} falso(s) positivo(s), ${bundle.history.truePositive} verdadero(s) positivo(s), ${bundle.history.open} abierta(s).`,
      citations: alertIds,
    });
  }
  if (incidentIds.length > 0) {
    facts.push({
      text: `Las alertas ya están unidas a incidente(s) abierto(s): ${incidentIds.join(', ')}.`,
      citations: incidentIds.slice(0, MAX_CITED),
    });
  }
  if (unhealthy.length > 0) {
    facts.push({
      text: `Fuentes sin datos frescos o con falla al leer: ${unhealthy.map((source) => source.id).join(', ')}.`,
      citations: unhealthy.slice(0, MAX_CITED).map((source) => source.id),
    });
  }

  // ── Hechos de la evidencia ampliada (conteos; nunca valores de entidad) ──────────────────
  const context = bundle.context ?? null;
  const summaryOfEvents = bundle.eventSummary ?? null;
  if (summaryOfEvents) {
    const top = (entries: readonly { value: string; count: number }[]) =>
      entries
        .slice(0, 3)
        .map((entry) => `${entry.value} (${entry.count})`)
        .join(', ');
    const parts = [
      `${summaryOfEvents.window.matching} evento(s) de la entidad en la ventana de la alerta`,
      summaryOfEvents.day ? `${summaryOfEvents.day.matching} en las últimas 24 h` : null,
    ].filter(Boolean);
    facts.push({
      text: `Eventos de origen: ${parts.join(' y ')}${
        summaryOfEvents.byAction.length > 0 ? `; acciones más frecuentes: ${top(summaryOfEvents.byAction)}` : ''
      }${summaryOfEvents.byOutcome.length > 0 ? `; resultados: ${top(summaryOfEvents.byOutcome)}` : ''}${
        summaryOfEvents.bySource.length > 0 ? `; fuentes: ${top(summaryOfEvents.bySource)}` : ''
      }.`,
      citations: alertIds.slice(0, 1),
    });
  }
  if (context?.activity) {
    facts.push({
      text: `Actividad de la entidad: ${context.activity.alerts7d} alerta(s) en 7 días.`,
      citations: alertIds.slice(0, 1),
    });
  }
  if (context?.entityRisk) {
    facts.push({
      text: `Riesgo de la entidad en el correlador: ${Math.round(context.entityRisk.score)}/100 (pico ${Math.round(context.entityRisk.peak)}, ${context.entityRisk.observations} observación(es)).`,
      citations: alertIds.slice(0, 1),
    });
  }
  if (context?.rule) {
    const mitre = context.rule.mitre.map((technique) => `${technique.id} ${technique.name}`);
    facts.push({
      text: `Regla ${context.rule.id}${context.rule.level !== null ? ` (nivel ${context.rule.level})` : ''}: ${context.rule.description}${
        mitre.length > 0 ? `. MITRE ATT&CK: ${mitre.slice(0, 3).join('; ')}` : ''
      }.`,
      citations: alertIds.slice(0, 1),
    });
  }

  // ── Valoración por reglas: el porqué de la conclusión ────────────────────────────────────
  const assessment = assessEvidence(bundle, priority);
  // Marca para la segunda vía de cierre benigno (actions.ts): solo actividad habitual con
  // confianza media y CERO señales de riesgo; las guardas duras del cierre siguen aplicando.
  if (
    decision.verdict === 'inconclusive' &&
    assessment.verdict === 'likely_false_positive' &&
    assessment.confidence === 'medium' &&
    assessment.risk.length === 0
  ) {
    reasons.push('RULE_ASSESSMENT_BENIGN');
  }
  // Hay al menos una señal de riesgo o urgencia: lo que justifica pedir una revisión humana.
  if (assessment.risk.length > 0) reasons.push('RULE_ASSESSMENT_RISK');
  const explanation = assessment.explanation;
  if (explanation && bundle.subject) {
    const shown = Object.entries(bundle.subject.details)
      .slice(0, 8)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    if (shown) {
      facts.unshift({ text: `Datos del evento de la alerta: ${shown}.`, citations: alertIds.slice(0, 1) });
    }
  }
  const inferences = [
    ...assessment.risk.map((signal) => ({ text: `Señal de riesgo: ${signal.text}`, citations: alertIds.slice(0, 1) })),
    ...assessment.benign.map((signal) => ({ text: `Señal de actividad habitual: ${signal.text}`, citations: alertIds.slice(0, 1) })),
  ];
  const knownFalsePositives = context?.rule?.knownFalsePositives ?? [];
  if (knownFalsePositives.length > 0) {
    inferences.push({
      text: `Falsos positivos documentados para esta regla: ${knownFalsePositives.slice(0, 3).join(' · ')}`,
      citations: alertIds.slice(0, 1),
    });
  }

  // Sin usuario ni IP, «sin entidad» no es un vacío en una vulnerabilidad, una falla de
  // plataforma, FIM o rootcheck: su análisis no depende de una persona.
  const notApplicable = explanation
    ? /^(Sin referencia de entidad|Sin regla o referencia de entidad)/u
    : null;
  const gaps = bundle.completeness.gaps
    .filter((gap) => !notApplicable || !notApplicable.test(gap))
    .slice(0, 6);
  if (bundle.completeness.truncated) gaps.push('La lectura de evidencia quedó truncada.');
  if (!reasons.includes('NOT_ELIGIBLE') && decision.decision === 'infer') {
    gaps.push('No se ejecutó análisis con modelo para este expediente.');
  }

  const situation = reasons.includes('DUPLICATE_OF_OPEN_INCIDENT')
    ? `Las alertas ya pertenecen al incidente ${incidentIds.join(', ')}; el trabajo continúa allí.`
    : reasons.includes('KNOWN_BENIGN_PATTERN')
      ? 'El historial de esta regla y entidad solo registra cierres como falso positivo; requiere confirmación humana.'
      : reasons.includes('EVIDENCE_INCOMPLETE') && decision.decision === 'deterministic'
        ? 'La evidencia está incompleta o hay fuentes sin datos frescos.'
        : reasons.includes('ISOLATED_LOW_SIGNAL')
          ? 'Alerta aislada de baja señal, sin correlación con otras alertas ni fuentes.'
          : reasons.includes('NOT_ELIGIBLE')
            ? 'La prioridad no es elegible para análisis con modelo.'
            : 'Expediente sin análisis de IA.';
  const summary = explanation
    ? `${explanation.label}. Qué pasó: ${explanation.whatHappened} Por qué importa: ${explanation.whyItMatters} ${assessment.conclusion}`
    : `${assessment.conclusion} ${situation}`;

  // La política manda cuando ya concluyó (patrón benigno conocido); si no, la valoración por reglas.
  const verdict = decision.verdict !== 'inconclusive' ? decision.verdict : assessment.verdict;
  const confidence = decision.verdict !== 'inconclusive' ? decision.confidence : assessment.confidence;

  const escalateWhen = context?.rule?.escalateWhen ?? [];
  const baseSteps = reasons.includes('DUPLICATE_OF_OPEN_INCIDENT')
    ? ['Revisar el incidente abierto y agregar allí cualquier hallazgo nuevo.']
    : verdict === 'likely_true_positive'
      ? [
          'Revisar la alerta con prioridad: las señales de riesgo de arriba indican qué confirmar primero.',
          ...(context?.rule?.runbooks.length ? [`Seguir el runbook: ${context.rule.runbooks.slice(0, 2).join(', ')}.`] : []),
        ]
      : verdict === 'likely_false_positive'
        ? [
            'Confirmar que coincide con la actividad habitual descrita y cerrar con la razón concreta.',
            'Si el patrón se repite, proponer el ajuste de la regla por el proceso de ingeniería de detección.',
          ]
        : decision.status === 'completed'
          ? ['Atender la alerta en la cola humana según su prioridad.']
          : ['Revisar la alerta en la cola humana; el expediente no reemplaza el triaje.'];
  const nextSteps = [
    ...(explanation && !reasons.includes('DUPLICATE_OF_OPEN_INCIDENT') ? explanation.actions : baseSteps),
    ...escalateWhen.slice(0, 4).map((criterion) => `Escalar si: ${criterion}`),
  ];

  return {
    summary,
    verdict,
    confidence,
    recommendedPriority: assessment.recommendedPriority,
    facts,
    inferences,
    gaps,
    nextSteps,
    citations,
    verified: true,
    deterministic: { reasons },
  };
}
