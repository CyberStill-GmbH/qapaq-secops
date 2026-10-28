/**
 * `POST /api/alerts/:id/enrichment/virustotal` sobre HTTP real (inyección Fastify).
 *
 * El adapter real se construye desde la configuración, pero `fetch` es un doble: ninguna prueba
 * sale a Internet y la clave es sintética. Se comprueba la frontera: sesión, CSRF, capability,
 * que solo se consultan hashes de la alerta, cuota, caché, auditoría y el arranque sin clave.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InMemorySoc } from '@qapaq/soc';

import { buildApi } from '../src/bootstrap.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const SYNTHETIC_KEY = 'f'.repeat(64);
const SHA256 = 'c'.repeat(64);
const MD5 = 'd'.repeat(32);

type Built = Awaited<ReturnType<typeof buildApi>>;

let officeSequence = 0;
function nextOfficeIp(): string {
  officeSequence += 1;
  // Red de oficina del perfil de pruebas; una IP por sesión aísla el límite real de callbacks.
  return `10.20.${150 + Math.floor(officeSequence / 250)}.${(officeSequence % 250) + 1}`;
}

function harness(built: Built) {
  const server = () => built.application.getHttpAdapter().getInstance();
  const runtime: SecOpsRuntime = built.runtime;

  async function signIn(username: string) {
    const remoteAddress = nextOfficeIp();
    const start = await server().inject({ method: 'GET', url: '/api/auth/start', remoteAddress });
    const setCookie = start.headers['set-cookie'];
    const flowCookie =
      (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0] ?? '';
    const state = new URL(start.headers.location as string, 'http://local').searchParams.get(
      'state',
    );
    const authorize = await server().inject({
      method: 'GET',
      url: `/api/auth/local/authorize?state=${encodeURIComponent(state ?? '')}&username=${encodeURIComponent(username)}`,
      remoteAddress,
      headers: { cookie: flowCookie },
    });
    const callback = new URL(authorize.headers.location as string, 'http://local');
    const response = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${callback.search}`,
      remoteAddress,
      headers: { cookie: flowCookie },
    });
    const cookies = response.headers['set-cookie'];
    const cookie =
      (Array.isArray(cookies) ? cookies : [cookies as string])
        .find((value) => value?.startsWith('qapaq_session='))
        ?.split(';', 1)[0] ?? '';
    const session = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
      remoteAddress,
    });
    const csrf = JSON.parse(session.body).csrfToken as string;
    return { cookie, csrf, remoteAddress };
  }

  async function seedAlert(resources: readonly Record<string, string>[]): Promise<string> {
    const soc = runtime.soc as InMemorySoc;
    soc.alertRows.clear();
    runtime.detectionContext = {
      privilegedIdentities: new Set(['jperez@qapaq.pe']),
      criticalAssets: new Set(['host-1']),
    };
    const recordId = '0199bf00-0000-7000-8000-0000000000a1';
    const ingest = await server().inject({
      method: 'POST',
      url: '/api/ingest/security-events',
      remoteAddress: '10.20.5.9',
      payload: {
        schemaVersion: '1.0.0',
        recordId,
        eventUid: `siem-qapaq-lab:alerts:${recordId}`,
        eventUidType: 'native',
        kind: 'alert',
        occurredAt: '2026-10-27T09:00:00.000Z',
        observedAt: '2026-10-27T09:00:01.000Z',
        receivedAt: '2026-10-27T09:00:02.000Z',
        source: {
          kind: 'siem',
          vendor: 'Wazuh, Inc.',
          product: 'Wazuh',
          dataset: 'alerts',
          instanceId: 'siem-qapaq-lab',
          nativeEventId: recordId,
        },
        tenant: { id: runtime.tenantId },
        severity: {
          normalized: 'critical',
          score: 95,
          originalValue: 14,
          originalLabel: 'critical',
          originalScale: 'wazuh-level-0-15',
          mappingId: 'qapaq.wazuh.severity',
          mappingVersion: '1.2.0',
        },
        category: ['malware'],
        outcome: 'success',
        action: 'alert.created',
        entities: {
          identities: [{ kind: 'user', id: 'identity-1', principal: 'jperez@qapaq.pe' }],
          resources: [{ kind: 'host', id: 'host-1', type: 'endpoint' }, ...resources],
        },
        detection: {
          rule: { id: '554', name: 'Archivo añadido', provider: 'wazuh', groups: ['syscheck'] },
        },
        raw: {
          ref: `raw:${recordId}`,
          sha256: 'a'.repeat(64),
          mediaType: 'application/json',
          sizeBytes: 1024,
        },
        provenance: {
          connector: 'qapaq-wazuh-indexer',
          connectorVersion: '1.0.0',
          parserVersion: '1.2.0',
          mappingVersion: '1.2.0',
          timestampQuality: 'source',
          ingestionPath: [{ kind: 'adapter', vendor: 'QAPAQ', product: 'QAPAQ SecOps' }],
        },
      },
    });
    expect(ingest.statusCode).toBe(201);
    const alert = [...soc.alertRows.values()][0];
    expect(alert).toBeDefined();
    return alert!.id;
  }

  function enrich(
    alertId: string,
    session: { cookie: string; csrf: string; remoteAddress: string } | undefined,
    options: { csrf?: boolean; payload?: unknown } = {},
  ) {
    return server().inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/enrichment/virustotal`,
      remoteAddress: session?.remoteAddress ?? '10.20.5.9',
      headers: session
        ? {
            cookie: session.cookie,
            ...(options.csrf === false ? {} : { 'x-csrf-token': session.csrf }),
          }
        : {},
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
  }

  return { server, runtime, signIn, seedAlert, enrich };
}

function fileReport(sha256: string) {
  return {
    data: {
      id: sha256,
      type: 'file',
      attributes: {
        first_submission_date: 1_700_000_000,
        last_analysis_date: 1_760_000_000,
        last_analysis_stats: {
          malicious: 41,
          suspicious: 2,
          undetected: 20,
          harmless: 0,
          timeout: 3,
        },
        popular_threat_classification: {
          suggested_threat_label: 'trojan.synthetic/test',
          popular_threat_category: [{ count: 30, value: 'trojan' }],
          popular_threat_name: [{ count: 12, value: 'synthetic' }],
        },
      },
    },
  };
}

describe('enriquecimiento por hash con clave configurada', () => {
  let built: Built;
  let h: ReturnType<typeof harness>;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let respond: (url: string) => Response;

  beforeAll(async () => {
    built = await buildApi(
      { QAPAQ_PROFILE: 'test', QAPAQ_VIRUSTOTAL_API_KEY: SYNTHETIC_KEY },
      () => {},
    );
    await built.application.init();
    await built.application.getHttpAdapter().getInstance().ready();
    h = harness(built);
  });

  afterAll(async () => {
    await built.stop();
  });

  beforeEach(() => {
    calls.length = 0;
    respond = (url) => Response.json(fileReport(url.split('/').pop()!));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://www.virustotal.com/api/v3/files/')) {
        throw new Error(`salida no esperada en la prueba: ${url}`);
      }
      calls.push({ url, init });
      return respond(url);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arranca con la integración habilitada', () => {
    expect(built.fileReputation).toBe('enabled');
  });

  it('exige sesión y token CSRF antes de consultar', async () => {
    const alertId = await h.seedAlert([{ kind: 'file', type: 'sha256', id: SHA256 }]);
    const analyst = await h.signIn('analista@qapaq.pe');

    expect((await h.enrich(alertId, undefined)).statusCode).toBe(401);
    const withoutCsrf = await h.enrich(alertId, analyst, { csrf: false });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(JSON.parse(withoutCsrf.body).code).toBe('REQUEST_NOT_VERIFIED');
    expect(calls).toHaveLength(0);
  });

  it.each(['lider@qapaq.pe', 'auditor@qapaq.pe', 'sinrol@qapaq.pe'])(
    '%s sin la capability recibe la misma respuesta que un recurso inexistente',
    async (username) => {
      const alertId = await h.seedAlert([{ kind: 'file', type: 'sha256', id: SHA256 }]);
      const session = await h.signIn(username);
      if (!session.cookie) return; // sin rol no hay sesión: tampoco hay consulta posible
      const response = await h.enrich(alertId, session);

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).code).toBe('RESOURCE_UNAVAILABLE');
      expect(calls).toHaveLength(0);
    },
  );

  it('consulta el hash más fuerte de la alerta, ignora el cuerpo y audita el resultado', async () => {
    const alertId = await h.seedAlert([
      { kind: 'file', type: 'md5', id: MD5 },
      { kind: 'file', type: 'sha256', id: SHA256 },
    ]);
    const admin = await h.signIn('admin@qapaq.pe');
    const response = await h.enrich(alertId, admin, {
      payload: { hash: 'e'.repeat(64), url: 'https://intranet.qapaq.local' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      alertId,
      hash: { algorithm: 'sha256', value: SHA256 },
      status: 'found',
      cached: false,
      cacheTtlHours: 24,
      reputation: {
        detections: 43,
        engines: 63,
        firstSeenAt: '2023-11-14T22:13:20.000Z',
        threatLabels: ['trojan.synthetic/test', 'trojan', 'synthetic'],
        reportUrl: `https://www.virustotal.com/gui/file/${SHA256}`,
      },
      quota: { minute: { limit: 4, remaining: 3 }, day: { limit: 500, remaining: 499 } },
    });
    expect(calls.map((call) => call.url)).toEqual([
      `https://www.virustotal.com/api/v3/files/${SHA256}`,
    ]);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(new Headers(calls[0]!.init?.headers).get('x-apikey')).toBe(SYNTHETIC_KEY);

    const audit = await (h.runtime.soc as InMemorySoc).allAudit();
    const entry = audit
      .filter((event) => event.action === 'alert.enrichment.file_reputation')
      .at(-1);
    expect(entry).toMatchObject({
      outcome: 'succeeded',
      resource: { type: 'alert', id: alertId },
      metadata: {
        provider: 'virustotal',
        algorithm: 'sha256',
        hash: SHA256,
        status: 'found',
        cached: false,
        detections: 43,
        engines: 63,
      },
    });
    expect(entry!.actor.type).toBe('user');
    expect(
      JSON.stringify(entry, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(SYNTHETIC_KEY);
  });

  it('responde desde la caché sin volver a salir ni gastar cuota', async () => {
    const alertId = await h.seedAlert([{ kind: 'file', type: 'sha1', id: '1'.repeat(40) }]);
    const analyst = await h.signIn('analista@qapaq.pe');
    respond = () => Response.json({ error: { code: 'NotFoundError' } }, { status: 404 });

    const first = JSON.parse((await h.enrich(alertId, analyst)).body);
    const second = JSON.parse((await h.enrich(alertId, analyst)).body);

    expect(first).toMatchObject({ status: 'unknown', reputation: null, cached: false });
    expect(second).toMatchObject({ status: 'unknown', cached: true });
    expect(second.quota.minute.remaining).toBe(first.quota.minute.remaining);
    expect(calls).toHaveLength(1);
  });

  it('una alerta sin hash no consulta nada', async () => {
    const alertId = await h.seedAlert([]);
    const analyst = await h.signIn('analista@qapaq.pe');
    const response = await h.enrich(alertId, analyst);

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: ['hash'],
    });
    expect(calls).toHaveLength(0);
  });

  it('una alerta de otro tenant o inexistente no se distingue de una sin permiso', async () => {
    const analyst = await h.signIn('analista@qapaq.pe');
    const response = await h.enrich('0199bf00-0000-7000-8000-00000000ffff', analyst);

    expect(response.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('un fallo del servicio es dependencia degradada y queda auditado como fallido', async () => {
    const alertId = await h.seedAlert([{ kind: 'file', type: 'sha256', id: '2'.repeat(64) }]);
    const analyst = await h.signIn('analista@qapaq.pe');
    respond = () => new Response('upstream', { status: 503 });
    const response = await h.enrich(alertId, analyst);

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).code).toBe('DEPENDENCY_DEGRADED');
    const audit = await (h.runtime.soc as InMemorySoc).allAudit();
    expect(audit.at(-1)).toMatchObject({
      action: 'alert.enrichment.file_reputation',
      outcome: 'failed',
      metadata: { errorCode: 'REPUTATION_UNAVAILABLE' },
    });
  });

  it('respeta 4 consultas por minuto por tenant y devuelve Retry-After', async () => {
    const analyst = await h.signIn('analista@qapaq.pe');
    // Usos previos del minuto en curso (las pruebas anteriores también gastaron cupo).
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof h.enrich>> | undefined;
    for (let index = 0; index < 6; index += 1) {
      const alertId = await h.seedAlert([
        { kind: 'file', type: 'sha256', id: String(3 + index).repeat(64) },
      ]);
      const response = await h.enrich(alertId, analyst);
      statuses.push(response.statusCode);
      if (response.statusCode === 429) limited ??= response;
    }

    expect(statuses).toContain(429);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(JSON.parse(limited!.body).code).toBe('RATE_LIMITED');
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    const audit = await (h.runtime.soc as InMemorySoc).allAudit();
    expect(audit.at(-1)).toMatchObject({ outcome: 'denied', reason: 'quota_exhausted' });
  });
});

describe('enriquecimiento por hash sin clave', () => {
  let built: Built;
  let h: ReturnType<typeof harness>;

  beforeAll(async () => {
    built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
    await built.application.init();
    await built.application.getHttpAdapter().getInstance().ready();
    h = harness(built);
  });

  afterAll(async () => {
    await built.stop();
  });

  it('el API arranca y el endpoint responde con el error del catálogo', async () => {
    expect(built.fileReputation).toBe('disabled');
    const alertId = await h.seedAlert([{ kind: 'file', type: 'sha256', id: SHA256 }]);
    const analyst = await h.signIn('analista@qapaq.pe');
    const response = await h.enrich(alertId, analyst);

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'INTEGRATION_NOT_CONFIGURED',
      retriable: false,
    });
  });

  it('la alerta expone sus hashes como entidades para que la consola ofrezca la consulta', async () => {
    const alertId = await h.seedAlert([{ kind: 'file', type: 'md5', id: MD5 }]);
    const analyst = await h.signIn('analista@qapaq.pe');
    const response = await h.server().inject({
      method: 'GET',
      url: `/api/alerts/${alertId}`,
      headers: { cookie: analyst.cookie },
      remoteAddress: analyst.remoteAddress,
    });

    expect(JSON.parse(response.body).alert.entities).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'md5', label: MD5 })]),
    );
  });
});
