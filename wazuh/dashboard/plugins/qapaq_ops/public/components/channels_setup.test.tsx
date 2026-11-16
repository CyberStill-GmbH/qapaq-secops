/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotificationChannelView } from '../../common';
import { ChannelsUnavailable } from './channels_panel';
import { TeamsSetupGuide, teamsSetupStep } from './channels_setup';

const teams = (overrides: Partial<NotificationChannelView> = {}): NotificationChannelView => ({
  id: 'teams',
  apiId: 'teams',
  enabled: false,
  configured: false,
  state: 'unconfigured',
  target: null,
  lastDelivery: null,
  ...overrides,
});

const guide = (channel: NotificationChannelView, canManage = true) =>
  renderToStaticMarkup(
    <TeamsSetupGuide
      channel={channel}
      canManage={canManage}
      busy={false}
      onConfigure={() => undefined}
      onEnable={() => undefined}
      onTest={() => undefined}
      onRefresh={() => undefined}
    />,
  );

describe('puesta en marcha de Teams', () => {
  it('avanza configurar → activar → probar → verificar según lo que informa el API', () => {
    expect(teamsSetupStep(teams())).toBe('configure');
    expect(teamsSetupStep(teams({ configured: true, state: 'inactive' }))).toBe('enable');
    expect(teamsSetupStep(teams({ configured: true, enabled: true, state: 'unknown' }))).toBe('test');
    expect(
      teamsSetupStep(
        teams({
          configured: true,
          enabled: true,
          state: 'failing',
          lastDelivery: { ok: false, at: '2026-11-13T10:00:00Z', reason: 'HTTP 404' },
        }),
      ),
    ).toBe('test');
    expect(
      teamsSetupStep(
        teams({
          configured: true,
          enabled: true,
          state: 'active',
          lastDelivery: { ok: true, at: '2026-11-13T10:00:00Z' },
        }),
      ),
    ).toBe('verify');
  });

  it('en un despliegue nuevo ofrece configurar y no da el canal por listo', () => {
    const html = guide(teams());
    expect(html).toContain('Configurar Microsoft Teams');
    expect(html).toContain('Crea un flujo de Workflows');
    expect(html).not.toContain('Microsoft aceptó la última solicitud');
  });

  it('configurado pero apagado ofrece activar', () => {
    const html = guide(teams({ configured: true, state: 'inactive' }));
    expect(html).toContain('Activar Microsoft Teams');
    expect(html).toContain('Webhook guardado y protegido');
  });

  it('tras la aceptación de Microsoft pide verificar en el canal y no afirma entrega', () => {
    const html = guide(
      teams({
        configured: true,
        enabled: true,
        state: 'active',
        target: 'https://prod-00.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRET',
        lastDelivery: { ok: true, at: '2026-11-13T10:00:00Z' },
      }),
    );
    expect(html).toContain('Microsoft aceptó la última solicitud registrada');
    expect(html).toContain('no confirma la publicación ni la lectura');
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('logic.azure.com');
  });

  it('sin permiso de administración solo permite actualizar el estado', () => {
    const html = guide(teams(), false);
    expect(html).not.toContain('Configurar Microsoft Teams');
    expect(html).toContain('Un administrador de la plataforma');
    expect(html).toContain('Actualizar estado');
  });
});

describe('gestión de canales no disponible', () => {
  it('distingue la falta de permiso de una API que no sirve los canales', () => {
    const forbidden = renderToStaticMarkup(<ChannelsUnavailable problem="forbidden" />);
    const unavailable = renderToStaticMarkup(<ChannelsUnavailable problem="unavailable" />);
    expect(forbidden).toContain('no tiene permiso');
    expect(forbidden).not.toContain('no está sirviendo');
    expect(unavailable).toContain('no está sirviendo la gestión de canales');
    expect(unavailable).toContain('no es un problema de permisos');
  });
});
