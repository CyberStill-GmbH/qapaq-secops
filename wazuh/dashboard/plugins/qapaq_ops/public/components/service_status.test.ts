/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { emptyLevels, IntegrationsConfig, OverviewResponse, ProviderStats } from '../../common';
import { providerStatus, wazuhStatus } from './service_status';

const AUTO = { state: 'auto' as const, missingPermissions: [], note: '' };
const NOW = Date.parse('2026-11-04T16:00:00Z');

function stats(lastEventAt: string | null): ProviderStats {
  return { events24h: 1, lastEventAt, levels24h: emptyLevels(), metrics: {} };
}

function overview(patch: Partial<OverviewResponse> = {}): OverviewResponse {
  const integrations = {
    wazuh: AUTO,
    office365: {
      state: 'blocked',
      missingPermissions: ['ActivityFeed.Read'],
      note: 'Pedir consentimiento',
    },
    sharepoint: { state: 'disabled', missingPermissions: [], note: 'Permisos pendientes de validar.' },
    bitdefender: AUTO,
    snyk: AUTO,
    cloudflare: AUTO,
    aws: { state: 'disabled', missingPermissions: [], note: '' },
    respond: AUTO,
    qapaqzito: AUTO,
    alertMail: AUTO,
  } as IntegrationsConfig;
  return {
    generatedAt: new Date(NOW).toISOString(),
    alertsAccess: 'ok',
    monitoringAccess: 'ok',
    siem: null,
    providers: {
      office365: stats(null),
      sharepoint: stats(null),
      bitdefender: stats('2026-11-04T15:50:00Z'),
      snyk: stats('2026-10-30T10:00:00Z'),
      cloudflare: stats('2026-11-02T10:00:00Z'),
      aws: stats(null),
    },
    topEvents: [],
    agents: { total: 1, active: 1, disconnected: 0, other: 0, groups: {}, measuredAt: null },
    integrations,
    ...patch,
  };
}

describe('estado de servicios', () => {
  it('lo declarado manda: permiso faltante, servicio no configurado', () => {
    expect(providerStatus('office365', overview(), NOW)).toEqual({
      tone: 'warn',
      label: 'Requiere permiso',
      detail: 'ActivityFeed.Read · Pedir consentimiento',
    });
    expect(providerStatus('aws', overview(), NOW).label).toBe('Deshabilitado');
  });

  it('lo medido: reciente, callado según el ritmo del proveedor', () => {
    expect(providerStatus('bitdefender', overview(), NOW).tone).toBe('ok');
    // Snyk solo emite por cambio: 5 días sin eventos sigue siendo normal.
    expect(providerStatus('snyk', overview(), NOW).tone).toBe('ok');
    expect(providerStatus('cloudflare', overview(), NOW)).toMatchObject({
      tone: 'warn',
      label: 'Silencioso',
    });
    expect(providerStatus('bitdefender', overview(), NOW).label).toBe('Operativo');
  });

  it('sin permiso de lectura no se presenta como caída', () => {
    expect(providerStatus('snyk', overview({ alertsAccess: 'forbidden' }), NOW)).toMatchObject({
      tone: 'neutral',
      label: 'Sin permiso de lectura',
    });
  });

  it('Wazuh: agentes desconectados degradan; todo activo es operativo', () => {
    expect(wazuhStatus(overview(), null).label).toBe('Operativo');
    expect(
      wazuhStatus(
        overview({
          agents: { total: 3, active: 2, disconnected: 1, other: 0, groups: {}, measuredAt: null },
        }),
        null,
      ),
    ).toMatchObject({ tone: 'warn', label: 'Agentes desconectados' });
  });

  it('monitor de plataforma: manda si es reciente; permisos solo con error de permisos', () => {
    const auto = { state: 'auto' as const, missingPermissions: [], note: '' };
    const health = (state: string, summary = '', at = '2026-11-04T15:30:00Z') => ({
      access: 'ok' as const,
      sources: {
        office365: {
          source: 'office365',
          state: state as 'ok',
          at,
          severity: 'info' as const,
          summary,
          lastSeen: null,
          since: null,
        },
      },
      problems: [],
    });
    const base = overview();
    const o = (h: ReturnType<typeof health>) =>
      ({
        ...base,
        integrations: { ...base.integrations, office365: auto },
        providers: { ...base.providers!, office365: stats('2026-11-04T15:55:00Z') },
        platformHealth: h,
      }) as OverviewResponse;
    expect(providerStatus('office365', o(health('ok')), NOW).label).toBe('Operativo');
    expect(providerStatus('office365', o(health('failing', 'HTTP 503 del proveedor')), NOW)).toMatchObject({
      tone: 'fail',
      label: 'Fallando',
    });
    expect(
      providerStatus('office365', o(health('failing', 'AF10001: permission set does not include')), NOW)
        .label,
    ).toBe('Requiere permiso');
    // Monitor atrasado («deshabilitado»/«silencioso») con eventos fluyendo: Operativo.
    expect(providerStatus('office365', o(health('disabled', 'falta ActivityFeed.Read')), NOW).label).toBe(
      'Operativo',
    );
    expect(providerStatus('office365', o(health('silent')), NOW).label).toBe('Operativo');
    // Monitor con más de 2 h: deciden los datos.
    expect(
      providerStatus('office365', o(health('failing', 'x', '2026-11-04T10:00:00Z')), NOW).label,
    ).toBe('Operativo');
    // Sin eventos: el monitor manda.
    const quiet = { ...o(health('disabled')), providers: { ...base.providers!, office365: stats(null) } };
    expect(providerStatus('office365', quiet as OverviewResponse, NOW).label).toBe('Deshabilitado');
  });
});
