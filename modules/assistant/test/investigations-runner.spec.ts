/**
 * Analista IA — runner y almacén en memoria: caminos felices, costo (una llamada como máximo),
 * concurrencia, fencing, caídas antes/después del envío, cancelación, cuarentena, ajustes y
 * acciones.
 */

import { describe, expect, it } from 'vitest';

import {
  ANALYST_SYSTEM_PROMPT,
  fingerprintOf,
  InferenceNotSentError,
  InMemoryAnalystSettingsStore,
  InMemoryInvestigationStore,
  InvestigationInputError,
  InvestigationRunner,
  POLICY_VERSION,
  type AnalystSettings,
  type InvestigationRunnerLimits,
  type InvestigationRunnerOptions,
} from '../src/investigations/index.js';
import {
  alert,
  analystJson,
  AUTONOMOUS,
  BASE,
  bundle,
  draft,
  FakeClock,
  FakeEvidence,
  FakeModel,
  FakeSocActions,
  LIMITS,
  RATE_CARD,
  response,
  settings,
  TENANT,
} from './investigations-fixtures.js';

interface Harness {
  readonly store: InMemoryInvestigationStore;
  readonly clock: FakeClock;
  readonly evidence: FakeEvidence;
  readonly economy: FakeModel;
  readonly advanced: FakeModel;
  runner(overrides?: Partial<InvestigationRunnerOptions>): InvestigationRunner;
}

function harness(): Harness {
  const store = new InMemoryInvestigationStore();
  const clock = new FakeClock();
  const evidence = new FakeEvidence();
  const economy = new FakeModel();
  const advanced = new FakeModel();
  return {
    store,
    clock,
    evidence,
    economy,
    advanced,
    runner: (overrides = {}) =>
      new InvestigationRunner({
        store,
        evidence,
        models: {
          economy: { id: 'economy-model', model: economy },
          advanced: { id: 'advanced-model', model: advanced },
        },
        rateCard: RATE_CARD,
        limits: LIMITS,
        clock,
        retryDelayMs: () => 0,
        ...overrides,
      }),
  };
}

const calls = (h: Harness) => h.economy.requests.length + h.advanced.requests.length;

describe('runner · caminos felices', () => {
  it('la vía determinista no hace ninguna llamada al modelo', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P4' }));
    expect(await h.runner().runOnce()).toBe('processed');
    const done = await h.store.byId(TENANT, job.id);
    expect(calls(h)).toBe(0);
    expect(done).toMatchObject({
      status: 'completed',
      inference: 'none',
      stage: null,
      leaseUntil: null,
    });
    expect(done?.result?.deterministic.reasons).toContain('NOT_ELIGIBLE');
    expect(await h.store.invocations(TENANT, job.id)).toEqual([]);
    const events = await h.store.events(TENANT, job.id);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.find((event) => event.stage === 'model')?.kind).toBe('skipped');
  });

  it('P2 rutinario usa el nivel económico: una llamada, sin herramientas, prompt estable', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    await h.runner().runOnce();
    expect(h.economy.requests).toHaveLength(1);
    expect(h.advanced.requests).toHaveLength(0);
    const request = h.economy.requests[0]!;
    expect(request).toMatchObject({ system: ANALYST_SYSTEM_PROMPT, tools: [], allowTools: false });
    expect(request.maxTokens).toBeLessThanOrEqual(700);
    const done = await h.store.byId(TENANT, job.id);
    expect(done).toMatchObject({ status: 'completed', inference: 'economy' });
    expect(done?.result).toMatchObject({ verified: true, verdict: 'likely_true_positive' });
    expect(done?.result?.citations.map((citation) => citation.id)).toContain('alert-1');
    const [invocation] = await h.store.invocations(TENANT, job.id);
    expect(invocation).toMatchObject({
      state: 'settled',
      tier: 'economy',
      model: 'economy-model',
      usage: { inputTokens: 900, outputTokens: 200 },
      estimatedMicroUsd: 1900,
      rateCardVersion: 'test-card-1',
    });
  });

  it('P1 usa el nivel avanzado', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P1' }));
    await h.runner().runOnce();
    expect(h.advanced.requests).toHaveLength(1);
    expect(calls(h)).toBe(1);
    expect((await h.store.byId(TENANT, job.id))?.inference).toBe('advanced');
  });

  it('sin modelo avanzado baja al económico, nunca sube', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P1' }));
    await h.runner({ models: { economy: { id: 'economy-model', model: h.economy } } }).runOnce();
    expect(h.economy.requests).toHaveLength(1);
    expect((await h.store.byId(TENANT, job.id))?.result?.deterministic.reasons).toContain(
      'TIER_DOWNGRADED',
    );

    const h2 = harness();
    const { job: routine } = await h2.store.enqueue(draft({ priority: 'P2' }));
    await h2
      .runner({ models: { advanced: { id: 'advanced-model', model: h2.advanced } } })
      .runOnce();
    expect(calls(h2)).toBe(0);
    expect(await h2.store.byId(TENANT, routine.id)).toMatchObject({
      status: 'requires_review',
      inference: 'none',
    });
  });

  it('salida inválida: requiere revisión sin segunda llamada de reparación', async () => {
    const h = harness();
    const bad = new FakeModel(() => response('esto no es JSON'));
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    await h.runner({ models: { economy: { id: 'economy-model', model: bad } } }).runOnce();
    expect(bad.requests).toHaveLength(1);
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({
      status: 'requires_review',
      lastErrorCode: 'MALFORMED_JSON',
    });
  });

  it('una cita inventada deja el expediente no verificado y en revisión', async () => {
    const h = harness();
    const liar = new FakeModel(() =>
      response(
        analystJson({ facts: [{ text: 'Se exfiltraron datos.', citations: ['alert-404'] }] }),
      ),
    );
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    await h.runner({ models: { economy: { id: 'economy-model', model: liar } } }).runOnce();
    const done = await h.store.byId(TENANT, job.id);
    expect(done).toMatchObject({ status: 'requires_review', result: { verified: false } });
    expect(done?.result?.deterministic.reasons).toContain('UNVERIFIED_OUTPUT');
  });

  it('sin techo diario no hay inferencia: expediente determinista identificado como tal', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P1' }));
    await h.runner({ limits: { ...LIMITS, dailyCeilingMicroUsd: null } }).runOnce();
    expect(calls(h)).toBe(0);
    const done = await h.store.byId(TENANT, job.id);
    expect(done).toMatchObject({ status: 'requires_review', inference: 'none' });
    expect(done?.result?.deterministic.reasons).toContain('INFERENCE_DISABLED');
    expect(done?.result?.summary).toContain('sin análisis de IA');
  });

  it('la misma evidencia no se factura dos veces', async () => {
    const h = harness();
    await h.store.enqueue(draft({ priority: 'P2', idempotencyKey: 'first' }));
    await h.runner().runOnce();
    const { job: second } = await h.store.enqueue(
      draft({ priority: 'P2', idempotencyKey: 'second' }),
    );
    await h.runner().runOnce();
    expect(calls(h)).toBe(1);
    expect((await h.store.byId(TENANT, second.id))?.result?.deterministic.reasons).toContain(
      'REUSED_PRIOR_RESULT',
    );
  });
});

describe('almacén · cola, idempotencia y orden', () => {
  it('enqueue es idempotente por (tenant, clave) y valida el borrador', async () => {
    const store = new InMemoryInvestigationStore();
    const first = await store.enqueue(draft({ idempotencyKey: 'same' }));
    const again = await store.enqueue(draft({ idempotencyKey: 'same' }));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, job: { id: first.job.id } });
    await expect(
      store.enqueue(draft({ trigger: 'system', source: 'manual' })),
    ).rejects.toBeInstanceOf(InvestigationInputError);
    await expect(
      store.enqueue(draft({ trigger: 'user', initiatedBy: null })),
    ).rejects.toBeInstanceOf(InvestigationInputError);
  });

  it('el atraso nunca deja sin atender un P1 nuevo: prioridad primero, luego antigüedad', async () => {
    const store = new InMemoryInvestigationStore();
    await store.enqueue(
      draft({ priority: 'P3', source: 'backlog', createdAt: new Date(BASE - 86_400_000) }),
    );
    await store.enqueue(
      draft({ priority: 'P1', source: 'backlog', createdAt: new Date(BASE - 3_600_000) }),
    );
    const fresh = await store.enqueue(
      draft({ priority: 'P1', source: 'new_alert', createdAt: new Date(BASE) }),
    );
    const at = new Date(BASE + 1000);
    const order = [];
    for (let index = 0; index < 3; index += 1) order.push(await store.claim(at, 60_000, 3));
    expect(order.map((job) => [job?.priority, job?.source])).toEqual([
      ['P1', 'backlog'],
      ['P1', 'new_alert'],
      ['P3', 'backlog'],
    ]);
    expect(order[1]?.id).toBe(fresh.job.id);
  });

  it('lista por clave, más recientes primero, aislada por tenant', async () => {
    const store = new InMemoryInvestigationStore();
    for (let index = 0; index < 5; index += 1) {
      await store.enqueue(draft({ createdAt: new Date(BASE + index * 1000) }));
    }
    await store.enqueue(draft({ tenantId: 'otro' }));
    const first = await store.list(TENANT, { pageSize: 3 });
    const second = await store.list(TENANT, { pageSize: 3, cursor: first.next! });
    expect(first.items).toHaveLength(3);
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
    expect(first.items[0]!.createdAt.getTime()).toBe(BASE + 4000);
    expect((await store.list(TENANT, { status: 'running' })).items).toEqual([]);
  });
});

describe('concurrencia y fencing', () => {
  it('dos runners compiten por un trabajo: solo uno lo procesa', async () => {
    const h = harness();
    await h.store.enqueue(draft({ priority: 'P2' }));
    const outcomes = await Promise.all([h.runner().runOnce(), h.runner().runOnce()]);
    expect(outcomes.sort()).toEqual(['idle', 'processed']);
    expect(calls(h)).toBe(1);
  });

  it('dos runners compiten por la última cuota del día: uno analiza, el otro queda sin presupuesto', async () => {
    const probe = harness();
    const { job: sample } = await probe.store.enqueue(draft({ priority: 'P2' }));
    await probe.runner().runOnce();
    const [reservation] = await probe.store.invocations(TENANT, sample.id);
    const ceiling = reservation!.reservedMicroUsd + 100;

    const h = harness();
    const limits: InvestigationRunnerLimits = { ...LIMITS, dailyCeilingMicroUsd: ceiling };
    const a = await h.store.enqueue(draft({ priority: 'P2', alertIds: ['alert-1'] }));
    const b = await h.store.enqueue(draft({ priority: 'P2', alertIds: ['alert-2'] }));
    await Promise.all([h.runner({ limits }).runOnce(), h.runner({ limits }).runOnce()]);
    const statuses = [
      (await h.store.byId(TENANT, a.job.id))?.status,
      (await h.store.byId(TENANT, b.job.id))?.status,
    ].sort();
    expect(statuses).toEqual(['budget_exhausted', 'completed']);
    expect(calls(h)).toBe(1);
    const snapshot = await h.store.budgetSnapshot(TENANT, h.clock.now(), ceiling);
    expect(snapshot.settledMicroUsd + snapshot.reservedMicroUsd).toBeLessThanOrEqual(ceiling);
  });

  it('un token viejo no escribe nada tras el takeover', async () => {
    const store = new InMemoryInvestigationStore();
    await store.enqueue(draft());
    const first = (await store.claim(new Date(BASE), 10_000, 3))!;
    const stale = { jobId: first.id, fencingToken: first.fencingToken };
    const later = new Date(BASE + 20_000);
    const second = (await store.claim(later, 10_000, 3))!;
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    expect(second.attempt).toBe(2);
    expect(await store.heartbeat(stale, later, 10_000)).toBe('lost');
    expect(await store.checkpoint(stale, { at: later, stage: 'triage' })).toBe(false);
    expect(
      await store.finish(stale, {
        at: later,
        status: 'completed',
        result: null,
        inference: 'none',
      }),
    ).toBeNull();
    expect(
      await store.releaseForRetry(stale, {
        at: later,
        availableAt: later,
        errorCode: 'X_ERROR',
        maxAttempts: 3,
      }),
    ).toBe('stale');
    expect(
      await store.planActions(stale, {
        at: later,
        status: 'completed',
        result: null,
        inference: 'none',
        actions: [],
      }),
    ).toBeNull();
    expect((await store.byId(TENANT, first.id))?.status).toBe('running');
  });

  it('un lease vencido se recupera y el nuevo intento termina el trabajo', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P4' }));
    await h.store.claim(h.clock.now(), LIMITS.leaseMs, 3);
    expect(await h.runner().runOnce()).toBe('idle');
    h.clock.advance(LIMITS.leaseMs + 1);
    expect(await h.runner().runOnce()).toBe('processed');
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({ status: 'completed', attempt: 2 });
  });
});

describe('caídas alrededor del envío al proveedor', () => {
  it('caída antes del envío: la reserva se libera y el nuevo dueño envía una sola vez', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    const claimed = (await h.store.claim(h.clock.now(), LIMITS.leaseMs, 3))!;
    const reserved = await h.store.reserveInvocation(
      { jobId: claimed.id, fencingToken: claimed.fencingToken },
      {
        at: h.clock.now(),
        phase: 'analysis',
        fingerprint: fingerprintOf(TENANT, ['alert-1'], 'otra-marca', POLICY_VERSION),
        tier: 'economy',
        model: 'economy-model',
        reservedInputTokens: 10,
        reservedOutputTokens: 10,
        reservedMicroUsd: 100,
        rateCardVersion: RATE_CARD.version,
        dailyCeilingMicroUsd: 1_000_000,
        maxCallsPerRun: 1,
      },
    );
    expect(reserved.ok).toBe(true);
    h.clock.advance(LIMITS.leaseMs + 1);
    await h.runner().runOnce();
    expect(calls(h)).toBe(1);
    const states = (await h.store.invocations(TENANT, job.id)).map((row) => row.state).sort();
    expect(states).toEqual(['released', 'settled']);
    expect((await h.store.byId(TENANT, job.id))?.status).toBe('completed');
  });

  it('caída después del envío: queda uso por conciliar y el takeover no reinvoca', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    const taker = h.runner();
    const slow = new FakeModel(async () => {
      // El worker se cuelga con la llamada en vuelo: otro reclama tras vencer el lease.
      h.clock.advance(LIMITS.leaseMs + 1);
      expect(await taker.runOnce()).toBe('processed');
      return response(analystJson());
    });
    await h.runner({ models: { economy: { id: 'economy-model', model: slow } } }).runOnce();
    expect(slow.requests).toHaveLength(1);
    expect(h.economy.requests).toHaveLength(0);
    const done = await h.store.byId(TENANT, job.id);
    expect(done).toMatchObject({
      status: 'usage_unreconciled',
      lastErrorCode: 'USAGE_UNRECONCILED',
    });
    expect((await h.store.invocations(TENANT, job.id)).map((row) => row.state)).toEqual([
      'usage_unknown',
    ]);
    expect((await h.store.budgetSnapshot(TENANT, h.clock.now())).unknownCount).toBe(1);
  });

  it('error ambiguo del proveedor tras el envío: usage_unknown, sin reintento', async () => {
    const h = harness();
    const failing = new FakeModel(() => {
      throw new Error('socket hang up con datos de la solicitud');
    });
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    await h.runner({ models: { economy: { id: 'economy-model', model: failing } } }).runOnce();
    expect(failing.requests).toHaveLength(1);
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({ status: 'usage_unreconciled' });
    const events = JSON.stringify(await h.store.events(TENANT, job.id));
    expect(events).not.toContain('socket hang up');
  });

  it('error probado antes del envío: se libera la reserva y se reintenta', async () => {
    const h = harness();
    let first = true;
    const flaky = new FakeModel(() => {
      if (first) {
        first = false;
        throw new InferenceNotSentError();
      }
      return response(analystJson());
    });
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    const runner = h.runner({ models: { economy: { id: 'economy-model', model: flaky } } });
    await runner.runOnce();
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({
      status: 'queued',
      lastErrorCode: 'MODEL_NOT_SENT',
    });
    await runner.runOnce();
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({ status: 'completed' });
    expect((await h.store.invocations(TENANT, job.id)).map((row) => row.state)).toEqual([
      'settled',
    ]);
  });
});

describe('cancelación', () => {
  it('antes del envío: no reserva ni llama al modelo', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P1' }));
    h.evidence.next = async (claimed) => {
      expect(await h.store.requestCancel(TENANT, claimed.id, claimed.revision, h.clock.now())).toBe(
        'ok',
      );
      return bundle();
    };
    await h.runner().runOnce();
    expect(calls(h)).toBe(0);
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({ status: 'cancelled', result: null });
    expect(await h.store.invocations(TENANT, job.id)).toEqual([]);
  });

  it('después del envío: el resultado tardío conserva su uso y el trabajo sigue cancelado', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    const late = new FakeModel(async () => {
      const current = (await h.store.byId(TENANT, job.id))!;
      expect(await h.store.requestCancel(TENANT, job.id, current.revision, h.clock.now())).toBe(
        'ok',
      );
      return response(analystJson());
    });
    await h.runner({ models: { economy: { id: 'economy-model', model: late } } }).runOnce();
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({
      status: 'cancelled',
      result: null,
      inference: 'economy',
    });
    expect((await h.store.invocations(TENANT, job.id))[0]).toMatchObject({
      state: 'settled',
      estimatedMicroUsd: 1900,
    });
  });

  it('órdenes humanas con compare-and-set', async () => {
    const store = new InMemoryInvestigationStore();
    const { job } = await store.enqueue(draft());
    const at = new Date(BASE);
    expect(await store.requestCancel(TENANT, job.id, job.revision + 5, at)).toBe('conflict');
    expect(await store.requestCancel('otro', job.id, job.revision, at)).toBe('not_found');
    expect(await store.retry(TENANT, job.id, job.revision, at)).toBe('conflict');
    expect(await store.requestCancel(TENANT, job.id, job.revision, at)).toBe('ok');
    const cancelled = (await store.byId(TENANT, job.id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(await store.requestCancel(TENANT, job.id, cancelled.revision, at)).toBe('terminal');
    expect(await store.retry(TENANT, job.id, cancelled.revision, at)).toBe('ok');
    expect((await store.byId(TENANT, job.id))?.status).toBe('queued');
  });
});

describe('fallos transitorios y cuarentena', () => {
  it('un trabajo venenoso queda failed tras maxAttempts y no expone el error del origen', async () => {
    const h = harness();
    h.evidence.next = () => {
      throw new Error('indexer 500 con contenido del origen');
    };
    const { job } = await h.store.enqueue(draft({ priority: 'P2' }));
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt += 1) await h.runner().runOnce();
    expect(await h.runner().runOnce()).toBe('idle');
    const done = await h.store.byId(TENANT, job.id);
    expect(done).toMatchObject({
      status: 'failed',
      attempt: 3,
      lastErrorCode: 'EVIDENCE_UNAVAILABLE',
    });
    expect(h.evidence.calls).toBe(3);
    expect(JSON.stringify(await h.store.events(TENANT, job.id))).not.toContain('indexer 500');
  });
});

describe('ajustes del administrador gobiernan el runner', () => {
  async function withSettings(value: AnalystSettings, priority: 'P1' | 'P2' = 'P2') {
    const h = harness();
    const settingsStore = new InMemoryAnalystSettingsStore();
    await settingsStore.put(TENANT, value, 0, 'admin', new Date(BASE));
    const { job } = await h.store.enqueue(draft({ priority }));
    await h.runner({ settings: settingsStore }).runOnce();
    return { h, job: (await h.store.byId(TENANT, job.id))! };
  }

  it('sin ajustes guardados rige el valor por defecto: deshabilitado, sin modelo', async () => {
    const h = harness();
    const { job } = await h.store.enqueue(draft({ priority: 'P1' }));
    await h.runner({ settings: new InMemoryAnalystSettingsStore() }).runOnce();
    expect(calls(h)).toBe(0);
    expect((await h.store.byId(TENANT, job.id))?.result?.deterministic.reasons).toContain(
      'ANALYST_DISABLED',
    );
  });

  it('el alcance deja fuera prioridades', async () => {
    const { h, job } = await withSettings(
      settings({ scope: { priorities: ['P1'], inferenceMinPriority: 'P1' } }),
    );
    expect(calls(h)).toBe(0);
    expect(job.result?.deterministic.reasons).toContain('OUT_OF_SCOPE');
  });

  it('presupuesto, tokens de salida, nivel avanzado e instrucciones', async () => {
    const { h, job } = await withSettings(
      settings({
        budget: {
          dailyCeilingMicroUsd: 5_000_000,
          maxOutputTokens: 300,
          advancedTierEnabled: false,
        },
        instructions: 'Prioriza cuentas privilegiadas.',
      }),
      'P1',
    );
    expect(h.advanced.requests).toHaveLength(0);
    expect(h.economy.requests).toHaveLength(1);
    const request = h.economy.requests[0]!;
    expect(request.maxTokens).toBe(300);
    expect(request.system).toBe(ANALYST_SYSTEM_PROMPT);
    expect(String(request.messages[0]?.content)).toContain('Prioriza cuentas privilegiadas.');
    expect(job.inference).toBe('economy');
  });

  it('techo de los ajustes más bajo que el despliegue: manda el más estricto', async () => {
    const { h, job } = await withSettings(
      settings({
        budget: { dailyCeilingMicroUsd: 10, maxOutputTokens: 1_200, advancedTierEnabled: true },
      }),
    );
    expect(calls(h)).toBe(0);
    expect(job.status).toBe('budget_exhausted');
  });
});

describe('acciones sobre el SOC', () => {
  async function benignRun(socActions: FakeSocActions, value: AnalystSettings = AUTONOMOUS) {
    const h = harness();
    h.evidence.next = () =>
      bundle({
        alerts: [alert({ priority: 'P4' })],
        history: { total: 9, falsePositive: 9, truePositive: 0, open: 0 },
      });
    const settingsStore = new InMemoryAnalystSettingsStore();
    await settingsStore.put(TENANT, value, 0, 'admin', new Date(BASE));
    const { job } = await h.store.enqueue(draft({ priority: 'P4' }));
    const runner = h.runner({ settings: settingsStore, actions: socActions });
    return { h, job, runner };
  }

  it('autónomo: cierra el benigno determinista y adjunta el informe, sin pedir revisión', async () => {
    const soc = new FakeSocActions();
    const { h, job, runner } = await benignRun(soc);
    await runner.runOnce();
    expect(calls(h)).toBe(0);
    expect(soc.calls).toEqual(['close_benign', 'report']);
    expect(soc.reviews).toEqual([]);
    const actions = await h.store.actions(TENANT, job.id);
    expect(actions.every((action) => action.state === 'executed')).toBe(true);
    const done = await h.store.byId(TENANT, job.id);
    expect(done).toMatchObject({ status: 'completed', plannedStatus: null });
    expect((await h.store.events(TENANT, job.id)).some((event) => event.stage === 'acting')).toBe(
      true,
    );
  });

  it('un fallo del host se registra y no hace fallar la investigación', async () => {
    const soc = new FakeSocActions();
    soc.failOn = 'close_benign';
    const { h, job, runner } = await benignRun(soc);
    await runner.runOnce();
    const actions = await h.store.actions(TENANT, job.id);
    expect(actions.find((action) => action.kind === 'close_benign')).toMatchObject({
      state: 'failed',
      errorCode: 'ACTION_FAILED',
    });
    expect(actions.find((action) => action.kind === 'report')?.state).toBe('executed');
    expect((await h.store.byId(TENANT, job.id))?.status).toBe('completed');
    expect(JSON.stringify(await h.store.events(TENANT, job.id))).not.toContain('secret data');
  });

  it('tras un takeover no se repite una acción ya ejecutada', async () => {
    const soc = new FakeSocActions();
    const { h, job, runner } = await benignRun(soc);
    let crashed = false;
    const original = soc.attachReport.bind(soc);
    soc.attachReport = async () => {
      const outcome = await original();
      if (!crashed) {
        crashed = true;
        h.clock.advance(LIMITS.leaseMs + 1); // el worker pierde el lease en plena etapa `acting`
      }
      return outcome;
    };
    await runner.runOnce();
    expect((await h.store.byId(TENANT, job.id))?.status).toBe('running');
    await runner.runOnce();
    expect(soc.calls.filter((name) => name === 'close_benign')).toHaveLength(1);
    expect(soc.calls.filter((name) => name === 'request_review')).toHaveLength(0);
    expect(h.evidence.calls).toBe(1);
    expect(await h.store.byId(TENANT, job.id)).toMatchObject({ status: 'completed', attempt: 2 });
  });

  it('asistido: nunca cambia el estado de la alerta', async () => {
    const soc = new FakeSocActions();
    const { runner } = await benignRun(soc, { ...AUTONOMOUS, mode: 'assisted' });
    await runner.runOnce();
    expect(soc.calls).toEqual(['report']);
  });

  it('el libro de acciones es idempotente por (trabajo, tipo)', async () => {
    const store = new InMemoryInvestigationStore();
    await store.enqueue(draft());
    const job = (await store.claim(new Date(BASE), 60_000, 3))!;
    const lease = { jobId: job.id, fencingToken: job.fencingToken };
    const plan = {
      at: new Date(BASE),
      status: 'completed' as const,
      result: null,
      inference: 'none' as const,
      actions: [{ kind: 'report' as const, reason: 'REPORT_PER_RUN' as const }],
    };
    await store.planActions(lease, plan);
    expect(await store.markAction(lease, 'report', { at: new Date(BASE), state: 'executed' })).toBe(
      true,
    );
    const again = await store.planActions(lease, plan);
    expect(again).toHaveLength(1);
    expect(again?.[0]?.state).toBe('executed');
    expect(await store.markAction(lease, 'report', { at: new Date(BASE), state: 'failed' })).toBe(
      false,
    );
  });
});
