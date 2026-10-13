/**
 * Sprint 5 — respaldo por correo cuando Teams no confirma la entrega.
 *
 * Cadena de responsabilidad: el aviso que Teams no registró (reintentos agotados o error
 * permanente) se envía por correo a las mismas personas que la política de ruteo eligió para
 * Teams. Si el correo tampoco sale o no hay destinatarios, cae en la bandeja de la consola, que
 * sigue exigiendo acuse: agotar los canales nunca es callar.
 *
 * El correo sale por Microsoft Graph (`POST /users/<buzón>/sendMail`) con un token de aplicación
 * de la misma app del API; requiere el permiso de aplicación `Mail.Send`, que conviene acotar al
 * buzón del SOC con una Application Access Policy de Exchange. El contenido es el mismo mínimo
 * que la tarjeta de Teams: severidad, título y enlace a QAPAQ. Ni identidades afectadas, ni IPs,
 * ni crudo.
 */

import type { FallbackChannel, FallbackNotification, NotificationChannel } from '@qapaq/soar';

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
}

export class GraphMailFallbackChannel implements FallbackChannel {
  public constructor(private readonly options: GraphMailFallbackOptions) {}

  public async notify(
    notification: FallbackNotification,
  ): Promise<{ readonly channel: NotificationChannel; readonly reference: string }> {
    const recipients = notification.recipients ?? [];
    if (recipients.length === 0) return this.options.next.notify(notification);
    try {
      const token = await this.options.accessToken();
      const response = await (this.options.fetch ?? globalThis.fetch)(
        new URL(`/v1.0/users/${encodeURIComponent(this.options.sender)}/sendMail`, GRAPH),
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject:
                `QAPAQ SecOps · ${notification.severity.toUpperCase()} · ${notification.title}`.slice(
                  0,
                  255,
                ),
              body: {
                contentType: 'Text',
                content: [
                  'Teams no confirmó la entrega de este aviso; se envía por correo.',
                  '',
                  `Severidad: ${notification.severity}`,
                  `Título: ${notification.title}`,
                  `Ocurrido: ${notification.at.toISOString()}`,
                  notification.link ? `Abrir en QAPAQ: ${notification.link}` : '',
                ].join('\n'),
              },
              toRecipients: recipients.map((recipient) => ({
                emailAddress: { address: recipient.upn, name: recipient.displayName },
              })),
            },
            saveToSentItems: false,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status !== 202) {
        this.options.onError?.(`GRAPH_MAIL_${response.status}`);
        return this.options.next.notify(notification);
      }
      return {
        channel: 'fallback_email',
        reference: `email:${notification.tenantId}:${notification.aggregateId}:${recipients.length}`,
      };
    } catch {
      this.options.onError?.('GRAPH_MAIL_UNAVAILABLE');
      return this.options.next.notify(notification);
    }
  }
}
