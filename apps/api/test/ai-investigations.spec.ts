/**
 * `/api/ai-investigations`: capacidades, CSRF, step-up, compare-and-set, validación con ruta de
 * campo, auditoría sin texto de instrucciones y DTO enmascarado.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANALYST_SETTINGS,
  InMemoryAnalystSettingsStore,
  InMemoryInvestigationStore,
  POLICY_VERSION,
} from '@qapaq/assistant';
import { InMemoryAuditStore } from '@qapaq/audit';
import { createAlert, InMemorySoc } from '@qapaq/soc';

import { RuntimeSocActions } from '../src/assistant/analyst-actions.js';
import { BUILT_IN_ANALYST_RATE_CARD } from '../src/assistant/analyst-config.js';
import { RuntimeEvidenceReader } from '../src/assistant/analyst-evidence.js';
import {
  AiInvestigationsController,
  changedSettingKeys,
} from '../src/assistant/ai-investigations.controller.js';
import { decodeCursor, encodeCursor, maskActorRef } from '../src/assistant/ai-investigations.dto.js';
import { ApiError } from '../src/http/api-error.js';
import { AnalystHost } from '../src/runtime/analyst-host.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const T = 't1';
const NOW = new Date();
const SUBJECT = '0f8e2c1a-1111-2222-3333-444455556666';

function harness(options: {
  capabilities: readonly string[];
  sessionAgeMs?: number;
  csrf?: boolean;
  analystEnabled?: boolean;
  deploymentCeiling?: number | null;
  withAnalyst?: boolean;
}) {
  const audit = new InMemoryAuditStore();
  const soc = new InMemorySoc();
  const store = new InMemoryInvestigationStore();
  const settings = new InMemoryAnalystSettingsStore();
  const host = new AnalystHost({
    tenantId: T,
    config: {
      enabled: options.analystEnabled ?? true,
      provider: undefined,
      models: { economy: 'claude-haiku-5-5', advanced: 'claude-sonnet-5-5' },
      dailyCeilingMicroUsd:
        options.deploymentCeiling === undefined ? 5_000_000 : options.deploymentCeiling,
      rateCard: BUILT_IN_ANALYST_RATE_CARD,
      concurrency: 1,
      backlogSweep: false,
    },
    store,
    settings,
    evidence: new RuntimeEvidenceReader({ tenantId: T, soc, now: () => new Date() }),
    actions: new RuntimeSocActions({
      tenantId: T,
      soc: () => ({ unitOfWork: soc, clock: { now: () => new Date() }, ids: { next: () => randomUUID() } }),
      read: soc,
    }),
    models: {},
    soc,
    clock: () => new Date(),
    consoleBaseUrl: 'https://soc.example',
  });
  const runtime = {
    now: () => NOW,
    audit,
    soc,
    tenantId: T,
    analyst: options.withAnalyst === false ? undefined : host,
    csrfTokenFor: () => 'csrf-ok',
    resolveActor: () =>
      Promise.resolve({
        ok: true,
        actor: {
          subjectId: SUBJECT,
          tenantId: T,
          sessionId: 's1',
          capabilities: new Set(options.capabilities),
          roles: [],
        },
        session: { id: 's1', createdAt: new Date(NOW.getTime() - (options.sessionAgeMs ?? 60_000)) },
      }),
  } as unknown as SecOpsRuntime;
  const request = {
    ip: '10.0.0.1',
    headers: {
      cookie: 'qapaq_session=s1',
      ...(options.csrf === false ? {} : { 'x-csrf-token': 'csrf-ok' }),
    },
  } as never;
  return { controller: new AiInvestigationsController(runtime), request, audit, soc, store, settings, host };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = error.getResponse() as { code: string; fields?: string[] };
    return body.fields?.length ? `${body.code}:${body.fields.join(',')}` : body.code;
  }
};

function settingsBody(patch: Record<string, unknown> = {}, expectedRevision = 0) {
  const { review, ...rest } = DEFAULT_ANALYST_SETTINGS;
  // La consola no envía `review.maxImmediatePerHour`.
  const { maxImmediatePerHour: _omit, ...uiReview } = review;
  return { settings: { ...rest, review: uiReview, ...patch }, expectedRevision };
}

function putAlert(soc: InMemorySoc, tenantId = T) {
  const id = randomUUID();
  const alert = createAlert({
    id,
    tenantId,
    candidateId: id,
    eventRecordId: randomUUID(),
    title: 'QAPAQ Wazuh: acceso de jperez@qapaq.pe',
    priority: 'P3',
    score: 40,
    reasons: [],
    occurredAt: NOW,
    createdAt: NOW,
  });
  soc.alertRows.set(`${tenantId}|${id}`, alert);
  return alert;
}

describe('autorización', () => {
  it('sin capacidad o sin analista publicado responde RESOURCE_UNAVAILABLE', async () => {
    const none = harness({ capabilities: ['alerts.read'] });
    expect(await code(none.controller.list(none.request, {}))).toBe('RESOURCE_UNAVAILABLE');
    expect(await code(none.controller.budget(none.request))).toBe('RESOURCE_UNAVAILABLE');
    const unpublished = harness({ capabilities: ['investigations.read'], withAnalyst: false });
    expect(await code(unpublished.controller.getSettings(unpublished.request))).toBe('RESOURCE_UNAVAILABLE');
    const reader = harness({ capabilities: ['investigations.read'] });
    expect(await code(reader.controller.start(reader.request, { alertId: 'x' }))).toBe('RESOURCE_UNAVAILABLE');
  });

  it('PUT settings exige configure, CSRF y sesión reciente', async () => {
    const analyst = harness({ capabilities: ['investigations.read', 'investigations.run'] });
    expect(await code(analyst.controller.putSettings(analyst.request, settingsBody()))).toBe('RESOURCE_UNAVAILABLE');
    const noCsrf = harness({ capabilities: ['investigations.configure'], csrf: false });
    expect(await code(noCsrf.controller.putSettings(noCsrf.request, settingsBody()))).toBe('REQUEST_NOT_VERIFIED');
    const stale = harness({ capabilities: ['investigations.configure'], sessionAgeMs: 2 * 3_600_000 });
    expect(await code(stale.controller.putSettings(stale.request, settingsBody()))).toBe('STEP_UP_REQUIRED');
    for (const h of [analyst, noCsrf, stale]) expect(await h.settings.get(T)).toBeUndefined();
  });
});

describe('ajustes', () => {
  it('valida con la ruta del campo, respeta el techo del despliegue y la revisión', async () => {
    const admin = harness({ capabilities: ['investigations.read', 'investigations.configure'], deploymentCeiling: 2_000_000 });
    expect(await code(admin.controller.putSettings(admin.request, { settings: {} }))).toBe('VALIDATION_FAILED:expectedRevision');
    expect(await code(admin.controller.putSettings(admin.request, settingsBody({ mode: 'yolo' })))).toBe('VALIDATION_FAILED:mode');
    expect(
      await code(
        admin.controller.putSettings(
          admin.request,
          settingsBody({ budget: { dailyCeilingMicroUsd: 3_000_000, maxOutputTokens: 1200, advancedTierEnabled: true } }),
        ),
      ),
    ).toBe('VALIDATION_FAILED:budget.dailyCeilingMicroUsd');
    expect(
      await code(
        admin.controller.putSettings(
          admin.request,
          settingsBody({ budget: { dailyCeilingMicroUsd: null, maxOutputTokens: 100, advancedTierEnabled: true } }),
        ),
      ),
    ).toBe('VALIDATION_FAILED:budget.maxOutputTokens');
    expect(await code(admin.controller.putSettings(admin.request, settingsBody({}, 3)))).toBe('STATE_CONFLICT');

    const saved = (await admin.controller.putSettings(
      admin.request,
      settingsBody({ enabled: true, mode: 'assisted', instructions: 'Prioriza M365. SECRETO-INSTRUCCION' }),
    )) as { settings: Record<string, unknown>; canConfigure: boolean };
    expect(saved.canConfigure).toBe(true);
    expect(saved.settings).toMatchObject({ enabled: true, mode: 'assisted', revision: 1 });
    expect(saved.settings['updatedBy']).toBe('0f8e2c1a…');
    expect((saved.settings['review'] as Record<string, unknown>)['maxImmediatePerHour']).toBe(6);
    const events = await admin.audit.range(T, 1n, 20);
    const updated = events.find((event) => event.action === 'ai.analyst.settings.updated');
    expect(updated?.metadata?.['changed']).toBe('enabled,instructions,mode');
    expect(JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('SECRETO-INSTRUCCION');
    expect(events.filter((event) => event.action === 'ai.analyst.settings.update_rejected')).toHaveLength(4);
  });

  it('GET settings informa canConfigure según la capacidad', async () => {
    const reader = harness({ capabilities: ['investigations.read'] });
    const view = (await reader.controller.getSettings(reader.request)) as {
      settings: { revision: number; enabled: boolean };
      canConfigure: boolean;
    };
    expect(view).toMatchObject({ canConfigure: false, settings: { revision: 0, enabled: false } });
  });

  it('changedSettingKeys lista hojas, nunca valores', () => {
    expect(
      changedSettingKeys(DEFAULT_ANALYST_SETTINGS, {
        ...DEFAULT_ANALYST_SETTINGS,
        actions: { ...DEFAULT_ANALYST_SETTINGS.actions, closeBenign: true },
      }),
    ).toEqual(['actions.closeBenign']);
  });
});

describe('investigaciones', () => {
  it('POST valida la alerta y el tenant, es idempotente y se audita', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run'] });
    expect(await code(h.controller.start(h.request, { alertId: '../x' }))).toBe('VALIDATION_FAILED:alertId');
    const foreign = putAlert(h.soc, 't2');
    expect(await code(h.controller.start(h.request, { alertId: foreign.id }))).toBe('RESOURCE_UNAVAILABLE');
    const alert = putAlert(h.soc);
    const first = (await h.controller.start(h.request, { alertId: alert.id })) as {
      run: Record<string, unknown>;
      created: boolean;
    };
    const second = (await h.controller.start(h.request, { alertId: alert.id })) as {
      run: { id: string };
      created: boolean;
    };
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, run: { id: first.run['id'] } });
    expect(first.run).toMatchObject({
      status: 'queued',
      trigger: 'user',
      initiatedBy: '0f8e2c1a…',
      revision: expect.any(Number),
      actionKinds: [],
      mode: null,
    });
    // El título se enmascara; ningún identificador de persona sin máscara.
    expect(JSON.stringify(first)).not.toContain('jperez@');
    const actions = (await h.audit.range(T, 1n, 20)).map((event) => event.action);
    expect(actions.filter((action) => action === 'ai.analyst.investigation.requested')).toHaveLength(2);
  });

  it('con el analista apagado no se encola (STATE_CONFLICT) pero se listan y leen ajustes', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run'], analystEnabled: false });
    const alert = putAlert(h.soc);
    expect(await code(h.controller.start(h.request, { alertId: alert.id }))).toBe('STATE_CONFLICT:analyst');
    expect(await h.controller.list(h.request, {})).toMatchObject({ items: [], nextCursor: null });
    expect(await h.controller.budget(h.request)).toMatchObject({ enabled: false, inferenceEnabled: false, billing: 'not_connected' });
  });

  it('cancel/retry exigen revisión esperada y responden STATE_CONFLICT ante otra revisión', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run'] });
    const alert = putAlert(h.soc);
    const started = (await h.controller.start(h.request, { alertId: alert.id })) as {
      run: { id: string; revision: number };
    };
    const id = started.run.id;
    expect(await code(h.controller.cancel(h.request, id, {}))).toBe('VALIDATION_FAILED:expectedRevision');
    expect(await code(h.controller.cancel(h.request, id, { expectedRevision: started.run.revision + 5 }))).toBe('STATE_CONFLICT');
    expect(await code(h.controller.retry(h.request, id, { expectedRevision: started.run.revision }))).toBe('STATE_CONFLICT');
    const cancelled = (await h.controller.cancel(h.request, id, { expectedRevision: started.run.revision })) as {
      run: { status: string };
    };
    expect(cancelled.run.status).toBe('cancelled');
    expect(await code(h.controller.get(h.request, 'budget'))).toBe('RESOURCE_UNAVAILABLE');
    expect(await code(h.controller.get(h.request, randomUUID()))).toBe('RESOURCE_UNAVAILABLE');
  });

  it('lista con cursor opaco y valida los parámetros', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run'] });
    for (let index = 0; index < 3; index += 1) {
      await h.controller.start(h.request, { alertId: putAlert(h.soc).id });
    }
    const page = (await h.controller.list(h.request, { pageSize: '2' })) as {
      items: unknown[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const rest = (await h.controller.list(h.request, { cursor: page.nextCursor! })) as { items: unknown[] };
    expect(rest.items).toHaveLength(1);
    expect(await code(h.controller.list(h.request, { status: 'nope' }))).toBe('VALIDATION_FAILED:status');
    expect(await code(h.controller.list(h.request, { pageSize: '500' }))).toBe('VALIDATION_FAILED:pageSize');
    expect(await code(h.controller.list(h.request, { cursor: '%%%' }))).toBe('VALIDATION_FAILED:cursor');
    expect(await code(h.controller.digest(h.request, { from: '2026-11-01', to: '2026-12-31' }))).toBe('VALIDATION_FAILED:to');
  });

  it('cursor y máscara', () => {
    const cursor = { createdAt: NOW, id: randomUUID() };
    expect(decodeCursor(encodeCursor(cursor)!)).toEqual(cursor);
    expect(maskActorRef('jperez@qapaq.pe')).toBe('jp***@qapaq.pe');
    expect(maskActorRef('svc:qapaq-ai-analyst')).toBe('svc:qapaq-ai-analyst');
    expect(maskActorRef(null)).toBeNull();
  });
});

describe('estado actual de la alerta revisada', () => {
  it('lista y expediente traen `alert` del modelo de lectura del SOC, enmascarado y al día', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run', 'alerts.read'] });
    const alert = putAlert(h.soc);
    const started = (await h.controller.start(h.request, { alertId: alert.id })) as {
      run: { id: string; alert: unknown };
    };
    expect(started.run.alert).toEqual({
      status: 'new',
      assigneeId: null,
      assignedToYou: false,
      verdict: null,
      incidentId: null,
      incidentByAnalyst: false,
    });
    // Una persona atiende la alerta: la siguiente lectura lo refleja (sin migración ni caché).
    h.soc.alertRows.set(`${T}|${alert.id}`, {
      ...alert,
      status: 'closed',
      assigneeId: SUBJECT,
      verdict: 'false_positive',
      revision: alert.revision + 3,
    });
    const page = (await h.controller.list(h.request, {})) as { items: Array<{ alert: unknown }> };
    expect(page.items[0]!.alert).toEqual({
      status: 'closed',
      assigneeId: '0f8e2c1a…',
      assignedToYou: true,
      verdict: 'false_positive',
      incidentId: null,
      incidentByAnalyst: false,
    });
    const detail = (await h.controller.get(h.request, started.run.id)) as { run: { alert: { status: string } } };
    expect(detail.run.alert.status).toBe('closed');
    expect(JSON.stringify(page)).not.toContain(SUBJECT);
  });

  it('sin alerts.read no se lee la alerta: `alert` es null (sin dato)', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run'] });
    const alert = putAlert(h.soc);
    const started = (await h.controller.start(h.request, { alertId: alert.id })) as { run: { id: string; alert: unknown } };
    expect(started.run.alert).toBeNull();
    const page = (await h.controller.list(h.request, {})) as { items: Array<{ alert: unknown }> };
    expect(page.items[0]!.alert).toBeNull();
  });
});

describe('GET /activity', () => {
  it('exige investigations.read y el analista publicado', async () => {
    const none = harness({ capabilities: ['alerts.read'] });
    expect(await code(none.controller.activity(none.request))).toBe('RESOURCE_UNAVAILABLE');
    const unpublished = harness({ capabilities: ['investigations.read'], withAnalyst: false });
    expect(await code(unpublished.controller.activity(unpublished.request))).toBe('RESOURCE_UNAVAILABLE');
    // La ruta literal no se confunde con un expediente.
    const reader = harness({ capabilities: ['investigations.read'] });
    expect(await code(reader.controller.get(reader.request, 'activity'))).toBe('RESOURCE_UNAVAILABLE');
  });

  it('vacío: ceros contados, sin dato donde no hay medida y feed vacío', async () => {
    const h = harness({ capabilities: ['investigations.read'], deploymentCeiling: null });
    const view = (await h.controller.activity(h.request)) as Record<string, any>;
    expect(view['correlationId']).toEqual(expect.any(String));
    expect(view['host']).toMatchObject({
      enabled: true,
      running: false,
      settingsEnabled: false,
      mode: 'shadow',
      lastTickAt: null,
      lastProcessedAt: null,
      inFlight: 0,
      concurrency: 1,
      lastErrorCode: null,
      scope: 'process',
    });
    expect(view['queue']).toEqual({ queued: 0, running: 0, oldestQueuedAt: null, byPriority: { P1: 0, P2: 0, P3: 0, P4: 0 } });
    expect(view['today']).toMatchObject({ boundary: 'America/Lima', runs: 0, failed: 0, estimatedMicroUsd: null });
    // Día de Lima: empieza a las 05:00 UTC.
    expect(view['today'].from).toMatch(/T05:00:00\.000Z$/u);
    expect(view['backlog']).toEqual({ openAlertsWithoutCaseFile: 0, openIncidentsWithoutCaseFile: 0 });
    expect(view['feed']).toEqual([]);
  });

  it('cola, conteos del día y feed con escalación, revisión y cierre; títulos enmascarados', async () => {
    const h = harness({ capabilities: ['investigations.read', 'investigations.run'] });
    const queued = putAlert(h.soc);
    await h.controller.start(h.request, { alertId: queued.id });
    const worked = putAlert(h.soc);
    const { job } = await h.store.enqueue({
      id: randomUUID(),
      tenantId: T,
      subject: { kind: 'alert', id: worked.id, title: worked.title },
      alertIds: [worked.id],
      priority: 'P1',
      trigger: 'system',
      source: 'backlog',
      initiatedBy: null,
      idempotencyKey: `alert:${worked.id}:${POLICY_VERSION}`,
      fingerprint: 'fp-1',
      policyVersion: 'p',
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    // El claim toma el P1 primero.
    const claimed = (await h.store.claim(NOW, 60_000, 3))!;
    expect(claimed.id).toBe(job.id);
    const lease = { jobId: job.id, fencingToken: claimed.fencingToken };
    await h.store.planActions(lease, {
      at: NOW,
      status: 'completed',
      result: null,
      inference: 'none',
      actions: [
        { kind: 'escalate', reason: 'ESCALATE_CORRELATED_P1' },
        { kind: 'request_review', reason: 'REVIEW_STATE_CHANGE_NOTICE', urgency: 'immediate', groupKey: 'g' },
      ],
    });
    await h.store.markAction(lease, 'escalate', { at: NOW, state: 'executed', ref: { kind: 'incident', id: 'inc-1' } });
    await h.store.appendEvent(lease, { at: NOW, stage: 'acting', kind: 'completed', detail: { action: 'escalate', incident: 'created' } });
    await h.store.markAction(lease, 'request_review', { at: NOW, state: 'executed', ref: { kind: 'notification', id: 'n-1' } });
    await h.store.finish(lease, { at: NOW, status: 'completed', result: null, inference: 'none' });

    const view = (await h.controller.activity(h.request)) as Record<string, any>;
    expect(view['queue']).toMatchObject({ queued: 1, running: 0, byPriority: { P1: 0, P3: 1 } });
    expect(view['queue'].oldestQueuedAt).toEqual(expect.any(String));
    expect(view['today']).toMatchObject({
      runs: 1,
      withoutInference: 1,
      escalated: 1,
      incidentsCreated: 1,
      incidentsAttached: 0,
      reviewRequested: 1,
      reviewImmediate: 1,
      reviewDigest: 0,
      closedBenign: 0,
      failed: 0,
      estimatedMicroUsd: 0,
    });
    // La alerta cubierta por `alert:<id>` no cuenta; la del pedido manual sí (sin trabajo del sistema).
    expect(view['backlog'].openAlertsWithoutCaseFile).toBe(1);
    const kinds = (view['feed'] as Array<Record<string, unknown>>).map((item) => `${item['kind']}:${item['actionKind'] ?? item['status'] ?? ''}`);
    expect(kinds).toEqual(['run_finished:completed', 'action:request_review', 'action:escalate', 'run_started:']);
    const escalation = (view['feed'] as Array<Record<string, unknown>>)[2]!;
    expect(escalation).toMatchObject({
      jobId: job.id,
      priority: 'P1',
      actionState: 'executed',
      disposition: 'created',
      ref: { kind: 'incident', id: 'inc-1' },
    });
    expect(JSON.stringify(view)).not.toContain('jperez@');
  });
});
