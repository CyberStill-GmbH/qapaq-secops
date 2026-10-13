/**
 * Sprint 5 — a quién avisar en Teams según el evento y el rol en el SOC.
 *
 * La política es una tabla (dato, no código repartido): cada evento notificable declara qué
 * roles QAPAQ lo reciben. Los destinatarios concretos (correos) los resuelve
 * `RecipientDirectory`, que implementa el composition root con el padrón del grupo de admisión
 * y el rol efectivo de cada persona. Quien queda «sin acceso asignado» nunca recibe nada.
 *
 * | Evento                                | Roles                       | Motivo              |
 * | ------------------------------------- | --------------------------- | ------------------- |
 * | `soc.alert.created` P1                | analista, lead              | triage inmediato    |
 * | `soc.alert.escalated` P1              | lead, admin de plataforma   | decisión de caso    |
 * | `soc.incident.opened` crítico         | lead, admin de plataforma   | conducción del caso |
 *
 * Cualquier otro evento no se notifica. El canal sigue siendo uno solo (el Teams Workflow del
 * SOC): los destinatarios llegan como menciones y Teams avisa a cada uno.
 */

import type { OutboxMessageDraft } from '@qapaq/soc';

export const NOTIFIED_ROLES = [
  'qapaq.soc.analyst',
  'qapaq.soc.lead',
  'qapaq.platform.admin',
] as const;
export type NotifiedRole = (typeof NOTIFIED_ROLES)[number];

interface Route {
  readonly messageType: OutboxMessageDraft['messageType'];
  readonly matches: (payload: Readonly<Record<string, unknown>>) => boolean;
  readonly roles: readonly NotifiedRole[];
}

export const NOTIFICATION_ROUTES: readonly Route[] = Object.freeze([
  {
    messageType: 'soc.alert.created',
    matches: (payload) => payload['priority'] === 'P1',
    roles: ['qapaq.soc.analyst', 'qapaq.soc.lead'],
  },
  {
    messageType: 'soc.alert.escalated',
    matches: (payload) => payload['priority'] === 'P1',
    roles: ['qapaq.soc.lead', 'qapaq.platform.admin'],
  },
  {
    messageType: 'soc.incident.opened',
    matches: (payload) => payload['severity'] === 'critical',
    roles: ['qapaq.soc.lead', 'qapaq.platform.admin'],
  },
]);

/** Roles a notificar para un mensaje del outbox; vacío = el mensaje no se notifica. */
export function rolesToNotify(
  message: Pick<OutboxMessageDraft, 'messageType' | 'payload'>,
): readonly NotifiedRole[] {
  const route = NOTIFICATION_ROUTES.find(
    (candidate) =>
      candidate.messageType === message.messageType && candidate.matches(message.payload),
  );
  return route?.roles ?? [];
}

export interface NotificationRecipient {
  /** UPN o correo con que Teams resuelve la mención. */
  readonly upn: string;
  readonly displayName: string;
  /** Clave de la persona para sus dispositivos (OID de Entra). */
  readonly subjectKey?: string;
}

/** Destinatarios por rol; lo implementa el composition root con el padrón del grupo. */
export interface RecipientDirectory {
  recipientsFor(
    tenantId: string,
    roles: readonly NotifiedRole[],
  ): Promise<readonly NotificationRecipient[]>;
}

/** Menciones por tarjeta: más allá de esto el aviso deja de ser útil y Teams lo recorta. */
export const MAXIMUM_MENTIONS = 25;
