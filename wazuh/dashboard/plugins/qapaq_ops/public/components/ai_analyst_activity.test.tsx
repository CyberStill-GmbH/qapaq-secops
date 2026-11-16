/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiActivity, normalizeActivity } from '../../common';
import {
  AiActivityFeed,
  AiActivityHeader,
  AiActivityKpis,
  AiActivityPanel,
  AiAnalystMascot,
} from './ai_analyst_activity';

const NOW = Date.parse('2026-11-14T15:00:30.000Z');
const BASE = '/osd';

function activity(overrides: Record<string, unknown> = {}): AiActivity {
  const parsed = normalizeActivity({
    host: {
      enabled: true,
      running: true,
      settingsEnabled: true,
      mode: 'autonomous',
      lastTickAt: '2026-11-14T15:00:00.000Z',
      lastProcessedAt: '2026-11-14T14:58:00.000Z',
      inFlight: 1,
      concurrency: 2,
      lastErrorCode: null,
    },
    queue: { queued: 3, running: 1, oldestQueuedAt: '2026-11-14T14:00:00.000Z', byPriority: { P1: 1, P2: 0, P3: 2, P4: 0 } },
    today: {
      day: '2026-11-14',
      runs: 4,
      withoutInference: 3,
      economy: 1,
      advanced: 0,
      escalated: 1,
      incidentsCreated: 1,
      incidentsAttached: 0,
      closedBenign: 2,
      acknowledged: 0,
      reviewRequested: 2,
      reviewImmediate: 1,
      reviewDigest: 1,
      failed: 0,
      estimatedMicroUsd: 1900,
    },
    backlog: { openAlertsWithoutCaseFile: null, openIncidentsWithoutCaseFile: 2 },
    feed: [
      {
        at: '2026-11-14T15:00:00.000Z',
        jobId: 'job-1',
        priority: 'P1',
        subjectTitle: '<script>alert(1)</script> acceso',
        kind: 'action',
        actionKind: 'escalate',
        actionState: 'executed',
        disposition: 'created',
        ref: { kind: 'incident', id: 'inc 1' },
      },
      {
        at: '2026-11-14T14:59:00.000Z',
        jobId: 'job-2',
        priority: 'P4',
        subjectTitle: 'Ruido conocido',
        kind: 'run_finished',
        status: 'completed',
        inference: 'none',
        reason: 'KNOWN_BENIGN_PATTERN',
      },
    ],
    ...overrides,
  });
  if (!parsed) throw new Error('fixture');
  return parsed;
}

describe('mascota', () => {
  it('usa el basePath, ambos tamaños y dimensiones fijas', () => {
    const html = renderToStaticMarkup(<AiAnalystMascot basePath={BASE} />);
    expect(html).toContain('src="/osd/ui/qapaq/qapaq-ai-analyst-qapaqzito-160.webp"');
    expect(html).toContain('/osd/ui/qapaq/qapaq-ai-analyst-qapaqzito-160.webp 1x, /osd/ui/qapaq/qapaq-ai-analyst-qapaqzito.webp 2x');
    expect(html).toContain('alt="Analista IA"');
    expect(html).toContain('width="142"');
    expect(html).toContain('height="160"');
    expect(html).not.toContain('loading="lazy"');
  });
});

describe('cabecera', () => {
  it('activo: modo, último ciclo, simultáneas y punto que late', () => {
    const html = renderToStaticMarkup(<AiActivityHeader host={activity().host} basePath={BASE} now={NOW} />);
    expect(html).toContain('Activo');
    expect(html).toContain('modo Autónomo');
    expect(html).toContain('data-pulse="true"');
    expect(html).toContain('hace 30 segundos');
    expect(html).toContain('1 / 2');
  });

  it('detenido y apagado no laten y dicen por qué; el fallo vigente va en mono', () => {
    const stopped = activity().host;
    const html = renderToStaticMarkup(
      <AiActivityHeader host={{ ...stopped, running: false, lastErrorCode: 'RUNNER_FAILED' }} basePath={BASE} now={NOW} />,
    );
    expect(html).toContain('Detenido');
    expect(html).toContain('data-pulse="false"');
    expect(html).toContain('RUNNER_FAILED');
    const off = renderToStaticMarkup(
      <AiActivityHeader host={{ ...stopped, enabled: false, lastTickAt: null }} basePath={BASE} now={NOW} />,
    );
    expect(off).toContain('Apagado');
    expect(off).toContain('data-pulse="false"');
    expect(off).toContain('Sin dato');
  });
});

describe('KPI del día', () => {
  it('relato de costo: porción sin IA y costo rotulado como estimado; null es «Sin dato»', () => {
    const html = renderToStaticMarkup(<AiActivityKpis today={activity().today} />);
    expect(html).toContain('75,0 %');
    expect(html).toContain('(estimado)');
    expect(html).toContain('día de Lima');
    const empty = renderToStaticMarkup(
      <AiActivityKpis today={{ ...activity().today, estimatedMicroUsd: null, runs: null }} />,
    );
    expect(empty).toContain('Sin dato');
  });
});

describe('feed', () => {
  it('frases, enlaces al expediente y a la referencia, texto escapado', () => {
    const html = renderToStaticMarkup(
      <AiActivityFeed feed={activity().feed} basePath={BASE} onSelect={() => undefined} />,
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Escaló a incidente nuevo');
    expect(html).toContain('Resolvió sin IA: patrón benigno conocido');
    expect(html).toContain('href="/osd/app/qapaq-ai-analyst?id=job-1"');
    expect(html).toContain('href="/osd/app/qapaq-incidents?id=inc%201"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('data-qapaq-no-translate');
  });

  it('vacío explícito', () => {
    const html = renderToStaticMarkup(<AiActivityFeed feed={[]} basePath={BASE} onSelect={() => undefined} />);
    expect(html).toContain('Sin actividad en las últimas 24 horas.');
  });

  it('el panel completo muestra la cola por prioridad y el atraso sin dato', () => {
    const html = renderToStaticMarkup(
      <AiActivityPanel activity={activity()} basePath={BASE} now={NOW} onSelect={() => undefined} />,
    );
    expect(html).toContain('Alertas abiertas sin expediente');
    expect(html).toContain('Sin dato');
    expect(html).toContain('hace 1 hora');
  });
});
