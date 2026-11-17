/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AiRunDetail,
  AiRunSummary,
  Alert,
  CAPABILITIES,
  normalizeRunAlert,
  normalizeRunDetail,
  normalizeRunPage,
} from '../../common';
import {
  AlertStepError,
  getAlert,
  openIncidentForAlert,
  runAlertCommand,
  runAlertSteps,
} from '../api/alert_review';
import { QapaqApiClient, QapaqApiError } from '../api/client';
import {
  attentionSummary,
  EMPTY_FILTERS,
  falsePositiveNote,
  falsePositivePlan,
  filterRuns,
  isAlertHandled,
  isPendingReview,
  needsAttention,
  REVIEW_DONE_TEXT,
  reviewActions,
  reviewInbox,
  reviewNoteValid,
  ReviewViewer,
  threatSummary,
} from './ai_analyst_model';
import { AiReviewInboxRow, AiReviewPanelView, reviewAlertId } from './ai_analyst_review';

const NOW = Date.parse('2026-11-15T15:00:00.000Z');
const ME = 'oid-me';

function run(overrides: Record<string, unknown> = {}): AiRunDetail {
  const detail = normalizeRunDetail({
    id: 'run-1',
    status: 'requires_review',
    priority: 'P2',
    trigger: 'system',
    subject: { kind: 'alert', id: 'a-1', title: 'Acceso desde país nuevo' },
    alertCount: 1,
    inference: 'economy',
    verdict: 'inconclusive',
    confidence: 'low',
    createdAt: '2026-11-15T14:00:00.000Z',
    updatedAt: '2026-11-15T14:00:05.000Z',
    finishedAt: '2026-11-15T14:00:05.000Z',
    revision: 2,
    actionKinds: ['request_review'],
    alertIds: ['a-1'],
    result: {
      summary: 'Inicio de sesión desde un país nuevo sin otras señales.',
      verdict: 'inconclusive',
      confidence: 'low',
      facts: [],
      inferences: [],
      gaps: [],
      nextSteps: [],
      citations: [],
      verified: false,
    },
    alert: { status: 'new', assigneeId: null, assignedToYou: false, verdict: null, incidentId: null, incidentByAnalyst: false },
    ...overrides,
  });
  if (!detail) throw new Error('fixture');
  return detail;
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a-1',
    title: 'Acceso desde país nuevo',
    priority: 'P2',
    score: 60,
    status: 'new',
    assigneeId: null,
    verdict: null,
    incidentId: null,
    occurredAt: '2026-11-15T13:59:00.000Z',
    revision: 4,
    reasons: [],
    entities: [],
    ...overrides,
  };
}

function viewer(capabilities: readonly string[]): ReviewViewer {
  const set = new Set(capabilities);
  return { subjectId: ME, can: (capability) => set.has(capability) };
}

const ALL = viewer([
  CAPABILITIES.alertsRead,
  CAPABILITIES.alertsTriage,
  CAPABILITIES.alertsAssign,
  CAPABILITIES.incidentsWrite,
]);

/** Cliente falso: registra cada llamada y responde con la alerta avanzada una revisión. */
function fakeApi(options: { failAt?: number } = {}) {
  const calls: Array<{ method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }> = [];
  let current = alert();
  const api = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return { alert: current };
    },
    post: async (path: string, body: Record<string, unknown>) => {
      calls.push({ method: 'POST', path, body });
      if (options.failAt === calls.length) throw new QapaqApiError('STATE_CONFLICT', 409, 'corr-1');
      if (path === '/incidents') return { incident: { id: 'inc-9' } };
      const name = body.name as string;
      const status =
        name === 'acknowledge' || name === 'assign'
          ? current.status === 'triaged'
            ? 'triaged'
            : 'acknowledged'
          : name === 'triage'
            ? 'triaged'
            : name === 'close'
              ? 'closed'
              : current.status;
      current = {
        ...current,
        status,
        revision: (body.expectedRevision as number) + 1,
        assigneeId:
          name === 'assign'
            ? (body.assigneeId as string)
            : name === 'acknowledge'
              ? current.assigneeId ?? ME
              : current.assigneeId,
        verdict: name === 'triage' ? (body.verdict as Alert['verdict']) : current.verdict,
      };
      return { alert: current };
    },
  };
  return { api: api as unknown as QapaqApiClient, calls, set: (next: Alert) => (current = next) };
}

describe('revisión pendiente: solo mientras la alerta necesita a una persona', () => {
  it('cerrada o en un incidente de una persona ya no está pendiente; sin dato sí', () => {
    expect(isPendingReview(run())).toBe(true);
    expect(isPendingReview(run({ alert: null }))).toBe(true);
    expect(isAlertHandled(null)).toBe(false);
    expect(isPendingReview(run({ alert: { status: 'closed', verdict: 'false_positive' } }))).toBe(false);
    expect(isPendingReview(run({ alert: { status: 'acknowledged', incidentId: 'inc-1' } }))).toBe(false);
    // Un incidente que abrió el propio analista no cuenta como atención humana.
    expect(
      isPendingReview(run({ alert: { status: 'acknowledged', incidentId: 'inc-1', incidentByAnalyst: true } })),
    ).toBe(true);
    // Reconocer o asignar no basta: la alerta sigue esperando una decisión.
    expect(isPendingReview(run({ alert: { status: 'acknowledged', assigneeId: 'oi***' } }))).toBe(true);
    expect(isPendingReview(run({ status: 'completed' }))).toBe(false);
    expect(needsAttention(run({ alert: { status: 'closed' } }))).toBe(false);
    expect(needsAttention(run({ status: 'failed', alert: { status: 'closed' } }))).toBe(true);
  });

  it('«Necesita tu atención» deja de contar las revisiones atendidas y no las caduca a las 24 h', () => {
    const summary = attentionSummary({
      runs: [
        run({ id: 'pending' }),
        run({ id: 'closed', alert: { status: 'closed' } }),
        run({ id: 'incident', alert: { status: 'acknowledged', incidentId: 'inc-2' } }),
        run({ id: 'old', finishedAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z' }),
        run({ id: 'old-failed', status: 'failed', finishedAt: '2026-11-10T10:00:00.000Z' }),
      ],
      now: NOW,
    });
    expect(summary.review).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.items.map((item) => item.jobId).sort()).toEqual(['old', 'pending']);
  });

  it('la bandeja: solo pendientes, mayor prioridad primero y, a igual prioridad, la que más espera', () => {
    const runs: AiRunSummary[] = [
      run({ id: 'p3', priority: 'P3', finishedAt: '2026-11-15T10:00:00.000Z' }),
      run({ id: 'p1-new', priority: 'P1', finishedAt: '2026-11-15T12:00:00.000Z' }),
      run({ id: 'p1-old', priority: 'P1', finishedAt: '2026-11-14T12:00:00.000Z' }),
      run({ id: 'done', priority: 'P1', alert: { status: 'closed' } }),
      run({ id: 'p3', priority: 'P3', alert: { status: 'closed' } }),
    ];
    expect(reviewInbox(runs).map((item) => item.id)).toEqual(['p1-old', 'p1-new', 'p3']);
    // La vista rápida filtra sin reordenar; la bandeja ordena con `reviewInbox`.
    expect(filterRuns(runs, { ...EMPTY_FILTERS, view: 'attention' }).map((item) => item.id)).toEqual([
      'p3',
      'p1-new',
      'p1-old',
    ]);
    expect(filterRuns(runs, { ...EMPTY_FILTERS, view: 'failed' })).toEqual([]);
  });
});

describe('contrato: estado actual de la alerta en la investigación', () => {
  it('se normaliza en estricto; ausente o sin estado queda en null (sin dato)', () => {
    expect(normalizeRunAlert({ status: 'triaged', assigneeId: 'jp***', assignedToYou: true, verdict: 'benign', incidentId: null })).toEqual({
      status: 'triaged',
      assigneeId: 'jp***',
      assignedToYou: true,
      verdict: 'benign',
      incidentId: null,
      incidentByAnalyst: false,
    });
    expect(normalizeRunAlert({ status: 'raro', verdict: 'otro', assignedToYou: 'sí' })).toMatchObject({
      status: 'unknown',
      verdict: 'unknown',
      assignedToYou: false,
    });
    expect(normalizeRunAlert(undefined)).toBeNull();
    expect(normalizeRunAlert({})).toBeNull();
    const page = normalizeRunPage({ items: [{ id: 'r', status: 'requires_review', subject: {} }] });
    expect(page.items[0].alert).toBeNull();
  });
});

describe('acciones de revisión por los endpoints de alertas existentes', () => {
  it('lee la alerta y asigna con compare-and-set', async () => {
    const { api, calls } = fakeApi();
    const current = await getAlert(api, 'a-1');
    await runAlertCommand(api, current, 'assign', { assigneeId: ME });
    expect(calls).toEqual([
      { method: 'GET', path: '/alerts/a-1' },
      {
        method: 'POST',
        path: '/alerts/a-1/commands',
        body: { name: 'assign', expectedRevision: 4, assigneeId: ME },
      },
    ]);
    await expect(getAlert(api, '../x')).rejects.toThrow('no válido');
  });

  it('«falso positivo y cerrar» sobre una alerta nueva: reconocer → triar → cerrar, encadenando revisiones', async () => {
    const { api, calls } = fakeApi();
    const plan = falsePositivePlan(alert(), ALL);
    expect(plan).toEqual({ steps: [{ name: 'acknowledge' }, { name: 'triage' }, { name: 'close' }], blocked: null });
    const note = falsePositiveNote(run());
    const closed = await runAlertSteps(api, alert(), plan.steps, { subjectId: ME, verdict: 'false_positive', note });
    expect(closed.status).toBe('closed');
    expect(calls.map((call) => [call.path, call.body])).toEqual([
      ['/alerts/a-1/commands', { name: 'acknowledge', expectedRevision: 4 }],
      ['/alerts/a-1/commands', { name: 'triage', expectedRevision: 5, verdict: 'false_positive', note }],
      ['/alerts/a-1/commands', { name: 'close', expectedRevision: 6, note }],
    ]);
  });

  it('si otra persona la tiene, primero se la asigna (con alerts.assign)', async () => {
    const taken = alert({ status: 'acknowledged', assigneeId: 'svc:qapaq-ai-analyst' });
    const { api, calls, set } = fakeApi();
    set(taken);
    const plan = falsePositivePlan(taken, ALL);
    expect(plan.steps.map((step) => step.name)).toEqual(['assign', 'triage', 'close']);
    await runAlertSteps(api, taken, plan.steps, { subjectId: ME, verdict: 'false_positive', note: 'Nota suficiente.' });
    expect(calls[0].body).toEqual({ name: 'assign', expectedRevision: 4, assigneeId: ME });
    // Ya triada como falso positivo o benigna: solo se cierra, con la nota.
    expect(falsePositivePlan(alert({ status: 'triaged', verdict: 'benign' }), ALL).steps).toEqual([{ name: 'close' }]);
  });

  it('un fallo a mitad conserva lo aplicado y lo informa', async () => {
    const { api } = fakeApi({ failAt: 2 });
    const plan = falsePositivePlan(alert(), ALL);
    const failure = await runAlertSteps(api, alert(), plan.steps, {
      subjectId: ME,
      verdict: 'false_positive',
      note: 'Nota suficiente.',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AlertStepError);
    expect((failure as AlertStepError).completed).toBe(1);
    expect((failure as AlertStepError).partial.status).toBe('acknowledged');
    expect(((failure as AlertStepError).failure as QapaqApiError).message).toBe(
      'El elemento cambió mientras trabajaba en él. Vuelva a cargarlo.',
    );
  });

  it('confirmar amenaza abre el incidente por POST /incidents con la revisión de la alerta', async () => {
    const { api, calls } = fakeApi();
    const id = await openIncidentForAlert(api, alert(), {
      title: ' Acceso desde país nuevo ',
      severity: 'high',
      summary: threatSummary(run()),
    });
    expect(id).toBe('inc-9');
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/incidents',
      body: {
        alertId: 'a-1',
        title: 'Acceso desde país nuevo',
        severity: 'high',
        summary: threatSummary(run()),
        expectedAlertRevision: 4,
      },
    });
  });

  it('las notas precargadas citan el expediente y la conclusión, y respetan 10–2000 caracteres', () => {
    const note = falsePositiveNote(run());
    expect(note).toContain('expediente run-1');
    expect(note).toContain('no concluyente');
    expect(note).toContain('Inicio de sesión desde un país nuevo');
    expect(reviewNoteValid(note)).toBe(true);
    expect(reviewNoteValid('corta')).toBe(false);
    expect(reviewNoteValid('x'.repeat(2001))).toBe(false);
    const long = falsePositiveNote(run({ result: { summary: 'y'.repeat(5000), verdict: 'inconclusive' } }));
    expect(long.length).toBe(2000);
    expect(falsePositiveNote({ id: 'r', result: null })).toBe('Falso positivo confirmado tras revisar el expediente r del Analista IA.');
  });
});

describe('capacidades: se oculta lo que el API rechazaría y se explica lo que no aplica', () => {
  it('sin capacidad la acción no se muestra', () => {
    const readOnly = reviewActions(alert(), viewer([CAPABILITIES.alertsRead]));
    expect(Object.values(readOnly).every((action) => !action.visible && !action.enabled)).toBe(true);
    const triageOnly = reviewActions(alert(), viewer([CAPABILITIES.alertsRead, CAPABILITIES.alertsTriage]));
    expect(triageOnly.assign.visible).toBe(false);
    expect(triageOnly.open_incident.visible).toBe(false);
    expect(triageOnly.acknowledge).toEqual({ visible: true, enabled: true, reason: null });
    expect(triageOnly.close_false_positive.enabled).toBe(true);
  });

  it('con capacidad pero en un estado que no lo permite, se deshabilita con el motivo', () => {
    const taken = alert({ status: 'acknowledged', assigneeId: 'otra-persona' });
    const noAssign = viewer([CAPABILITIES.alertsRead, CAPABILITIES.alertsTriage]);
    expect(reviewActions(taken, noAssign).close_false_positive).toEqual({
      visible: true,
      enabled: false,
      reason: 'La alerta está asignada a otra persona y tu cuenta no puede reasignarla.',
    });
    expect(reviewActions(taken, ALL).acknowledge.reason).toBe('La alerta ya está reconocida.');
    expect(reviewActions(alert({ status: 'acknowledged', assigneeId: ME }), ALL).assign.reason).toBe(
      'Ya la tienes asignada.',
    );
    const linked = reviewActions(alert({ status: 'acknowledged', incidentId: 'inc-1' }), ALL);
    expect(linked.open_incident.enabled).toBe(false);
    expect(linked.close_false_positive.reason).toContain('incidente');
    const closed = reviewActions(alert({ status: 'closed' }), ALL);
    expect(closed.close_false_positive.reason).toBe('La alerta ya está cerrada.');
    expect(closed.assign.reason).toBe('La alerta está cerrada: ya no se reasigna.');
    expect(reviewActions(alert({ status: 'triaged', verdict: 'true_positive' }), ALL).close_false_positive.reason).toBe(
      'La alerta ya se trió como verdadero positivo.',
    );
  });

  it('el panel muestra el estado de la alerta y solo los botones permitidos', () => {
    const markup = renderToStaticMarkup(
      <AiReviewPanelView
        run={run()}
        alert={alert({ status: 'acknowledged', assigneeId: 'svc:qapaq-ai-analyst' })}
        canReadAlert
        viewer={viewer([CAPABILITIES.alertsRead, CAPABILITIES.alertsTriage])}
        basePath="/b"
        headingId="h"
      />,
    );
    expect(markup).toContain('Tu revisión');
    expect(markup).toContain('Reconocida');
    expect(markup).toContain('Analista IA');
    expect(markup).toContain('Confirmar: falso positivo y cerrar');
    expect(markup).toContain('La alerta está asignada a otra persona y tu cuenta no puede reasignarla.');
    expect(markup).toContain('Marcar revisada sin cambios');
    expect(markup).not.toContain('Asignármela');
    expect(markup).not.toContain('Confirmar amenaza: abrir incidente');
    expect(markup).toContain('data-test-subj="qapaqAiReview-open"');
  });

  it('con todos los permisos ofrece las cinco acciones; sin alerts.read solo lo explica', () => {
    const markup = renderToStaticMarkup(
      <AiReviewPanelView run={run()} alert={alert()} canReadAlert viewer={ALL} basePath="" headingId="h" />,
    );
    for (const label of [
      'Asignármela',
      'Confirmar: falso positivo y cerrar',
      'Confirmar amenaza: abrir incidente',
      'Marcar revisada sin cambios',
      'Abrir alerta',
    ]) {
      expect(markup).toContain(label);
    }
    const blind = renderToStaticMarkup(
      <AiReviewPanelView run={run()} alert={null} canReadAlert={false} viewer={viewer([])} basePath="" headingId="h" />,
    );
    expect(blind).toContain('Tu cuenta no puede ver alertas');
    expect(blind).not.toContain('Asignármela');
  });

  it('formulario de cierre con la nota precargada y confirmación tras actuar', () => {
    const note = falsePositiveNote(run());
    const form = renderToStaticMarkup(
      <AiReviewPanelView run={run()} alert={alert()} canReadAlert viewer={ALL} basePath="" headingId="h" mode="close" note={note} />,
    );
    expect(form).toContain('Nota de cierre');
    expect(form).toContain('Cerrar como falso positivo');
    expect(form).toContain('Inicio de sesión desde un país nuevo');
    const done = renderToStaticMarkup(
      <AiReviewPanelView
        run={run()}
        alert={alert({ status: 'closed', verdict: 'false_positive', assigneeId: ME })}
        canReadAlert
        viewer={ALL}
        basePath=""
        headingId="h"
        done={REVIEW_DONE_TEXT.close_false_positive}
      />,
    );
    expect(done).toContain('Alerta cerrada como falso positivo · nota guardada');
    expect(done).toContain('Revisión resuelta');
    expect(done).toContain('<strong>Tú</strong>');
  });

  it('un error del API se muestra en llano', () => {
    const markup = renderToStaticMarkup(
      <AiReviewPanelView
        run={run()}
        alert={alert()}
        canReadAlert
        viewer={ALL}
        basePath=""
        headingId="h"
        error={new QapaqApiError('RESOURCE_UNAVAILABLE', 404, 'c-1')}
      />,
    );
    expect(markup).toContain('El recurso solicitado no está disponible para su cuenta.');
  });
});

describe('bandeja de revisión', () => {
  it('cada fila ofrece revisar en línea e investigar en el expediente', () => {
    const markup = renderToStaticMarkup(
      <ul>
        <AiReviewInboxRow run={run()} basePath="/b" now={NOW} expanded={false} onToggle={() => undefined} onSelect={() => undefined} />
      </ul>,
    );
    expect(markup).toContain('Revisar aquí');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('href="/b/app/qapaq-ai-analyst?id=run-1"');
    expect(markup).toContain('Investigar');
    expect(markup).toContain('Nueva · sin asignar');
    expect(reviewAlertId(run())).toBe('a-1');
    expect(reviewAlertId({ subject: { kind: 'candidate', id: 'c', title: '' }, alertIds: ['x', 'y'] })).toBeNull();
  });
});
