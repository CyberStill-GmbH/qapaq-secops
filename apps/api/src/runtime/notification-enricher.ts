/**
 * Enriquecedor de avisos: convierte un mensaje del outbox en un `NotificationContext`
 * explicativo con la alerta (entidades, correlación, regla), el catálogo de detecciones de
 * Qapaqzito (MITRE, caso de uso, runbook) y la explicación del correlador cuando la alerta viene de
 * `qapaq-correlator`. Todo lo que sale hacia Teams/correo queda enmascarado (`maskText`).
 *
 * Si algo falta (alerta borrada, regla fuera del catálogo, correlador sin explicación), el
 * contexto se degrada a lo disponible: el aviso siempre sale.
 */

import type { Alert } from '@qapaq/soc';
import type { OutboxMessageDraft } from '@qapaq/soc';
import {
  contextFromMessage,
  entityFromKeys,
  maskText,
  sourceFromTitle,
  type CorrelationSummary,
  type NotificationContext,
  type NotificationEnricher,
} from '@qapaq/soar';

import { ruleForTitle, type SocKnowledge } from '../assistant/soc-knowledge.js';
import { describeAttention } from '../soc/attention-ranking.js';
import type { EntityRiskLookup } from './entity-risk.js';

const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  BASE_SEVERITY: 'severidad de la regla',
  BREAK_GLASS_IDENTITY: 'cuenta de emergencia',
  PRIVILEGED_IDENTITY: 'identidad privilegiada',
  CRITICAL_ASSET: 'activo crítico',
  SUCCESSFUL_INTRUSION: 'intrusión exitosa',
  REPEATED_ACTIVITY: 'actividad repetida',
  CORRELATED_ENTITY: 'entidad correlacionada',
  ATTACK_CHAIN: 'cadena de ataque',
  EXTERNAL_EXPOSURE: 'exposición externa',
  MAINTENANCE_WINDOW: 'ventana de mantenimiento',
  KNOWN_BENIGN: 'regla benigna conocida',
  INFORMATIONAL_ONLY: 'solo informativo',
});

/** Reglas del monitor de plataforma (101800–101849): no están en el catálogo de detecciones. */
const PLATFORM_RULES = { from: 101_800, to: 101_849 } as const;

function platformExplanation(ruleId: string): { why: string; next: string } | undefined {
  const id = Number(ruleId);
  if (!Number.isInteger(id) || id < PLATFORM_RULES.from || id > PLATFORM_RULES.to) return undefined;
  return {
    why: 'Salud de la plataforma SOC: si un servicio, el disco o la ingesta fallan, QAPAQ deja de detectar o de avisar sin que nadie lo note.',
    next: 'Revisa «Salud de fuentes» en la consola y el estado del contenedor o recurso indicado; si ya se recuperó, cierra la alerta como benigna con la causa (docs/20 · monitoreo de plataforma).',
  };
}

/** Primer paso accionable del runbook: la sección que nombra la regla o el triage de 10 minutos. */
export function runbookStep(markdown: string, ruleId: string | null): string | null {
  const sections = markdown.split(/\n(?=## )/u);
  const mentions = (heading: string) => {
    if (!ruleId) return false;
    if (heading.includes(ruleId)) return true;
    const id = Number(ruleId);
    return [...heading.matchAll(/(\d{4,6})\s*[–-]\s*(\d{4,6})/gu)].some(
      (range) => id >= Number(range[1]) && id <= Number(range[2]),
    );
  };
  const section =
    sections.find((candidate) => mentions(candidate.split('\n')[0] ?? '')) ??
    sections.find((candidate) => /^## Triage/u.test(candidate));
  if (!section) return null;
  const line = section
    .split('\n')
    .slice(1)
    .find((candidate) => /^\s*(?:\d+\.|-)\s+\S/u.test(candidate));
  if (!line) return null;
  return line
    .replace(/^\s*(?:\d+\.|-)\s+/u, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .trim()
    .slice(0, 400);
}

function correlationOf(alert: Alert): CorrelationSummary | null {
  if (!alert.ruleId?.startsWith('qapaq-correlator:')) return null;
  const details = alert.reasons.map((reason) => reason.detail ?? '').filter(Boolean);
  const narrative = details.find((detail) => detail.startsWith('Explicación: '));
  return {
    patternId: alert.ruleId.slice('qapaq-correlator:'.length),
    candidateId: alert.candidateId,
    narrative: narrative ? maskText(narrative.slice('Explicación: '.length)) : (details[0] ? maskText(details[0]) : null),
    stages: details.filter((detail) => /^Etapa \d+:/u.test(detail)).map(maskText),
    entities: alert.entityKeys.map((key) => {
      const entity = entityFromKeys([key]);
      return entity ? entity.display : maskText(key);
    }),
  };
}

export function notificationEnricher(input: {
  readonly alertById: (tenantId: string, alertId: string) => Promise<Alert | undefined>;
  readonly knowledge: SocKnowledge;
  /** Riesgo de entidad del correlador (opcional); si falla o falta, el aviso sale igual. */
  readonly entityRisk?: EntityRiskLookup;
}): NotificationEnricher {
  const { knowledge } = input;
  return {
    async contextFor(message: OutboxMessageDraft) {
      const base = contextFromMessage(message);
      if (message.aggregateType !== 'alert') {
        return { context: base, entityKeys: [], occurredAt: message.availableAt };
      }
      const alert = await input.alertById(message.tenantId, message.aggregateId);
      if (!alert) return { context: base, entityKeys: [], occurredAt: message.availableAt };

      const correlation = correlationOf(alert);
      const rule =
        (alert.ruleId ? knowledge.rules[alert.ruleId] : undefined) ??
        ruleForTitle(knowledge, alert.title);
      const useCase = rule?.useCases?.[0]
        ? knowledge.useCases.find((candidate) => candidate.id === rule.useCases![0])
        : undefined;
      const runbookId = rule?.runbooks?.[0];
      const runbook = runbookId
        ? knowledge.runbooks.find((candidate) => candidate.id === runbookId)
        : undefined;
      const platform = alert.ruleId ? platformExplanation(alert.ruleId) : undefined;
      // Contexto del correlador (riesgo acumulado de la entidad, cadena, fuentes). Nunca bloquea el aviso.
      const riskContext = await input.entityRisk
        ?.snapshot()
        .then((snapshot) => describeAttention(alert, snapshot).why)
        .catch(() => null);
      const correlatorSteps = alert.reasons
        .map((reason) => reason.detail ?? '')
        .filter((detail) => detail.startsWith('Siguiente paso: '))
        .map((detail) => maskText(detail.slice('Siguiente paso: '.length)));

      const why = [
        correlation ? 'Varias señales de la misma entidad forman una cadena de ataque reconocida por el correlador QAPAQ.' : null,
        useCase
          ? `Caso de uso «${useCase.title}»${useCase.priorityHint ? `; prioridad esperada ${useCase.priorityHint}` : ''}.`
          : null,
        platform?.why ?? null,
        riskContext ? `Contexto del correlador: ${riskContext}.` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      const reasons = alert.reasons
        .map((reason) => REASON_LABELS[reason.code])
        .filter((label): label is string => Boolean(label));
      const uniqueReasons = [...new Set(reasons)];
      const title = maskText(alert.title).slice(0, 300);
      // «Qué pasó»: el título QAPAQ sin el sufijo técnico «(wazuh 101807)».
      const summary = title.replace(/\s*\(wazuh \d+\)\s*$/u, '').replace(/^QAPAQ [^:]{2,40}:\s*/u, '');
      const context: NotificationContext = {
        ...base,
        alertId: alert.id,
        incidentId: alert.incidentId,
        title,
        priority: alert.priority,
        source: sourceFromTitle(alert.title, alert.ruleId) ?? base.source,
        entity: entityFromKeys(alert.entityKeys),
        ruleId: alert.ruleId,
        summary: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}`.slice(0, 400),
        whyItMatters: why || (uniqueReasons.length > 0 ? `Prioridad por: ${uniqueReasons.join(', ')}.` : null),
        mitre: (rule?.mitre ?? []).slice(0, 4).map((id) => ({
          id,
          name: knowledge.techniques[id]?.name ?? null,
        })),
        correlation,
        score: alert.score,
        reasons: uniqueReasons,
        relatedAlertCount: alert.relatedAlertIds.length,
        occurredAt: alert.occurredAt.toISOString(),
        nextStep:
          correlatorSteps[0] ??
          (runbook ? runbookStep(runbook.markdown, alert.ruleId) : null) ??
          platform?.next ??
          null,
        runbook: runbook ? { title: runbook.title, path: runbook.path } : null,
        test: base.test || /\bPRUEBA\b/u.test(alert.title),
      };
      return { context, entityKeys: alert.entityKeys, occurredAt: alert.occurredAt };
    },
  };
}
