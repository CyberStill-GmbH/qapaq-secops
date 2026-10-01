/**
 * C-20 — carga mínima para el canal de Teams.
 *
 * El canal de Teams no es un sistema de evidencia y no debe convertirse en uno. El
 * mensaje lleva lo justo para que alguien decida abrir QAPAQ: qué pasó, con qué
 * severidad y dónde mirarlo. Nada de identidades, direcciones, referencias al crudo ni
 * contenido del evento: todo eso vive detrás de autorización, y un canal de chat no la
 * aplica.
 */

import type { SocEventType } from '@qapaq/soc';

export const TEAMS_PAYLOAD_VERSION = '1.0.0' as const;

export interface CriticalNotificationInput {
  readonly tenantId: string;
  readonly messageType: SocEventType;
  readonly aggregateType: 'alert' | 'incident';
  readonly aggregateId: string;
  readonly title: string;
  readonly severity: string;
  readonly occurredAt: Date;
  readonly consoleBaseUrl: string;
  readonly clientRequestId: string;
}

export interface TeamsMessage {
  readonly type: 'message';
  readonly attachments: readonly [
    {
      readonly contentType: 'application/vnd.microsoft.card.adaptive';
      readonly content: Readonly<Record<string, unknown>>;
    },
  ];
  readonly qapaq: {
    readonly version: string;
    readonly clientRequestId: string;
    readonly aggregateId: string;
  };
}

/** Campos que jamás deben viajar al canal, comprobado por spec. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'raw',
  'rawRef',
  'identities',
  'principal',
  'ip',
  'token',
  'secret',
] as const;

function deepLink(input: CriticalNotificationInput): string {
  const base = input.consoleBaseUrl.replace(/\/+$/u, '');
  return `${base}/${input.aggregateType === 'incident' ? 'incidents' : 'alerts'}/${encodeURIComponent(input.aggregateId)}`;
}

export function buildTeamsMessage(input: CriticalNotificationInput): TeamsMessage {
  const link = deepLink(input);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.5',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          body: [
            {
              type: 'TextBlock',
              size: 'Medium',
              weight: 'Bolder',
              wrap: true,
              text: `QAPAQ SecOps · ${input.severity.toUpperCase()}`,
            },
            { type: 'TextBlock', wrap: true, text: input.title },
            {
              type: 'FactSet',
              facts: [
                { title: 'Tipo', value: input.messageType },
                { title: 'Identificador', value: input.aggregateId },
                { title: 'Ocurrido', value: input.occurredAt.toISOString() },
              ],
            },
          ],
          actions: [{ type: 'Action.OpenUrl', title: 'Abrir en QAPAQ', url: link }],
        },
      },
    ],
    qapaq: {
      version: TEAMS_PAYLOAD_VERSION,
      clientRequestId: input.clientRequestId,
      aggregateId: input.aggregateId,
    },
  };
}
