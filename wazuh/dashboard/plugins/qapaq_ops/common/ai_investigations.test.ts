/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  actionApplies,
  actionKindShort,
  actionReasonLabel,
  AI_RUN_STATUS_LABEL,
  AI_RUN_STATUSES,
  AnalystSettings,
  buildProgressTimeline,
  canCancel,
  canRetry,
  changedAlert,
  deterministicReasonLabel,
  digestRangeError,
  draftFromSettings,
  draftsEqual,
  evidenceSourceStateLabel,
  formatCount,
  formatDuration,
  formatMicroUsd,
  formatShare,
  inferenceLabel,
  inferenceOff,
  isActive,
  isTerminal,
  isValidAiRunId,
  isValidAlertId,
  localDay,
  mergeRuns,
  microUsdToUsdText,
  normalizeBudget,
  normalizeDigest,
  normalizeRunDetail,
  normalizeRunPage,
  normalizeRunReport,
  normalizeRunSummary,
  normalizeSettings,
  normalizeSettingsView,
  safeMarkdownFilename,
  sanitizeErrorCode,
  settingsFromDraft,
  settingsRisk,
  shareWithoutInference,
  stageLabel,
  usdTextToMicroUsd,
  verdictLabel,
} from './ai_investigations';
import { QAPAQ_APPS } from './index';
import { NAV_PLACEMENT } from './navigation';

const SUMMARY = {
  id: 'run-1',
  status: 'running',
  stage: 'triage',
  priority: 'P2',
  trigger: 'system',
  initiatedBy: null,
  subject: { kind: 'alert', id: 'a-1', title: 'Inicio de sesión imposible' },
  alertCount: 1,
  inference: null,
  verdict: null,
  confidence: null,
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:05.000Z',
  finishedAt: null,
  revision: 3,
  estimatedCostMicroUsd: null,
  actionKinds: [],
};

const SETTINGS: AnalystSettings = {
  revision: 4,
  updatedAt: '2026-11-13T09:00:00.000Z',
  updatedBy: 'li***@qapaq.pe',
  enabled: true,
  mode: 'shadow',
  scope: { priorities: ['P1', 'P2', 'P3'], inferenceMinPriority: 'P2' },
  actions: {
    escalate: false,
    requestReview: true,
    acknowledge: false,
    closeBenign: false,
    attachReport: true,
  },
  escalation: { minConfidence: 'high', priorities: ['P1', 'P2'] },
  closeBenign: { maxPriority: 'P4', minHistory: 5 },
  review: { notifyPriorities: ['P1'], notifyOnStatuses: ['requires_review', 'failed'] },
  budget: { dailyCeilingMicroUsd: 2500000, maxOutputTokens: 2000, advancedTierEnabled: false },
  reports: { perRun: true, digest: 'daily', digestHourLima: 8 },
  instructions: 'Prioriza cuentas privilegiadas.',
};

describe('normalizadores del Analista IA', () => {
  it('conserva null como ausencia de dato y nunca lo convierte en cero', () => {
    const run = normalizeRunSummary(SUMMARY)!;
    expect(run.estimatedCostMicroUsd).toBeNull();
    expect(run.inference).toBeNull();
    expect(run.verdict).toBeNull();
    expect(run.priority).toBe('P2');
    expect(formatMicroUsd(run.estimatedCostMicroUsd)).toBe('Sin dato');
    expect(formatCount(null)).toBe('Sin dato');
    expect(formatCount(0)).toBe('0');
  });

  it('un enum desconocido queda neutro en vez de romper la vista', () => {
    const run = normalizeRunSummary({
      ...SUMMARY,
      status: 'hibernating',
      inference: 'quantum',
      verdict: 'maybe',
      priority: 'P9',
      trigger: 'cron',
      subject: { kind: 'cluster', id: 'x', title: 't' },
    })!;
    expect(run.status).toBe('unknown');
    expect(AI_RUN_STATUS_LABEL[run.status]).toBe('Estado desconocido');
    expect(run.inference).toBe('unknown');
    expect(run.verdict).toBe('unknown');
    expect(run.priority).toBeNull();
    expect(run.trigger).toBe('unknown');
    expect(run.subject.kind).toBe('unknown');
    expect(isActive(run.status)).toBe(false);
    expect(isTerminal(run.status)).toBe(false);
  });

  it('descarta filas sin id, duplicados y números imposibles', () => {
    expect(normalizeRunSummary(null)).toBeNull();
    expect(normalizeRunSummary({ status: 'queued' })).toBeNull();
    const page = normalizeRunPage({
      items: [SUMMARY, SUMMARY, { nope: true }, { ...SUMMARY, id: 'run-2', revision: -1 }],
      nextCursor: 'c2',
    });
    expect(page.items.map((run) => run.id)).toEqual(['run-1', 'run-2']);
    expect(page.items[1].revision).toBeNull();
    expect(page.nextCursor).toBe('c2');
    expect(normalizeRunPage('<html>')).toEqual({ items: [], nextCursor: null });
  });

  it('normaliza el expediente: eventos ordenados, resultado, acciones e invocaciones', () => {
    const detail = normalizeRunDetail({
      ...SUMMARY,
      status: 'completed',
      policyVersion: 'p-7',
      attempt: 1,
      lastErrorCode: null,
      cancelRequested: false,
      alertIds: ['a-1', 7, ''],
      events: [
        { sequence: 2, at: '2026-11-13T10:00:03.000Z', stage: 'triage', kind: 'completed', detail: {} },
        {
          sequence: 1,
          at: '2026-11-13T10:00:01.000Z',
          stage: 'triage',
          kind: 'started',
          detail: { rules: 4, nested: { no: 1 }, ok: true },
        },
        { sequence: 3, stage: '', kind: 'started' },
      ],
      evidence: {
        complete: true,
        truncated: false,
        alertsScanned: 1,
        eventsScanned: 0,
        sources: [{ id: 'm365', label: 'Microsoft 365', state: 'healthy', fresh: null }, {}],
        gaps: ['sin registros de VPN'],
      },
      result: {
        summary: 'Resumen',
        verdict: 'likely_false_positive',
        confidence: 'high',
        recommendedPriority: 'P4',
        facts: [{ text: 'Hecho', citations: ['alert:a-1'] }, { citations: [] }],
        inferences: [],
        gaps: [],
        nextSteps: ['Revisar'],
        citations: [{ kind: 'alert', id: 'a-1', label: 'Alerta a-1' }, { kind: 'x' }],
        verified: 'yes',
        deterministic: { reasons: ['KNOWN_BENIGN_PATTERN', 'NEW_CODE'] },
      },
      usage: null,
      invocations: [{ phase: 'analysis', tier: 'economy', model: 'm', state: 'usage_unknown' }],
      actions: [
        {
          id: 'act-1',
          kind: 'close_benign',
          state: 'executed',
          reason: 'KNOWN_BENIGN_PATTERN',
          at: '2026-11-13T10:00:04.000Z',
          executedAt: '2026-11-13T10:00:04.500Z',
          ref: { kind: 'alert', id: 'a-1' },
          errorCode: null,
        },
        { id: 'act-2', kind: 'teleport', state: 'weird', reason: null, ref: null },
      ],
    })!;
    expect(detail.alertIds).toEqual(['a-1']);
    expect(detail.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(detail.events[0].detail).toEqual({ rules: 4, ok: true });
    expect(detail.evidence!.sources).toHaveLength(1);
    expect(detail.evidence!.eventsScanned).toBe(0);
    expect(detail.result!.facts).toHaveLength(1);
    expect(detail.result!.citations).toHaveLength(1);
    // Solo `true` explícito cuenta como verificado.
    expect(detail.result!.verified).toBe(false);
    expect(detail.result!.deterministicReasons).toEqual(['KNOWN_BENIGN_PATTERN', 'NEW_CODE']);
    expect(detail.usage).toBeNull();
    expect(detail.invocations[0].estimatedMicroUsd).toBeNull();
    expect(detail.actions[0].kind).toBe('close_benign');
    expect(detail.actions[1]).toMatchObject({ kind: 'unknown', rawKind: 'teleport', state: 'unknown' });
    expect(changedAlert(detail.actions)).toBe(true);
    expect(changedAlert(detail.actions.slice(1))).toBe(false);
  });

  it('el presupuesto distingue sin techo de techo cero y no inventa conteos', () => {
    const empty = normalizeBudget({});
    expect(empty.day.limitMicroUsd).toBeNull();
    expect(empty.runs.today).toBeNull();
    expect(empty.enabled).toBeNull();
    expect(empty.billing).toBe('not_connected');
    expect(shareWithoutInference(empty)).toBeNull();
    expect(inferenceOff(empty)).toBe(true);

    const budget = normalizeBudget({
      enabled: true,
      mode: 'assisted',
      inferenceEnabled: true,
      day: {
        date: '2026-11-13',
        limitMicroUsd: 5000000,
        reservedMicroUsd: 0,
        settledMicroUsd: 12300,
        unknownInvocations: 2,
      },
      tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      runs: { today: 8, withoutInference: 7, economy: 1, advanced: 0 },
      rateCardVersion: '2026-11',
      billing: 'not_connected',
    });
    expect(budget.mode).toBe('assisted');
    expect(budget.day.reservedMicroUsd).toBe(0);
    expect(inferenceOff(budget)).toBe(false);
    expect(shareWithoutInference(budget)).toBe(0.875);
    expect(formatShare(0.875)).toBe('87,5 %');
    expect(formatShare(null)).toBe('Sin dato');
  });
});

describe('rótulos y reglas puras', () => {
  it('cada estado del contrato tiene rótulo en español', () => {
    for (const status of AI_RUN_STATUSES) expect(AI_RUN_STATUS_LABEL[status]).toBeTruthy();
    expect(inferenceLabel('none')).toBe('Sin IA');
    expect(inferenceLabel('economy')).toBe('Económico');
    expect(inferenceLabel('advanced')).toBe('Avanzado');
    expect(inferenceLabel(null)).toBe('Sin dato');
    expect(verdictLabel(null)).toBe('Sin veredicto');
    expect(stageLabel('acting')).toBe('Acciones del analista');
    expect(stageLabel('warp')).toBeNull();
    expect(deterministicReasonLabel('NOT_ELIGIBLE')).toBeTruthy();
    expect(deterministicReasonLabel('constructor')).toBeNull();
    expect(actionReasonLabel('MODE_SHADOW')).toBeTruthy();
    expect(actionReasonLabel('KNOWN_BENIGN_PATTERN')).toBeTruthy();
    expect(actionReasonLabel('SOMETHING_NEW')).toBeNull();
    expect(actionKindShort('escalate')).toBe('Escaló');
    expect(actionKindShort('teleport')).toBeNull();
    expect(evidenceSourceStateLabel('healthy')).toBe('Operativa');
    expect(evidenceSourceStateLabel('odd')).toBeNull();
  });

  it('activo, terminal, detener y reintentar', () => {
    expect(isActive('queued')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('requires_review')).toBe(true);
    expect(canCancel({ status: 'running', revision: 2 })).toBe(true);
    expect(canCancel({ status: 'running', revision: 2, cancelRequested: true })).toBe(false);
    expect(canCancel({ status: 'running', revision: null })).toBe(false);
    expect(canCancel({ status: 'completed', revision: 2 })).toBe(false);
    expect(canRetry({ status: 'failed', revision: 2 })).toBe(true);
    expect(canRetry({ status: 'budget_exhausted', revision: 2 })).toBe(true);
    expect(canRetry({ status: 'usage_unreconciled', revision: 2 })).toBe(false);
    expect(canRetry({ status: 'completed', revision: 2 })).toBe(false);
    expect(canRetry({ status: 'unknown', revision: 2 })).toBe(false);
  });

  it('valida ids y nunca acepta rutas literales como id de investigación', () => {
    expect(isValidAiRunId('3f2a-11')).toBe(true);
    expect(isValidAiRunId('budget')).toBe(false);
    expect(isValidAiRunId('Settings')).toBe(false);
    expect(isValidAiRunId('digest')).toBe(false);
    expect(isValidAiRunId('a/b')).toBe(false);
    expect(isValidAiRunId('../x')).toBe(false);
    expect(isValidAiRunId('')).toBe(false);
    expect(isValidAlertId('alert_01:x')).toBe(true);
    expect(isValidAlertId('con espacio')).toBe(false);
    expect(sanitizeErrorCode('MODEL_TIMEOUT')).toBe('MODEL_TIMEOUT');
    expect(sanitizeErrorCode('<img src=x>')).toBeNull();
    expect(sanitizeErrorCode(null)).toBeNull();
  });

  it('el costo siempre va rotulado como estimado', () => {
    expect(formatMicroUsd(12300)).toBe('US$ 0,0123 (estimado)');
    expect(formatMicroUsd(1500000)).toBe('US$ 1,50 (estimado)');
    expect(formatMicroUsd(1234560000)).toBe('US$ 1 234,56 (estimado)');
    expect(formatMicroUsd(0)).toBe('US$ 0,00 (estimado)');
    expect(formatMicroUsd(40)).toBe('menos de US$ 0,0001 (estimado)');
    expect(formatMicroUsd(null)).toBe('Sin dato');
    expect(formatMicroUsd(Number.NaN)).toBe('Sin dato');
  });

  it('duraciones legibles', () => {
    expect(formatDuration(45000)).toBe('45 s');
    expect(formatDuration(125000)).toBe('2 min 05 s');
    expect(formatDuration(3780000)).toBe('1 h 03 min');
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });

  it('la línea de progreso solo proyecta eventos reales', () => {
    const events = normalizeRunDetail({
      ...SUMMARY,
      events: [
        { sequence: 1, at: '2026-11-13T10:00:00.000Z', stage: 'fetching_evidence', kind: 'started' },
        { sequence: 2, at: '2026-11-13T10:00:04.000Z', stage: 'fetching_evidence', kind: 'completed' },
        { sequence: 3, at: '2026-11-13T10:00:04.000Z', stage: 'model', kind: 'skipped', detail: { reason: 'NOT_ELIGIBLE' } },
        { sequence: 4, at: '2026-11-13T10:00:05.000Z', stage: 'writing', kind: 'started' },
      ],
    })!.events;
    const live = buildProgressTimeline(events, true);
    expect(live.map((step) => [step.stage, step.status])).toEqual([
      ['fetching_evidence', 'completed'],
      ['model', 'skipped'],
      ['writing', 'running'],
    ]);
    expect(live[0].durationMs).toBe(4000);
    // No aparecen etapas que el servidor no registró (triage, validating).
    expect(live).toHaveLength(3);
    const ended = buildProgressTimeline(events, false);
    expect(ended[2].status).toBe('interrupted');
    expect(buildProgressTimeline([], true)).toEqual([]);
  });

  it('une páginas sin duplicar y antepone las nuevas', () => {
    const a = normalizeRunSummary(SUMMARY)!;
    const b = normalizeRunSummary({ ...SUMMARY, id: 'run-2' })!;
    const done = normalizeRunSummary({ ...SUMMARY, status: 'completed' })!;
    const merged = mergeRuns([a], [b, done]);
    expect(merged.map((run) => [run.id, run.status])).toEqual([
      ['run-2', 'running'],
      ['run-1', 'completed'],
    ]);
  });
});

describe('configuración del analista', () => {
  it('lee una configuración completa y rechaza una incompleta en vez de rellenarla', () => {
    expect(normalizeSettings(SETTINGS)).toEqual(SETTINGS);
    expect(normalizeSettings({ ...SETTINGS, mode: 'yolo' })).toBeNull();
    expect(normalizeSettings({ ...SETTINGS, actions: { escalate: true } })).toBeNull();
    expect(
      normalizeSettings({ ...SETTINGS, scope: { priorities: ['P1', 'P7'], inferenceMinPriority: 'P2' } }),
    ).toBeNull();
    expect(
      normalizeSettings({ ...SETTINGS, budget: { ...SETTINGS.budget, dailyCeilingMicroUsd: 'x' } }),
    ).toBeNull();
    expect(normalizeSettings({ ...SETTINGS, instructions: undefined })).toBeNull();
    const off = normalizeSettings({
      ...SETTINGS,
      budget: { ...SETTINGS.budget, dailyCeilingMicroUsd: null },
    })!;
    expect(off.budget.dailyCeilingMicroUsd).toBeNull();
  });

  it('sin canConfigure explícito queda en solo lectura', () => {
    expect(normalizeSettingsView({ settings: SETTINGS })!.canConfigure).toBe(false);
    expect(normalizeSettingsView({ settings: SETTINGS, canConfigure: true })!.canConfigure).toBe(true);
    expect(normalizeSettingsView({ settings: {}, canConfigure: true })).toBeNull();
    expect(normalizeSettingsView({ settings: SETTINGS })!.deploymentEnabled).toBeNull();
    expect(normalizeSettingsView({ settings: SETTINGS, deploymentEnabled: false })!.deploymentEnabled).toBe(false);
    expect(normalizeSettingsView({ settings: SETTINGS, deploymentEnabled: true })!.deploymentEnabled).toBe(true);
  });

  it('convierte US$ ↔ micro-USD sin perder precisión', () => {
    expect(usdTextToMicroUsd('2,50')).toBe(2500000);
    expect(usdTextToMicroUsd('2.5')).toBe(2500000);
    expect(usdTextToMicroUsd(' 0,0125 ')).toBe(12500);
    expect(usdTextToMicroUsd('10')).toBe(10000000);
    expect(usdTextToMicroUsd('0')).toBeNull();
    expect(usdTextToMicroUsd('')).toBeNull();
    expect(usdTextToMicroUsd('-1')).toBeNull();
    expect(usdTextToMicroUsd('1,2,3')).toBeNull();
    expect(usdTextToMicroUsd('1e3')).toBeNull();
    expect(microUsdToUsdText(2500000)).toBe('2,50');
    expect(microUsdToUsdText(12500)).toBe('0,0125');
    expect(microUsdToUsdText(10000000)).toBe('10,00');
    expect(usdTextToMicroUsd(microUsdToUsdText(1234567))).toBe(1234567);
  });

  it('el borrador ida y vuelta produce el mismo cuerpo, sin revision ni autoría', () => {
    const draft = draftFromSettings(SETTINGS);
    const parsed = settingsFromDraft(draft);
    expect(parsed.errors).toEqual({});
    const { revision, updatedAt, updatedBy, ...input } = SETTINGS;
    expect(parsed.input).toEqual(input);
    expect(parsed.input).not.toHaveProperty('revision');
    expect(revision).toBe(4);
    expect(updatedAt).toBeTruthy();
    expect(updatedBy).toBeTruthy();
    expect(draftsEqual(draft, draftFromSettings(SETTINGS))).toBe(true);
    expect(draftsEqual(draft, { ...draft, enabled: false })).toBe(false);
  });

  it('IA desactivada se guarda como techo null, no como cero', () => {
    const draft = { ...draftFromSettings(SETTINGS), inferenceOn: false, dailyCeilingUsd: '9,99' };
    expect(settingsFromDraft(draft).input!.budget.dailyCeilingMicroUsd).toBeNull();
  });

  it('valida los mismos límites que el backend', () => {
    const base = draftFromSettings(SETTINGS);
    const bad = settingsFromDraft({
      ...base,
      scopePriorities: [],
      closeMinHistory: '2',
      dailyCeilingUsd: 'mucho',
      maxOutputTokens: '0',
      digestHourLima: '24',
      instructions: 'x'.repeat(1001),
    });
    expect(bad.input).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual([
      'budget.dailyCeilingMicroUsd',
      'budget.maxOutputTokens',
      'closeBenign.minHistory',
      'instructions',
      'reports.digestHourLima',
      'scope.priorities',
    ]);
    expect(settingsFromDraft({ ...base, closeMinHistory: '51' }).errors).toHaveProperty(
      'closeBenign.minHistory',
    );
    expect(settingsFromDraft({ ...base, closeMinHistory: '3.5' }).input).toBeNull();
    expect(settingsFromDraft({ ...base, closeMinHistory: '50', digestHourLima: '0' }).input).not.toBeNull();
    const noEscalation = settingsFromDraft({
      ...base,
      mode: 'autonomous',
      actions: { ...base.actions, escalate: true },
      escalationPriorities: [],
    });
    expect(noEscalation.errors).toHaveProperty('escalation.priorities');
  });

  it('qué acciones aplican por modo y qué cambios piden confirmación', () => {
    expect(actionApplies('shadow', 'requestReview')).toBe(false);
    expect(actionApplies('assisted', 'requestReview')).toBe(true);
    expect(actionApplies('assisted', 'closeBenign')).toBe(false);
    expect(actionApplies('autonomous', 'closeBenign')).toBe(true);
    const draft = draftFromSettings(SETTINGS);
    expect(settingsRisk(SETTINGS, draft)).toEqual({ autonomous: false, closeBenign: false });
    expect(
      settingsRisk(SETTINGS, {
        ...draft,
        mode: 'autonomous',
        actions: { ...draft.actions, closeBenign: true },
      }),
    ).toEqual({ autonomous: true, closeBenign: true });
    // Ya estaba en autónomo: no se vuelve a pedir confirmación por el modo.
    expect(
      settingsRisk({ ...SETTINGS, mode: 'autonomous' }, { ...draft, mode: 'autonomous' }).autonomous,
    ).toBe(false);
  });
});

describe('informes', () => {
  it('sanea el nombre de archivo y exige contenido', () => {
    expect(safeMarkdownFilename('../../etc/passwd', 'x')).toBe('etc-passwd.md');
    expect(safeMarkdownFilename('informe run 1.MD', 'x')).toBe('informe-run-1.md');
    expect(safeMarkdownFilename('', 'analista-ia-run-1')).toBe('analista-ia-run-1.md');
    expect(safeMarkdownFilename(null, '///')).toBe('informe.md');
    expect(normalizeRunReport({ filename: 'a.md', markdown: '' }, 'run-1')).toBeNull();
    expect(
      normalizeRunReport({ filename: 'a b.md', markdown: '# Informe', generatedAt: 'ayer' }, 'run-1'),
    ).toEqual({ filename: 'a-b.md', markdown: '# Informe', generatedAt: null });
  });

  it('el resumen conserva los conteos ausentes como null', () => {
    const digest = normalizeDigest({
      from: '2026-11-07',
      to: '2026-11-13',
      totals: { runs: 10, escalated: 0, withoutInference: 9 },
      byPriority: { P1: 1, P2: 'dos' },
      topRules: [{ ruleId: '101503', count: 4 }, { count: 2 }],
      estimatedMicroUsd: null,
      markdown: '# Resumen',
    })!;
    expect(digest.totals.escalated).toBe(0);
    expect(digest.totals.closedBenign).toBeNull();
    expect(digest.byPriority).toEqual({ P1: 1, P2: null, P3: null, P4: null });
    expect(digest.topRules).toEqual([{ ruleId: '101503', count: 4 }]);
    expect(digest.estimatedMicroUsd).toBeNull();
    expect(normalizeDigest(null)).toBeNull();
  });

  it('valida el periodo', () => {
    expect(digestRangeError('2026-11-07', '2026-11-13')).toBeNull();
    expect(digestRangeError('2026-11-13', '2026-11-13')).toBeNull();
    expect(digestRangeError('2026-11-14', '2026-11-13')).toContain('posterior');
    expect(digestRangeError('', '2026-11-13')).toBeTruthy();
    expect(digestRangeError('13/11/2026', '2026-11-13')).toBeTruthy();
    expect(localDay(new Date(2026, 10, 13, 9), -6)).toBe('2026-11-07');
    expect(localDay(new Date(2026, 0, 1, 9), -1)).toBe('2025-12-31');
  });
});

describe('registro de la vista', () => {
  it('Analista IA está registrada y va después de Incidentes en Investigación', () => {
    const app = QAPAQ_APPS.find((item) => item.id === 'qapaq-ai-analyst');
    expect(app).toMatchObject({ view: 'ai_analyst', title: 'Analista IA' });
    const placement = NAV_PLACEMENT['qapaq-ai-analyst'];
    expect(placement.category).toBe('investigation');
    expect(placement.order).toBeGreaterThan(NAV_PLACEMENT['qapaq-incidents'].order);
    expect(placement.order).toBeLessThan(NAV_PLACEMENT['threat-hunting'].order);
  });
});
