/**
 * Explicación por dominio: cada alerta dice qué pasó, por qué importa y qué hacer.
 */
import { describe, expect, it } from 'vitest';

import {
  assessEvidence,
  buildDeterministicResult,
  closeBenignAllowed,
  DEFAULT_ANALYST_SETTINGS,
  deterministicStatus,
  explainDomain,
  triagePolicy,
  type EvidenceBundle,
  type InvestigationJob,
} from '../src/investigations/index.js';
import { alert, bundle } from './investigations-fixtures.js';

const subjectBundle = (
  domain: NonNullable<EvidenceBundle['subject']>['domain'],
  details: Record<string, string | number | boolean>,
  priority: 'P1' | 'P2' | 'P3' | 'P4' = 'P2',
): EvidenceBundle =>
  bundle({
    alerts: [alert({ priority, entityRefs: [], signal: 'other' })],
    subject: { domain, details },
  });

const caseFile = (evidence: EvidenceBundle, priority: 'P1' | 'P2' | 'P3' | 'P4' = 'P2') =>
  buildDeterministicResult({
    subject: { kind: 'alert', id: 'alert-1' },
    priority,
    bundle: evidence,
    decision: triagePolicy({ priority, bundle: evidence }),
  });

describe('vulnerabilidad', () => {
  it('KEV y expuesta: problema real y urgente, con el CVE, el activo y qué hacer', () => {
    const evidence = subjectBundle('vulnerability', {
      cve: 'CVE-2026-125350',
      asset: 'qapaq_services:quoter-webapp/Dockerfile',
      kev: 'true',
      epss: '0.42',
      reason: 'kev,expuesta',
      priority: 'P1',
    });
    const explained = explainDomain(evidence)!;
    expect(explained.whatHappened).toContain('CVE-2026-125350');
    expect(explained.whatHappened).toContain('quoter-webapp');
    expect(explained.risk.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(['KEV_EXPLOITED', 'HIGH_EPSS', 'EXPOSED_ASSET']),
    );
    const result = caseFile(evidence);
    expect(result.verdict).toBe('likely_true_positive');
    expect(result.summary).toMatch(/^Vulnerabilidad\. Qué pasó: Se detectó la vulnerabilidad CVE-2026-125350/u);
    expect(result.summary).toContain('con urgencia');
    expect(result.nextSteps.join(' ')).toMatch(/urgente/u);
    expect(result.deterministic.reasons).toContain('RULE_ASSESSMENT_RISK');
    expect(deterministicStatus('completed', result)).toBe('requires_review');
    // «Sin entidad» no es un vacío para una vulnerabilidad.
    expect(result.gaps.join(' ')).not.toMatch(/Sin referencia de entidad/u);
  });

  it('no expuesta y con EPSS bajo: hallazgo real sin urgencia, no pide revisión', () => {
    const evidence = subjectBundle('vulnerability', {
      cve: 'CVE-2026-1',
      asset: 'repo/app',
      kev: 'false',
      epss: '0.001',
      reason: 'no_expuesta,sin_fix',
    }, 'P4');
    const result = caseFile(evidence, 'P4');
    expect(result.verdict).toBe('likely_true_positive');
    expect(result.summary).toContain('sin urgencia inmediata');
    expect(result.deterministic.reasons).not.toContain('RULE_ASSESSMENT_RISK');
    expect(deterministicStatus('completed', result)).toBe('completed');
  });
});

describe('plataforma', () => {
  it('disco por encima del umbral: explica el impacto y cómo liberarlo', () => {
    const evidence = subjectBundle('platform', {
      check: 'host_disk',
      status: 'problem',
      component: '/var/lib/docker',
      summary: 'Disco /var/lib/docker al 92% (libre 7.9 GiB, umbral 85%).',
    });
    const result = caseFile(evidence);
    expect(result.summary).toMatch(/^Salud de la plataforma\. Qué pasó: Disco \/var\/lib\/docker al 92%/u);
    expect(result.summary).toMatch(/Indexer deja de escribir/u);
    expect(result.nextSteps[0]).toMatch(/Liberar espacio/u);
    expect(deterministicStatus('completed', result)).toBe('requires_review');
  });

  it('recuperado: no es un problema vigente', () => {
    const explained = explainDomain(
      subjectBundle('platform', { check: 'service_down', status: 'ok', summary: 'Recuperado.' }),
    )!;
    expect(explained.confirmedIssue).toBe(false);
    expect(explained.benign.map((signal) => signal.code)).toContain('PLATFORM_RECOVERED');
  });
});

describe('integridad de archivos y rootcheck', () => {
  it('cambio en una ruta sensible es señal de riesgo; en releases de QAPAQ, actividad habitual', () => {
    const sensitive = explainDomain(subjectBundle('file_integrity', { path: '/etc/sudoers', event: 'modified' }))!;
    expect(sensitive.risk.map((signal) => signal.code)).toContain('SENSITIVE_PATH');
    const expected = explainDomain(
      subjectBundle('file_integrity', { path: '/opt/qapaq/releases/2026/app.js', event: 'added' }),
    )!;
    expect(expected.benign.map((signal) => signal.code)).toContain('EXPECTED_PATH');
    expect(expected.whatHappened).toMatch(/se creó/u);
  });

  it('rootcheck en capas de Docker es el falso positivo conocido', () => {
    const explained = explainDomain(
      subjectBundle('rootcheck', { file: '/var/lib/docker/overlay2/abc/merged/bin/x' }),
    )!;
    expect(explained.benign.map((signal) => signal.code)).toContain('DOCKER_OVERLAY');
    expect(explained.risk).toEqual([]);
  });
});

describe('seguridad', () => {
  it('una señal de riesgo del dominio impide cualquier cierre automático', () => {
    const evidence = {
      ...subjectBundle('file_integrity', { path: '/etc/sudoers' }, 'P4'),
      history: { total: 100, falsePositive: 10, truePositive: 0, open: 0 },
    };
    const result = caseFile(evidence, 'P4');
    const job = { priority: 'P4', subject: { kind: 'alert', id: 'alert-1' } } as unknown as InvestigationJob;
    const forced = {
      ...result,
      verdict: 'likely_false_positive' as const,
      deterministic: { reasons: [...result.deterministic.reasons, 'KNOWN_BENIGN_PATTERN'] },
    };
    expect(
      closeBenignAllowed(job, forced, evidence, DEFAULT_ANALYST_SETTINGS, {
        status: 'completed',
        inference: 'none',
      }),
    ).toBe(false);
  });

  it('sin detalles del evento no hay explicación de dominio (se usa la valoración general)', () => {
    expect(explainDomain(bundle())).toBeNull();
    expect(assessEvidence(bundle(), 'P3').explanation).toBeNull();
  });
});
