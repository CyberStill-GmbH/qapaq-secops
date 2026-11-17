/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */

import type { NotificationChannelView } from '../../common';
import {
  channelDestinationSummary,
  channelHint,
  channelName,
  isConsoleChannel,
} from './channels_display';

const channel = (overrides: Partial<NotificationChannelView>): NotificationChannelView => ({
  id: 'teams',
  enabled: true,
  configured: true,
  state: 'active',
  target: null,
  lastDelivery: null,
  ...overrides,
});

describe('resumen seguro del destino de cada canal', () => {
  it('no muestra la URL completa aunque el API devuelva el webhook sin enmascarar', () => {
    const webhook = 'https://contoso.logic.azure.com/workflows/secret-token/triggers/manual';

    const summary = channelDestinationSummary(channel({ target: webhook }));

    expect(summary).toBe('Webhook configurado · URL protegida');
    expect(summary).not.toContain('contoso');
    expect(summary).not.toContain('secret-token');
  });

  it('distingue un canal de correo pendiente de configurar', () => {
    expect(
      channelDestinationSummary(
        channel({ id: 'fallback_email', configured: false, target: null, state: 'unconfigured' }),
      ),
    ).toBe('Sin configurar');
  });

  it('describe la bandeja de QAPAQ sin ofrecer la dirección interna', () => {
    expect(
      channelDestinationSummary(
        channel({ id: 'manual_console', target: 'qapaq-internal://notification-inbox' }),
      ),
    ).toBe('Bandeja interna de QAPAQ');
  });
});

describe('el push del API es un canal propio, no la bandeja de respaldo', () => {
  const push = channel({ id: 'manual_console', apiId: 'push' });
  const inbox = channel({ id: 'manual_console' });

  it('solo la bandeja sin apiId push es el respaldo siempre disponible', () => {
    expect(isConsoleChannel(push)).toBe(false);
    expect(isConsoleChannel(inbox)).toBe(true);
    expect(isConsoleChannel(channel({ id: 'teams', apiId: 'teams' }))).toBe(false);
  });

  it('nombra y describe el push como avisos al navegador', () => {
    expect(channelName(push)).toBe('Avisos al navegador');
    expect(channelName(inbox)).toBe('Consola');
    expect(channelHint(push)).toContain('navegadores registrados');
    expect(channelHint(inbox)).toContain('Bandeja interna de QAPAQ');
  });

  it('resume el destino del push sin confundirlo con la bandeja', () => {
    expect(channelDestinationSummary(push)).toContain('Web Push');
    expect(channelDestinationSummary({ ...push, configured: false })).toBe('Sin configurar');
  });
});
