/**
 * C-20 — adapter HTTP del Teams Workflow.
 *
 * La URL del workflow **es** el secreto: quien la tiene puede publicar en el canal. Por
 * eso se resuelve por `SecretProvider` en el arranque, nunca se registra en logs ni se
 * incluye en errores, y la clase solo guarda una referencia opaca para diagnóstico.
 *
 * El timeout propio es obligatorio: sin él, una llamada colgada bloquea al consumidor y
 * el crítico no sale por ningún canal.
 */

import {
  RETRY_POLICY,
  classifyHttpStatus,
  classifyTransportError,
  type DeliveryFailure,
} from './delivery-policy.js';
import type { TeamsMessage } from './teams-payload.js';

export interface DeliveryOutcome {
  readonly delivered: boolean;
  readonly failure?: DeliveryFailure;
  readonly httpStatus?: number;
}

export interface NotificationTransport {
  send(message: TeamsMessage, clientRequestId: string): Promise<DeliveryOutcome>;
  /** Referencia no sensible del destino, apta para logs y evidencia. */
  readonly destinationRef: string;
}

export interface TeamsTransportOptions {
  readonly workflowUrl: string;
  readonly destinationRef: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export class TeamsWorkflowTransport implements NotificationTransport {
  private readonly workflowUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  public readonly destinationRef: string;

  public constructor(options: TeamsTransportOptions) {
    this.workflowUrl = options.workflowUrl;
    this.destinationRef = options.destinationRef;
    this.timeoutMs = options.timeoutMs ?? RETRY_POLICY.requestTimeoutMs;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async send(message: TeamsMessage, clientRequestId: string): Promise<DeliveryOutcome> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.workflowUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Teams Workflows conserva esta cabecera: permite deduplicar el reenvío de un
          // intento ambiguo en lugar de publicar dos tarjetas iguales.
          'client-request-id': clientRequestId,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (response.ok) return { delivered: true, httpStatus: response.status };
      return {
        delivered: false,
        httpStatus: response.status,
        failure: {
          class: classifyHttpStatus(response.status),
          code: `HTTP_${response.status}`,
          httpStatus: response.status,
          // El cuerpo del error no se propaga: puede repetir la URL firmada.
          detail: `El destino respondió ${response.status}.`,
        },
      };
    } catch (error) {
      return { delivered: false, failure: classifyTransportError(error) };
    } finally {
      clearTimeout(deadline);
    }
  }
}
