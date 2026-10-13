/**
 * C-20 — carga mínima para el canal de Teams.
 *
 * El canal de Teams no es un sistema de evidencia y no debe convertirse en uno. El
 * mensaje lleva lo justo para que alguien decida abrir QAPAQ: qué pasó, con qué
 * severidad y dónde mirarlo. Nada de identidades, direcciones, referencias al crudo ni
 * contenido del evento: todo eso vive detrás de autorización, y un canal de chat no la
 * aplica.
 *
 * Sprint 5: la tarjeta puede mencionar a los destinatarios por rol (`mentions`). Una mención es
 * el nombre y el UPN de una persona del SOC que debe actuar, no un dato del evento: no se
 * mencionan identidades afectadas por la alerta.
 */

import type { SocEventType } from '@qapaq/soc';

import type { NotificationRecipient } from './notification-routing.js';

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
  /** Personas del SOC a mencionar (Teams les avisa individualmente). */
  readonly mentions?: readonly NotificationRecipient[];
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

/** Texto de mención de Teams: el nombre visible, sin caracteres que rompan el marcado. */
function mentionText(recipient: NotificationRecipient): string {
  const name = recipient.displayName.replace(/[<>]/gu, '').trim() || recipient.upn;
  return `<at>${name}</at>`;
}

export function buildTeamsMessage(input: CriticalNotificationInput): TeamsMessage {
  const link = deepLink(input);
  const mentions = input.mentions ?? [];
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
            ...(mentions.length > 0
              ? [
                  {
                    type: 'TextBlock',
                    wrap: true,
                    text: `Para: ${mentions.map(mentionText).join(', ')}`,
                  },
                ]
              : []),
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
          ...(mentions.length > 0
            ? {
                msteams: {
                  entities: mentions.map((recipient) => ({
                    type: 'mention',
                    text: mentionText(recipient),
                    mentioned: { id: recipient.upn, name: recipient.displayName },
                  })),
                },
              }
            : {}),
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
