/**
 * C-28 — cálculo de cuota por réplica y presupuesto de capacidad.
 *
 * KrakenD Community Edition aplica su límite **por proceso**: no hay cuota agregada
 * sincronizada entre réplicas. Por eso el valor configurado no es el objetivo del
 * sistema, sino el objetivo dividido entre las réplicas que pueden atender tráfico.
 *
 * El reparto se hace sobre `replicas - 1` por defecto: si se dimensiona sobre el total,
 * la caída de una réplica deja al conjunto por debajo del objetivo justo cuando más
 * falta hace. Dimensionar con holgura N-1 es lo que convierte "tenemos dos réplicas" en
 * alta disponibilidad real y no en dos mitades de un mismo servicio.
 */

/** Mínimo de réplicas para tolerar la caída de una sin perder servicio. */
export const MINIMUM_REPLICAS_FOR_HA = 2;

/** Multiplicador de ráfaga admitido sobre la tasa sostenida. */
export const BURST_FACTOR = 2;

export class CapacityError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'CapacityError';
    this.code = code;
  }
}

/**
 * @param {{ aggregateRatePerSecond: number, replicas: number, toleratedFailures?: number }} input
 * @returns {{ perReplicaRate: number, perReplicaBurst: number, servingReplicas: number,
 *            aggregateWhenHealthy: number, aggregateWhenDegraded: number }}
 */
export function planReplicaQuota(input) {
  const { aggregateRatePerSecond, replicas } = input;
  const toleratedFailures = input.toleratedFailures ?? 1;
  if (!Number.isFinite(aggregateRatePerSecond) || aggregateRatePerSecond <= 0) {
    throw new CapacityError('RATE_INVALID', 'La tasa agregada debe ser positiva.');
  }
  if (!Number.isInteger(replicas) || replicas < MINIMUM_REPLICAS_FOR_HA) {
    throw new CapacityError('REPLICAS_INSUFFICIENT', 'La alta disponibilidad exige dos réplicas.');
  }
  if (
    !Number.isInteger(toleratedFailures) ||
    toleratedFailures < 0 ||
    toleratedFailures >= replicas
  ) {
    throw new CapacityError(
      'TOLERANCE_INVALID',
      'La tolerancia debe ser menor que el número de réplicas.',
    );
  }
  const servingReplicas = replicas - toleratedFailures;
  const perReplicaRate = Math.ceil(aggregateRatePerSecond / servingReplicas);
  return {
    perReplicaRate,
    perReplicaBurst: perReplicaRate * BURST_FACTOR,
    servingReplicas,
    // Con todas las réplicas sanas el conjunto admite más que el objetivo: esa holgura
    // es deliberada y debe declararse, no descubrirse en producción.
    aggregateWhenHealthy: perReplicaRate * replicas,
    aggregateWhenDegraded: perReplicaRate * servingReplicas,
  };
}

/**
 * Comprueba que un perfil configurado cumple el objetivo incluso degradado.
 * @param {{ aggregateRatePerSecond: number, replicas: number, configuredRate: number,
 *           configuredBurst: number, toleratedFailures?: number }} input
 */
export function verifyConfiguredQuota(input) {
  const plan = planReplicaQuota(input);
  const problems = [];
  if (input.configuredRate !== plan.perReplicaRate) {
    problems.push(
      `La tasa configurada ${input.configuredRate} no corresponde a ${plan.perReplicaRate} por réplica.`,
    );
  }
  if (input.configuredBurst !== plan.perReplicaBurst) {
    problems.push(
      `La ráfaga configurada ${input.configuredBurst} no corresponde a ${plan.perReplicaBurst}.`,
    );
  }
  if (plan.aggregateWhenDegraded < input.aggregateRatePerSecond) {
    problems.push('El conjunto degradado no alcanza la tasa objetivo.');
  }
  return { ok: problems.length === 0, plan, problems };
}

/** Perfil de capacidad aprobado para el entorno objetivo de esta entrega. */
export const TARGET_PROFILE = Object.freeze({
  aggregateRatePerSecond: 20,
  replicas: 2,
  toleratedFailures: 1,
});
