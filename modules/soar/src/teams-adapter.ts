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
  /** Time the HTTP response headers were received from the workflow. */
  readonly responseAt?: string;
  readonly failure?: DeliveryFailure;
  readonly httpStatus?: number;
  /**
   * Identificador que devolvió el destino. Power Automate / Logic Apps responden 202 con
   * `x-ms-workflow-run-id` (la ejecución del flujo que publica la tarjeta); si no, el
   * `x-ms-request-id`/`request-id`. Prueba que M365 aceptó el mensaje, no que alguien lo leyó.
   */
  readonly providerMessageId?: string;
}

const PROVIDER_ID_HEADERS = [
  'x-ms-workflow-run-id',
  'x-ms-request-id',
  'request-id',
  'x-ms-correlation-request-id',
] as const;

/** Primer identificador de proveedor presente, saneado (solo caracteres de id). */
export function providerMessageIdOf(headers: Headers | undefined): string | undefined {
  if (!headers) return undefined;
  for (const name of PROVIDER_ID_HEADERS) {
    const value = headers.get(name);
    if (value && /^[A-Za-z0-9._:-]{4,128}$/u.test(value)) return `${name}:${value}`;
  }
  return undefined;
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
    // QAPAQ metadata stays local to the outbox. Teams webhook schema accepts only the message
    // envelope and card attachments; sending our extension caused Power Automate to reject it.
    const { qapaq: _metadata, ...webhookPayload } = message;
    try {
      const response = await this.fetchImplementation(this.workflowUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Teams Workflows conserva esta cabecera: permite deduplicar el reenvío de un
          // intento ambiguo en lugar de publicar dos tarjetas iguales.
          'client-request-id': clientRequestId,
        },
        body: JSON.stringify(webhookPayload),
        signal: controller.signal,
      });
      const responseAt = new Date().toISOString();
      const providerMessageId = providerMessageIdOf(response.headers);
      if (response.ok) {
        return {
          delivered: true,
          httpStatus: response.status,
          responseAt,
          ...(providerMessageId ? { providerMessageId } : {}),
        };
      }
      return {
        delivered: false,
        httpStatus: response.status,
        responseAt,
        ...(providerMessageId ? { providerMessageId } : {}),
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
