/**
 * C-16 — priorización QAPAQ sobre alertas ya detectadas por el proveedor de origen.
 *
 * Esto **no** es un motor de detección y no reimplementa el ruleset del SIEM. El
 * proveedor decide que algo es una alerta; QAPAQ decide qué merece la atención de un
 * analista hoy, usando contexto que el SIEM no tiene: qué identidades son privilegiadas,
 * qué activos son críticos y qué ventanas de mantenimiento están abiertas.
 *
 * Cada ajuste deja un reason code. Un analista debe poder responder "¿por qué está esto
 * arriba?" sin leer código, y una prioridad sin razones sería incontestable.
 *
 * Historial del ruleset:
 *
 * - 1.0.0: severidad, identidad privilegiada, activo crítico/expuesto, intrusión exitosa,
 *   repetición, supresión por mantenimiento o regla benigna.
 * - 1.1.0: cuentas break-glass (siempre P1 y no suprimibles), correlación por entidad
 *   (`CORRELATED_ENTITY`) y cadena de compromiso de cuenta (`ATTACK_CHAIN`); comparación de
 *   identidades y activos sin distinguir mayúsculas, porque los UPN de Entra no las
 *   distinguen y una diferencia de capitalización no puede apagar un ajuste.
 */

import type { SecurityEvent } from '@qapaq/contracts';

import type { CorrelationSignal } from './correlation.js';

export const PRIORITIZATION_RULESET_ID = 'qapaq.detection.prioritization' as const;
export const PRIORITIZATION_RULESET_VERSION = '1.1.0' as const;

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REASON_CODES = [
  'BASE_SEVERITY',
  'BREAK_GLASS_IDENTITY',
  'PRIVILEGED_IDENTITY',
  'CRITICAL_ASSET',
  'SUCCESSFUL_INTRUSION',
  'REPEATED_ACTIVITY',
  'CORRELATED_ENTITY',
  'ATTACK_CHAIN',
  'EXTERNAL_EXPOSURE',
  'MAINTENANCE_WINDOW',
  'KNOWN_BENIGN',
  'INFORMATIONAL_ONLY',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  readonly code: ReasonCode;
  readonly delta: number;
  readonly detail: string;
}

/** Contexto QAPAQ. Lo aporta un puerto; el dominio no consulta inventarios. */
export interface PrioritizationContext {
  readonly privilegedIdentities: ReadonlySet<string>;
  /**
   * Cuentas de emergencia excluidas de Conditional Access. Su uso legítimo es excepcional
   * y siempre debe revisarse, por eso fuerzan P1 y no admiten supresión.
   */
  readonly breakGlassIdentities?: ReadonlySet<string>;
  readonly criticalAssets: ReadonlySet<string>;
  readonly internetFacingAssets?: ReadonlySet<string>;
  /** Eventos equivalentes observados en la ventana reciente, sin contar el actual. */
  readonly recentSimilarCount?: number;
  readonly maintenanceWindow?: {
    readonly from: Date;
    readonly to: Date;
    readonly reference: string;
  };
  /** Reglas del proveedor declaradas benignas por acuerdo, con su referencia documental. */
  readonly knownBenignRuleIds?: ReadonlySet<string>;
  /**
   * Resultado de `correlate` para este evento. Si está presente, su `recentSimilarCount`
   * prevalece sobre el campo homónimo de arriba, que se conserva por compatibilidad.
   */
  readonly correlation?: CorrelationSignal;
}

export interface PrioritizationOutcome {
  readonly score: number;
  readonly priority: Priority;
  readonly reasons: readonly Reason[];
  readonly suppressed: boolean;
  readonly rulesetId: string;
  readonly rulesetVersion: string;
}

const BASE_SCORE: Readonly<Record<SecurityEvent['severity']['normalized'], number>> = Object.freeze(
  {
    critical: 80,
    high: 60,
    medium: 40,
    low: 20,
    informational: 5,
    unknown: 15,
  },
);

export const PRIORITY_THRESHOLDS = Object.freeze({ P1: 85, P2: 65, P3: 35 });

/** Umbral de promoción a alerta SOC. Por debajo, el evento permanece consultable. */
export const PROMOTION_THRESHOLD = PRIORITY_THRESHOLDS.P3;

const REPEAT_THRESHOLD = 5;
/** Alertas distintas sobre la misma entidad que justifican subir la atención. */
const CORRELATION_THRESHOLD = 3;

export function priorityForScore(score: number): Priority {
  if (score >= PRIORITY_THRESHOLDS.P1) return 'P1';
  if (score >= PRIORITY_THRESHOLDS.P2) return 'P2';
  if (score >= PRIORITY_THRESHOLDS.P3) return 'P3';
  return 'P4';
}

function identityKeys(event: SecurityEvent): readonly string[] {
  return event.entities.identities.flatMap((identity) =>
    [identity.principal, identity.id, identity.name].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
}

function resourceKeys(event: SecurityEvent): readonly string[] {
  return event.entities.resources.flatMap((resource) =>
    [resource.id, resource.name].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
}

/**
 * Búsqueda sin distinguir mayúsculas. El conjunto de contexto se normaliza una vez por
 * llamada: es pequeño (cientos de entradas) y así el puerto que lo aporta no tiene que
 * conocer esta regla.
 */
function findIn(keys: readonly string[], set: ReadonlySet<string> | undefined): string | undefined {
  if (!set || set.size === 0) return undefined;
  const normalized = new Set([...set].map((value) => value.toLowerCase()));
  return keys.find((key) => normalized.has(key.toLowerCase()));
}

export function prioritize(
  event: SecurityEvent,
  context: PrioritizationContext,
): PrioritizationOutcome {
  const reasons: Reason[] = [];
  const base = BASE_SCORE[event.severity.normalized];
  reasons.push({
    code: 'BASE_SEVERITY',
    delta: base,
    detail: `Severidad normalizada ${event.severity.normalized} (origen ${event.severity.originalLabel}).`,
  });

  const identities = identityKeys(event);
  const resources = resourceKeys(event);
  const breakGlass = findIn(identities, context.breakGlassIdentities);
  if (breakGlass) {
    reasons.push({
      code: 'BREAK_GLASS_IDENTITY',
      // El total se recorta a 100: con este ajuste siempre alcanza P1.
      delta: 100,
      detail: `Cuenta de emergencia (break-glass) involucrada: ${breakGlass}.`,
    });
  }
  // Una break-glass ya es privilegiada; sumar ambos ajustes contaría dos veces lo mismo.
  const privileged = breakGlass ? undefined : findIn(identities, context.privilegedIdentities);
  if (privileged) {
    reasons.push({
      code: 'PRIVILEGED_IDENTITY',
      delta: 15,
      detail: `Identidad privilegiada involucrada: ${privileged}.`,
    });
  }
  const criticalAsset = findIn(resources, context.criticalAssets);
  if (criticalAsset) {
    reasons.push({
      code: 'CRITICAL_ASSET',
      delta: 15,
      detail: `Activo crítico involucrado: ${criticalAsset}.`,
    });
  }
  const exposed = findIn(resources, context.internetFacingAssets);
  if (exposed) {
    reasons.push({
      code: 'EXTERNAL_EXPOSURE',
      delta: 10,
      detail: `Activo expuesto a Internet: ${exposed}.`,
    });
  }
  const offensive = event.category.some((category) =>
    ['intrusion_detection', 'malware', 'threat'].includes(category),
  );
  if (offensive && event.outcome === 'success') {
    reasons.push({
      code: 'SUCCESSFUL_INTRUSION',
      delta: 20,
      detail: 'Actividad ofensiva con resultado exitoso.',
    });
  }
  const correlation = context.correlation;
  const repeats = correlation?.recentSimilarCount ?? context.recentSimilarCount ?? 0;
  if (repeats >= REPEAT_THRESHOLD) {
    reasons.push({
      code: 'REPEATED_ACTIVITY',
      delta: 10,
      detail: `${repeats} eventos equivalentes en la ventana reciente.`,
    });
  }
  if (correlation && correlation.relatedCount >= CORRELATION_THRESHOLD) {
    reasons.push({
      code: 'CORRELATED_ENTITY',
      delta: 10,
      detail:
        `${correlation.relatedCount} alertas recientes comparten usuario o IP ` +
        `(${correlation.entityKeys.join(', ')}).`,
    });
  }
  if (correlation?.chain) {
    reasons.push({
      code: 'ATTACK_CHAIN',
      delta: 25,
      detail:
        `${correlation.chain.description} ` +
        `Alertas precursoras: ${correlation.chain.precursorAlertIds.length}.`,
    });
  }

  let suppressed = false;
  const ruleId = event.detection?.rule?.id;
  // Ni una regla benigna ni una ventana de mantenimiento silencian una cuenta break-glass
  // ni una cadena de compromiso: son justamente lo que un atacante haría coincidir.
  const suppressible = !breakGlass && !correlation?.chain;
  if (suppressible && ruleId && context.knownBenignRuleIds?.has(ruleId)) {
    suppressed = true;
    reasons.push({
      code: 'KNOWN_BENIGN',
      delta: -base,
      detail: `Regla ${ruleId} declarada benigna por acuerdo vigente.`,
    });
  }
  const window = context.maintenanceWindow;
  if (suppressible && window) {
    const occurred = new Date(event.occurredAt).getTime();
    if (occurred >= window.from.getTime() && occurred <= window.to.getTime()) {
      suppressed = true;
      reasons.push({
        code: 'MAINTENANCE_WINDOW',
        delta: -base,
        detail: `Ventana de mantenimiento ${window.reference}.`,
      });
    }
  }
  if (event.severity.normalized === 'informational' && !suppressed) {
    reasons.push({
      code: 'INFORMATIONAL_ONLY',
      delta: 0,
      detail: 'Evento informativo: queda consultable y no asciende por sí solo.',
    });
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      reasons.reduce((total, reason) => total + reason.delta, 0),
    ),
  );
  return {
    score,
    priority: priorityForScore(score),
    reasons,
    suppressed,
    rulesetId: PRIORITIZATION_RULESET_ID,
    rulesetVersion: PRIORITIZATION_RULESET_VERSION,
  };
}
