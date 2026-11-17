/**
 * `/api/risk/*`: proyección de solo lectura del correlador privado con la sesión y capacidades
 * de la persona. El correlador falso valida el token de lectura y entrega claves crudas que la
 * API debe convertir en referencias opacas `ent_…`.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { buildApi } from '../src/bootstrap.js';

const READ_TOKEN = 'test-only-correlator-read-token-0123456789abcdef';
const officeIp = '10.20.200.1';
let application: NestFastifyApplication;
let runtime: Awaited<ReturnType<typeof buildApi>>['runtime'];
let stop: () => Promise<void>;
let fake: Server;
const seen: { url: string; auth: string | undefined }[] = [];

const server = () => application.getHttpAdapter().getInstance();

const entitySummary = {
  key: 'user:victima@qapaq.pe',
  type: 'user',
  value: 'victima@qapaq.pe',
  score: 142.5,
  breakdown: { base: 90, diversityMultiplier: 1.25, progressionBonus: 30, effective: 142.5 },
  peak: 150,
  sources: ['aws', 'm365'],
  tactics: ['credential-access', 'privilege-escalation'],
  criticality: 'medium',
  candidateIds: ['rc_1'],
};

const candidate = {
  id: 'rc_1',
  idempotencyKey: 'qapaq-correlator|pattern|x',
  kind: 'pattern',
  patternId: 'credential-to-privilege',
  title: 'QAPAQ Riesgo: cadena',
  entity: { type: 'user', value: 'victima@qapaq.pe' },
  relatedEntityKeys: ['ip:203.0.113.9', 'bogus'],
  score: 90,
  priority: 'P1',
  status: 'proposed',
  stages: [],
  explanation: {
    patternId: 'credential-to-privilege',
    patternTitle: 'Cadena de credenciales',
    narrative: 'Fallos, acceso y cambio privilegiado.',
    stages: [
      { stage: 'auth.failure', ruleId: '101710', at: 'now', observationId: 'w1', source: 'aws' },
    ],
    entities: [
      { key: 'user:victima@qapaq.pe', role: 'pivot' },
      { key: 'ip:203.0.113.9', role: 'related' },
      { key: 'bogus', role: 'related' },
    ],
    evidenceObservationIds: ['w1', 'w2'],
    topContributors: [{ ruleId: '101640', points: 20 }],
    scoreBase: 90,
    diversityMultiplier: 1.25,
    progressionBonus: 30,
    nextSteps: ['Revocar sesiones.'],
  },
};

function fakeCorrelator(request: { url?: string; headers: Record<string, unknown> }) {
  const url = new URL(request.url ?? '/', 'http://fake');
  if (url.pathname === '/v1/entities')
    return { asOf: 'now', ready: true, threshold: 80, items: [entitySummary] };
  if (url.pathname === '/v1/entities/keys')
    return { keys: ['user:otro@qapaq.pe', 'user:victima@qapaq.pe'] };
  if (url.pathname === '/v1/entity' && url.searchParams.get('key') === 'user:victima@qapaq.pe') {
    return {
      asOf: 'now',
      entity: {
        ...entitySummary,
        aliases: ['user:iam:061098277310/victima'],
        related: ['ip:203.0.113.9'],
        contributors: [{ ruleId: '101711', points: 20, source: 'aws', observationId: 'x' }],
        timeline: [{ at: 'now', score: 142.5 }],
      },
      candidates: [candidate],
    };
  }
  if (url.pathname === '/v1/feedback')
    return {
      evaluatedAt: 'now',
      verdicts: 5,
      activeSuppressions: 0,
      cdbListName: 'qapaq-correlator-fp-allowlist',
      proposals: [
        { id: 'rsup_1', kind: 'allowlist', ruleId: '101501', entityKey: 'ip:203.0.113.9', falsePositives: 3, truePositives: 0, ratio: 1, suppression: 'proposed', protected: false, reason: 'x', highestPriority: 'P3', thresholdAt: 'now' },
        { id: 'rsup_2', kind: 'demote', ruleId: '5712', entityKey: '', falsePositives: 4, truePositives: 0, ratio: 1, entities: 3, suppression: 'none', protected: false, reason: 'y', highestPriority: 'P4', thresholdAt: 'now' },
      ],
    };
  if (url.pathname === '/v1/candidates')
    return { asOf: 'now', reduction: { qapaqAlerts: 3.2 }, items: [candidate] };
  return undefined;
}

function cookiesOf(response: { headers: Record<string, unknown> }): string[] {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? (header as string[]) : header ? [header as string] : [];
}

async function signIn(username: string) {
  const start = await server().inject({
    method: 'GET',
    url: '/api/auth/start',
    remoteAddress: officeIp,
  });
  const flowCookie = cookiesOf(start)[0]?.split(';', 1)[0] ?? '';
  const headers = flowCookie ? { cookie: flowCookie } : {};
  const state = new URL(start.headers.location as string, 'http://local').searchParams.get('state');
  const authorize = await server().inject({
    method: 'GET',
    url: `/api/auth/local/authorize?state=${encodeURIComponent(state ?? '')}&username=${encodeURIComponent(username)}`,
    remoteAddress: officeIp,
    headers,
  });
  const callback = new URL(authorize.headers.location as string, 'http://local');
  const response = await server().inject({
    method: 'GET',
    url: `/api/auth/callback${callback.search}`,
    remoteAddress: officeIp,
    headers,
  });
  return (
    cookiesOf(response)
      .find((value) => value.startsWith('qapaq_session='))
      ?.split(';', 1)[0] ?? ''
  );
}

function get(cookie: string, url: string) {
  return server().inject({ method: 'GET', url, remoteAddress: officeIp, headers: { cookie } });
}

beforeAll(async () => {
  fake = createServer((request, response) => {
    seen.push({ url: request.url ?? '', auth: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${READ_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const body = fakeCorrelator(request);
    if (!body) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const port = (fake.address() as AddressInfo).port;
  const built = await buildApi(
    {
      QAPAQ_PROFILE: 'test',
      QAPAQ_ENTITY_REF_KEY: randomBytes(32).toString('base64'),
      QAPAQ_CORRELATOR_URL: `http://127.0.0.1:${port}`,
      QAPAQ_CORRELATOR_READ_TOKEN: READ_TOKEN,
    },
    () => {},
  );
  application = built.application;
  runtime = built.runtime;
  stop = built.stop;
  await application.init();
  await server().ready();
});

afterAll(async () => {
  await stop();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

describe('riesgo por entidad (/api/risk)', () => {
  it('exige sesión', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/risk/entities',
      remoteAddress: officeIp,
    });
    expect(response.statusCode).toBe(401);
  });

  it('lista entidades con referencias opacas y sin claves internas', async () => {
    const cookie = await signIn('analista@qapaq.pe');
    const response = await get(cookie, '/api/risk/entities?top=5');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items[0]).toMatchObject({
      kind: 'user',
      label: 'victima@qapaq.pe',
      score: 142.5,
    });
    expect(body.items[0].ref).toMatch(/^ent_[A-Za-z0-9_-]{22}$/u);
    expect(body.items[0].key).toBeUndefined();
    expect(seen.at(-1)).toEqual({ url: '/v1/entities?top=5', auth: `Bearer ${READ_TOKEN}` });
  });

  it('valida top y type', async () => {
    const cookie = await signIn('analista@qapaq.pe');
    expect((await get(cookie, '/api/risk/entities?top=0')).statusCode).toBe(422);
    expect((await get(cookie, '/api/risk/entities?top=101')).statusCode).toBe(422);
    expect((await get(cookie, '/api/risk/entities?type=email')).statusCode).toBe(422);
  });

  it('el detalle solo acepta referencias opacas (D-10b) y resuelve la entidad', async () => {
    const cookie = await signIn('lider@qapaq.pe');
    expect((await get(cookie, '/api/risk/entities/user/victima@qapaq.pe')).statusCode).toBe(422);
    const ref = runtime.entityRefOf(runtime.tenantId, 'user:victima@qapaq.pe');
    const response = await get(cookie, `/api/risk/entities/user/${ref}`);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.entity).toMatchObject({ ref, kind: 'user', label: 'victima@qapaq.pe' });
    expect(body.entity.contributors[0]).toEqual(
      expect.objectContaining({ ruleId: '101711', points: 20, suppressed: false }),
    );
    expect(body.entity.contributors[0].observationId).toBeUndefined();
    expect(body.entity.aliases).toEqual([{ kind: 'user', label: 'iam:061098277310/victima' }]);
    expect(body.candidates[0].entity.ref).toBe(ref);
    const unknown = runtime.entityRefOf(runtime.tenantId, 'user:nadie@qapaq.pe');
    expect((await get(cookie, `/api/risk/entities/user/${unknown}`)).statusCode).toBe(404);
  });

  it('candidatos: proyecta entidades relacionadas y descarta claves inválidas', async () => {
    const cookie = await signIn('analista@qapaq.pe');
    const response = await get(cookie, '/api/risk/candidates?status=proposed&limit=10');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items[0]).toMatchObject({
      id: 'rc_1',
      priority: 'P1',
      patternId: 'credential-to-privilege',
    });
    expect(body.items[0].relatedEntities).toHaveLength(1);
    expect(body.items[0].idempotencyKey).toBeUndefined();
    const explanation = body.items[0].explanation;
    expect(explanation).toMatchObject({
      patternId: 'credential-to-privilege',
      narrative: 'Fallos, acceso y cambio privilegiado.',
      evidenceObservationIds: ['w1', 'w2'],
      nextSteps: ['Revocar sesiones.'],
      score: { base: 90, diversityMultiplier: 1.25, progressionBonus: 30 },
    });
    expect(explanation.entities).toHaveLength(2);
    expect(explanation.entities[0]).toMatchObject({
      kind: 'user',
      role: 'pivot',
      label: 'victima@qapaq.pe',
    });
    expect(explanation.entities[0].ref).toMatch(/^ent_/u);
    expect(explanation.entities[0].key).toBeUndefined();
    expect((await get(cookie, '/api/risk/candidates?status=open')).statusCode).toBe(422);
  });

  it('sin alerts.read responde como recurso inexistente', async () => {
    const cookie = await signIn('auditor@qapaq.pe');
    expect((await get(cookie, '/api/risk/entities')).statusCode).toBe(404);
  });
});

describe('riesgo sin correlador configurado', () => {
  it('responde dependencia degradada', async () => {
    const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
    try {
      await built.application.init();
      const other = built.application.getHttpAdapter().getInstance();
      await other.ready();
      expect(built.runtime.correlatorRead).toBeUndefined();
    } finally {
      await built.stop();
    }
  });
});

describe('cola de atención y propuestas de feedback', () => {
  it('attention: devuelve alertas abiertas con `attention` y valida el límite', async () => {
    const cookie = await signIn('analista@qapaq.pe');
    const response = await get(cookie, '/api/risk/attention?limit=3');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.riskAvailable).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeLessThanOrEqual(3);
    for (const item of body.items) {
      expect(item.attention).toEqual(expect.objectContaining({ score: expect.any(Number) }));
      expect(item.status).toBe('open');
    }
    expect((await get(cookie, '/api/risk/attention?limit=0')).statusCode).toBe(422);
    expect((await get(cookie, '/api/risk/attention?limit=21')).statusCode).toBe(422);
  });

  it('sin alerts.read responde como recurso inexistente', async () => {
    const cookie = await signIn('auditor@qapaq.pe');
    expect((await get(cookie, '/api/risk/attention')).statusCode).toBe(404);
    expect((await get(cookie, '/api/risk/feedback')).statusCode).toBe(404);
  });

  it('feedback: proyecta propuestas con entidad opaca', async () => {
    const cookie = await signIn('lider@qapaq.pe');
    const response = await get(cookie, '/api/risk/feedback');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.proposals).toHaveLength(2);
    expect(body.proposals[0]).toMatchObject({ kind: 'allowlist', ruleId: '101501', falsePositives: 3 });
    expect(body.proposals[0].entity.ref).toMatch(/^ent_/u);
    expect(body.proposals[0].entityKey).toBeUndefined();
    expect(body.proposals[1].entity).toBeNull();
  });
});
