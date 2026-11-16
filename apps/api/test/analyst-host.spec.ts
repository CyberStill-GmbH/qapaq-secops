/**
 * Analista IA en el API: lector de evidencia (tenant, truncado), acciones sobre el SOC (asistido no
 * muta; autónomo solo por las guardas), pedidos de revisión por el outbox con resumen agrupado,
 * encolado posterior al commit, barrido del atraso y apagado ordenado.
 */

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ANALYST_SETTINGS,
  InMemoryAnalystSettingsStore,
  InMemoryInvestigationStore,
  type AnalystSettings,
  type InvestigationJob,
} from '@qapaq/assistant';
import {
  ConsoleFallbackChannel,
  drainOutbox,
  InMemoryAttemptStore,
  runSuppressedDigest,
  type DispatchDependencies,
  type NotificationTransport,
} from '@qapaq/soar';
import { createAlert, InMemorySoc, requestAlertReview, type Alert } from '@qapaq/soc';

import { RuntimeSocActions, ANALYST_SERVICE_ACTOR_ID, analystServiceActor } from '../src/assistant/analyst-actions.js';
import { BUILT_IN_ANALYST_RATE_CARD, type AnalystConfig } from '../src/assistant/analyst-config.js';
import { EVIDENCE_LIMITS, RuntimeEvidenceReader } from '../src/assistant/analyst-evidence.js';
import {
  ANALYST_HOST_DEFAULTS,
  AnalystHost,
  clampSettings,
  limaClock,
} from '../src/runtime/analyst-host.js';

const T = 't1';
const NOW = new Date();
const RULE = 'rule-100';
const ENTITY = 'ent_abcdef123456';

let soc: InMemorySoc;

function putAlert(overrides: Partial<Alert> & { readonly id?: string } = {}): Alert {
  const id = overrides.id ?? randomUUID();
  const base = createAlert({
    id,
    tenantId: overrides.tenantId ?? T,
    candidateId: id,
    eventRecordId: randomUUID(),
    title: overrides.title ?? 'QAPAQ Wazuh: inicio de sesión fallido',
    priority: overrides.priority ?? 'P4',
    score: 20,
    reasons: [{ code: 'BASE_SEVERITY', delta: 20, detail: 'base' }],
    occurredAt: overrides.occurredAt ?? NOW,
    createdAt: overrides.createdAt ?? NOW,
    entityKeys: ['user:jperez@qapaq.pe'],
    entityRefs: overrides.entityRefs ?? [ENTITY],
    signal: 'other',
    ruleId: overrides.ruleId === undefined ? RULE : overrides.ruleId,
    relatedAlertIds: overrides.relatedAlertIds ?? [],
  });
  const alert = { ...base, ...overrides, id } as Alert;
  soc.alertRows.set(`${alert.tenantId}|${alert.id}`, alert);
  return alert;
}

/** Cinco cierres previos como falso positivo de la misma regla y entidad (patrón conocido). */
function benignHistory(count = 5) {
  for (let index = 0; index < count; index += 1) {
    putAlert({
      status: 'closed',
      verdict: 'false_positive',
      createdAt: new Date(NOW.getTime() - (index + 1) * 86_400_000),
    });
  }
}

const deps = () => ({
  unitOfWork: soc,
  clock: { now: () => new Date() },
  ids: { next: () => randomUUID() },
});

function config(overrides: Partial<AnalystConfig> = {}): AnalystConfig {
  return {
    enabled: true,
    provider: undefined,
    models: { economy: 'claude-haiku-5-5', advanced: 'claude-sonnet-5-5' },
    dailyCeilingMicroUsd: null,
    rateCard: BUILT_IN_ANALYST_RATE_CARD,
    concurrency: 1,
    backlogSweep: true,
    ...overrides,
  };
}

async function harness(
  settingsPatch: Partial<AnalystSettings> | null,
  options: { readonly config?: Partial<AnalystConfig>; readonly kicks?: { count: number } } = {},
) {
  const store = new InMemoryInvestigationStore();
  const settings = new InMemoryAnalystSettingsStore();
  if (settingsPatch) {
    await settings.put(T, { ...DEFAULT_ANALYST_SETTINGS, enabled: true, ...settingsPatch }, 0, 'admin', NOW);
  }
  const digests: unknown[] = [];
  const host = new AnalystHost({
    tenantId: T,
    config: config(options.config),
    store,
    settings,
    evidence: new RuntimeEvidenceReader({ tenantId: T, soc, now: () => new Date() }),
    actions: new RuntimeSocActions({
      tenantId: T,
      soc: deps,
      read: soc,
      kickDispatch: () => {
        if (options.kicks) options.kicks.count += 1;
      },
    }),
    models: {},
    soc,
    clock: () => new Date(),
    consoleBaseUrl: 'https://soc.example',
    sendDigest: async (input) => {
      digests.push(input);
    },
    retryDelayMs: () => 0,
  });
  return { host, store, settings, digests };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  soc = new InMemorySoc();
});

describe('lector de evidencia', () => {
  it('lee solo el tenant del runtime y no publica claves de entidad', async () => {
    const own = putAlert({ priority: 'P3', relatedAlertIds: [] });
    const foreign = putAlert({ tenantId: 't2', priority: 'P1' });
    benignHistory(2);
    const reader = new RuntimeEvidenceReader({ tenantId: T, soc, now: () => new Date() });
    const job = { tenantId: T, alertIds: [own.id, foreign.id] } as unknown as InvestigationJob;
    const bundle = await reader.collect(job, new AbortController().signal);
    expect(bundle.alerts.map((alert) => alert.id)).toEqual([own.id]);
    expect(bundle.completeness.complete).toBe(false);
    expect(bundle.completeness.gaps.join(' ')).toContain(foreign.id);
    expect(bundle.history).toMatchObject({ total: 2, falsePositive: 2, truePositive: 0 });
    expect(JSON.stringify(bundle)).not.toContain('jperez@qapaq.pe');
    expect(bundle.alerts[0]!.entityRefs).toEqual([ENTITY]);
    await expect(
      reader.collect({ tenantId: 't2', alertIds: [foreign.id] } as unknown as InvestigationJob, new AbortController().signal),
    ).rejects.toThrow('EVIDENCE_TENANT_MISMATCH');
  });

  it('marca truncado si el historial no se leyó completo y falla de forma honesta', async () => {
    const own = putAlert({ priority: 'P4' });
    const reader = new RuntimeEvidenceReader({
      tenantId: T,
      soc: {
        alertById: (tenantId, id) => soc.alertById(tenantId, id),
        listAlerts: async () => ({ items: [], total: 900 }),
      },
      now: () => new Date(),
    });
    const bundle = await reader.collect(
      { tenantId: T, alertIds: [own.id] } as unknown as InvestigationJob,
      new AbortController().signal,
    );
    expect(bundle.completeness).toMatchObject({ truncated: true });
    const broken = new RuntimeEvidenceReader({
      tenantId: T,
      soc: {
        alertById: (tenantId, id) => soc.alertById(tenantId, id),
        listAlerts: async () => {
          throw new Error('db down');
        },
      },
      sourceHealth: async () => [{ id: 'wazuh', label: 'Wazuh', state: 'failed', fresh: false }],
      now: () => new Date(),
    });
    const degraded = await broken.collect(
      { tenantId: T, alertIds: [own.id] } as unknown as InvestigationJob,
      new AbortController().signal,
    );
    expect(degraded.completeness.complete).toBe(false);
    expect(degraded.sourceHealth[0]).toMatchObject({ state: 'failed', fresh: false });
  });
});

describe('acciones del analista sobre el SOC', () => {
  it('asistido nunca cambia la alerta: recomienda y pide revisión por el outbox', async () => {
    const related = putAlert({ priority: 'P2' });
    const alert = putAlert({ priority: 'P1', relatedAlertIds: [related.id] });
    const kicks = { count: 0 };
    const { host, store } = await harness(
      { mode: 'assisted', actions: { ...DEFAULT_ANALYST_SETTINGS.actions, escalate: true } },
      { kicks },
    );
    const { job } = await host.enqueueAlert(alert, { source: 'new_alert' });
    expect(await host.runOnce()).toBe('processed');
    const after = await soc.alertById(T, alert.id);
    expect(after).toMatchObject({ status: 'new', incidentId: null, revision: alert.revision });
    expect(soc.incidentRows.size).toBe(0);
    const actions = await store.actions(T, job.id);
    expect(actions.find((action) => action.kind === 'escalate')).toBeUndefined();
    expect(actions.find((action) => action.kind === 'request_review')).toMatchObject({
      state: 'executed',
      reason: 'REVIEW_ESCALATION_RECOMMENDED',
      urgency: 'immediate',
    });
    const outbox = [...soc.outboxRows.values()].filter(
      (message) => message.messageType === 'soc.alert.review_requested',
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toMatchObject({ urgency: 'immediate', investigationId: job.id });
    expect(kicks.count).toBe(1);
    // Auditado como servicio, con correlación al expediente y sin texto del modelo.
    const events = await soc.audit.range(T, 1n, 50);
    const review = events.find((event) => event.action === 'soc.alert.review_requested');
    expect(review).toMatchObject({
      actor: { id: ANALYST_SERVICE_ACTOR_ID, type: 'service' },
      correlationId: `ai-investigation:${job.id}`,
    });
  });

  it('autónomo cierra un benigno conocido con todas las guardas y lo deja en la nota (sin pedir revisión)', async () => {
    benignHistory(5);
    const alert = putAlert({ priority: 'P4' });
    const { host, store } = await harness({
      mode: 'autonomous',
      actions: { ...DEFAULT_ANALYST_SETTINGS.actions, closeBenign: true },
    });
    const { job } = await host.enqueueAlert(alert, { source: 'new_alert' });
    await host.runOnce();
    const closed = await soc.alertById(T, alert.id);
    expect(closed).toMatchObject({ status: 'closed', verdict: 'false_positive' });
    expect(closed?.triageNote).toContain(job.id);
    const actions = await store.actions(T, job.id);
    expect(actions.find((action) => action.kind === 'close_benign')?.state).toBe('executed');
    expect(closed?.triageNote).toContain('Cierre automático del Analista IA');
    expect(actions.find((action) => action.kind === 'request_review')).toBeUndefined();
  });

  it('autónomo NO cierra un P3 con un verdadero positivo previo ni sin historial suficiente', async () => {
    benignHistory(5);
    putAlert({ status: 'closed', verdict: 'true_positive', createdAt: new Date(NOW.getTime() - 3_600_000) });
    const alert = putAlert({ priority: 'P4' });
    const thin = putAlert({ priority: 'P4', ruleId: 'other-rule' });
    const { host } = await harness({
      mode: 'autonomous',
      actions: { ...DEFAULT_ANALYST_SETTINGS.actions, closeBenign: true },
    });
    await host.enqueueAlert(alert, { source: 'new_alert' });
    await host.enqueueAlert(thin, { source: 'new_alert' });
    await host.runOnce();
    await host.runOnce();
    expect((await soc.alertById(T, alert.id))?.status).toBe('new');
    expect((await soc.alertById(T, thin.id))?.status).toBe('new');
  });

  it('el puerto se niega a cerrar P1/P2, alertas de una persona o vinculadas, y escalar es idempotente', async () => {
    const actions = new RuntimeSocActions({ tenantId: T, soc: deps, read: soc });
    const job = (alert: Alert) =>
      ({ id: randomUUID(), tenantId: T, subject: { kind: 'alert', id: alert.id }, alertIds: [alert.id], policyVersion: 'p' }) as unknown as InvestigationJob;
    const p2 = putAlert({ priority: 'P2' });
    await expect(actions.closeBenign(job(p2), 'nota suficiente')).rejects.toThrow('PRIORITY_NOT_ALLOWED');
    const owned = putAlert({ priority: 'P4', status: 'acknowledged', assigneeId: 'persona-1' });
    await expect(actions.closeBenign(job(owned), 'nota suficiente')).rejects.toThrow('ALREADY_HANDLED');
    const linked = putAlert({ priority: 'P4', incidentId: randomUUID() });
    await expect(actions.closeBenign(job(linked), 'nota suficiente')).rejects.toThrow('ALERT_LINKED');
    const target = putAlert({ priority: 'P1' });
    const result = { verdict: 'likely_true_positive', confidence: 'high', verified: true } as never;
    const first = await actions.escalate(job(target), result);
    const again = await actions.escalate(job(target), result);
    expect(first.incidentId).toBeDefined();
    expect(again.incidentId).toBe(first.incidentId);
    expect(soc.incidentRows.size).toBe(1);
    // El informe se adjunta como nota del incidente existente.
    const attached = await actions.attachReport(job(target), { filename: 'x.md', markdown: '# Informe' });
    expect(attached.reportId).toBeDefined();
    expect([...soc.noteRows.values()][0]?.authorId).toBe(ANALYST_SERVICE_ACTOR_ID);
  });
});

describe('pedidos de revisión: outbox y resumen agrupado', () => {
  it('los diferidos no abren tarjetas: el resumen sale en UN mensaje por ventana', async () => {
    const a = putAlert({ priority: 'P2' });
    const b = putAlert({ priority: 'P2' });
    const c = putAlert({ priority: 'P3', ruleId: 'otra' });
    const actor = analystServiceActor(T);
    for (const [alert, group] of [
      [a, 'rule:rule-100|entity:ent_abcdef123456'],
      [b, 'rule:rule-100|entity:ent_abcdef123456'],
      [c, 'rule:otra|entity:ent_abcdef123456'],
    ] as const) {
      const outcome = await requestAlertReview(deps(), {
        actor,
        alertId: alert.id,
        correlationId: 'c',
        investigationId: randomUUID(),
        urgency: 'digest',
        groupKey: group,
        reason: 'REVIEW_REQUIRES_REVIEW',
      });
      expect(outcome.ok).toBe(true);
    }
    const sent: unknown[] = [];
    const transport: NotificationTransport = {
      destinationRef: 'teams:test',
      send: async (message) => {
        sent.push(message);
        return { delivered: true, httpStatus: 202 };
      },
    };
    const attempts = new InMemoryAttemptStore();
    const tokens = new Map<string, string>();
    let clock = new Date();
    const dependencies: DispatchDependencies = {
      outbox: {
        claimPending: async (limit, now) => {
          const claimed = await soc.claimOutbox(now, limit, 60_000);
          for (const message of claimed) tokens.set(message.messageId, message.claimToken);
          return claimed;
        },
        markPublished: async (id, at) => {
          await soc.markOutboxPublished(id, tokens.get(id)!, at);
        },
        scheduleRetry: async (id, at, code) => {
          await soc.scheduleOutboxRetry(id, tokens.get(id)!, at, code);
        },
      },
      attempts,
      transport,
      fallback: new ConsoleFallbackChannel(),
      audit: soc.audit,
      clock: { now: () => clock },
      ids: { next: () => randomUUID() },
      consoleBaseUrl: 'https://soc.example',
    };
    await drainOutbox(dependencies, 5, 1);
    expect(sent).toHaveLength(0);
    const suppressed = await attempts.listUndigested(T, 50);
    expect(suppressed).toHaveLength(3);
    expect(new Set(suppressed.map((item) => item.groupKey))).toEqual(
      new Set(['ai-review:rule:rule-100|entity:ent_abcdef123456', 'ai-review:rule:otra|entity:ent_abcdef123456']),
    );
    clock = new Date(clock.getTime() + 20 * 60_000);
    const digest = await runSuppressedDigest({
      tenantId: T,
      attempts,
      transport,
      audit: soc.audit,
      clock: { now: () => clock },
      consoleBaseUrl: 'https://soc.example',
    });
    expect(digest?.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('Revisión pedida por el Analista IA');
  });

  it('un pedido inmediato sigue la vía normal del despacho (una tarjeta)', async () => {
    const alert = putAlert({ priority: 'P1' });
    const outcome = await requestAlertReview(deps(), {
      actor: analystServiceActor(T),
      alertId: alert.id,
      correlationId: 'c',
      investigationId: 'job-1',
      urgency: 'immediate',
      groupKey: 'job:job-1',
      reason: 'REVIEW_ESCALATION_RECOMMENDED',
    });
    expect(outcome.ok).toBe(true);
    // Repetir el mismo pedido no encola un segundo aviso.
    const again = await requestAlertReview(deps(), {
      actor: analystServiceActor(T),
      alertId: alert.id,
      correlationId: 'c',
      investigationId: 'job-1',
      urgency: 'immediate',
      groupKey: 'job:job-1',
      reason: 'REVIEW_ESCALATION_RECOMMENDED',
    });
    expect(again.ok && again.value.enqueued).toBe(false);
    expect([...soc.outboxRows.values()].filter((m) => m.messageType === 'soc.alert.review_requested')).toHaveLength(1);
  });
});

describe('host: encolado, barrido, resumen y apagado', () => {
  it('alertCreated encola tras el commit solo con el analista y los ajustes activos', async () => {
    const off = await harness(null);
    off.host.alertCreated(putAlert({ priority: 'P1' }));
    await settle();
    expect((await off.store.list(T)).items).toHaveLength(0);

    const on = await harness({ scope: { ...DEFAULT_ANALYST_SETTINGS.scope, priorities: ['P1', 'P2'] } });
    on.host.alertCreated(putAlert({ priority: 'P1' }));
    on.host.alertCreated(putAlert({ priority: 'P4' }));
    await settle();
    const items = (await on.store.list(T)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'new_alert', trigger: 'system', priority: 'P1' });

    const disabled = await harness({}, { config: { enabled: false } });
    disabled.host.alertCreated(putAlert({ priority: 'P1' }));
    await settle();
    expect((await disabled.store.list(T)).items).toHaveLength(0);
  });

  it('un fallo al encolar no se propaga a quien creó la alerta', async () => {
    const { host, store } = await harness({});
    store.enqueue = () => Promise.reject(new Error('down'));
    expect(() => host.alertCreated(putAlert({ priority: 'P1' }))).not.toThrow();
    await settle();
  });

  it('el barrido toma las abiertas sin trabajo, P1 primero y en lote chico, sin duplicar', async () => {
    const batch = ANALYST_HOST_DEFAULTS.sweepBatch;
    for (let index = 0; index < batch + 2; index += 1) putAlert({ priority: 'P4' });
    const p1 = putAlert({ priority: 'P1' });
    putAlert({ priority: 'P1', status: 'closed' });
    const { host, store } = await harness({});
    expect(await host.sweepBacklog()).toBe(batch);
    const first = (await store.list(T, { pageSize: 100 })).items;
    expect(first.some((job) => job.subject.id === p1.id && job.source === 'backlog')).toBe(true);
    expect(await host.sweepBacklog()).toBe(3);
    expect(await host.sweepBacklog()).toBe(0);
    expect((await store.list(T, { pageSize: 100 })).items).toHaveLength(batch + 3);
  });

  it('manual es idempotente por revisión de la alerta', async () => {
    const alert = putAlert({ priority: 'P2' });
    const { host } = await harness({});
    const first = await host.enqueueAlert(alert, { source: 'manual', initiatedBy: 'persona-1' });
    const second = await host.enqueueAlert(alert, { source: 'manual', initiatedBy: 'persona-1' });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, job: { id: first.job.id } });
  });

  it('encola un expediente del candidato Go en vez de uno por miembro del atraso', async () => {
    const members = [putAlert({ priority: 'P2' }), putAlert({ priority: 'P3' })];
    const parent = putAlert({ priority: 'P2', ruleId: 'qapaq-correlator:mail-burst', relatedAlertIds: members.map((a) => a.id) });
    const { host, store } = await harness({});
    expect(await host.sweepBacklog()).toBe(1);
    expect(await host.sweepBacklog()).toBe(0);
    const jobs = (await store.list(T)).items;
    expect(jobs.map((job) => job.subject.id)).toEqual([parent.id]);
    const evidence = await new RuntimeEvidenceReader({ tenantId: T, soc, now: () => NOW }).collect(jobs[0]!, new AbortController().signal);
    expect(evidence.relatedAlerts.map((alert) => alert.id).sort()).toEqual(members.map((alert) => alert.id).sort());
    expect(members.every((member) => soc.alertRows.get(`${T}|${member.id}`)?.status === 'new')).toBe(true);
  });

  it('no oculta P1 ni miembros mas graves que el candidato Go', async () => {
    const critical = putAlert({ priority: 'P1' });
    const high = putAlert({ priority: 'P2' });
    putAlert({ priority: 'P3', ruleId: 'qapaq-correlator:mail-burst', relatedAlertIds: [critical.id, high.id] });
    const { host } = await harness({});
    expect(await host.sweepBacklog()).toBe(3);
  });

  it('una relacion ordinaria no sustituye un candidato Go ni omite investigaciones', async () => {
    const member = putAlert({ priority: 'P3' });
    putAlert({ priority: 'P2', relatedAlertIds: [member.id] });
    const { host } = await harness({});
    expect(await host.sweepBacklog()).toBe(2);
  });

  it('un grupo fuera del alcance configurado no impide investigar al miembro', async () => {
    const member = putAlert({ priority: 'P3' });
    putAlert({ priority: 'P2', ruleId: 'qapaq-correlator:mail-burst', relatedAlertIds: [member.id] });
    const { host, store } = await harness({ scope: { ...DEFAULT_ANALYST_SETTINGS.scope, priorities: ['P3'] } });
    expect(await host.sweepBacklog()).toBe(1);
    expect((await store.list(T)).items[0]?.subject.id).toBe(member.id);
  });

  it('un cambio posterior del miembro vuelve a requerir expediente propio', async () => {
    const member = putAlert({ priority: 'P3' });
    putAlert({ priority: 'P2', ruleId: 'qapaq-correlator:mail-burst', relatedAlertIds: [member.id] });
    const { host, store } = await harness({});
    expect(await host.sweepBacklog()).toBe(1);
    putAlert({ ...member, updatedAt: new Date(Date.now() + 60_000), revision: 1 });
    expect(await host.sweepBacklog()).toBe(1);
    expect((await store.list(T)).items).toHaveLength(2);
  });

  it('no agrupa cuando el lector no puede incluir todos los miembros', async () => {
    const count = EVIDENCE_LIMITS.maxRelatedAlerts + 1;
    const members = Array.from({ length: count }, () => putAlert({ priority: 'P3' }));
    putAlert({ priority: 'P2', ruleId: 'qapaq-correlator:mail-burst', relatedAlertIds: members.map((a) => a.id) });
    const { host, store } = await harness({});
    // El barrido encola por lotes: se repite hasta cubrir a todos los miembros.
    for (let i = 0; i < Math.ceil((count + 1) / ANALYST_HOST_DEFAULTS.sweepBatch) + 2; i += 1) {
      await host.sweepBacklog();
    }
    let total = 0;
    let cursor: Awaited<ReturnType<typeof store.list>>['next'] | undefined;
    do {
      const page = await store.list(T, { pageSize: 100, ...(cursor ? { cursor } : {}) });
      total += page.items.length;
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(total).toBe(count + 1);
  });

  it('el resumen diario sale una vez a la hora de Lima configurada', async () => {
    const { hour } = limaClock(new Date());
    const { host, digests } = await harness({
      reports: { perRun: true, digest: 'daily', digestHourLima: hour },
    });
    expect(await host.runDailyDigest()).toBe(true);
    expect(digests[0]).toMatchObject({ date: limaClock(new Date()).day });
    const later = await harness({
      reports: { perRun: true, digest: 'daily', digestHourLima: Math.min(23, hour + 1) },
    });
    if (hour < 23) expect(await later.host.runDailyDigest()).toBe(false);
  });

  it('stop aborta y drena: el trabajo en curso devuelve el intento sin contarlo', async () => {
    const alert = putAlert({ priority: 'P3' });
    const { host, store } = await harness({});
    const { job } = await host.enqueueAlert(alert, { source: 'new_alert' });
    await host.stop();
    expect(await host.runOnce()).toBe('idle');
    expect((await store.byId(T, job.id))?.status).toBe('queued');
  });

  it('stop durante la lectura de evidencia devuelve el trabajo a la cola (HOST_SHUTDOWN)', async () => {
    const alert = putAlert({ priority: 'P3' });
    const store = new InMemoryInvestigationStore();
    const settings = new InMemoryAnalystSettingsStore();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const host = new AnalystHost({
      tenantId: T,
      config: config(),
      store,
      settings,
      evidence: {
        collect: (_job, signal) =>
          new Promise((_resolve, reject) => {
            reading();
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
      actions: new RuntimeSocActions({ tenantId: T, soc: deps, read: soc }),
      models: {},
      soc,
      clock: () => new Date(),
      consoleBaseUrl: 'https://soc.example',
    });
    const { job } = await host.enqueueAlert(alert, { source: 'new_alert' });
    const run = host.runOnce();
    await started;
    await host.stop();
    expect(await run).toBe('processed');
    const after = await store.byId(T, job.id);
    expect(after).toMatchObject({ status: 'queued', lastErrorCode: 'HOST_SHUTDOWN' });
  });

  it('el techo de los ajustes nunca supera el del despliegue', () => {
    const settings = {
      ...DEFAULT_ANALYST_SETTINGS,
      budget: { ...DEFAULT_ANALYST_SETTINGS.budget, dailyCeilingMicroUsd: 9_000_000 },
    };
    expect(clampSettings(settings, 2_000_000).budget.dailyCeilingMicroUsd).toBe(2_000_000);
    expect(clampSettings(settings, null).budget.dailyCeilingMicroUsd).toBeNull();
  });
});

describe('escalación sin duplicados e incidentes sin expediente', () => {
  const job = (alert: Alert) =>
    ({
      id: randomUUID(),
      tenantId: T,
      subject: { kind: 'alert', id: alert.id },
      alertIds: [alert.id],
      policyVersion: 'p',
    }) as unknown as InvestigationJob;
  const result = { verdict: 'likely_true_positive', confidence: 'high', verified: true } as never;

  it('asocia al incidente abierto del mismo grupo y solo crea uno si no hay', async () => {
    const actions = new RuntimeSocActions({ tenantId: T, soc: deps, read: soc, audit: soc.audit });
    const first = putAlert({ priority: 'P1' });
    const created = await actions.escalate(job(first), result);
    expect(created.disposition).toBe('created');
    const incident = soc.incidentRows.get(`${T}|${created.incidentId}`)!;
    expect(incident.title).toBe(`Analista IA · P1 · regla ${RULE} · ${ENTITY}`);
    const second = putAlert({ priority: 'P1' });
    const attached = await actions.escalate(job(second), result);
    expect(attached).toEqual({ incidentId: created.incidentId, disposition: 'attached' });
    expect(soc.incidentRows.size).toBe(1);
    expect(soc.incidentRows.get(`${T}|${created.incidentId}`)?.alertIds).toEqual([
      first.id,
      second.id,
    ]);
    expect((await soc.alertById(T, second.id))?.incidentId).toBe(created.incidentId);
    // Otro grupo (otra regla) abre su propio incidente.
    const other = putAlert({ priority: 'P1', ruleId: 'otra-regla' });
    expect((await actions.escalate(job(other), result)).disposition).toBe('created');
    expect(soc.incidentRows.size).toBe(2);
    const audited = (await soc.audit.range(T, 1n, 100)).map((event) => event.action);
    expect(audited.filter((a) => a === 'ai.analyst.escalation.incident_created')).toHaveLength(2);
    expect(audited.filter((a) => a === 'ai.analyst.escalation.incident_attached')).toHaveLength(1);
    expect(audited).toContain('soc.incident.attach_alert');
  });

  it('un incidente cerrado no se reutiliza', async () => {
    const actions = new RuntimeSocActions({ tenantId: T, soc: deps, read: soc });
    const first = putAlert({ priority: 'P2' });
    const created = await actions.escalate(job(first), result);
    const key = `${T}|${created.incidentId}`;
    soc.incidentRows.set(key, { ...soc.incidentRows.get(key)!, status: 'closed' });
    const second = putAlert({ priority: 'P2' });
    expect((await actions.escalate(job(second), result)).disposition).toBe('created');
  });

  it('el barrido documenta cada incidente abierto con UNA nota, idempotente tras reiniciar', async () => {
    const actions = new RuntimeSocActions({ tenantId: T, soc: deps, read: soc });
    const alertA = putAlert({ priority: 'P2' });
    const alertB = putAlert({ priority: 'P1', ruleId: 'otra-regla' });
    const a = await actions.escalate(job(alertA), result);
    const b = await actions.escalate(job(alertB), result);
    const store = new InMemoryInvestigationStore();
    const settings = new InMemoryAnalystSettingsStore();
    await settings.put(T, { ...DEFAULT_ANALYST_SETTINGS, enabled: true }, 0, 'admin', NOW);
    const build = () =>
      new AnalystHost({
        tenantId: T,
        config: config(),
        store,
        settings,
        evidence: new RuntimeEvidenceReader({ tenantId: T, soc, now: () => new Date() }),
        actions: new RuntimeSocActions({ tenantId: T, soc: deps, read: soc }),
        models: {},
        soc,
        clock: () => new Date(),
        consoleBaseUrl: 'https://soc.example',
        retryDelayMs: () => 0,
      });
    const drain = async (host: AnalystHost) => {
      for (let index = 0; index < 10; index += 1) {
        if ((await host.runOnce()) === 'idle') return;
      }
    };
    const host = build();
    expect(await host.sweepIncidents()).toBe(2);
    await drain(host);
    const notesOf = (incidentId: string) =>
      [...soc.noteRows.values()].filter(
        (note) => note.incidentId === incidentId && note.authorId === ANALYST_SERVICE_ACTOR_ID,
      );
    expect(notesOf(a.incidentId!)).toHaveLength(1);
    expect(notesOf(b.incidentId!)).toHaveLength(1);
    expect(await host.sweepIncidents()).toBe(0);
    // Reinicio: otro host sobre los mismos almacenes no vuelve a documentar.
    const restarted = build();
    expect(await restarted.sweepIncidents()).toBe(0);
    await drain(restarted);
    expect(notesOf(a.incidentId!)).toHaveLength(1);
    expect(notesOf(b.incidentId!)).toHaveLength(1);
    // Nunca cambia el estado de los incidentes.
    expect([...soc.incidentRows.values()].map((incident) => incident.status)).toEqual([
      'open',
      'open',
    ]);
    const jobs = (await store.list(T, { pageSize: 100 })).items;
    expect(jobs.map((item) => item.idempotencyKey).sort()).toEqual(
      [`incident:${a.incidentId}`, `incident:${b.incidentId}`].sort(),
    );
    expect(jobs.every((item) => item.source === 'backlog')).toBe(true);
  });
});

describe('evidencia ampliada (mismo alcance que Qapaqzito, sin modelo)', () => {
  it('reúne incidentes, riesgo, eventos, actividad, avisos y auditoría; lo inalcanzable es un vacío', async () => {
    const actions = new RuntimeSocActions({ tenantId: T, soc: deps, read: soc });
    const linked = putAlert({ priority: 'P1' });
    await actions.escalate(
      {
        id: randomUUID(),
        tenantId: T,
        subject: { kind: 'alert', id: linked.id },
        alertIds: [linked.id],
        policyVersion: 'p',
      } as unknown as InvestigationJob,
      { verdict: 'likely_true_positive', confidence: 'high', verified: true } as never,
    );
    const alert = putAlert({ priority: 'P2', title: 'QAPAQ Office 365: inicio de sesión sospechoso' });
    const requests: unknown[] = [];
    const event = (id: string, principal: string) => ({
      event: {
        recordId: id,
        occurredAt: NOW.toISOString(),
        source: { product: 'Wazuh', vendor: 'Wazuh, Inc.' },
        category: ['authentication'],
        action: 'logon',
        outcome: 'failure',
        entities: { identities: [{ kind: 'user', id: 'x', principal }] },
      },
      raw: { full_log: 'CRUDO' },
    });
    const reader = new RuntimeEvidenceReader({
      tenantId: T,
      soc,
      knowledge: { rules: {}, techniques: {}, useCases: [], runbooks: [] } as never,
      events: {
        // Como el proveedor real: con filtro por entidad solo devuelve los eventos de la entidad.
        read: async (request) => {
          requests.push(request.filters);
          const all = [event('e-1', 'jperez@qapaq.pe'), event('e-2', 'otro@qapaq.pe')];
          const wanted = request.filters.entities?.map((entity) => entity.value.toLowerCase());
          return {
            items: (wanted
              ? all.filter((item) =>
                  wanted.includes(item.event.entities.identities[0]!.principal.toLowerCase()),
                )
              : all) as never,
            unparsedCount: 0,
            nextCursor: null,
          };
        },
      },
      correlator: async (path) =>
        path.startsWith('/v1/entity?')
          ? {
              status: 200,
              body: {
                entity: { score: 77, peak: 90, observations: 5, tactics: ['initial-access'], sources: ['m365'] },
              },
            }
          : { status: 503, body: null },
      audit: {
        read: async () => ({
          events: [
            {
              action: 'soc.alert.acknowledge',
              outcome: 'succeeded',
              actor: { id: 'x', type: 'user' },
              occurredAt: NOW,
            },
          ] as never,
          nextCursor: null,
        }),
      },
      notifications: {
        listByTenant: async () =>
          [{ status: 'sent', channel: 'teams', updatedAt: NOW, context: { alertId: alert.id } }] as never,
      },
      now: () => new Date(),
    });
    const bundle = await reader.collect(
      { tenantId: T, alertIds: [alert.id] } as unknown as InvestigationJob,
      new AbortController().signal,
    );
    const context = bundle.context!;
    expect(context.incidents).toHaveLength(1);
    expect(context.incidents[0]).toMatchObject({ status: 'open', alertCount: 1 });
    expect(context.entityRisk).toMatchObject({ score: 77, entityRef: ENTITY });
    expect(context.activity).toMatchObject({ entityRef: ENTITY, events24h: 1 });
    expect(context.notifications).toEqual([
      { status: 'sent', channel: 'teams', at: NOW.toISOString() },
    ]);
    expect(context.audit[0]).toMatchObject({ action: 'soc.alert.acknowledge', actorType: 'user' });
    expect(bundle.events.map((item) => item.id)).toEqual(['e-1']);
    expect(bundle.events[0]!.entityRefs).toEqual([ENTITY]);
    // Lectura dirigida por la entidad (no un barrido del tenant) y agregados de todo lo leído.
    expect(requests.length).toBeGreaterThan(0);
    for (const filters of requests) {
      expect(filters).toEqual({ entities: [{ kind: 'user', value: 'jperez@qapaq.pe' }] });
    }
    expect(bundle.eventSummary).toMatchObject({
      entityScoped: true,
      window: { matching: 1 },
      day: { matching: 1 },
      byOutcome: [{ value: 'failure', count: 1 }],
    });
    expect(bundle.completeness.gaps.join(' | ')).not.toMatch(/truncad|sin agotar|limitada/u);
    const gaps = bundle.completeness.gaps.join(' | ');
    expect(gaps).toContain('conocimiento SOC versionado');
    expect(gaps).toContain('Microsoft 365');
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('jperez@qapaq.pe');
    expect(text).not.toContain('CRUDO');

    const bare = await new RuntimeEvidenceReader({ tenantId: T, soc, now: () => new Date() }).collect(
      { tenantId: T, alertIds: [alert.id] } as unknown as InvestigationJob,
      new AbortController().signal,
    );
    const bareGaps = bare.completeness.gaps.join(' | ');
    for (const named of ['Lector de eventos', 'Correlador', 'avisos', 'Auditoría', 'Conocimiento SOC']) {
      expect(bareGaps).toContain(named);
    }
  });
});

describe('estado del host y panel de actividad', () => {
  it('estado en memoria: apagado, sin iniciar, activo, pasadas, fallo superado y detenido', async () => {
    const off = await harness({}, { config: { enabled: false } });
    expect(off.host.status()).toMatchObject({ enabled: false, running: false, inFlight: 0, lastTickAt: null });
    off.host.start();
    expect(off.host.status().running).toBe(false);

    const { host, store } = await harness({ mode: 'shadow' }, { config: { backlogSweep: false } });
    expect(host.status()).toMatchObject({
      enabled: true,
      running: false,
      concurrency: 1,
      lastTickAt: null,
      lastProcessedAt: null,
      lastErrorCode: null,
    });
    await host.enqueueAlert(putAlert({ priority: 'P4' }), { source: 'new_alert' });
    expect(await host.runOnce()).toBe('processed');
    const afterRun = host.status();
    expect(afterRun.lastTickAt).toBeInstanceOf(Date);
    expect(afterRun.lastProcessedAt).toBeInstanceOf(Date);
    expect(afterRun.inFlight).toBe(0);
    expect(await host.runOnce()).toBe('idle');
    expect(host.status().lastProcessedAt).toEqual(afterRun.lastProcessedAt);

    const claim = store.claim.bind(store);
    store.claim = () => Promise.reject(new Error('db down'));
    await expect(host.runOnce()).rejects.toThrow('db down');
    expect(host.status().lastErrorCode).toBe('RUNNER_FAILED');
    store.claim = claim;
    expect(await host.runOnce()).toBe('idle');
    expect(host.status().lastErrorCode).toBeNull();

    host.start();
    expect(host.status().running).toBe(true);
    await host.stop();
    expect(host.status().running).toBe(false);
  });

  it('atraso sin expediente: alertas sin trabajo del sistema e incidentes sin trabajo ni nota', async () => {
    const { host } = await harness({ mode: 'shadow' }, { config: { backlogSweep: false } });
    const covered = putAlert({ priority: 'P3' });
    putAlert({ priority: 'P2' });
    putAlert({ priority: 'P4', status: 'closed' });
    await host.enqueueAlert(covered, { source: 'new_alert' });
    expect(await host.backlog()).toEqual({ openAlertsWithoutCaseFile: 1, openIncidentsWithoutCaseFile: 0 });

    // Lectura incompleta (más filas que las devueltas) y sin lector de incidentes ⇒ sin dato.
    const partial = new AnalystHost({
      tenantId: T,
      config: config({ backlogSweep: false }),
      store: new InMemoryInvestigationStore(),
      settings: new InMemoryAnalystSettingsStore(),
      evidence: { collect: () => Promise.reject(new Error('unused')) },
      actions: {} as never,
      models: {},
      soc: { listAlerts: async () => ({ items: [], total: 5 }) },
      clock: () => new Date(),
      consoleBaseUrl: 'https://soc.example',
    });
    expect(await partial.backlog()).toEqual({ openAlertsWithoutCaseFile: null, openIncidentsWithoutCaseFile: null });
  });
});
