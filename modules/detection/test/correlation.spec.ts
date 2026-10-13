import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_COMPROMISE_CHAIN_ID,
  correlate,
  correlationHorizon,
  DEFAULT_CORRELATION_POLICY,
  entityKeysOf,
  signalOf,
  type CorrelatableAlert,
  type SignalCatalog,
} from '../src/correlation.js';
import { decidePromotion } from '../src/promotion.js';
import { prioritize, type PrioritizationContext } from '../src/prioritization.js';
import { securityEvent } from './support/events.js';

/**
 * C-16 · correlación por entidad. Las cuentas e IPs son sintéticas (RFC 5737).
 */

const USER = 'Usuario.Sintetico@qapaq-lab.example';
const USER_KEY = 'user:usuario.sintetico@qapaq-lab.example';
const IP_KEY = 'ip:203.0.113.24';
const AT = new Date('2026-10-07T15:30:00.000Z');

function m365Event(action: string, overrides: Parameters<typeof securityEvent>[0] = {}) {
  return securityEvent({
    action,
    category: ['iam', 'email'],
    outcome: 'success',
    entities: {
      identities: [{ kind: 'user', principal: USER }],
      resources: [
        { kind: 'ip', id: '203.0.113.24', type: 'client' },
        { kind: 'service', name: 'Exchange', type: 'microsoft365.workload' },
      ],
    },
    detection: {
      rule: { id: '100510', name: 'Regla de bandeja', provider: 'wazuh', groups: ['office365'] },
    },
    ...overrides,
  });
}

function alert(
  id: string,
  minutesBefore: number,
  overrides: Partial<CorrelatableAlert> = {},
): CorrelatableAlert {
  return {
    id,
    occurredAt: new Date(AT.getTime() - minutesBefore * 60_000),
    entityKeys: [USER_KEY],
    signal: 'other',
    ruleId: '999',
    ...overrides,
  };
}

/** Catálogo de prueba: el dominio no trae nombres de operación, los entrega el runtime. */
const CATALOG: SignalCatalog = {
  'office365.new-inboxrule': 'persistence',
  'office365.add-member-to-role': 'privilege_escalation',
  'office365.set-adminauditlogconfig': 'defense_evasion',
  'office365.userloginfailed': 'credential_access',
  'office365.userloggedin': 'initial_access',
  'office365.searchexported': 'exfiltration',
};

function correlateWith(
  ...args: [Parameters<typeof correlate>[0], Parameters<typeof correlate>[1]]
) {
  return correlate(args[0], args[1], DEFAULT_CORRELATION_POLICY, CATALOG);
}

const BASE_CONTEXT: PrioritizationContext = {
  privilegedIdentities: new Set(),
  criticalAssets: new Set(),
};

describe('C-16 · claves y señales', () => {
  it('deriva claves user:/ip: en minúsculas, ordenadas y sin duplicados', () => {
    expect(entityKeysOf(m365Event('office365.new-inboxrule'))).toEqual([IP_KEY, USER_KEY]);
  });

  it('ignora recursos que no son IP y entidades sin principal', () => {
    const event = securityEvent({
      entities: {
        identities: [{ kind: 'service', id: 'svc-1' }],
        resources: [{ kind: 'host', id: 'host-1' }],
      },
    });
    expect(entityKeysOf(event)).toEqual([]);
  });

  it.each([
    ['office365.new-inboxrule', 'persistence'],
    ['office365.add-member-to-role', 'privilege_escalation'],
    ['office365.set-adminauditlogconfig', 'defense_evasion'],
    ['office365.userloginfailed', 'credential_access'],
    ['office365.searchexported', 'exfiltration'],
  ] as const)('clasifica %s como %s', (action, expected) => {
    expect(signalOf(m365Event(action), CATALOG)).toBe(expected);
  });

  it('el grupo de una regla local QAPAQ prevalece sobre la acción', () => {
    const event = m365Event('office365.userloggedin', {
      detection: {
        rule: {
          id: '100501',
          name: 'Spray',
          provider: 'wazuh',
          groups: ['office365', 'qapaq_credential_access'],
        },
      },
    });
    expect(signalOf(event, CATALOG)).toBe('credential_access');
  });

  it('una autenticación sin acción conocida se clasifica por resultado', () => {
    const failed = securityEvent({ category: ['authentication'], outcome: 'failure' });
    const ok = securityEvent({ category: ['authentication'], outcome: 'success' });
    expect(signalOf(failed)).toBe('credential_access');
    expect(signalOf(ok)).toBe('initial_access');
  });
});

describe('C-16 · agrupación y repetición', () => {
  it('relaciona alertas que comparten usuario o IP dentro de la ventana', () => {
    const result = correlateWith(m365Event('office365.new-inboxrule'), [
      alert('a-user', 30),
      alert('a-ip', 60, { entityKeys: [IP_KEY] }),
      alert('a-ajena', 10, { entityKeys: ['user:otra@qapaq-lab.example'] }),
      alert('a-vieja', 25 * 60),
    ]);

    expect(result.relatedAlertIds).toEqual(['a-user', 'a-ip']);
    expect(result.relatedCount).toBe(2);
  });

  it('una alerta posterior al evento no se considera relacionada', () => {
    const result = correlateWith(m365Event('office365.new-inboxrule'), [alert('futura', -5)]);
    expect(result.relatedAlertIds).toEqual([]);
  });

  it('cuenta solo la misma regla sobre la misma entidad en la ventana de repetición', () => {
    const result = correlateWith(m365Event('office365.new-inboxrule'), [
      alert('r1', 10, { ruleId: '100510' }),
      alert('r2', 50, { ruleId: '100510' }),
      alert('r3', 90, { ruleId: '100510' }),
      alert('otra-regla', 5, { ruleId: '91532' }),
    ]);
    expect(result.recentSimilarCount).toBe(2);
  });

  it('respeta el tope de alertas listadas pero cuenta todas', () => {
    const many = Array.from({ length: 80 }, (_, index) => alert(`m-${index}`, index + 1));
    const result = correlateWith(m365Event('office365.new-inboxrule'), many);

    expect(result.relatedAlertIds).toHaveLength(DEFAULT_CORRELATION_POLICY.maximumRelated);
    expect(result.relatedCount).toBe(80);
  });
});

describe('C-16 · cadena de compromiso de cuenta', () => {
  it('detecta acceso alertado seguido de persistencia sobre el mismo usuario', () => {
    const result = correlateWith(m365Event('office365.new-inboxrule'), [
      alert('spray', 40, { signal: 'credential_access' }),
    ]);

    expect(result.chain).toEqual(
      expect.objectContaining({
        chainId: ACCOUNT_COMPROMISE_CHAIN_ID,
        precursorAlertIds: ['spray'],
      }),
    );
  });

  it('no arma cadena si el precursor solo comparte IP', () => {
    const result = correlateWith(m365Event('office365.new-inboxrule'), [
      alert('spray-ip', 40, { signal: 'credential_access', entityKeys: [IP_KEY] }),
    ]);
    expect(result.chain).toBeUndefined();
  });

  it('no arma cadena si el orden es inverso: el acceso es el evento actual', () => {
    const result = correlateWith(m365Event('office365.userloginfailed'), [
      alert('regla', 40, { signal: 'persistence' }),
    ]);
    expect(result.chain).toBeUndefined();
  });

  it('no arma cadena fuera de la ventana', () => {
    const result = correlateWith(m365Event('office365.new-inboxrule'), [
      alert('spray-viejo', 25 * 60, { signal: 'credential_access' }),
    ]);
    expect(result.chain).toBeUndefined();
  });

  it('el horizonte cubre la ventana más larga de la política', () => {
    const event = m365Event('office365.new-inboxrule');
    expect(correlationHorizon(event).getTime()).toBe(
      AT.getTime() - DEFAULT_CORRELATION_POLICY.chainWindowMs,
    );
  });
});

describe('C-16 · efecto en la priorización 1.1.0', () => {
  it('una cadena suma ATTACK_CHAIN y no puede suprimirse por mantenimiento', () => {
    const event = m365Event('office365.new-inboxrule');
    const correlation = correlateWith(event, [alert('spray', 40, { signal: 'credential_access' })]);
    const outcome = prioritize(event, {
      ...BASE_CONTEXT,
      correlation,
      maintenanceWindow: {
        from: new Date(AT.getTime() - 3_600_000),
        to: new Date(AT.getTime() + 3_600_000),
        reference: 'CHG-SINTETICO-1',
      },
    });

    expect(outcome.reasons.map((reason) => reason.code)).toContain('ATTACK_CHAIN');
    expect(outcome.suppressed).toBe(false);
  });

  it('tres o más alertas relacionadas suman CORRELATED_ENTITY', () => {
    const event = m365Event('office365.new-inboxrule');
    const correlation = correlateWith(event, [alert('x1', 5), alert('x2', 6), alert('x3', 7)]);
    const codes = prioritize(event, { ...BASE_CONTEXT, correlation }).reasons.map(
      (reason) => reason.code,
    );

    expect(codes).toContain('CORRELATED_ENTITY');
  });

  it('una cuenta break-glass siempre es P1, aun con severidad baja y regla benigna', () => {
    const event = m365Event('office365.userloggedin', {
      severity: {
        normalized: 'low',
        score: 25,
        originalValue: 3,
        originalLabel: '3',
        originalScale: 'provider-level-0-15',
        mappingId: 'wazuh.alerts.severity',
        mappingVersion: '1.1.0',
      },
    });
    const outcome = prioritize(event, {
      ...BASE_CONTEXT,
      breakGlassIdentities: new Set(['usuario.sintetico@qapaq-lab.example']),
      knownBenignRuleIds: new Set(['100510']),
    });

    expect(outcome.priority).toBe('P1');
    expect(outcome.suppressed).toBe(false);
    expect(outcome.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['BREAK_GLASS_IDENTITY']),
    );
    expect(outcome.reasons.map((reason) => reason.code)).not.toContain('PRIVILEGED_IDENTITY');
  });

  it('compara identidades sin distinguir mayúsculas', () => {
    const outcome = prioritize(m365Event('office365.new-inboxrule'), {
      ...BASE_CONTEXT,
      privilegedIdentities: new Set(['USUARIO.SINTETICO@QAPAQ-LAB.EXAMPLE']),
    });
    expect(outcome.reasons.map((reason) => reason.code)).toContain('PRIVILEGED_IDENTITY');
  });

  it('el candidato promovido conserva claves, señal, regla y relacionadas', () => {
    const event = m365Event('office365.new-inboxrule', {
      severity: {
        normalized: 'high',
        score: 75,
        originalValue: 10,
        originalLabel: '10',
        originalScale: 'provider-level-0-15',
        mappingId: 'wazuh.alerts.severity',
        mappingVersion: '1.1.0',
      },
    });
    const correlation = correlateWith(event, [alert('prev', 10)]);
    const decision = decidePromotion(event, { ...BASE_CONTEXT, correlation }, undefined, AT);
    if (decision.outcome !== 'promoted') throw new Error('se esperaba promoción');

    expect(decision.candidate).toMatchObject({
      entityKeys: [IP_KEY, USER_KEY],
      signal: 'persistence',
      ruleId: '100510',
      relatedAlertIds: ['prev'],
    });
  });
});
