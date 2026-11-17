/**
 * Valoración por reglas (sin modelo): conclusiones explicables y sin habilitar acciones.
 */
import { describe, expect, it } from 'vitest';

import {
  assessEvidence,
  buildDeterministicResult,
  closeBenignAllowed,
  DEFAULT_ANALYST_SETTINGS,
  deterministicStatus,
  triagePolicy,
  type EvidenceBundle,
  type InvestigationJob,
} from '../src/investigations/index.js';
import { alert, bundle } from './investigations-fixtures.js';

const context = (overrides: Partial<NonNullable<EvidenceBundle['context']>> = {}) => ({
  rule: {
    id: '91578',
    level: 5,
    description: 'Office 365: Events related to the MailItemsAccessed mailbox auditing action.',
    mitre: [{ id: 'T1114.002', name: 'Remote Email Collection', tactics: ['Recolección'] }],
    runbooks: ['reglas-estandar-wazuh'],
    knownFalsePositives: ['El propio dueño sincronizando su buzón.'],
    escalateWhen: ['Quien accede no es el dueño del buzón.'],
    priorityHint: 'P4',
  },
  incidents: [],
  entityRisk: null,
  activity: { entityRef: 'ent_aaa', alerts7d: 120, events24h: 400, eventsScanned: 400, complete: true },
  notifications: [],
  audit: [],
  ...overrides,
});

describe('assessEvidence', () => {
  it('actividad habitual sin riesgo ⇒ probable falso positivo, con el porqué', () => {
    const evidence = bundle({
      alerts: [alert({ priority: 'P3' })],
      history: { total: 300, falsePositive: 4, truePositive: 0, open: 0 },
      context: context(),
    });
    const result = assessEvidence(evidence, 'P3');
    expect(result.verdict).toBe('likely_false_positive');
    expect(result.confidence).toBe('medium');
    expect(result.benign.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(['PRIOR_FALSE_POSITIVES', 'RECURRING_ACTIVITY', 'ISOLATED', 'LOW_IMPACT_RULE']),
    );
    expect(result.risk).toEqual([]);
    expect(result.recommendedPriority).toBe('P4');
    expect(result.conclusion).toMatch(/^Conclusión por reglas \(sin IA\): probable falso positivo/u);
  });

  it('señales de riesgo independientes ⇒ probable verdadero positivo y prioridad sugerida más alta', () => {
    const evidence = bundle({
      alerts: [alert({ priority: 'P3' })],
      history: { total: 3, falsePositive: 0, truePositive: 1, open: 1 },
      eventSummary: {
        window: { from: 'a', to: 'b', scanned: 40, matching: 40 },
        day: { scanned: 40, matching: 40 },
        bySource: [{ value: 'Office 365', count: 40 }],
        byAction: [{ value: 'UserLoginFailed', count: 30 }],
        byOutcome: [
          { value: 'failure', count: 30 },
          { value: 'success', count: 2 },
        ],
        byCategory: [],
        firstAt: 'a',
        lastAt: 'b',
        entityScoped: true,
      },
      context: context({
        entityRisk: {
          entityRef: 'ent_aaa',
          score: 82,
          peak: 90,
          observations: 6,
          tactics: ['credential-access', 'initial-access'],
          sources: ['m365'],
        },
      }),
    });
    const result = assessEvidence(evidence, 'P3');
    expect(result.verdict).toBe('likely_true_positive');
    expect(result.confidence).toBe('medium');
    expect(result.risk.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(['PRIOR_TRUE_POSITIVE', 'HIGH_ENTITY_RISK', 'MULTI_TACTIC', 'FAILURES_THEN_SUCCESS']),
    );
    expect(result.recommendedPriority).toBe('P2');
  });

  it('la confianza de una valoración por reglas nunca es alta y baja si falta evidencia', () => {
    const evidence = bundle({
      history: { total: 300, falsePositive: 9, truePositive: 0, open: 0 },
      completeness: { complete: false, truncated: false, alertsScanned: 1, eventsScanned: 0, gaps: ['x'] },
      context: context(),
    });
    const result = assessEvidence(evidence, 'P4');
    expect(result.confidence).toBe('low');
    expect(result.conclusion).toMatch(/cautela/u);
  });
});

describe('expediente determinista con conclusión', () => {
  it('trae conclusión, porqué, hechos de la evidencia y pasos de escalado de la guía de la regla', () => {
    const evidence = bundle({
      alerts: [alert({ priority: 'P3' })],
      history: { total: 300, falsePositive: 4, truePositive: 0, open: 0 },
      context: context(),
    });
    const decision = triagePolicy({ priority: 'P3', bundle: evidence });
    const result = buildDeterministicResult({
      subject: { kind: 'alert', id: 'alert-1' },
      priority: 'P3',
      bundle: evidence,
      decision,
    });
    expect(result.summary).toMatch(/^Conclusión por reglas \(sin IA\)/u);
    expect(result.inferences.some((entry) => entry.text.startsWith('Señal de actividad habitual'))).toBe(true);
    expect(result.facts.some((entry) => entry.text.includes('MITRE ATT&CK: T1114.002'))).toBe(true);
    expect(result.nextSteps).toContain('Escalar si: Quien accede no es el dueño del buzón.');
  });

  it('la conclusión por reglas no habilita el cierre automático (exige el patrón benigno de la política)', () => {
    const evidence = bundle({
      alerts: [alert({ priority: 'P3' })],
      history: { total: 300, falsePositive: 4, truePositive: 0, open: 0 },
      context: context(),
    });
    const decision = triagePolicy({ priority: 'P3', bundle: evidence });
    const result = buildDeterministicResult({
      subject: { kind: 'alert', id: 'alert-1' },
      priority: 'P3',
      bundle: evidence,
      decision,
    });
    expect(result.verdict).toBe('likely_false_positive');
    expect(result.deterministic.reasons).not.toContain('KNOWN_BENIGN_PATTERN');
    const job = { priority: 'P3', subject: { kind: 'alert', id: 'alert-1' } } as unknown as InvestigationJob;
    const settings = {
      ...DEFAULT_ANALYST_SETTINGS,
      closeBenign: { ...DEFAULT_ANALYST_SETTINGS.closeBenign, minHistory: 1 },
    };
    expect(closeBenignAllowed(job, result, evidence, settings, { status: 'completed', inference: 'none' })).toBe(
      false,
    );
  });

  it('un verdadero positivo con señales de riesgo pasa a revisión; uno sin urgencia no molesta', () => {
    const risky = { verdict: 'likely_true_positive', deterministic: { reasons: ['RULE_ASSESSMENT_RISK'] } };
    const calm = { verdict: 'likely_true_positive', deterministic: { reasons: [] } };
    expect(deterministicStatus('completed', risky as never)).toBe('requires_review');
    expect(deterministicStatus('completed', calm as never)).toBe('completed');
    expect(
      deterministicStatus('completed', { verdict: 'likely_false_positive', deterministic: { reasons: [] } } as never),
    ).toBe('completed');
    expect(deterministicStatus('partial', risky as never)).toBe('partial');
  });
});
