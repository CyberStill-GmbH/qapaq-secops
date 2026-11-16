/**
 * Orden de «Alertas que requieren atención»: prioridad de la alerta + riesgo acumulado de sus
 * entidades según el correlador + pertenencia a una cadena correlada. Función pura: sin el
 * correlador (`risk.available === false`) el orden es el histórico (prioridad, luego más reciente).
 */

import type { Alert } from '@qapaq/soc';

import { normalizeEntityKey, type EntityRiskSnapshot } from '../runtime/entity-risk.js';

/** Separación entre prioridades: un riesgo 100 sube una alerta ~1,7 prioridades, no más. */
const PRIORITY_BASE: Readonly<Record<string, number>> = { P1: 180, P2: 120, P3: 60, P4: 0 };
const CHAIN_BONUS = 25;
const RELATED_BONUS_EACH = 2;
const RELATED_BONUS_MAX = 10;
/** Por debajo de este riesgo la entidad no se menciona en el «por qué» (ruido). */
const RISK_MENTION_FLOOR = 20;

export interface AttentionInfo {
  readonly attentionScore: number;
  /** Explicación corta para la insignia; `null` si el correlador no aporta nada. */
  readonly why: string | null;
  readonly entityRisk: number | null;
}

export interface RankedAlert {
  readonly alert: Alert;
  readonly attention: AttentionInfo;
}

const STAGE_DETAIL = /^Etapa \d+:/u;

export function isCorrelatorAlert(alert: Alert): boolean {
  return alert.ruleId?.startsWith('qapaq-correlator:') === true;
}

export function describeAttention(alert: Alert, risk: EntityRiskSnapshot): AttentionInfo {
  const base = PRIORITY_BASE[alert.priority] ?? 0;
  // Sin correlador el orden es el de siempre (prioridad y luego más reciente).
  if (!risk.available) return { attentionScore: base, why: null, entityRisk: null };
  let best: { score: number; sources: number; chains: number } | undefined;
  for (const key of alert.entityKeys) {
    const entry = risk.byKey.get(normalizeEntityKey(key));
    if (!entry) continue;
    if (!best || entry.score > best.score) {
      best = { score: entry.score, sources: entry.sources.length, chains: entry.candidateCount };
    }
  }
  const entityRisk = best ? Math.min(100, Math.max(0, Math.round(best.score))) : null;
  const stages = alert.reasons.filter((reason) => STAGE_DETAIL.test(reason.detail ?? '')).length;
  const correlated = isCorrelatorAlert(alert);
  const inChain = correlated || (best?.chains ?? 0) > 0;
  const related = alert.relatedAlertIds.length;

  const parts: string[] = [];
  if (entityRisk !== null && entityRisk >= RISK_MENTION_FLOOR) {
    parts.push(`Riesgo de entidad ${entityRisk}/100`);
  }
  if (correlated && stages > 0) parts.push(`cadena ${stages} etapas`);
  else if (inChain) parts.push('en cadena correlada');
  if (best && best.sources >= 2) parts.push(`${best.sources} fuentes`);
  if (related > 0) parts.push(`${related} relacionadas`);
  const why = parts.length > 0 ? parts.join(' · ') : null;

  const score =
    base +
    (entityRisk ?? 0) +
    (inChain ? CHAIN_BONUS : 0) +
    Math.min(RELATED_BONUS_MAX, related * RELATED_BONUS_EACH);
  return { attentionScore: score, why, entityRisk };
}

export function rankAttention(
  alerts: readonly Alert[],
  risk: EntityRiskSnapshot,
  limit: number,
): RankedAlert[] {
  const ranked = alerts.map((alert) => ({ alert, attention: describeAttention(alert, risk) }));
  ranked.sort(
    (a, b) =>
      b.attention.attentionScore - a.attention.attentionScore ||
      b.alert.occurredAt.getTime() - a.alert.occurredAt.getTime() ||
      a.alert.id.localeCompare(b.alert.id),
  );
  return ranked.slice(0, limit);
}
