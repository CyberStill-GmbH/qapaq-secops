/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */

import type { NotificationChannelView } from '../../common';
import { NOTIFICATION_CHANNEL_LABEL } from '../../common';

export function isConsoleChannel(channel: NotificationChannelView): boolean {
  return channel.id === 'manual_console' && channel.apiId !== 'push';
}

export function channelName(channel: NotificationChannelView): string {
  return channel.apiId === 'push' ? 'Avisos al navegador' : NOTIFICATION_CHANNEL_LABEL[channel.id];
}

export function channelHint(channel: NotificationChannelView): string {
  if (channel.apiId === 'push') return 'Envía avisos a los navegadores registrados. Cada persona debe permitir las notificaciones en su dispositivo.';
  if (channel.id === 'teams') return 'Envía avisos al canal del SOC mediante un flujo de Workflows en Microsoft Teams.';
  if (channel.id === 'fallback_email') return 'Envía un correo al buzón del SOC si Teams no confirma. El destino se configura en el servicio.';
  return 'Bandeja interna de QAPAQ. Siempre disponible como último canal de respaldo.';
}

/** Summarizes destinations without rendering values that could contain a webhook secret. */
export function channelDestinationSummary(channel: NotificationChannelView): string {
  if (isConsoleChannel(channel)) return 'Bandeja interna de QAPAQ';
  if (!channel.configured) return 'Sin configurar';
  if (channel.apiId === 'push') return 'Servicio Web Push configurado · requiere un navegador registrado';
  if (channel.id === 'teams') return 'Webhook configurado · URL protegida';
  return 'Buzón del SOC configurado · dirección protegida';
}
