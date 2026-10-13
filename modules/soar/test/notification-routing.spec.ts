/**
 * Sprint 5 — avisos de Teams por rol del SOC.
 *
 * Fija la política (qué eventos avisan y a qué roles) y las menciones de la tarjeta. Correos
 * sintéticos.
 */

import { describe, expect, it } from 'vitest';

import { buildTeamsMessage, FORBIDDEN_PAYLOAD_KEYS, rolesToNotify } from '../src/index.js';

describe('política de ruteo por rol', () => {
  it('P1 nueva → analista y lead; escalada → lead y admin; incidente crítico → lead y admin', () => {
    expect(
      rolesToNotify({ messageType: 'soc.alert.created', payload: { priority: 'P1' } }),
    ).toEqual(['qapaq.soc.analyst', 'qapaq.soc.lead']);
    expect(
      rolesToNotify({ messageType: 'soc.alert.escalated', payload: { priority: 'P1' } }),
    ).toEqual(['qapaq.soc.lead', 'qapaq.platform.admin']);
    expect(
      rolesToNotify({ messageType: 'soc.incident.opened', payload: { severity: 'critical' } }),
    ).toEqual(['qapaq.soc.lead', 'qapaq.platform.admin']);
  });

  it('lo que no es crítico no se notifica', () => {
    expect(
      rolesToNotify({ messageType: 'soc.alert.created', payload: { priority: 'P2' } }),
    ).toEqual([]);
    expect(
      rolesToNotify({ messageType: 'soc.alert.triaged', payload: { priority: 'P1' } }),
    ).toEqual([]);
    expect(
      rolesToNotify({ messageType: 'soc.incident.opened', payload: { severity: 'high' } }),
    ).toEqual([]);
  });
});

describe('tarjeta con menciones', () => {
  const base = {
    tenantId: 't',
    messageType: 'soc.alert.created' as const,
    aggregateType: 'alert' as const,
    aggregateId: 'a-1',
    title: 'Regla de reenvío externa',
    severity: 'P1',
    occurredAt: new Date('2026-10-13T01:00:00.000Z'),
    consoleBaseUrl: 'https://app.jappi.net.pe',
    clientRequestId: 'req-1',
  };

  it('menciona a cada destinatario por UPN y sin marcado inyectable en el nombre', () => {
    const message = buildTeamsMessage({
      ...base,
      mentions: [
        { upn: 'ana@qapaq-lab.example', displayName: 'Ana <script>' },
        { upn: 'beto@qapaq-lab.example', displayName: 'Beto' },
      ],
    });
    const card = message.attachments[0].content as {
      body: { text?: string }[];
      msteams: { entities: { text: string; mentioned: { id: string } }[] };
    };
    expect(card.msteams.entities.map((entity) => entity.mentioned.id)).toEqual([
      'ana@qapaq-lab.example',
      'beto@qapaq-lab.example',
    ]);
    expect(card.msteams.entities[0]!.text).toBe('<at>Ana script</at>');
    expect(
      card.body.some((block) => block.text === 'Para: <at>Ana script</at>, <at>Beto</at>'),
    ).toBe(true);
  });

  it('sin destinatarios no agrega menciones, y nunca lleva campos prohibidos', () => {
    const text = JSON.stringify(buildTeamsMessage(base));
    expect(text).not.toContain('msteams');
    for (const key of FORBIDDEN_PAYLOAD_KEYS) expect(text).not.toContain(`"${key}"`);
  });
});
