/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  AiActivityFeedItem,
  feedSentence,
  hostState,
  isValidAiRunId,
  normalizeActivity,
  todayShareWithoutInference,
} from './index';

const BASE_ITEM: AiActivityFeedItem = {
  key: 'k',
  at: '2026-11-14T15:00:00.000Z',
  jobId: 'job-1',
  priority: 'P3',
  subjectTitle: 'Alerta',
  kind: 'action',
  status: null,
  inference: null,
  actionKind: 'escalate',
  actionState: 'executed',
  reason: null,
  urgency: null,
  disposition: null,
  ref: null,
};

const item = (patch: Partial<AiActivityFeedItem>): AiActivityFeedItem => ({ ...BASE_ITEM, ...patch });

describe('normalizeActivity', () => {
  it('conserva null frente a 0 y descarta lo que no es número', () => {
    const activity = normalizeActivity({
      host: { enabled: true, running: true, settingsEnabled: true, mode: 'autonomous', inFlight: 0, concurrency: 2 },
      queue: { queued: 0, running: null, byPriority: { P1: 0, P2: 'x', P3: -1 } },
      today: { runs: 0, withoutInference: null, estimatedMicroUsd: 0, failed: '3' },
      backlog: { openAlertsWithoutCaseFile: null, openIncidentsWithoutCaseFile: 0 },
      feed: [],
    });
    expect(activity).not.toBeNull();
    expect(activity!.host).toMatchObject({ inFlight: 0, concurrency: 2, lastTickAt: null, lastErrorCode: null });
    expect(activity!.queue).toEqual({
      queued: 0,
      running: null,
      oldestQueuedAt: null,
      byPriority: { P1: 0, P2: null, P3: null, P4: null },
    });
    expect(activity!.today).toMatchObject({ runs: 0, withoutInference: null, estimatedMicroUsd: 0, failed: null });
    expect(activity!.backlog).toEqual({ openAlertsWithoutCaseFile: null, openIncidentsWithoutCaseFile: 0 });
  });

  it('una respuesta sin la forma del panel es null; el feed se valida, acota y deduplica', () => {
    expect(normalizeActivity(null)).toBeNull();
    expect(normalizeActivity({ correlationId: 'c' })).toBeNull();
    const entry = {
      at: '2026-11-14T15:00:00.000Z',
      jobId: 'job-1',
      priority: 'P9',
      subjectTitle: '  Título  ',
      kind: 'action',
      actionKind: 'teleport',
      actionState: 'executed',
      reason: 'bad code with spaces',
      ref: { kind: 'incident', id: 'inc-1' },
    };
    const activity = normalizeActivity({
      host: {},
      feed: [entry, entry, { jobId: 'x' }, { at: 'no-date', jobId: 'y' }, ...Array.from({ length: 80 }, (_, i) => ({ ...entry, jobId: `j${i}` }))],
    });
    expect(activity!.feed[0]).toMatchObject({
      priority: null,
      subjectTitle: 'Título',
      actionKind: 'unknown',
      reason: null,
      ref: { kind: 'incident', id: 'inc-1' },
    });
    expect(activity!.feed.length).toBeLessThanOrEqual(50);
    expect(new Set(activity!.feed.map((row) => row.key)).size).toBe(activity!.feed.length);
  });

  it('«activity» es una ruta literal, nunca un id de expediente', () => {
    expect(isValidAiRunId('activity')).toBe(false);
  });
});

describe('feedSentence', () => {
  it('inicio y cierre de corridas', () => {
    expect(feedSentence(item({ kind: 'run_started', actionKind: null, actionState: null })).text).toBe('Empezó a investigar');
    const finished = (patch: Partial<AiActivityFeedItem>) =>
      feedSentence(item({ kind: 'run_finished', actionKind: null, actionState: null, ...patch }));
    expect(finished({ status: 'completed', inference: 'none', reason: 'KNOWN_BENIGN_PATTERN' }).text).toBe(
      'Resolvió sin IA: patrón benigno conocido',
    );
    expect(finished({ status: 'completed', inference: 'none', reason: 'NEW_CODE' })).toEqual({ text: 'Resolvió sin IA', code: 'NEW_CODE' });
    expect(finished({ status: 'completed', inference: 'economy' }).text).toBe('Terminó la investigación con modelo económico');
    expect(finished({ status: 'completed', inference: 'advanced' }).text).toBe('Terminó la investigación con modelo avanzado');
    expect(finished({ status: 'requires_review', inference: 'economy' }).text).toBe('Terminó: requiere revisión humana');
    expect(finished({ status: 'failed', reason: 'LEASE_EXPIRED_MAX_ATTEMPTS' })).toEqual({
      text: 'La investigación falló',
      code: 'LEASE_EXPIRED_MAX_ATTEMPTS',
    });
    expect(finished({ status: 'budget_exhausted' }).text).toBe('Se detuvo: presupuesto diario de IA agotado');
    expect(finished({ status: 'unknown' }).text).toBe('Terminó (estado desconocido)');
  });

  it('acciones por tipo y estado', () => {
    expect(feedSentence(item({ disposition: 'created' })).text).toBe('Escaló a incidente nuevo');
    expect(feedSentence(item({ disposition: 'attached' })).text).toBe('Adjuntó a incidente existente');
    expect(feedSentence(item({})).text).toBe('Escaló a incidente');
    expect(feedSentence(item({ actionKind: 'close_benign' })).text).toBe('Cerró como benigno conocido');
    expect(feedSentence(item({ actionKind: 'acknowledge' })).text).toBe('Reconoció la alerta');
    expect(feedSentence(item({ actionKind: 'request_review', urgency: 'immediate' })).text).toBe(
      'Pidió revisión humana (inmediata)',
    );
    expect(feedSentence(item({ actionKind: 'request_review', urgency: 'digest' })).text).toBe(
      'Pidió revisión humana (en el resumen)',
    );
    expect(feedSentence(item({ actionKind: 'report' })).text).toBe('Adjuntó el informe');
    expect(feedSentence(item({ actionKind: 'unknown' })).text).toBe('Ejecutó una acción desconocida');
    expect(feedSentence(item({ actionState: 'failed' })).text).toBe('Falló al escalar a incidente');
    expect(feedSentence(item({ actionKind: 'close_benign', actionState: 'skipped', reason: 'GUARD_NOT_MET' }))).toEqual({
      text: 'Omitió cerrar como benigna conocida',
      code: 'GUARD_NOT_MET',
    });
    expect(feedSentence(item({ actionState: 'planned' })).text).toBe('Propuso escalar a incidente');
    expect(feedSentence(item({ actionState: 'unknown' })).text).toBe('Escalar a incidente (estado desconocido)');
    expect(feedSentence(item({ kind: 'unknown' })).text).toBe('Actividad no reconocida por esta consola');
  });
});

describe('hostState', () => {
  const host = {
    enabled: true,
    running: true,
    settingsEnabled: true,
    mode: 'autonomous',
    lastTickAt: null,
    lastProcessedAt: null,
    inFlight: 0,
    concurrency: 1,
    lastErrorCode: null,
  };
  it('activo con modo; apagado; detenido por proceso o por ajustes; desconocido', () => {
    expect(hostState(host)).toMatchObject({ state: 'active', label: 'Activo', detail: 'modo Autónomo', pulsing: true });
    expect(hostState({ ...host, mode: 'assisted' }).detail).toBe('modo Asistido');
    expect(hostState({ ...host, mode: 'shadow' }).detail).toBe('modo Sombra');
    expect(hostState({ ...host, enabled: false })).toMatchObject({ state: 'off', label: 'Apagado', pulsing: false });
    expect(hostState({ ...host, running: false })).toMatchObject({ state: 'stopped', label: 'Detenido', pulsing: false });
    expect(hostState({ ...host, settingsEnabled: false })).toMatchObject({
      state: 'stopped',
      detail: 'Pausado en «Configuración»: no toma alertas nuevas.',
    });
    expect(hostState({ ...host, running: null })).toMatchObject({ state: 'unknown', pulsing: false });
  });

  it('porción sin IA: solo con datos coherentes', () => {
    const today = { runs: 4, withoutInference: 3 } as never;
    expect(todayShareWithoutInference(today)).toBe(0.75);
    expect(todayShareWithoutInference({ runs: 0, withoutInference: 0 } as never)).toBeNull();
    expect(todayShareWithoutInference({ runs: null, withoutInference: 1 } as never)).toBeNull();
  });
});
