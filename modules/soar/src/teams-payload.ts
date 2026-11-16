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
  readonly status?: string;
  readonly score?: number | null;
  readonly signal?: string | null;
  readonly ruleId?: string | null;
  readonly reasonCodes?: string;
  readonly relatedAlertCount?: number;
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
      readonly contentUrl: null;
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

const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  BASE_SEVERITY: 'severidad base',
  BREAK_GLASS_IDENTITY: 'cuenta de emergencia',
  PRIVILEGED_IDENTITY: 'identidad privilegiada',
  CRITICAL_ASSET: 'activo crítico',
  SUCCESSFUL_INTRUSION: 'intrusión exitosa',
  REPEATED_ACTIVITY: 'actividad repetida',
  CORRELATED_ENTITY: 'entidad correlacionada',
  ATTACK_CHAIN: 'cadena de ataque',
  EXTERNAL_EXPOSURE: 'exposición externa',
  MAINTENANCE_WINDOW: 'ventana de mantenimiento',
  KNOWN_BENIGN: 'regla benigna conocida',
  INFORMATIONAL_ONLY: 'solo informativo',
});

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
  const clean = (value: string | null | undefined, maximum: number): string =>
    (value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum) || 'Sin dato';
  const reasons = (input.reasonCodes ?? '')
    .split(',')
    .map((code) => REASON_LABELS[code.trim()])
    .filter((label): label is string => label !== undefined)
    .join('; ');
  const facts = [
    { title: 'Tipo', value: input.messageType },
    { title: 'Prioridad', value: clean(input.severity, 24) },
    { title: 'Estado', value: clean(input.status, 32) },
    ...(input.score === undefined || input.score === null
      ? []
      : [{ title: 'Puntaje', value: String(input.score) }]),
    ...(input.signal ? [{ title: 'Señal', value: clean(input.signal, 48) }] : []),
    ...(input.ruleId ? [{ title: 'Regla', value: clean(input.ruleId, 80) }] : []),
    ...(reasons
      ? [{ title: 'Motivos de prioridad', value: clean(reasons, 240) }]
      : []),
    ...(input.relatedAlertCount === undefined
      ? []
      : [{ title: 'Alertas relacionadas', value: String(input.relatedAlertCount) }]),
    { title: 'Identificador', value: input.aggregateId },
    { title: 'Ocurrido', value: input.occurredAt.toISOString() },
  ];
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          version: '1.2',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          body: [
            {
              type: 'TextBlock',
              size: 'Medium',
              weight: 'Bolder',
              wrap: true,
              text: `QAPAQ SecOps · ${clean(input.severity, 24).toUpperCase()} · Requiere revisión`,
            },
            { type: 'TextBlock', wrap: true, text: clean(input.title, 300) },
            { type: 'TextBlock', wrap: true, text: 'Revisa el contexto y registra el triaje en QAPAQ.' },
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
              facts,
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
