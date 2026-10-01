/**
 * C-20 — clasificación de fallos y política de reintento.
 *
 * La distinción que gobierna todo este componente es entre tres clases de fallo:
 *
 * - **transitorio**: el destino existe y rechazó por carga o indisponibilidad temporal.
 *   Se reintenta con espera creciente.
 * - **permanente**: el destino rechaza el contenido o las credenciales. Reintentar lo
 *   mismo no cambiará nada; se agota y se va al fallback.
 * - **ambiguo**: un timeout o un corte tras enviar. *No se sabe si el mensaje llegó.*
 *   Es el caso peligroso, y se trata reenviando con el mismo identificador de cliente
 *   para que el destino deduplique, en lugar de asumir que no llegó.
 *
 * Asumir "no llegó" ante un timeout produce mensajes duplicados en el canal del SOC, que
 * es exactamente lo que erosiona la confianza en las notificaciones críticas.
 */

export const FAILURE_CLASSES = ['transient', 'permanent', 'ambiguous'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RETRY_POLICY = Object.freeze({
  maximumAttempts: 5,
  baseDelayMs: 2_000,
  maximumDelayMs: 5 * 60 * 1000,
  /** Tiempo máximo de una llamada al destino antes de considerarla ambigua. */
  requestTimeoutMs: 10_000,
});

export interface DeliveryFailure {
  readonly class: FailureClass;
  readonly code: string;
  readonly httpStatus?: number;
  readonly detail: string;
}

/** Estados HTTP que Teams devuelve y cómo se interpretan. */
export function classifyHttpStatus(status: number): FailureClass {
  if (status === 408 || status === 429) return 'transient';
  if (status === 502 || status === 503 || status === 504) return 'ambiguous';
  if (status >= 500) return 'transient';
  return 'permanent';
}

export function classifyTransportError(error: unknown): DeliveryFailure {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return {
      class: 'ambiguous',
      code: 'REQUEST_TIMEOUT',
      detail: 'La petición venció sin respuesta; la entrega no se puede afirmar ni negar.',
    };
  }
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  if (cause === 'ECONNRESET' || cause === 'EPIPE') {
    return {
      class: 'ambiguous',
      code: cause,
      detail: 'La conexión se cortó después de enviar; la entrega es indeterminada.',
    };
  }
  if (cause === 'ENOTFOUND' || cause === 'ECONNREFUSED' || cause === 'EAI_AGAIN') {
    return { class: 'transient', code: cause, detail: 'El destino no está accesible.' };
  }
  return { class: 'transient', code: name, detail: message };
}

/** Espera exponencial determinista. El jitter lo aporta el consumidor, no la política. */
export function nextDelayMs(attempt: number): number {
  const exponential = RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, RETRY_POLICY.maximumDelayMs);
}

export function shouldRetry(failure: DeliveryFailure, attempt: number): boolean {
  if (attempt >= RETRY_POLICY.maximumAttempts) return false;
  return failure.class !== 'permanent';
}
