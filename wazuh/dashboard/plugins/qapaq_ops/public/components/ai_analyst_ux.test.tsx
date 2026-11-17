/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AiActivityFeedItem,
  AiRunDetail,
  AiRunSummary,
  AnalystSettings,
  draftFromSettings,
  normalizeActivity,
  normalizeBudget,
  normalizeRunDetail,
} from '../../common';
import { AiAttentionPanel } from './ai_analyst_activity';
import { AiBudgetTile } from './ai_analyst_budget';
import { AiCaseFile, AiConclusion } from './ai_analyst_case_file';
import {
  attentionSummary,
  budgetUsage,
  describeDetail,
  EMPTY_FILTERS,
  filterRuns,
  hasFilters,
  reasonText,
  togglePriority,
} from './ai_analyst_model';
import { ReasonTag } from './ai_analyst_parts';
import { AiRunFiltersBar } from './ai_analyst_runs';
import { AiSettingsForm, AiSettingsSummary } from './ai_analyst_settings';

const NOW = Date.parse('2026-11-14T15:00:00.000Z');

function run(overrides: Record<string, unknown> = {}): AiRunDetail {
  const detail = normalizeRunDetail({
    id: 'run-1',
    status: 'completed',
    stage: null,
    priority: 'P3',
    trigger: 'system',
    subject: { kind: 'alert', id: 'a-1', title: 'Acceso desde país nuevo' },
    alertCount: 1,
    inference: 'economy',
    verdict: 'likely_true_positive',
    confidence: 'medium',
    createdAt: '2026-11-14T14:00:00.000Z',
    updatedAt: '2026-11-14T14:00:05.000Z',
    finishedAt: '2026-11-14T14:00:05.000Z',
    revision: 2,
    actionKinds: [],
    alertIds: ['a-1'],
    events: [],
    evidence: null,
    result: {
      summary: 'Inicio de sesión anómalo.',
      verdict: 'likely_true_positive',
      confidence: 'medium',
      recommendedPriority: 'P2',
      facts: [],
      inferences: [],
      gaps: [],
      nextSteps: [],
      citations: [],
      verified: true,
      deterministic: { reasons: ['EVIDENCE_SAMPLED_FOR_MODEL', 'P2_ROUTINE'] },
    },
    actions: [],
    invocations: [],
    ...overrides,
  });
  if (!detail) throw new Error('fixture');
  return detail;
}

function feedItem(overrides: Partial<Record<string, unknown>> = {}): AiActivityFeedItem {
  const parsed = normalizeActivity({
    host: {},
    feed: [
      {
        at: '2026-11-14T14:30:00.000Z',
        jobId: 'job-esc',
        priority: 'P1',
        subjectTitle: 'Exfiltración',
        kind: 'action',
        actionKind: 'escalate',
        actionState: 'executed',
        disposition: 'created',
        ...overrides,
      },
    ],
  });
  if (!parsed) throw new Error('fixture');
  return parsed.feed[0];
}

describe('códigos del backend en lenguaje llano', () => {
  it('rotula motivos del triaje, del runner, de acciones y errores', () => {
    expect(reasonText('EVIDENCE_SAMPLED_FOR_MODEL')).toContain('muestra de los eventos');
    expect(reasonText('KNOWN_BENIGN_PATTERN')).toBe('Coincide con un patrón benigno conocido');
    expect(reasonText('VERDICT_TRUE_POSITIVE')).toBe('El veredicto apunta a un verdadero positivo');
    expect(reasonText('P1_ALWAYS_ANALYZED')).toContain('P1');
    expect(reasonText('MODEL_TIMEOUT')).toContain('tardó');
    expect(reasonText('ALGO_NUEVO')).toBeNull();
    expect(reasonText(null)).toBeNull();
    // Sin herencia de prototipo: `toString` no es un código conocido.
    expect(reasonText('toString')).toBeNull();
  });

  it('un código conocido se lee como texto; uno desconocido queda como etiqueta apagada', () => {
    const known = renderToStaticMarkup(<ReasonTag code="EVIDENCE_SAMPLED_FOR_MODEL" />);
    expect(known).toContain('muestra de los eventos');
    expect(known).toContain('title="EVIDENCE_SAMPLED_FOR_MODEL"');
    expect(known).not.toContain('>EVIDENCE_SAMPLED_FOR_MODEL<');
    const unknown = renderToStaticMarkup(<ReasonTag code="ALGO_NUEVO" />);
    expect(unknown).toContain('class="qapaqAiCode"');
    expect(unknown).toContain('>ALGO_NUEVO<');
  });

  it('el detalle de una etapa pasa a sí/no y a texto; lo desconocido queda aparte', () => {
    const entries = describeDetail({
      reason: 'EVIDENCE_SAMPLED_FOR_MODEL',
      verified: true,
      issues: 'UNCITED_FACT,CODIGO_X',
      shard: 'eu-1',
    });
    expect(entries[0]).toMatchObject({ label: 'Motivo', codes: [] });
    expect(entries[0].text).toContain('muestra de los eventos');
    expect(entries[1]).toMatchObject({ label: 'Verificado', text: 'Sí' });
    expect(entries[2].text).toBe('Hay hechos sin cita a la evidencia');
    expect(entries[2].codes).toEqual(['CODIGO_X']);
    expect(entries[3]).toMatchObject({ label: null, text: 'eu-1' });
  });

  it('el expediente no muestra códigos crudos en motivos ni en la cronología', () => {
    const markup = renderToStaticMarkup(
      <AiCaseFile
        run={run({
          events: [
            {
              sequence: 1,
              at: '2026-11-14T14:00:01.000Z',
              stage: 'model',
              kind: 'skipped',
              detail: { reason: 'EVIDENCE_SAMPLED_FOR_MODEL', shard: 'eu-1' },
            },
          ],
        })}
        basePath=""
        now={NOW}
      />,
    );
    expect(markup).toContain('Por qué decidió así');
    expect(markup).toContain('muestra de los eventos');
    expect(markup).not.toContain('>EVIDENCE_SAMPLED_FOR_MODEL<');
    expect(markup).not.toContain('reason=EVIDENCE_SAMPLED_FOR_MODEL');
    expect(markup).toContain('Detalles técnicos');
    expect(markup).toContain('shard=eu-1');
  });
});

describe('conclusión del expediente', () => {
  it('veredicto, confianza, prioridad sugerida y verificación arriba y juntos', () => {
    const markup = renderToStaticMarkup(<AiConclusion run={run()} />);
    expect(markup).toContain('Conclusión del analista');
    expect(markup).toContain('Probable verdadero positivo');
    expect(markup).toContain('data-tone="fail"');
    expect(markup).toContain('Confianza media');
    expect(markup).toContain('data-step="2"');
    expect(markup).toContain('P2');
    expect(markup).toContain('Citas verificadas');
    expect(markup).toContain('no cambió la alerta');
  });

  it('sin resultado dice por qué', () => {
    expect(
      renderToStaticMarkup(
        <AiConclusion run={run({ status: 'running', stage: 'triage', finishedAt: null, result: null })} />,
      ),
    ).toContain('sigue en curso (triaje determinista)');
    expect(renderToStaticMarkup(<AiConclusion run={run({ status: 'failed', result: null })} />)).toContain(
      'no produjo una conclusión',
    );
  });

  it('la conclusión aparece antes que el resumen y los hechos', () => {
    const markup = renderToStaticMarkup(<AiCaseFile run={run()} basePath="" now={NOW} />);
    expect(markup.indexOf('Conclusión del analista')).toBeLessThan(markup.indexOf('Inicio de sesión anómalo.'));
    expect(markup.indexOf('Inicio de sesión anómalo.')).toBeLessThan(markup.indexOf('Hechos observados'));
  });
});

describe('lo que necesita atención', () => {
  const runs: AiRunSummary[] = [
    run({ id: 'r-review', status: 'requires_review', priority: 'P3' }),
    run({ id: 'r-failed', status: 'failed', priority: 'P1', finishedAt: '2026-11-14T13:00:00.000Z' }),
    run({ id: 'r-old', status: 'failed', finishedAt: '2026-11-12T13:00:00.000Z' }),
    run({ id: 'r-ok', status: 'completed' }),
    run({ id: 'r-review', status: 'requires_review' }),
  ];

  it('cuenta revisión, fallos y escalaciones de las últimas 24 h, sin duplicar', () => {
    const summary = attentionSummary({
      runs,
      feed: [feedItem(), feedItem({ at: '2026-11-14T14:40:00.000Z' }), feedItem({ actionState: 'skipped', jobId: 'x' })],
      now: NOW,
    });
    expect(summary.review).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.escalated).toBe(1);
    expect(summary.items.map((item) => item.jobId)).toEqual(['job-esc', 'r-failed', 'r-review']);
  });

  it('el panel lleva a la lista filtrada y a cada expediente; marca el tope', () => {
    const summary = attentionSummary({ runs, feed: [feedItem()], now: NOW, capped: true });
    const markup = renderToStaticMarkup(
      <AiAttentionPanel summary={summary} basePath="/b" now={NOW} onSelect={() => undefined} onFilter={() => undefined} />,
    );
    expect(markup).toContain('Necesita tu atención');
    expect(markup).toContain('Revisión pendiente');
    expect(markup).toContain('1+');
    expect(markup).toContain('href="/b/app/qapaq-ai-analyst?id=r-failed"');
    expect(markup).toContain('Escalada a incidente');
    expect(markup).toContain('<button');
  });

  it('sin pendientes lo dice en positivo', () => {
    const markup = renderToStaticMarkup(
      <AiAttentionPanel
        summary={attentionSummary({ runs: [], now: NOW })}
        basePath=""
        now={NOW}
        onSelect={() => undefined}
      />,
    );
    expect(markup).toContain('Nada pendiente');
  });

  it('con error y sin lectura previa ofrece reintentar', () => {
    const markup = renderToStaticMarkup(
      <AiAttentionPanel summary={null} error={new Error('x')} basePath="" now={NOW} onSelect={() => undefined} onRetry={() => undefined} />,
    );
    expect(markup).toContain('No se pudo leer la lista de pendientes');
    expect(markup).toContain('Reintentar');
  });
});

describe('filtros de la lista', () => {
  const items: AiRunSummary[] = [
    run({ id: 'a', status: 'requires_review', priority: 'P1', verdict: 'inconclusive' }),
    run({ id: 'b', status: 'completed', priority: 'P3', actionKinds: ['escalate'] }),
    run({ id: 'c', status: 'running', priority: 'P2', verdict: null, finishedAt: null }),
    run({ id: 'd', status: 'completed', priority: 'P4', verdict: 'likely_false_positive', subject: { kind: 'alert', id: 'x', title: 'Ruido de VPN' } }),
  ];
  const ids = (list: readonly AiRunSummary[]) => list.map((item) => item.id);

  it('vistas rápidas, conclusión, prioridad y búsqueda', () => {
    expect(ids(filterRuns(items, EMPTY_FILTERS))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, view: 'attention' }))).toEqual(['a']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, view: 'escalated' }))).toEqual(['b']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, view: 'active' }))).toEqual(['c']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, verdict: 'none' }))).toEqual(['c']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, verdict: 'inconclusive' }))).toEqual(['a']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, priorities: ['P1', 'P4'] }))).toEqual(['a', 'd']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, query: 'vpn' }))).toEqual(['d']);
    expect(ids(filterRuns(items, { ...EMPTY_FILTERS, query: 'B' }))).toEqual(['b']);
  });

  it('sabe si hay filtros y ordena las prioridades al marcarlas', () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, query: '  ' })).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, status: 'failed' })).toBe(true);
    expect(togglePriority(['P3'], 'P1')).toEqual(['P1', 'P3']);
    expect(togglePriority(['P1', 'P3'], 'P1')).toEqual(['P3']);
  });

  it('la barra marca lo activo y solo ofrece «Quitar filtros» con filtros', () => {
    const counts = { all: 4, attention: 1, failed: 0, escalated: 1, active: 1 };
    const clean = renderToStaticMarkup(
      <AiRunFiltersBar filters={EMPTY_FILTERS} counts={counts} onChange={() => undefined} />,
    );
    expect(clean).not.toContain('Quitar filtros');
    expect(clean).toContain('aria-pressed="true"');
    expect(clean).toContain('Bandeja de revisión');
    expect(clean).toContain('Fallidas');
    const filtered = renderToStaticMarkup(
      <AiRunFiltersBar
        filters={{ ...EMPTY_FILTERS, priorities: ['P1'] }}
        counts={counts}
        onChange={() => undefined}
      />,
    );
    expect(filtered).toContain('Quitar filtros');
    expect(filtered).toMatch(/aria-pressed="true" aria-label="Prioridad P1"/u);
  });
});

describe('presupuesto', () => {
  it('suma confirmado y reservado y escala el tono al acercarse al techo', () => {
    const low = budgetUsage(
      normalizeBudget({ day: { limitMicroUsd: 2000000, settledMicroUsd: 200000, reservedMicroUsd: 100000 } }),
    );
    expect(low.usedMicroUsd).toBe(300000);
    expect(low.share).toBeCloseTo(0.15);
    expect(low.step).toBe(3);
    expect(low.tone).toBe('ok');
    const high = budgetUsage(normalizeBudget({ day: { limitMicroUsd: 1000000, settledMicroUsd: 900000 } }));
    expect(high.tone).toBe('warn');
    const over = budgetUsage(normalizeBudget({ day: { limitMicroUsd: 1000000, settledMicroUsd: 1500000 } }));
    expect(over.tone).toBe('fail');
    expect(over.step).toBe(20);
    expect(budgetUsage(normalizeBudget({ day: { limitMicroUsd: null } })).share).toBeNull();
  });

  it('la cifra del resumen dice «IA apagada» sin techo y el porcentaje con techo', () => {
    expect(
      renderToStaticMarkup(<AiBudgetTile budget={normalizeBudget({ day: { limitMicroUsd: null } })} />),
    ).toContain('IA apagada');
    const on = renderToStaticMarkup(
      <AiBudgetTile
        budget={normalizeBudget({
          inferenceEnabled: true,
          day: { limitMicroUsd: 2000000, settledMicroUsd: 500000, reservedMicroUsd: 0 },
        })}
      />,
    );
    expect(on).toContain('25 %');
    expect(on).toContain('US$ 0,5000 de US$ 2,00');
  });
});

describe('configuración', () => {
  const settings: AnalystSettings = {
    revision: 1,
    updatedAt: null,
    updatedBy: null,
    enabled: true,
    mode: 'autonomous',
    scope: { priorities: ['P1', 'P2'], inferenceMinPriority: 'P2' },
    actions: { escalate: true, requestReview: true, acknowledge: false, closeBenign: true, attachReport: false },
    escalation: { minConfidence: 'high', priorities: ['P1'] },
    closeBenign: { maxPriority: 'P4', minHistory: 5 },
    review: { notifyPriorities: ['P1'], notifyOnStatuses: ['failed'] },
    budget: { dailyCeilingMicroUsd: 2000000, maxOutputTokens: 2000, advancedTierEnabled: false },
    reports: { perRun: true, digest: 'off', digestHourLima: 8 },
    instructions: '',
  };

  it('marca las opciones de riesgo con su consecuencia', () => {
    const markup = renderToStaticMarkup(
      <AiSettingsForm
        saved={settings}
        draft={draftFromSettings(settings)}
        errors={{}}
        canEdit
        dirty={false}
        busy={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    expect(markup.match(/Riesgo alto/gu)).toHaveLength(3);
    expect(markup).toContain('sin esperar a una persona');
    expect(markup).toContain('sale de la cola abierta');
    expect(markup).toContain('dejan de verse como nuevas');
    for (const title of ['Funcionamiento', 'Qué investiga', 'Qué puede hacer por su cuenta', 'Cuándo avisa a una persona', 'Presupuesto de IA', 'Informes']) {
      expect(markup).toContain(title);
    }
  });

  it('resume lo vigente antes del formulario', () => {
    const markup = renderToStaticMarkup(<AiSettingsSummary saved={settings} />);
    expect(markup).toContain('Modo autónomo');
    expect(markup).toContain('IA con techo de US$ 2,00 al día');
    expect(markup).toContain('Actúa solo: escalar a incidente, pedir revisión humana, cerrar benignas conocidas');
  });
});
