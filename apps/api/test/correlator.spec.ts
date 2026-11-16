import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ingestCandidate, type InMemorySoc } from '@qapaq/soc';
import type { DetectionCandidate } from '@qapaq/detection';
import { buildApi } from '../src/bootstrap.js';

const TOKEN = 'test-only-correlator-service-token-0123456789';
const now = new Date('2026-11-08T12:00:00.000Z');
let application: NestFastifyApplication;
let runtime: Awaited<ReturnType<typeof buildApi>>['runtime'];
let stop: () => Promise<void>;
const server = () => application.getHttpAdapter().getInstance();
const memorySoc = () => runtime.soc as InMemorySoc;

function candidateRequest(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'correlator-test-key-001',
    patternId: 'credential-chain',
    kind: 'sequence',
    title: 'Correlated credential activity',
    summary: 'Multiple independent signals share a user entity.',
    priority: 'P2',
    score: 75,
    riskScore: 72.5,
    signal: 'credential_access',
    primaryEntityKey: 'user:analyst@example.test',
    entityKeys: ['user:analyst@example.test', 'host:workstation-1'],
    relatedAlertIds: [],
    occurredAt: now.toISOString(),
    firstSeen: now.toISOString(),
    memberCount: 2,
    stages: [],
    sources: ['wazuh'],
    tactics: ['credential-access'],
    ...overrides,
  };
}

function serviceHeaders(token = TOKEN) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const built = await buildApi(
    { QAPAQ_PROFILE: 'test', QAPAQ_CORRELATOR_SERVICE_TOKEN: TOKEN },
    () => {},
  );
  application = built.application;
  runtime = built.runtime;
  stop = built.stop;
  await application.init();
  await server().ready();
});

afterAll(async () => stop());

beforeEach(() => {
  memorySoc().alertRows.clear();
  memorySoc().incidentRows.clear();
  memorySoc().outboxRows.clear();
  memorySoc().outboxState.clear();
});

describe('contrato privado del correlador', () => {
  it('falla cerrado si no se configuró token de servicio', async () => {
    const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
    try {
      await built.application.init();
      const internalServer = built.application.getHttpAdapter().getInstance();
      await internalServer.ready();
      const response = await internalServer.inject({
        method: 'GET',
        url: '/api/internal/correlator/alerts',
        headers: serviceHeaders(),
      });
      expect(response.statusCode).not.toBe(200);
    } finally {
      await built.stop();
    }
  });

  it('rechaza llamadas anónimas, bearer incorrecto y credenciales de usuario', async () => {
    const anonymous = await server().inject({
      method: 'GET',
      url: '/api/internal/correlator/alerts',
    });
    const wrongToken = await server().inject({
      method: 'GET',
      url: '/api/internal/correlator/alerts',
      headers: serviceHeaders('wrong'),
    });
    const humanToken = await server().inject({
      method: 'GET',
      url: '/api/internal/correlator/alerts',
      headers: { authorization: 'Bearer analyst-session' },
    });
    expect(anonymous.statusCode).not.toBe(200);
    expect(wrongToken.statusCode).toBe(anonymous.statusCode);
    expect(humanToken.statusCode).toBe(anonymous.statusCode);
  });

  it('materializa una alerta del tenant del runtime con auditoría y outbox; un retry no duplica', async () => {
    const first = await server().inject({
      method: 'POST',
      url: '/api/internal/correlator/candidates',
      headers: serviceHeaders(),
      payload: candidateRequest(),
    });
    const retry = await server().inject({
      method: 'POST',
      url: '/api/internal/correlator/candidates',
      headers: serviceHeaders(),
      payload: candidateRequest({
        occurredAt: '2026-11-08T11:59:00.000Z',
        summary: 'retry carried a newer summary',
      }),
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(first.body)).toMatchObject({ created: true });
    expect(JSON.parse(retry.body)).toMatchObject({
      created: false,
      alertId: JSON.parse(first.body).alertId,
    });
    expect(memorySoc().alertRows.size).toBe(1);
    expect(memorySoc().outboxRows.size).toBe(1);
    const alert = [...memorySoc().alertRows.values()][0];
    expect(alert?.tenantId).toBe(runtime.tenantId);
    expect(
      (await memorySoc().allAudit()).filter((event) => event.action === 'soc.alert.created'),
    ).toHaveLength(1);
  });

  it('convierte la explicación en razones de la alerta y rechaza explicaciones inválidas', async () => {
    const explanation = {
      narrative: 'Misma IP: bloqueo WAF, escaneo del borde y fuerza bruta SSH.',
      stages: [
        {
          stage: 'edge.waf_block',
          ruleId: '101501',
          source: 'cloudflare',
          at: now.toISOString(),
          observationId: '1762250400.00001',
        },
        {
          stage: 'ssh.bruteforce',
          ruleId: '5712',
          source: 'linux-ssh',
          at: now.toISOString(),
          observationId: '1762250400.00007',
        },
      ],
      evidenceObservationIds: ['1762250400.00001', '1762250400.00007'],
      nextSteps: ['Confirmar en Cloudflare los bloqueos WAF.'],
    };
    const created = await server().inject({
      method: 'POST',
      url: '/api/internal/correlator/candidates',
      headers: serviceHeaders(),
      payload: candidateRequest({ idempotencyKey: 'correlator-explained-001', explanation }),
    });
    expect(created.statusCode).toBe(201);
    const alert = [...memorySoc().alertRows.values()][0];
    const details = (alert?.reasons ?? []).map((reason) => reason.detail);
    expect(details[0]).toBe('Multiple independent signals share a user entity.');
    expect(details).toContain(
      'Explicación: Misma IP: bloqueo WAF, escaneo del borde y fuerza bruta SSH.',
    );
    expect(details.some((d) => d.startsWith('Etapa 2: ssh.bruteforce · regla 5712'))).toBe(true);
    expect(details).toContain('Evidencia (alertas Wazuh): 1762250400.00001, 1762250400.00007');
    expect(details).toContain('Siguiente paso: Confirmar en Cloudflare los bloqueos WAF.');

    for (const bad of [
      { stages: [{ stage: 'X;drop', ruleId: '1', source: 'aws', at: now.toISOString() }] },
      { evidenceObservationIds: ['<script>'] },
      { nextSteps: Array.from({ length: 5 }, () => 'paso') },
      'texto',
    ]) {
      const rejected = await server().inject({
        method: 'POST',
        url: '/api/internal/correlator/candidates',
        headers: serviceHeaders(),
        payload: candidateRequest({
          idempotencyKey: 'correlator-bad-explanation',
          explanation: bad,
        }),
      });
      expect(rejected.statusCode).toBe(422);
    }
  });

  it('no permite referencias relacionadas de otro tenant y el feed no permite ampliar tenant por query', async () => {
    const foreignTenant = 'tenant-outside-runtime';
    const foreign: DetectionCandidate = {
      id: '0199bf22-0000-7000-8000-000000000111',
      tenantId: foreignTenant,
      eventRecordId: '0199bf22-0000-7000-8000-000000000112',
      eventUid: 'foreign-event',
      idempotencyKey: 'foreign-key',
      priority: 'P2',
      score: 70,
      reasons: [{ code: 'CORRELATED_PATTERN', delta: 70, detail: 'foreign seed' }],
      rulesetId: 'test',
      rulesetVersion: '1.0.0',
      occurredAt: now,
      createdAt: now,
      title: 'Foreign alert',
      entityKeys: ['user:foreign@example.test'],
      signal: 'other',
      ruleId: 'test:foreign',
      relatedAlertIds: [],
    };
    const seeded = await ingestCandidate(runtime.socDependencies(), foreign, 'test:seed');
    if (!seeded.ok) throw new Error('could not seed foreign tenant alert');

    const candidate = await server().inject({
      method: 'POST',
      url: '/api/internal/correlator/candidates',
      headers: serviceHeaders(),
      payload: candidateRequest({ relatedAlertIds: [foreign.id] }),
    });
    const feed = await server().inject({
      method: 'GET',
      url: `/api/internal/correlator/alerts?tenantId=${encodeURIComponent(foreignTenant)}`,
      headers: serviceHeaders(),
    });

    expect(candidate.statusCode).not.toBe(201);
    expect(JSON.parse(feed.body).items).toEqual([]);
  });

  it('valida audit feedback y registra de forma idempotente sin guardar texto adicional', async () => {
    const body = {
      action: 'risk.feedback.proposed',
      resourceId: 'proposal-01',
      reason: 'Repeated benign automation was confirmed.',
      ruleId: 'wazuh:5716',
      falsePositives: 4,
      truePositives: 2,
    };
    const send = () =>
      server().inject({
        method: 'POST',
        url: '/api/internal/correlator/audit',
        headers: serviceHeaders(),
        payload: body,
      });
    const first = await send();
    const retry = await send();
    const invalid = await server().inject({
      method: 'POST',
      url: '/api/internal/correlator/audit',
      headers: serviceHeaders(),
      payload: { ...body, falsePositives: -1 },
    });
    const audits = (await memorySoc().allAudit()).filter((event) => event.action === body.action);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(first.body)).toMatchObject({ recorded: true });
    expect(JSON.parse(retry.body)).toMatchObject({ recorded: false });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.tenantId).toBe(runtime.tenantId);
    expect(audits[0]?.metadata).toEqual({
      ruleId: 'wazuh:5716',
      falsePositives: 4,
      truePositives: 2,
    });
    expect(invalid.statusCode).toBe(422);
  });
});
