/**
 * El aviso de Teams/correo incluye el contexto del correlador en «Por qué importa» cuando está
 * disponible y sale igual (sin ese contexto) cuando el correlador falla.
 */

import { describe, expect, it } from 'vitest';
import type { Alert, OutboxMessageDraft } from '@qapaq/soc';

import { notificationEnricher } from '../src/runtime/notification-enricher.js';
import { parseEntityRisk, NO_ENTITY_RISK } from '../src/runtime/entity-risk.js';
import type { SocKnowledge } from '../src/assistant/soc-knowledge.js';

const knowledge = { rules: {}, useCases: [], runbooks: [], techniques: {} } as unknown as SocKnowledge;

const alert = {
  id: 'al_1',
  tenantId: 't',
  title: 'QAPAQ M365: inicio de sesión sospechoso (wazuh 100001)',
  priority: 'P2',
  score: 60,
  reasons: [],
  status: 'open',
  occurredAt: new Date('2026-11-13T10:00:00Z'),
  entityKeys: ['user:victima@qapaq.pe'],
  entityRefs: [],
  relatedAlertIds: ['a', 'b', 'c'],
  ruleId: '100001',
  incidentId: null,
  candidateId: 'c',
} as unknown as Alert;

const message = {
  tenantId: 't',
  aggregateType: 'alert',
  messageType: 'soc.alert.created',
  aggregateId: 'al_1',
  availableAt: new Date('2026-11-13T10:00:00Z'),
  payload: {},
} as unknown as OutboxMessageDraft;

describe('contexto del correlador en los avisos', () => {
  it('agrega riesgo, fuentes y alertas relacionadas a «Por qué importa»', async () => {
    const enricher = notificationEnricher({
      alertById: async () => alert,
      knowledge,
      entityRisk: {
        snapshot: async () => ({
          available: true,
          byKey: parseEntityRisk({
            items: [
              {
                key: 'user:victima@qapaq.pe',
                score: 82,
                sources: ['aws', 'm365', 'pam'],
                candidateIds: ['rc_1'],
              },
            ],
          }),
        }),
      },
    });
    const { context } = await enricher.contextFor(message);
    expect(context.whyItMatters).toContain(
      'Contexto del correlador: Riesgo de entidad 82/100 · en cadena correlada · 3 fuentes · 3 relacionadas.',
    );
    expect(context.relatedAlertCount).toBe(3);
  });

  it('si el correlador no está disponible o falla, el aviso sale sin ese contexto', async () => {
    for (const entityRisk of [
      { snapshot: async () => NO_ENTITY_RISK },
      {
        snapshot: async () => {
          throw new Error('down');
        },
      },
      undefined,
    ]) {
      const enricher = notificationEnricher({
        alertById: async () => alert,
        knowledge,
        ...(entityRisk ? { entityRisk } : {}),
      });
      const { context } = await enricher.contextFor(message);
      expect(context.whyItMatters ?? '').not.toContain('correlador');
      expect(context.title).toContain('inicio de sesión sospechoso');
    }
  });
});
