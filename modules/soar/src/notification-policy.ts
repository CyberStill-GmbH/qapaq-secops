/**
 * Política de ruido de los avisos (Teams/correo).
 *
 * Motivo (incidente del 2026-11-10): tras ~8 h con la API caída, al volver la ingesta procesó el
 * atraso y cada alerta P1/P2 creada abrió su propia tarjeta: 30 avisos en 11 minutos, 20 de
 * ellos la misma regla del monitor de plataforma sobre el mismo contenedor, ya resuelto. La
 * política decide por mensaje:
 *
 * 1. **Agrupar**: si el mismo grupo (incidente, patrón del correlador o regla+entidad) ya se
 *    avisó dentro de su ventana silenciosa, no se publica otra tarjeta; la ocurrencia se cuenta
 *    y aparece en el siguiente aviso del grupo o en el resumen.
 * 2. **Re-aviso silencioso**: pasada la ventana, una nueva ocurrencia del grupo sí sale, como
 *    «persiste» con el conteo acumulado. Nunca más de un aviso por grupo y ventana.
 * 3. **Atraso**: una P2 cuyo evento ocurrió hace más de `staleAfterMs` (backlog tras una caída)
 *    va al resumen, no a una tarjeta inmediata. Una P1 sale igual, rotulada «aviso tardío».
 * 4. **Tope**: como mucho `maxImmediatePerHour` tarjetas P2 por hora y tenant; el excedente va
 *    al resumen. Las P1 no tienen tope (sí agrupación).
 * 5. **P3/P4**: nunca inmediatas; las resume el digest periódico.
 */

import type { NotificationPriority } from './notification-context.js';
import type { SuppressionReason } from './notification.js';

export interface NotificationPolicyConfig {
  /** Ventana silenciosa por prioridad: dentro de ella el grupo no vuelve a avisar. */
  readonly quietPeriodMs: Readonly<Record<'P1' | 'P2', number>>;
  /** Un evento más antiguo que esto al despacharse es atraso (backlog). */
  readonly staleAfterMs: number;
  /** Tarjetas P2 inmediatas por hora y tenant. */
  readonly maxImmediatePerHour: number;
  /** Resumen periódico de P3/P4 (0 = apagado). */
  readonly digestIntervalMs: number;
  /** Lo suprimido (atraso, tope, agrupado) se resume a lo sumo tras este tiempo. */
  readonly digestFlushMs: number;
  /** Zona horaria de las horas en tarjetas y correos. */
  readonly timeZone: string;
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicyConfig = Object.freeze({
  quietPeriodMs: Object.freeze({ P1: 30 * 60_000, P2: 2 * 3_600_000 }),
  staleAfterMs: 60 * 60_000,
  maxImmediatePerHour: 12,
  digestIntervalMs: 6 * 3_600_000,
  digestFlushMs: 15 * 60_000,
  timeZone: 'America/Lima',
});

export interface PolicyHistory {
  /** Último aviso publicado del grupo (enviado, en respaldo o reconocido), si hubo. */
  readonly lastNotified: { readonly id: string; readonly at: Date } | null;
  /** Ocurrencias suprimidas del grupo desde ese último aviso. */
  readonly suppressedSinceLast: number;
  /** Tarjetas P2 publicadas en la última hora (tenant). */
  readonly immediateLastHour: number;
}

export type PolicyDecision =
  | {
      readonly kind: 'notify';
      /** Re-aviso de un grupo ya avisado (pasada la ventana). */
      readonly reminderOf: string | null;
      /** Ocurrencias acumuladas desde el último aviso del grupo (incluida esta). */
      readonly occurrences: number;
      /** El evento es antiguo: se rotula como aviso tardío. */
      readonly late: boolean;
    }
  | {
      readonly kind: 'suppress';
      readonly reason: SuppressionReason;
      /** Aviso del grupo que ya cubre esta ocurrencia (solo `grouped`). */
      readonly coveredBy: string | null;
    };

export function decideNotification(input: {
  readonly priority: NotificationPriority | null;
  /** `soc.incident.opened` crítico se trata como P1. */
  readonly incident: boolean;
  readonly occurredAt: Date;
  readonly now: Date;
  readonly history: PolicyHistory;
  readonly config?: NotificationPolicyConfig;
}): PolicyDecision {
  const config = input.config ?? DEFAULT_NOTIFICATION_POLICY;
  const priority = input.incident ? 'P1' : input.priority;
  if (priority !== 'P1' && priority !== 'P2') {
    return { kind: 'suppress', reason: 'digest', coveredBy: null };
  }
  const nowMs = input.now.getTime();
  const { lastNotified, suppressedSinceLast } = input.history;
  if (lastNotified && nowMs - lastNotified.at.getTime() < config.quietPeriodMs[priority]) {
    return { kind: 'suppress', reason: 'grouped', coveredBy: lastNotified.id };
  }
  const late = nowMs - input.occurredAt.getTime() > config.staleAfterMs;
  if (priority === 'P2' && late) return { kind: 'suppress', reason: 'stale_backlog', coveredBy: null };
  if (priority === 'P2' && input.history.immediateLastHour >= config.maxImmediatePerHour) {
    return { kind: 'suppress', reason: 'rate_limited', coveredBy: null };
  }
  return {
    kind: 'notify',
    reminderOf: lastNotified?.id ?? null,
    occurrences: (lastNotified ? suppressedSinceLast : 0) + 1,
    late,
  };
}

/** Lee la política desde variables `QAPAQ_NOTIFY_*` ya validadas (minutos enteros). */
export function notificationPolicyFrom(values: {
  readonly quietP1Minutes?: number;
  readonly quietP2Minutes?: number;
  readonly staleMinutes?: number;
  readonly maxPerHour?: number;
  readonly digestMinutes?: number;
  readonly timeZone?: string;
}): NotificationPolicyConfig {
  const base = DEFAULT_NOTIFICATION_POLICY;
  const minutes = (value: number | undefined, fallback: number) =>
    value === undefined ? fallback : value * 60_000;
  return Object.freeze({
    quietPeriodMs: Object.freeze({
      P1: minutes(values.quietP1Minutes, base.quietPeriodMs.P1),
      P2: minutes(values.quietP2Minutes, base.quietPeriodMs.P2),
    }),
    staleAfterMs: minutes(values.staleMinutes, base.staleAfterMs),
    maxImmediatePerHour: values.maxPerHour ?? base.maxImmediatePerHour,
    digestIntervalMs: minutes(values.digestMinutes, base.digestIntervalMs),
    digestFlushMs: base.digestFlushMs,
    timeZone: values.timeZone ?? base.timeZone,
  });
}
