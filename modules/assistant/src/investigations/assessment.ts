/**
 * Analista IA — valoración por reglas (sin modelo).
 *
 * Convierte la evidencia estructurada y el conocimiento SOC de la regla en una conclusión
 * legible: señales de riesgo y de benignidad con su porqué, veredicto orientativo, prioridad
 * recomendada y pasos concretos. Es pura y explicable: cada señal cita el dato que la produjo.
 *
 * Seguridad: esta valoración NO habilita acciones. El cierre benigno exige además la razón
 * `KNOWN_BENIGN_PATTERN` de la política y sus guardas duras; la escalación automática exige un
 * veredicto del modelo verificado o un P1 correlado (actions.ts). Por eso la confianza de una
 * valoración por reglas nunca pasa de `medium`.
 */

import { explainDomain, type DomainExplanation } from './domain.js';
import { evidenceSources, isCorrelatedEvidence, unhealthySources } from './policy.js';
import type {
  EvidenceBundle,
  EvidenceCount,
  InvestigationConfidence,
  InvestigationPriority,
  InvestigationVerdict,
} from './types.js';

export interface AssessmentSignal {
  readonly code: string;
  readonly text: string;
}

export interface EvidenceAssessment {
  readonly verdict: InvestigationVerdict;
  readonly confidence: InvestigationConfidence;
  readonly risk: readonly AssessmentSignal[];
  readonly benign: readonly AssessmentSignal[];
  readonly recommendedPriority: InvestigationPriority | null;
  /** Frase de conclusión, en castellano, sin datos personales (solo conteos y referencias). */
  readonly conclusion: string;
  /** Explicación del dominio (vulnerabilidad, plataforma, FIM, rootcheck); null si no aplica. */
  readonly explanation: DomainExplanation | null;
}

export const ASSESSMENT_THRESHOLDS = Object.freeze({
  /** Falsos positivos previos (sin verdaderos) para considerar la actividad habitual. */
  benignMinFalsePositives: 3,
  /** Alertas previas de la regla y entidad sin ningún verdadero positivo: actividad recurrente. */
  recurringMinHistory: 20,
  /** Riesgo de entidad del correlador (0–100). */
  highEntityRisk: 60,
  lowEntityRisk: 30,
  /** Fallos y éxitos en la ventana de eventos de la entidad (patrón de fuerza bruta con éxito). */
  failuresWithSuccess: 10,
  minTactics: 2,
});

const PRIORITY_LABEL: Readonly<Record<InvestigationVerdict, string>> = {
  likely_true_positive: 'probable verdadero positivo',
  likely_false_positive: 'probable falso positivo',
  inconclusive: 'sin conclusión firme',
};
const CONFIDENCE_LABEL: Readonly<Record<InvestigationConfidence, string>> = {
  low: 'confianza baja',
  medium: 'confianza media',
  high: 'confianza alta',
};

const countOf = (counts: readonly EvidenceCount[] | undefined, pattern: RegExp): number =>
  (counts ?? [])
    .filter((entry) => pattern.test(entry.value))
    .reduce((total, entry) => total + entry.count, 0);

/** Valoración por reglas. Pura: misma evidencia ⇒ misma conclusión. */
export function assessEvidence(
  bundle: EvidenceBundle,
  priority: InvestigationPriority,
  thresholds = ASSESSMENT_THRESHOLDS,
): EvidenceAssessment {
  const risk: AssessmentSignal[] = [];
  const benign: AssessmentSignal[] = [];
  const { history } = bundle;
  const context = bundle.context ?? null;
  const rule = context?.rule ?? null;
  const entityRisk = context?.entityRisk ?? null;
  const summary = bundle.eventSummary ?? null;
  const sources = evidenceSources(bundle);
  const correlated = isCorrelatedEvidence(bundle);
  const tactics = [
    ...new Set([...(bundle.candidate?.tactics ?? []), ...(entityRisk?.tactics ?? [])]),
  ];

  // ── Señales de riesgo ────────────────────────────────────────────────────────────────────
  if (history.truePositive > 0) {
    risk.push({
      code: 'PRIOR_TRUE_POSITIVE',
      text: `La misma regla y entidad ya tuvo ${history.truePositive} verdadero(s) positivo(s) en 30 días.`,
    });
  }
  if (entityRisk && entityRisk.score >= thresholds.highEntityRisk) {
    risk.push({
      code: 'HIGH_ENTITY_RISK',
      text: `El correlador da a la entidad un riesgo de ${Math.round(entityRisk.score)}/100${
        entityRisk.tactics.length > 0 ? ` (tácticas: ${entityRisk.tactics.slice(0, 4).join(', ')})` : ''
      }.`,
    });
  }
  if (tactics.length >= thresholds.minTactics) {
    risk.push({
      code: 'MULTI_TACTIC',
      text: `La actividad abarca ${tactics.length} tácticas MITRE distintas (${tactics.slice(0, 4).join(', ')}).`,
    });
  }
  if (sources.length >= 2) {
    risk.push({
      code: 'MULTI_SOURCE',
      text: `Hay señales de ${sources.length} fuentes distintas (${sources.slice(0, 4).join(', ')}).`,
    });
  }
  if (bundle.candidate && bundle.candidate.memberCount > 1) {
    risk.push({
      code: 'CORRELATED_CHAIN',
      text: `Forma parte de una cadena correlada de ${bundle.candidate.memberCount} alertas${
        bundle.candidate.stages.length > 1 ? ` en ${bundle.candidate.stages.length} etapas` : ''
      }.`,
    });
  }
  const failures = countOf(summary?.byOutcome, /^fail/iu);
  const successes = countOf(summary?.byOutcome, /^succ/iu);
  if (failures >= thresholds.failuresWithSuccess && successes > 0) {
    risk.push({
      code: 'FAILURES_THEN_SUCCESS',
      text: `La entidad acumula ${failures} resultado(s) fallido(s) y ${successes} exitoso(s) en los eventos leídos: revisar si hubo acceso tras los fallos.`,
    });
  }
  const openIncidents = (context?.incidents ?? []).filter((incident) => incident.status !== 'closed');
  if (openIncidents.length > 0) {
    risk.push({
      code: 'OPEN_INCIDENT',
      text: `La entidad tiene ${openIncidents.length} incidente(s) abierto(s) en curso.`,
    });
  }

  // ── Señales de actividad habitual ────────────────────────────────────────────────────────
  if (history.falsePositive >= thresholds.benignMinFalsePositives && history.truePositive === 0) {
    benign.push({
      code: 'PRIOR_FALSE_POSITIVES',
      text: `En 30 días la misma regla y entidad se cerró ${history.falsePositive} vez(es) como falso positivo y nunca como verdadero.`,
    });
  }
  if (history.total >= thresholds.recurringMinHistory && history.truePositive === 0) {
    benign.push({
      code: 'RECURRING_ACTIVITY',
      text: `Es actividad recurrente: ${history.total} alertas de esta regla y entidad en 30 días sin ningún verdadero positivo.`,
    });
  }
  if (!correlated && sources.length <= 1) {
    benign.push({
      code: 'ISOLATED',
      text: 'La alerta está aislada: sin alertas relacionadas, cadena correlada ni otras fuentes.',
    });
  }
  if (entityRisk && entityRisk.score < thresholds.lowEntityRisk) {
    benign.push({
      code: 'LOW_ENTITY_RISK',
      text: `El riesgo de la entidad en el correlador es bajo (${Math.round(entityRisk.score)}/100).`,
    });
  }
  if (rule?.priorityHint === 'P4') {
    benign.push({
      code: 'LOW_IMPACT_RULE',
      text: 'La guía SOC de esta regla la trata como registro de actividad de bajo impacto (P4 típico).',
    });
  }

  // ── Señales del dominio (lo que dice el propio evento de la alerta) ──────────────────────
  const explanation = explainDomain(bundle);
  if (explanation) {
    risk.push(...explanation.risk);
    benign.push(...explanation.benign);
    // «Aislada» no aplica a un hallazgo o a una falla: no son sospechas de ataque.
    if (explanation.confirmedIssue) {
      const index = benign.findIndex((signal) => signal.code === 'ISOLATED');
      if (index >= 0) benign.splice(index, 1);
    }
  }

  // ── Veredicto orientativo ────────────────────────────────────────────────────────────────
  const incomplete = !bundle.completeness.complete || unhealthySources(bundle).length > 0;
  let verdict: InvestigationVerdict = 'inconclusive';
  let confidence: InvestigationConfidence = 'low';
  if (explanation?.confirmedIssue) {
    // Hallazgo o falla confirmados por el propio evento: es real; la urgencia la dan las señales.
    verdict = 'likely_true_positive';
    confidence = incomplete ? 'low' : 'medium';
  } else if (risk.length >= 2) {
    verdict = 'likely_true_positive';
    confidence = risk.length >= 3 && !incomplete ? 'medium' : 'low';
  } else if (risk.length === 0 && benign.length >= 2) {
    verdict = 'likely_false_positive';
    confidence = benign.length >= 3 && !incomplete ? 'medium' : 'low';
  }

  let recommendedPriority: InvestigationPriority | null = null;
  if (
    verdict === 'likely_true_positive' &&
    risk.length > 0 &&
    (priority === 'P3' || priority === 'P4')
  ) {
    recommendedPriority = 'P2';
  } else if (verdict === 'likely_false_positive' && confidence === 'medium' && priority === 'P3') {
    recommendedPriority = 'P4';
  }

  const head = explanation?.confirmedIssue
    ? `Conclusión por reglas (sin IA): problema real que hay que resolver${
        risk.length > 0 ? ', con urgencia' : ', sin urgencia inmediata'
      } (${CONFIDENCE_LABEL[confidence]}).`
    : `Conclusión por reglas (sin IA): ${PRIORITY_LABEL[verdict]}, ${CONFIDENCE_LABEL[confidence]}.`;
  const why = explanation?.confirmedIssue
    ? risk.length > 0
      ? ` Pesan ${risk.length} señal(es) de urgencia.`
      : ' No hay señales de explotación ni de impacto inmediato.'
    : verdict === 'likely_true_positive'
      ? ` Pesan ${risk.length} señal(es) de riesgo independientes.`
      : verdict === 'likely_false_positive'
        ? ` Coincide con actividad habitual (${benign.length} señal(es)) y no hay señales de riesgo.`
        : risk.length === 1
          ? ' Hay una sola señal de riesgo: no alcanza para concluir, pero conviene revisarla.'
          : ' La evidencia no inclina la balanza en ningún sentido.';
  const caveat = incomplete ? ' Parte de la evidencia no se pudo leer: tomar la conclusión con cautela.' : '';
  return {
    verdict,
    confidence,
    risk,
    benign,
    recommendedPriority,
    conclusion: `${head}${why}${caveat}`,
    explanation,
  };
}
