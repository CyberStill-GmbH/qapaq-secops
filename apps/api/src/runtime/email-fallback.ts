/**
 * Correo de avisos por Microsoft Graph (`POST /users/<buzón>/sendMail`).
 *
 * Dos usos:
 *
 * - **Respaldo** (`FallbackChannel`): el aviso que Teams no registró (reintentos agotados o error
 *   permanente) se envía por correo a las mismas personas que la política de ruteo eligió. Si el
 *   correo tampoco sale o no hay destinatarios, cae en la bandeja de la consola, que sigue
 *   exigiendo acuse: agotar los canales nunca es callar.
 * - **Copia directa** (`MailChannel`): P1/incidentes críticos y resúmenes, además de Teams.
 *
 * Requiere el permiso de aplicación `Mail.Send` (acotado al buzón del SOC con una Application
 * Access Policy de Exchange). El contenido es el correo explicativo de `@qapaq/soar` (ya
 * enmascarado). Graph responde 202 sin cuerpo: la evidencia es el estado y el `request-id`; el
 * `internetMessageId` exigiría crear borradores (`Mail.ReadWrite`), que no se pide a propósito.
 */

import type {
  DeliveryEvidence,
  FallbackChannel,
  FallbackNotification,
  MailChannel,
  NotificationChannel,
  NotificationRecipient,
  RenderedEmail,
} from '@qapaq/soar';

const GRAPH = 'https://graph.microsoft.com';
const REQUEST_TIMEOUT_MS = 10_000;

export interface GraphMailFallbackOptions {
  /** Buzón remitente (UPN), p. ej. `soc-alertas@contoso.example`. */
  readonly sender: string;
  readonly accessToken: () => Promise<string>;
  /** Siguiente eslabón si el correo no sale (la consola). */
  readonly next: FallbackChannel;
  readonly fetch?: typeof globalThis.fetch;
  /** Notifica el código de un envío fallido (para el log del proceso). */
  readonly onError?: (code: string) => void;
  readonly clock?: () => Date;
}

function plainEmail(notification: FallbackNotification): RenderedEmail {
  const text = [
    'Teams no confirmó la entrega de este aviso; se envía por correo.',
    '',
    `Severidad: ${notification.severity}`,
    `Título: ${notification.title}`,
    `Ocurrido: ${notification.at.toISOString()}`,
    notification.link ? `Abrir en QAPAQ: ${notification.link}` : '',
  ].join('\n');
  return {
    subject: `QAPAQ SOC · ${notification.severity.toUpperCase()} · ${notification.title}`.slice(0, 255),
    html: '',
    text,
  };
}

function requestIdOf(headers: Headers): string | null {
  const value = headers.get('request-id') ?? headers.get('client-request-id');
  return value && /^[A-Za-z0-9-]{8,64}$/u.test(value) ? `request-id:${value}` : null;
}

export class GraphMailFallbackChannel implements FallbackChannel, MailChannel {
  public constructor(private readonly options: GraphMailFallbackOptions) {}

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  /** Envía un correo; nunca lanza: devuelve la evidencia (aceptado o fallido con motivo). */
  public async send(input: {
    readonly recipients: readonly NotificationRecipient[];
    readonly email: RenderedEmail;
    readonly clientRequestId: string;
  }): Promise<DeliveryEvidence> {
    const at = this.now().toISOString();
    const failed = (reason: string, httpStatus: number | null = null): DeliveryEvidence => {
      this.options.onError?.(reason);
      return {
        channel: 'email',
        outcome: 'failed',
        at,
        httpStatus,
        providerMessageId: null,
        providerLink: null,
        reason,
        recipients: input.recipients.length,
      };
    };
    if (input.recipients.length === 0) return failed('NO_RECIPIENTS');
    try {
      const token = await this.options.accessToken();
      const response = await (this.options.fetch ?? globalThis.fetch)(
        new URL(`/v1.0/users/${encodeURIComponent(this.options.sender)}/sendMail`, GRAPH),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'client-request-id': input.clientRequestId,
          },
          body: JSON.stringify({
            message: {
              subject: input.email.subject.slice(0, 255),
              body: input.email.html
                ? { contentType: 'HTML', content: input.email.html }
                : { contentType: 'Text', content: input.email.text },
              toRecipients: input.recipients.map((recipient) => ({
                emailAddress: { address: recipient.upn, name: recipient.displayName },
              })),
            },
            saveToSentItems: false,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status !== 202) return failed(`GRAPH_MAIL_${response.status}`, response.status);
      return {
        channel: 'email',
        outcome: 'accepted',
        at,
        httpStatus: 202,
        providerMessageId: requestIdOf(response.headers),
        providerLink: null,
        reason: null,
        recipients: input.recipients.length,
      };
    } catch {
      return failed('GRAPH_MAIL_UNAVAILABLE');
    }
  }

  public async notify(notification: FallbackNotification): Promise<{
    readonly channel: NotificationChannel;
    readonly reference: string;
    readonly evidence?: readonly DeliveryEvidence[];
  }> {
    const recipients = notification.recipients ?? [];
    if (recipients.length === 0) return this.options.next.notify(notification);
    const evidence = await this.send({
      recipients,
      email: notification.email ?? plainEmail(notification),
      clientRequestId: `${notification.tenantId}:${notification.aggregateId}`.slice(0, 64),
    });
    if (evidence.outcome !== 'accepted') {
      const next = await this.options.next.notify(notification);
      return { ...next, evidence: [evidence, ...(next.evidence ?? [])] };
    }
    return {
      channel: 'fallback_email',
      reference: `email:${notification.tenantId}:${notification.aggregateId}:${recipients.length}`,
      evidence: [evidence],
    };
  }
}
