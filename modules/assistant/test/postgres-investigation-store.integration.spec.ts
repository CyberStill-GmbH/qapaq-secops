/**
 * Analista IA en PostgreSQL real (excluido del run unitario; requiere `DATABASE_URL`).
 *
 * Fija lo que solo la base demuestra: claim concurrente con SKIP LOCKED, fencing tras takeover,
 * enqueue idempotente, carrera por la última cuota diaria (advisory lock), bitácora append-only,
 * libro de acciones idempotente, CAS de ajustes, listado por clave y los CHECK de la migración.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresInvestigationStore } from '../src/infrastructure/postgres-investigation-store.js';
import {
  DEFAULT_ANALYST_SETTINGS,
  InvestigationRunner,
  type InvocationReservationRequest,
} from '../src/investigations/index.js';
import {
  BASE,
  draft,
  FakeClock,
  FakeEvidence,
  FakeModel,
  LIMITS,
  RATE_CARD,
  settings,
  TENANT,
} from './investigations-fixtures.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../../../platform/database/', import.meta.url));
const postMigrate = readFileSync(
  fileURLToPath(new URL('../../../platform/database/bootstrap/post-migrate.sql', import.meta.url)),
  'utf8',
);

const reservation = (
  at: Date,
  fingerprint: string,
  overrides: Partial<InvocationReservationRequest> = {},
) => ({
  at,
  phase: 'analysis' as const,
  fingerprint,
  tier: 'economy' as const,
  model: 'economy-model',
  reservedInputTokens: 100,
  reservedOutputTokens: 100,
  reservedMicroUsd: 600,
  rateCardVersion: RATE_CARD.version,
  dailyCeilingMicroUsd: 1_000,
  maxCallsPerRun: 1,
  ...overrides,
});

describe.skipIf(!databaseUrl)('Analista IA · almacén PostgreSQL', () => {
  const name = `qapaq_analyst_${process.pid}_${Date.now()}`.toLowerCase();
  let url: string;
  let store: PostgresInvestigationStore;
  let other: PostgresInvestigationStore;

  beforeAll(async () => {
    const admin = new URL(databaseUrl!);
    admin.pathname = '/postgres';
    const client = new Client(admin.toString());
    await client.connect();
    await client.query(`CREATE DATABASE "${name}"`);
    await client.end();
    const target = new URL(databaseUrl!);
    target.pathname = `/${name}`;
    url = target.toString();
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: url },
        shell: process.platform === 'win32',
      },
    );
    store = PostgresInvestigationStore.connect({ connectionString: url, maxConnections: 4 });
    other = PostgresInvestigationStore.connect({ connectionString: url, maxConnections: 4 });
    await store.ready();
  });

  afterAll(async () => {
    await store?.close();
    await other?.close();
    const admin = new URL(databaseUrl!);
    admin.pathname = '/postgres';
    const client = new Client(admin.toString());
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.end();
  });

  async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    const client = new Client(url);
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows;
    } finally {
      await client.end();
    }
  }

  async function clearQueue(): Promise<void> {
    // Solo el dueño de la tabla puede borrar; el runtime real no tiene DELETE en eventos.
    await sql(
      'TRUNCATE ai_investigation_actions, ai_investigation_invocations, ai_investigation_events, ai_investigation_jobs',
    );
  }

  it('enqueue es idempotente por (tenant, clave) y rechaza borradores inválidos', async () => {
    await clearQueue();
    const first = await store.enqueue(draft({ idempotencyKey: 'same-key', source: 'backlog' }));
    const again = await other.enqueue(draft({ idempotencyKey: 'same-key' }));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, job: { id: first.job.id, source: 'backlog' } });
    await expect(store.enqueue(draft({ id: 'no-es-uuid' }))).rejects.toThrow('INVALID_JOB');
  });

  it('claims concurrentes: cada trabajo una sola vez, P1 primero', async () => {
    await clearQueue();
    for (let index = 0; index < 6; index += 1) {
      await store.enqueue(
        draft({
          priority: index === 5 ? 'P1' : 'P3',
          createdAt: new Date(BASE - (6 - index) * 1000),
        }),
      );
    }
    const at = new Date(BASE);
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) => (index % 2 ? store : other).claim(at, 60_000, 3)),
    );
    const claimed = claims.filter((job) => job !== null);
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed.map((job) => job!.id)).size).toBe(6);
    const first = await store.claim(at, 60_000, 3);
    expect(first).toBeNull();
    const p1 = claimed.find((job) => job!.priority === 'P1')!;
    expect(p1.fencingToken).toBe(1);
  });

  it('fencing: el dueño anterior no escribe tras el takeover', async () => {
    await clearQueue();
    const { job } = await store.enqueue(draft());
    const a = (await store.claim(new Date(BASE), 10_000, 3))!;
    const lease = { jobId: a.id, fencingToken: a.fencingToken };
    expect(
      await store.checkpoint(lease, {
        at: new Date(BASE + 1),
        stage: 'triage',
        event: { kind: 'started' },
      }),
    ).toBe(true);
    const later = new Date(BASE + 20_000);
    expect(await store.heartbeat(lease, later, 10_000)).toBe('lost');
    const b = (await other.claim(later, 10_000, 3))!;
    expect(b.fencingToken).toBe(a.fencingToken + 1);
    expect(await store.checkpoint(lease, { at: later, stage: 'model' })).toBe(false);
    expect(
      await store.finish(lease, {
        at: later,
        status: 'completed',
        result: null,
        inference: 'none',
      }),
    ).toBeNull();
    expect(await store.reserveInvocation(lease, reservation(later, job.fingerprint))).toEqual({
      ok: false,
      reason: 'STALE_LEASE',
    });
    expect(
      await store.planActions(lease, {
        at: later,
        status: 'completed',
        result: null,
        inference: 'none',
        actions: [],
      }),
    ).toBeNull();
    const current = await store.byId(TENANT, job.id);
    expect(current).toMatchObject({ status: 'running', stage: null, attempt: 2 });
  });

  it('carrera por la última cuota del día: una sola reserva gana', async () => {
    await clearQueue();
    const at = new Date(BASE);
    await store.enqueue(draft({ alertIds: ['a-1'] }));
    await store.enqueue(draft({ alertIds: ['a-2'] }));
    const j1 = (await store.claim(at, 60_000, 3))!;
    const j2 = (await other.claim(at, 60_000, 3))!;
    const outcomes = await Promise.all([
      store.reserveInvocation(
        { jobId: j1.id, fencingToken: j1.fencingToken },
        reservation(at, j1.fingerprint),
      ),
      other.reserveInvocation(
        { jobId: j2.id, fencingToken: j2.fencingToken },
        reservation(at, j2.fingerprint),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes).toContainEqual({ ok: false, reason: 'DAILY_CAP' });
    const snapshot = await store.budgetSnapshot(TENANT, at, 1_000);
    expect(snapshot.reservedMicroUsd).toBe(600);

    // Idempotencia y no reenvío de una llamada ambigua.
    const winner = outcomes.find((outcome) => outcome.ok)!;
    if (!winner.ok) throw new Error('sin ganador');
    const owner = winner.invocation.jobId === j1.id ? j1 : j2;
    const lease = { jobId: owner.id, fencingToken: owner.fencingToken };
    expect(await store.markDispatching(lease, winner.invocation.id, at)).toBe('ok');
    const again = await store.reserveInvocation(lease, reservation(at, owner.fingerprint));
    expect(again).toMatchObject({ ok: true, reused: true, invocation: { state: 'dispatching' } });
    expect(await store.markUsageUnknown(lease, winner.invocation.id, at)).toBe(true);
    expect((await store.budgetSnapshot(TENANT, at)).unknownCount).toBe(1);
  });

  it('la bitácora es append-only con secuencia monotónica', async () => {
    await clearQueue();
    const { job } = await store.enqueue(draft());
    const claimed = (await store.claim(new Date(BASE), 60_000, 3))!;
    const lease = { jobId: claimed.id, fencingToken: claimed.fencingToken };
    await Promise.all(
      [1, 2, 3, 4].map((index) =>
        store.appendEvent(lease, {
          at: new Date(BASE + index),
          stage: 'triage',
          kind: 'completed',
          detail: { index },
        }),
      ),
    );
    const events = await store.events(TENANT, job.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(await store.events('otro-tenant', job.id)).toEqual([]);

    // Rol runtime de producción: post-migrate.sql le quita UPDATE/DELETE en la bitácora.
    await sql(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qapaq_soc_runtime') THEN CREATE ROLE qapaq_soc_runtime; END IF; END $$`,
    );
    await sql('GRANT SELECT, INSERT, UPDATE, DELETE ON ai_investigation_events TO qapaq_soc_runtime');
    await sql(postMigrate);
    const privileges = await sql<{ update: boolean; delete: boolean; insert: boolean }>(
      `SELECT has_table_privilege('qapaq_soc_runtime', 'ai_investigation_events', 'UPDATE') AS update,
              has_table_privilege('qapaq_soc_runtime', 'ai_investigation_events', 'DELETE') AS delete,
              has_table_privilege('qapaq_soc_runtime', 'ai_investigation_events', 'INSERT') AS insert`,
    );
    expect(privileges[0]).toEqual({ update: false, delete: false, insert: true });
  });

  it('libro de acciones idempotente por (trabajo, tipo) y CHECK sin contención', async () => {
    await clearQueue();
    const { job } = await store.enqueue(draft());
    const claimed = (await store.claim(new Date(BASE), 60_000, 3))!;
    const lease = { jobId: claimed.id, fencingToken: claimed.fencingToken };
    const plan = {
      at: new Date(BASE),
      status: 'requires_review' as const,
      result: null,
      inference: 'none' as const,
      actions: [
        { kind: 'report' as const, reason: 'REPORT_PER_RUN' as const },
        {
          kind: 'request_review' as const,
          reason: 'REVIEW_REQUIRES_REVIEW' as const,
          urgency: 'immediate' as const,
          groupKey: 'rule:r|entity:e',
        },
      ],
    };
    expect(await store.planActions(lease, plan)).toHaveLength(2);
    expect(
      await store.markAction(lease, 'request_review', {
        at: new Date(BASE),
        state: 'executed',
        ref: { kind: 'notification', id: 'n-1' },
      }),
    ).toBe(true);
    const again = await store.planActions(lease, plan);
    expect(again?.find((action) => action.kind === 'request_review')).toMatchObject({
      state: 'executed',
      ref: { kind: 'notification', id: 'n-1' },
    });
    expect(await store.countImmediateReviews(TENANT, new Date(BASE - 1))).toBe(1);
    expect((await store.byId(TENANT, job.id))?.plannedStatus).toBe('requires_review');
    await expect(
      sql(
        `INSERT INTO ai_investigation_actions (id, job_id, tenant_id, kind, state, reason, at)
         VALUES (gen_random_uuid(), $1, $2, 'isolate_host', 'planned', 'X_REASON', now())`,
        [job.id, TENANT],
      ),
    ).rejects.toThrow(/ai_investigation_actions_kind_allowed/u);
  });

  it('ajustes con compare-and-set y validados al leer y escribir', async () => {
    expect(await store.settings.get(TENANT)).toBeUndefined();
    expect(await store.settings.put(TENANT, settings(), 0, 'ana', new Date(BASE))).toBe('ok');
    expect(
      await other.settings.put(TENANT, DEFAULT_ANALYST_SETTINGS, 0, 'luis', new Date(BASE)),
    ).toBe('conflict');
    expect(
      await other.settings.put(TENANT, DEFAULT_ANALYST_SETTINGS, 1, 'luis', new Date(BASE)),
    ).toBe('ok');
    expect(await store.settings.get(TENANT)).toMatchObject({
      revision: 2,
      updatedBy: 'luis',
      settings: { enabled: false },
    });
  });

  it('listado por clave, más recientes primero', async () => {
    await clearQueue();
    for (let index = 0; index < 5; index += 1) {
      await store.enqueue(draft({ createdAt: new Date(BASE + index * 1000) }));
    }
    const first = await store.list(TENANT, { pageSize: 2 });
    const second = await store.list(TENANT, { pageSize: 2, cursor: first.next! });
    const third = await store.list(TENANT, { pageSize: 2, cursor: second.next! });
    expect(
      [...first.items, ...second.items, ...third.items].map((job) => job.createdAt.getTime()),
    ).toEqual([4, 3, 2, 1, 0].map((index) => BASE + index * 1000));
    expect(third.next).toBeNull();
    expect((await store.list(TENANT, { status: 'completed' })).items).toEqual([]);
  });

  it('runner de punta a punta sobre PostgreSQL: una llamada, uso liquidado', async () => {
    await clearQueue();
    const clock = new FakeClock();
    const model = new FakeModel();
    const { job } = await store.enqueue(draft({ priority: 'P2' }));
    const runner = new InvestigationRunner({
      store,
      evidence: new FakeEvidence(),
      models: { economy: { id: 'economy-model', model } },
      rateCard: RATE_CARD,
      limits: LIMITS,
      clock,
    });
    expect(await runner.runOnce()).toBe('processed');
    expect(model.requests).toHaveLength(1);
    const done = await store.byId(TENANT, job.id);
    expect(done).toMatchObject({
      status: 'completed',
      inference: 'economy',
      result: { verified: true },
    });
    expect((await store.invocations(TENANT, job.id))[0]).toMatchObject({
      state: 'settled',
      estimatedMicroUsd: 1900,
    });
    expect((await store.budgetSnapshot(TENANT, clock.now())).runsToday.economy).toBe(1);
  });

  it('panel de actividad: cola por prioridad, terminados en la ventana, recientes, escalaciones y claves', async () => {
    await clearQueue();
    const at = (ms: number) => new Date(BASE + ms);
    const waiting = await store.enqueue(draft({ priority: 'P3', createdAt: at(-5_000) }));
    const urgent = await store.enqueue(draft({ priority: 'P1' }));
    await store.enqueue(draft({ tenantId: 'tenant-ajeno', priority: 'P4', idempotencyKey: 'ajena' }));
    const job = (await store.claim(at(0), 60_000, 3))!;
    expect(job.id).toBe(urgent.job.id);
    let counts = await store.activityCounts(TENANT, at(-1), at(86_400_000));
    expect(counts.queue).toEqual({
      queued: 1,
      running: 1,
      oldestQueuedAt: at(-5_000),
      byPriority: { P1: 0, P2: 0, P3: 1, P4: 0 },
    });
    const lease = { jobId: job.id, fencingToken: job.fencingToken };
    await store.appendEvent(lease, {
      at: at(10),
      stage: 'acting',
      kind: 'completed',
      detail: { action: 'escalate', incident: 'created' },
    });
    await store.appendEvent(lease, { at: at(11), stage: 'acting', kind: 'completed', detail: { action: 'report' } });
    await store.finish(lease, { at: at(20), status: 'failed', result: null, inference: 'none', errorCode: 'X_FAILED' });
    counts = await store.activityCounts(TENANT, at(-1), at(86_400_000));
    expect(counts.finished).toEqual({
      total: 1,
      byInference: { none: 1, economy: 0, advanced: 0 },
      byStatus: { failed: 1 },
    });
    expect(counts.settledMicroUsd).toBe(0);
    expect((await store.activityCounts(TENANT, at(21), at(86_400_000))).finished.total).toBe(0);
    expect((await store.recentJobs(TENANT, at(0), 10)).map((row) => row.id)).toEqual([job.id]);
    expect(await store.recentJobs(TENANT, at(21), 10)).toEqual([]);
    expect(await store.escalationOutcomes(TENANT, at(0), at(100))).toEqual([
      { jobId: job.id, at: at(10), disposition: 'created' },
    ]);
    expect(await store.escalationOutcomes('tenant-ajeno', at(0), at(100))).toEqual([]);
    expect([
      ...(await store.existingKeys(TENANT, [waiting.job.idempotencyKey, 'ajena', 'nada'])),
    ]).toEqual([waiting.job.idempotencyKey]);
    expect(await store.existingKeys(TENANT, [])).toEqual(new Set());
  });

  it('los CHECK rechazan estados fuera de catálogo y leases incoherentes', async () => {
    const { job } = await store.enqueue(draft());
    await expect(
      sql(`UPDATE ai_investigation_jobs SET status = 'closed', finished_at = now() WHERE id = $1`, [
        job.id,
      ]),
    ).rejects.toThrow(/ai_investigation_jobs_status_allowed/u);
    await expect(
      sql(`UPDATE ai_investigation_jobs SET status = 'running' WHERE id = $1`, [job.id]),
    ).rejects.toThrow(/ai_investigation_jobs_lease_coherent/u);
    await expect(
      sql(`UPDATE ai_investigation_jobs SET last_error_code = 'bad code' WHERE id = $1`, [job.id]),
    ).rejects.toThrow(/ai_investigation_jobs_error_code_format/u);
  });
});
