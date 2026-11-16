import { describe, expect, it } from 'vitest';

import {
  buildAlertCard,
  buildAlertEmail,
  investigationLink,
  linksFor,
  type AlertNotificationInput,
} from '../src/notification-content.js';
import {
  contextFromMessage,
  entityFromKeys,
  maskText,
  sourceFromTitle,
  type NotificationContext,
} from '../src/notification-context.js';
import { maskWebhookUrl, validateTeamsWebhookUrl } from '../src/notification-channels.js';

const BASE = 'https://dev.security.qapaq.pe';
const ALERT = '0199c3a5-0000-7000-8000-000000000001';

function context(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    kind: 'alert',
    alertId: ALERT,
    incidentId: null,
    title: maskText('QAPAQ M365: rodrigo@qapaq.pe creó o modificó una regla de bandeja que reenvía u oculta correo.'),
    priority: 'P1',
    severity: null,
    source: { id: 'm365', vendor: 'Microsoft 365' },
    entity: entityFromKeys(['ip:38.25.11.230', 'user:rodrigo@qapaq.pe']),
    ruleId: '100510',
    summary: 'Ro***@qapaq.pe creó una regla de bandeja que reenvía u oculta correo.',
    whyItMatters: 'Caso de uso «Persistencia en buzón (BEC)».',
    mitre: [{ id: 'T1564.008', name: 'Email Hiding Rules' }],
    correlation: null,
    score: 92,
    reasons: ['cadena de ataque'],
    relatedAlertCount: 3,
    occurredAt: '2026-11-10T04:09:13.000Z',
    nextStep: 'Confirmar destino del reenvío (dominio externo = P1 si hay pagos involucrados).',
    runbook: { title: 'Ataques de credenciales', path: 'docs/detection-engineering/runbooks/credenciales.md' },
    test: false,
    ...overrides,
  };
}

function input(overrides: Partial<NotificationContext> = {}): AlertNotificationInput {
  const ctx = context(overrides);
  return {
    context: ctx,
    links: linksFor(BASE, ctx, 'att-1'),
    timeZone: 'America/Lima',
    occurrences: 2,
    firstSeen: '2026-11-10T04:09:13.000Z',
    lastSeen: '2026-11-10T04:14:22.000Z',
    reminder: false,
    late: true,
    attemptId: '0199bf33-0000-7000-8000-000000000001',
  };
}

describe('enmascarado y fuente', () => {
  it('enmascara correos e IPs en texto libre y en la entidad', () => {
    expect(maskText('rodrigo@qapaq.pe desde 38.25.11.230')).toBe('ro***@qapaq.pe desde 38.25.x.x');
    expect(entityFromKeys(['ip:38.25.11.230', 'user:rodrigo@qapaq.pe'])).toEqual({
      kind: 'user',
      display: 'ro***@qapaq.pe',
    });
  });

  it('reconoce el proveedor por el prefijo del título o la regla del correlador', () => {
    expect(sourceFromTitle('QAPAQ M365: algo', '100510')?.vendor).toBe('Microsoft 365');
    expect(sourceFromTitle('QAPAQ Plataforma: disco', '101807')?.vendor).toBe('Plataforma QAPAQ (monitor)');
    expect(sourceFromTitle('Cadena', 'qapaq-correlator:bec-chain')?.vendor).toBe('Correlador QAPAQ');
  });

  it('sin enriquecedor, el contexto mínimo también enmascara el título', () => {
    const minimal = contextFromMessage({
      messageId: 'm',
      tenantId: 't',
      aggregateType: 'alert',
      aggregateId: ALERT,
      messageType: 'soc.alert.created',
      schemaVersion: '1.0.0',
      idempotencyKey: 'k',
      payload: { title: 'QAPAQ Entra: franco.clavo@qapaq.pe concedió permisos', priority: 'P2', ruleId: '100522' },
      availableAt: new Date('2026-11-10T00:00:00Z'),
    });
    expect(minimal.title).toBe('QAPAQ Entra: fr***@qapaq.pe concedió permisos');
    expect(minimal.priority).toBe('P2');
    expect(minimal.source?.vendor).toBe('Microsoft Entra ID');
  });
});

describe('tarjeta de Teams', () => {
  const card = buildAlertCard({ ...input(), clientRequestId: 'c', aggregateId: ALERT });
  const content = card.attachments[0].content as Record<string, unknown>;
  const json = JSON.stringify(card);

  it('el botón primario abre la investigación de esa alerta', () => {
    const actions = content['actions'] as { title: string; url: string; style?: string }[];
    expect(actions[0]).toEqual({
      type: 'Action.OpenUrl',
      title: 'Abrir investigación',
      url: `${BASE}/app/qapaq-alerts?id=${ALERT}&investigate=1`,
      style: 'positive',
    });
    expect(actions.map((action) => action.title)).toEqual([
      'Abrir investigación',
      'Playbook en Ankay',
      'Preguntar a Qapaqzito',
      'Acusar recibo',
    ]);
    expect(actions.find((action) => action.title === 'Acusar recibo')?.url).toBe(
      `${BASE}/app/qapaq-notifications?id=att-1`,
    );
  });

  it('explica: qué pasó, por qué importa (MITRE), evidencia y siguiente paso, en español', () => {
    for (const text of [
      'P1 · Crítica · Alerta',
      'Qué pasó',
      'Por qué importa',
      'T1564.008 Email Hiding Rules',
      'Evidencia',
      '2 ocurrencias',
      '3 alerta(s) relacionada(s)',
      'Siguiente paso recomendado',
      'Microsoft 365',
      'AVISO TARDÍO',
    ]) {
      expect(json).toContain(text);
    }
    expect(content['version']).toBe('1.4');
  });

  it('no lleva correos ni IPs en claro, ni campos internos', () => {
    expect(json).not.toContain('rodrigo@');
    expect(json).not.toContain('38.25.11.230');
    expect(json).not.toMatch(/"(raw|rawRef|token|secret)"/u);
  });

  it('rotula PRUEBA y correlación cuando corresponde', () => {
    const test = JSON.stringify(
      buildAlertCard({
        ...input({
          test: true,
          correlation: {
            patternId: 'bec-chain',
            candidateId: 'cand-1',
            narrative: 'Acceso anómalo seguido de regla de reenvío.',
            stages: ['Etapa 1: acceso · regla 100505 · m365'],
            entities: ['ro***@qapaq.pe'],
          },
        }),
        clientRequestId: 'c',
        aggregateId: ALERT,
      }),
    );
    expect(test).toContain('PRUEBA');
    expect(test).toContain('Patrón bec-chain');
    expect(test).toContain('Etapa 1: acceso');
  });
});

describe('correo', () => {
  it('HTML escapado con botón primario y versión de texto equivalente', () => {
    const email = buildAlertEmail(input({ title: 'QAPAQ <script>alert(1)</script>' }));
    expect(email.subject).toMatch(/^QAPAQ SOC · P1 Crítica · /u);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain(`href="${BASE}/app/qapaq-alerts?id=${ALERT}&amp;investigate=1"`);
    expect(email.text).toContain(`Abrir investigación: ${BASE}/app/qapaq-alerts?id=${ALERT}&investigate=1`);
    expect(buildAlertEmail(input({ test: true })).subject.startsWith('[PRUEBA] ')).toBe(true);
  });

  it('el enlace profundo es estable', () => {
    expect(investigationLink(`${BASE}/`, 'a b')).toBe(`${BASE}/app/qapaq-alerts?id=a%20b&investigate=1`);
  });
});

describe('webhook de Teams', () => {
  const workflows =
    'https://abc123.6a.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/05/workflows/82e70dbb3d92/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=AbCdEfGhIjKlMnOpQrStUv';

  it('acepta Workflows y Logic Apps; rechaza HTTP, hosts ajenos y URL sin firma', () => {
    expect(validateTeamsWebhookUrl(workflows)).toMatchObject({ ok: true, kind: 'workflows' });
    expect(
      validateTeamsWebhookUrl(
        'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?api-version=2016-06-01&sig=xyz',
      ),
    ).toMatchObject({ ok: true, kind: 'logic_apps' });
    expect(validateTeamsWebhookUrl(workflows.replace('https:', 'http:'))).toEqual({ ok: false, code: 'URL_NOT_HTTPS' });
    expect(validateTeamsWebhookUrl('https://evil.example/powerautomate/automations/direct/workflows/a/triggers/manual/paths/invoke?sig=1')).toEqual({
      ok: false,
      code: 'URL_HOST_NOT_ALLOWED',
    });
    expect(validateTeamsWebhookUrl('https://x.environment.api.powerplatform.com.evil.example/a')).toMatchObject({ ok: false });
    expect(validateTeamsWebhookUrl(workflows.replace(/&sig=[^&]+/u, ''))).toEqual({ ok: false, code: 'URL_SIGNATURE_MISSING' });
    expect(validateTeamsWebhookUrl('https://user:pw@abc.environment.api.powerplatform.com/x')).toMatchObject({ ok: false });
    expect(validateTeamsWebhookUrl(42)).toEqual({ ok: false, code: 'URL_REQUIRED' });
  });

  it('la máscara no permite reconstruir la URL', () => {
    const masked = maskWebhookUrl(workflows);
    expect(masked).toBe('https://abc123.…/…QrStUv');
    expect(masked).not.toContain('sig=');
    expect(masked.length).toBeLessThan(40);
  });
});
