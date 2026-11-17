/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { NotificationAttempt } from '../../common';
import {
  deliveryLines,
  describeGroup,
  groupNotifications,
  latestByChannel,
  maskEntity,
} from './notification_groups';
import { webhookProblem } from './notification_groups';

const base: NotificationAttempt = {
  id: 'n1',
  status: 'sent',
  channel: 'teams',
  attemptCount: 1,
  sentAt: '2026-11-10T10:00:00Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
  lastFailureClass: null,
};

describe('bandeja de notificaciones', () => {
  it('agrupa los avisos repetidos de la misma alerta', () => {
    const groups = groupNotifications([
      { ...base, id: 'a', alertId: 'x' },
      { ...base, id: 'b', alertId: 'x', sentAt: '2026-11-10T11:00:00Z' },
      { ...base, id: 'c', incidentId: 'i1' },
      { ...base, id: 'd' },
    ]);
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ['alert:x', 2],
      ['incident:i1', 1],
      ['attempt:d', 1],
    ]);
    expect(groups[0].latest.id).toBe('b');
  });

  it('entrega por intento: enviado, fallido con motivo y reconocido por quién', () => {
    expect(deliveryLines(base).map((l) => l.kind)).toEqual(['sent']);
    expect(
      deliveryLines({ ...base, status: 'failed', lastFailureClass: 'TRANSPORT_TIMEOUT' })[0],
    ).toMatchObject({ kind: 'failed', reason: 'TRANSPORT_TIMEOUT' });
    const acked = deliveryLines({
      ...base,
      status: 'acknowledged',
      acknowledgedAt: '2026-11-10T10:05:00Z',
      acknowledgedBy: 'lider@qapaq.pe',
    });
    expect(acked.map((l) => l.kind)).toEqual(['sent', 'acknowledged']);
    expect(acked[1].actor).toBe('lider@qapaq.pe');
  });

  it('usa el historial de la API cuando llega y su enlace a Teams', () => {
    const lines = latestByChannel([
      {
        ...base,
        deliveries: [
          { attempt: 1, channel: 'teams', outcome: 'sent', at: '2026-11-10T10:00:00Z' },
          {
            attempt: 1,
            channel: 'teams',
            outcome: 'delivered',
            at: '2026-11-10T10:00:05Z',
            link: 'https://teams.microsoft.com/l/message/x',
          },
        ],
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'delivered',
      link: 'https://teams.microsoft.com/l/message/x',
    });
  });

  it('lee el DTO actual de notificaciones y distingue aceptación del proveedor', () => {
    const apiItem: NotificationAttempt = {
      ...base,
      title: 'QAPAQ Microsoft 365: envío anómalo',
      summary: 'Se observó una operación de envío atípica.',
      whyItMatters: 'La cuenta requiere revisión del SOC.',
      nextStep: 'Revisar la actividad de la cuenta en QAPAQ.',
      source: 'Microsoft 365',
      sourceId: 'office365',
      ruleId: '101701',
      entity: { kind: 'user', display: 'us***@qapaq.pe' },
      alertId: 'alert-71',
      delivery: [
        {
          attempt: 1,
          channel: 'teams',
          outcome: 'accepted',
          at: '2026-11-10T10:00:00Z',
          responseAt: '2026-11-10T10:00:01Z',
          httpStatus: 202,
          providerLink: 'https://teams.microsoft.com/l/message/test',
          reason: null,
        },
      ],
    };
    const group = groupNotifications([apiItem])[0]!;
    const info = describeGroup(group, null);
    const lines = deliveryLines(apiItem);

    expect(info).toMatchObject({
      title: 'QAPAQ Microsoft 365: envío anómalo',
      summary: 'Se observó una operación de envío atípica.',
      whyItMatters: 'La cuenta requiere revisión del SOC.',
      nextStep: 'Revisar la actividad de la cuenta en QAPAQ.',
      ruleId: '101701',
      entity: 'us***@qapaq.pe',
      vendor: 'office365',
    });
    expect(lines[0]).toMatchObject({
      kind: 'sent',
      channel: 'teams',
      at: '2026-11-10T10:00:01Z',
      link: 'https://teams.microsoft.com/l/message/test',
    });
  });

  it('normaliza la evidencia real del API sin inventar un número de intento', () => {
    const apiItem: NotificationAttempt = {
      ...base,
      delivery: [
        {
          channel: 'teams',
          outcome: 'accepted',
          at: '2026-11-12T10:00:00Z',
          responseAt: '2026-11-12T10:00:01Z',
          httpStatus: 202,
          providerMessageId: 'workflow-run-71',
          providerLink: null,
          reason: null,
        },
      ],
    };

    expect(deliveryLines(apiItem)[0]).toMatchObject({
      channel: 'teams',
      attempt: null,
      kind: 'sent',
      at: '2026-11-12T10:00:01Z',
    });
  });

  it('representa avisos agrupados y sustituidos sin marcarlos como enviados', () => {
    expect(
      deliveryLines({ ...base, status: 'suppressed', suppressionReason: 'grouped' })[0],
    ).toMatchObject({
      kind: 'suppressed',
      reason: 'grouped',
    });
    expect(
      deliveryLines({ ...base, status: 'superseded', coveredBy: 'attempt-newer' })[0],
    ).toMatchObject({
      kind: 'superseded',
      reason: 'attempt-newer',
    });
  });

  it('enmascara entidades en claro', () => {
    expect(maskEntity('isabel.saravia@qapaq.pe')).toBe('is***@qapaq.pe');
    expect(maskEntity('18.214.220.109')).toBe('18.214.x.x');
    expect(maskEntity(null)).toBeNull();
  });

  it('valida el webhook de Teams (Workflows) sin aceptar conectores retirados', () => {
    expect(
      webhookProblem(
        'https://prod-00.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=xyz',
      ),
    ).toBeNull();
    expect(webhookProblem('http://x.logic.azure.com/workflows/a')).toMatch(/https/);
    expect(webhookProblem('https://qapaq.webhook.office.com/webhookb2/x')).toMatch(/Workflows/);
    expect(webhookProblem('https://evil.example.com/hook')).toMatch(/host/);
    expect(webhookProblem('')).toMatch(/Pega/);
  });
});
