/**
 * Specs del BFF sobre HTTP real (inyección Fastify, sin red): C-17, C-18, C-25 y C-27.
 *
 * El recorrido se ejercita como lo hará el navegador: redirect al emisor, retorno con
 * código, cookie de sesión y llamadas autorizadas. Lo que se comprueba aquí no es que
 * las funciones de dominio hagan su trabajo —eso está en sus propios módulos— sino que
 * la frontera HTTP no relaje ninguna decisión.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { buildApi } from '../src/bootstrap.js';
import type { InMemoryAttemptStore } from '@qapaq/soar';
import type { InMemorySoc } from '@qapaq/soc';

import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const ENVIRONMENT = { QAPAQ_PROFILE: 'test' } as const;

const OFFICE_IP = '10.20.5.9';
const REMOTE_IP = '203.0.113.7';
const PROXY_IP = '172.31.0.5';

/**
 * Cada prueba inicia sesión desde una IP de oficina distinta: el límite real de C-25
 * (30 callbacks por minuto y origen) no se relaja para las pruebas, se aísla.
 */
let officeIp = OFFICE_IP;
let officeSequence = 0;

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
/** El harness usa el adapter en memoria; sus filas se inspeccionan directamente. */
const memorySoc = () => runtime.soc as InMemorySoc;
let stop: () => Promise<void>;

function server() {
  return application.getHttpAdapter().getInstance();
}

function cookiePair(response: { headers: Record<string, unknown> }, prefix: string): string {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? (header as string[]) : header ? [header as string] : [];
  return cookies.find((cookie) => cookie.startsWith(prefix))?.split(';', 1)[0] ?? '';
}

async function signIn(
  username: string,
  remoteAddress = officeIp,
  headers: Record<string, string> = {},
  returnTo?: string,
) {
  const start = await server().inject({
    method: 'GET',
    url:
      returnTo === undefined
        ? '/api/auth/start'
        : `/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`,
    remoteAddress,
    headers,
  });
  const startSetCookies = Array.isArray(start.headers['set-cookie'])
    ? (start.headers['set-cookie'] as string[])
    : start.headers['set-cookie']
      ? [start.headers['set-cookie'] as string]
      : [];
  const flowCookie = startSetCookies[0]?.split(';', 1)[0] ?? '';
  const flowHeaders = {
    ...headers,
    ...(flowCookie ? { cookie: [headers.cookie, flowCookie].filter(Boolean).join('; ') } : {}),
  };
  const state = new URL(start.headers.location as string, 'http://local').searchParams.get('state');
  const authorize = await server().inject({
    method: 'GET',
    url: `/api/auth/local/authorize?state=${encodeURIComponent(state ?? '')}&username=${encodeURIComponent(username)}`,
    remoteAddress,
    headers: flowHeaders,
  });
  // El emisor local devuelve una ruta relativa: la API y la consola comparten origen.
  const callbackUrl = new URL(authorize.headers.location as string, 'http://local');
  const response = await server().inject({
    method: 'GET',
    url: `/api/auth/callback${callbackUrl.search}`,
    remoteAddress,
    headers: flowHeaders,
  });
  const responseCookies = Array.isArray(response.headers['set-cookie'])
    ? (response.headers['set-cookie'] as string[])
    : response.headers['set-cookie']
      ? [response.headers['set-cookie'] as string]
      : [];
  const cookie =
    responseCookies.find((value) => value.startsWith('qapaq_session='))?.split(';', 1)[0] ?? '';
  const session = cookie
    ? await server().inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: { cookie, ...headers },
        remoteAddress,
      })
    : undefined;
  const csrf = session?.statusCode === 200 ? (JSON.parse(session.body).csrfToken as string) : '';
  // Cabeceras de una mutación legítima: la cookie y el token CSRF de esa misma sesión.
  const mutation = { cookie, 'x-csrf-token': csrf };
  return { response, cookie, csrf, mutation, state };
}

/** El callback siempre redirige; un fallo viaja como código público en la URL de retorno. */
function authErrorOf(response: { headers: Record<string, unknown> }): string | null {
  return new URL(response.headers.location as string, 'http://local').searchParams.get('authError');
}

function securityEvent(recordId: string, severity: 'critical' | 'low') {
  return {
    schemaVersion: '1.0.0',
    recordId,
    eventUid: `siem-qapaq-lab:alerts:${recordId}`,
    eventUidType: 'native',
    kind: 'alert',
    occurredAt: '2026-10-08T09:00:00.000Z',
    observedAt: '2026-10-08T09:00:01.000Z',
    receivedAt: '2026-10-08T09:00:02.000Z',
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
      normalized: severity,
      score: severity === 'critical' ? 95 : 10,
      originalValue: severity === 'critical' ? 14 : 3,
      originalLabel: severity,
      originalScale: 'wazuh-level-0-15',
      mappingId: 'qapaq.wazuh.severity',
      mappingVersion: '1.0.0',
    },
    category: ['intrusion_detection'],
    // El caso bajo se declara sin resultado confirmado: una intrusión exitosa sube
    // por sí sola y dejaría de probar el umbral.
    outcome: severity === 'critical' ? 'success' : 'unknown',
    action: 'alert.created',
    entities: {
      identities: [{ kind: 'user', id: 'identity-1', principal: 'jperez@qapaq.pe' }],
      resources: [{ kind: 'host', id: 'host-1', name: 'srv-app-01.qapaq.local', type: 'endpoint' }],
    },
    detection: {
      rule: {
        id: '5716',
        name: 'Acceso sospechoso',
        version: '1',
        provider: 'wazuh',
        groups: ['authentication_failed'],
      },
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
      parserVersion: '1.0.0',
      mappingVersion: '1.0.0',
      timestampQuality: 'source',
      ingestionPath: [
        {
          kind: 'collector',
          vendor: 'Wazuh, Inc.',
          product: 'Wazuh',
          instanceId: 'siem-qapaq-lab',
        },
        { kind: 'adapter', vendor: 'QAPAQ', product: 'QAPAQ SecOps' },
      ],
    },
  };
}

async function ingest(recordId: string, severity: 'critical' | 'low' = 'critical') {
  return server().inject({
    method: 'POST',
    url: '/api/ingest/security-events',
    payload: securityEvent(recordId, severity),
    remoteAddress: OFFICE_IP,
  });
}

beforeAll(async () => {
  const built = await buildApi(ENVIRONMENT, () => {});
  application = built.application;
  runtime = built.runtime;
  stop = built.stop;
  await application.init();
  await server().ready();
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  officeSequence += 1;
  officeIp = `10.20.${100 + Math.floor(officeSequence / 250)}.${(officeSequence % 250) + 1}`;
  memorySoc().alertRows.clear();
  memorySoc().incidentRows.clear();
  memorySoc().outboxRows.clear();
  memorySoc().outboxState.clear();
  (runtime.notifications as InMemoryAttemptStore).rows.clear();
  runtime.detectionContext = {
    privilegedIdentities: new Set(['jperez@qapaq.pe']),
    criticalAssets: new Set(['host-1']),
  };
});

describe('C-18 · inicio de sesión por el BFF', () => {
  it('redirige al emisor con un state opaco y sin tokens en el cliente', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/auth/start',
      remoteAddress: OFFICE_IP,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('state=');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).not.toContain('id_token');
  });

  it('abre sesión, devuelve una cookie HttpOnly opaca y vuelve a la consola', async () => {
    const { response, cookie } = await signIn('analista@qapaq.pe');
    const headers = Array.isArray(response.headers['set-cookie'])
      ? (response.headers['set-cookie'] as string[])
      : [response.headers['set-cookie'] as string];
    const header = headers.find((value) => value.startsWith('qapaq_session=')) ?? '';

    expect(response.statusCode).toBe(303);
    expect(new URL(response.headers.location as string, 'http://local').pathname).toBe('/');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toBe('');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('analista@qapaq.pe');
    expect(cookie.length).toBeGreaterThan(20);
  });

  it('expone la sesión vigente con sus capabilities', async () => {
    const { cookie } = await signIn('lider@qapaq.pe');
    const session = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
    const body = JSON.parse(session.body);

    expect(session.statusCode).toBe(200);
    expect(body.capabilities).toContain('incidents.close');
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('rechaza el replay del mismo código de autorización', async () => {
    const start = await server().inject({
      method: 'GET',
      url: '/api/auth/start',
      remoteAddress: OFFICE_IP,
    });
    const state = new URL(start.headers.location as string, 'http://local').searchParams.get(
      'state',
    );
    const flowCookie = cookiePair(start, 'qapaq_oidc_flow_');
    const authorize = await server().inject({
      method: 'GET',
      url: `/api/auth/local/authorize?state=${state}&username=analista%40qapaq.pe`,
      remoteAddress: OFFICE_IP,
    });
    const search = new URL(authorize.headers.location as string, 'http://local').search;

    const first = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${search}`,
      headers: { cookie: flowCookie },
      remoteAddress: OFFICE_IP,
    });
    const replay = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${search}`,
      headers: { cookie: flowCookie },
      remoteAddress: OFFICE_IP,
    });

    expect(first.statusCode).toBe(303);
    expect(authErrorOf(first)).toBeNull();
    expect(replay.statusCode).toBe(303);
    expect(replay.headers['set-cookie']).toBeDefined();
    expect(replay.headers['set-cookie']).not.toContain('qapaq_session=');
    expect(authErrorOf(replay)).toBe('AUTH_FAILED');
  });

  it('ata el callback al navegador iniciador y no consume el state desde otro browser', async () => {
    const start = await server().inject({
      method: 'GET',
      url: '/api/auth/start',
      remoteAddress: OFFICE_IP,
    });
    const state = new URL(start.headers.location as string, 'http://local').searchParams.get(
      'state',
    );
    const flowCookie = cookiePair(start, 'qapaq_oidc_flow_');
    const authorize = await server().inject({
      method: 'GET',
      url: `/api/auth/local/authorize?state=${encodeURIComponent(state ?? '')}&username=analista%40qapaq.pe`,
      remoteAddress: OFFICE_IP,
    });
    const search = new URL(authorize.headers.location as string, 'http://local').search;

    const injected = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${search}`,
      remoteAddress: OFFICE_IP,
    });
    expect(authErrorOf(injected)).toBe('AUTH_FAILED');
    expect(injected.headers['set-cookie']).not.toContain('qapaq_session=');

    const originalBrowser = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${search}`,
      headers: { cookie: flowCookie },
      remoteAddress: OFFICE_IP,
    });
    expect(authErrorOf(originalBrowser)).toBeNull();
    expect(cookiePair(originalBrowser, 'qapaq_session=')).toMatch(/^qapaq_session=/u);
  });

  it('cierra la sesión y la cookie deja de servir', async () => {
    const { cookie, mutation } = await signIn('analista@qapaq.pe');
    const logout = await server().inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: mutation,
      remoteAddress: OFFICE_IP,
    });
    const after = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(logout.statusCode).toBe(204);
    expect(after.statusCode).toBe(401);
  });

  it('sin cookie responde AUTH_REQUIRED y no filtra detalle', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/alerts',
      remoteAddress: OFFICE_IP,
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(401);
    expect(body).toMatchObject({ code: 'AUTH_REQUIRED', action: 'sign_in_again' });
    expect(body.helpRef).toContain('https://');
    expect(body.correlationId).toBeTruthy();
  });
});

describe('C-25 · red, passkey y sesión única', () => {
  it('exige passkey desde fuera de la red QAPAQ', async () => {
    const withoutPasskey = await signIn('analista@qapaq.pe', REMOTE_IP);

    expect(withoutPasskey.cookie).toBe('');
    expect(authErrorOf(withoutPasskey.response)).toBe('PASSKEY_REQUIRED');

    const withPasskey = await signIn('lider@qapaq.pe', REMOTE_IP);

    expect(withPasskey.cookie).not.toBe('');
    expect(authErrorOf(withPasskey.response)).toBeNull();
  });

  it('ignora un X-Forwarded-For forjado desde una conexión no confiable', async () => {
    const forged = await signIn('analista@qapaq.pe', REMOTE_IP, {
      'x-forwarded-for': OFFICE_IP,
    });

    expect(forged.cookie).toBe('');
    expect(authErrorOf(forged.response)).toBe('PASSKEY_REQUIRED');
  });

  it('acepta la cadena cuando el proxy sí es confiable', async () => {
    const viaProxy = await signIn('analista@qapaq.pe', PROXY_IP, {
      'x-forwarded-for': `${OFFICE_IP}, ${PROXY_IP}`,
    });

    expect(viaProxy.cookie).not.toBe('');
    expect(authErrorOf(viaProxy.response)).toBeNull();
  });

  it('rechaza una cadena de proxies que no identifica cliente', async () => {
    const opaque = await signIn('analista@qapaq.pe', PROXY_IP, {
      'x-forwarded-for': `${PROXY_IP}, ${PROXY_IP}`,
    });

    expect(opaque.cookie).toBe('');
    expect(authErrorOf(opaque.response)).toBe('NETWORK_NOT_ALLOWED');
  });

  it('invalida la sesión anterior al abrir una nueva', async () => {
    const first = await signIn('analista@qapaq.pe');
    const second = await signIn('analista@qapaq.pe');

    const oldSession = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: first.cookie },
      remoteAddress: OFFICE_IP,
    });
    const newSession = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: second.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(oldSession.statusCode).toBe(401);
    expect(newSession.statusCode).toBe(200);
  });

  it('no admite a una cuenta sin rol y no revela el motivo', async () => {
    const { response, cookie } = await signIn('sinrol@qapaq.pe');
    const location = new URL(response.headers.location as string, 'http://local');

    expect(cookie).toBe('');
    // Mismo código que una credencial inválida: la URL no dice que faltaba un rol.
    expect(location.searchParams.get('authError')).toBe('AUTH_FAILED');
    expect(location.search).not.toMatch(/ROLE|role/u);
  });
});

describe('C-16/C-17 · recorrido operativo sobre HTTP', () => {
  it('promueve un evento crítico y lo publica como alerta consultable', async () => {
    const ingested = await ingest('01890f47-7abc-7def-8abc-00000000a001');
    const { cookie } = await signIn('analista@qapaq.pe');
    const alerts = await server().inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
    const body = JSON.parse(alerts.body);

    expect(JSON.parse(ingested.body).outcome).toBe('promoted');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ priority: 'P1', status: 'new' });
  });

  it('no promueve un evento por debajo del umbral', async () => {
    runtime.detectionContext = { privilegedIdentities: new Set(), criticalAssets: new Set() };
    const ingested = await ingest('01890f47-7abc-7def-8abc-00000000a002', 'low');

    expect(JSON.parse(ingested.body).outcome).toBe('not_promoted');
    expect(memorySoc().alertRows.size).toBe(0);
  });

  it('repetir la ingesta no crea una segunda alerta', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a003');
    const repeated = await ingest('01890f47-7abc-7def-8abc-00000000a003');

    expect(JSON.parse(repeated.body).outcome).toBe('duplicate');
    expect(memorySoc().alertRows.size).toBe(1);
  });

  it('recorre reconocer, triar, escalar y abrir caso', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a004');
    const analyst = await signIn('analista@qapaq.pe');
    const [alert] = JSON.parse(
      (
        await server().inject({
          method: 'GET',
          url: '/api/alerts',
          headers: { cookie: analyst.cookie },
          remoteAddress: OFFICE_IP,
        })
      ).body,
    ).items as { id: string; revision: number }[];

    const acknowledged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: analyst.mutation,
      payload: { name: 'acknowledge', expectedRevision: alert!.revision },
      remoteAddress: OFFICE_IP,
    });
    const triaged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: analyst.mutation,
      payload: {
        name: 'triage',
        expectedRevision: JSON.parse(acknowledged.body).alert.revision,
        verdict: 'true_positive',
        note: 'Confirmado con el usuario: no reconoce el acceso.',
      },
      remoteAddress: OFFICE_IP,
    });
    const escalated = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: analyst.mutation,
      payload: { name: 'escalate', expectedRevision: JSON.parse(triaged.body).alert.revision },
      remoteAddress: OFFICE_IP,
    });

    const lead = await signIn('lider@qapaq.pe');
    const incident = await server().inject({
      method: 'POST',
      url: '/api/incidents',
      headers: lead.mutation,
      payload: {
        alertId: alert!.id,
        title: 'Acceso no autorizado a srv-app-01',
        severity: 'critical',
        summary: 'Alerta P1 escalada por el analista.',
        expectedAlertRevision: JSON.parse(escalated.body).alert.revision,
      },
      remoteAddress: OFFICE_IP,
    });

    expect(JSON.parse(triaged.body).alert.verdict).toBe('true_positive');
    expect(JSON.parse(escalated.body).alert.status).toBe('escalated');
    expect(incident.statusCode).toBe(201);
    expect(JSON.parse(incident.body).incident).toMatchObject({
      status: 'open',
      severity: 'critical',
    });
    const incidentId = (JSON.parse(incident.body) as { incident: { id: string } }).incident.id;
    const incidentDetail = await server().inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent(incidentId)}`,
      headers: { cookie: lead.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(JSON.parse(incidentDetail.body).incident).toMatchObject({ id: incidentId });
  });

  it('devuelve conflicto ante una revisión obsoleta', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a005');
    const analyst = await signIn('analista@qapaq.pe');
    const [alert] = JSON.parse(
      (
        await server().inject({
          method: 'GET',
          url: '/api/alerts',
          headers: { cookie: analyst.cookie },
          remoteAddress: OFFICE_IP,
        })
      ).body,
    ).items as { id: string; revision: number }[];
    const payload = { name: 'acknowledge', expectedRevision: alert!.revision };

    await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: analyst.mutation,
      payload,
      remoteAddress: OFFICE_IP,
    });
    const stale = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: analyst.mutation,
      payload,
      remoteAddress: OFFICE_IP,
    });

    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({
      code: 'STATE_CONFLICT',
      action: 'reload_resource',
      retriable: true,
    });
  });
});

describe('C-18/C-27 · denegación y no enumeración', () => {
  it('oculta el crudo al rol que no tiene events.read_raw', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a006');
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');

    const asAnalyst = JSON.parse(
      (
        await server().inject({
          method: 'GET',
          url: '/api/alerts',
          headers: { cookie: analyst.cookie },
          remoteAddress: OFFICE_IP,
        })
      ).body,
    ).items[0];
    const asLead = JSON.parse(
      (
        await server().inject({
          method: 'GET',
          url: '/api/alerts',
          headers: { cookie: lead.cookie },
          remoteAddress: OFFICE_IP,
        })
      ).body,
    ).items[0];

    expect(Object.hasOwn(asAnalyst, 'rawRef')).toBe(false);
    expect(asLead.rawRef).toContain('raw:');
  });

  it('responde igual para un recurso inexistente y para uno no autorizado', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a007');
    const auditor = await signIn('auditor@qapaq.pe');
    const existingId = [...memorySoc().alertRows.values()][0]!.id;

    const notAuthorized = await server().inject({
      method: 'GET',
      url: `/api/alerts/${existingId}`,
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });
    const missing = await server().inject({
      method: 'GET',
      url: '/api/alerts/0199bf00-0000-7000-8000-00000000ffff',
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(notAuthorized.statusCode).toBe(missing.statusCode);
    expect(JSON.parse(notAuthorized.body).code).toBe(JSON.parse(missing.body).code);
    expect(JSON.parse(notAuthorized.body).message).toBe(JSON.parse(missing.body).message);
  });

  it('rechaza un comando mal formado con los campos afectados y sin el valor', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a008');
    const analyst = await signIn('analista@qapaq.pe');
    const alertId = [...memorySoc().alertRows.values()][0]!.id;

    const response = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/commands`,
      headers: analyst.mutation,
      payload: { name: 'triage' },
      remoteAddress: OFFICE_IP,
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields).toContain('expectedRevision');
  });

  it('propaga el correlationId que envía el cliente cuando tiene forma válida', async () => {
    const correlationId = '0199bf99-0000-4000-8000-00000000abcd';
    const response = await server().inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { 'x-correlation-id': correlationId },
      remoteAddress: OFFICE_IP,
    });

    expect(JSON.parse(response.body).correlationId).toBe(correlationId);
  });

  it('descarta un correlationId con forma inválida en lugar de reflejarlo', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { 'x-correlation-id': '<script>alert(1)</script>' },
      remoteAddress: OFFICE_IP,
    });

    expect(JSON.parse(response.body).correlationId).not.toContain('script');
  });
});

describe('C-19/C-20 · auditoría y notificación sobre HTTP', () => {
  it('entrega auditoría redactada al rol sin capability sensible', async () => {
    await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');
    const response = await server().inject({
      method: 'GET',
      url: '/api/audit/events?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z',
      headers: { cookie: lead.cookie },
      remoteAddress: OFFICE_IP,
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(
      body.items.some((item: { actor: { ip?: string } }) => item.actor.ip === '[REDACTED]'),
    ).toBe(true);
  });

  it('entrega auditoría completa al auditor y verifica la cadena', async () => {
    const auditor = await signIn('auditor@qapaq.pe');
    const events = await server().inject({
      method: 'GET',
      url: '/api/audit/events?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z',
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });
    const verify = await server().inject({
      method: 'GET',
      url: '/api/audit/verify',
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(JSON.parse(events.body).items[0].actor.ip).not.toBe('[REDACTED]');
    expect(JSON.parse(verify.body)).toMatchObject({ ok: true, violations: [] });
  });

  it('deniega la auditoría a quien no tiene la capability', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const response = await server().inject({
      method: 'GET',
      url: '/api/audit/events?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).code).toBe('RESOURCE_UNAVAILABLE');
  });

  it('drena el outbox y registra el intento de notificación crítica', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a009');
    const analyst = await signIn('analista@qapaq.pe');
    const alert = [...memorySoc().alertRows.values()][0]!;
    const acknowledged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/commands`,
      headers: analyst.mutation,
      payload: { name: 'acknowledge', expectedRevision: alert.revision },
      remoteAddress: OFFICE_IP,
    });
    const triaged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/commands`,
      headers: analyst.mutation,
      payload: {
        name: 'triage',
        expectedRevision: JSON.parse(acknowledged.body).alert.revision,
        verdict: 'true_positive',
        note: 'Confirmado con el usuario: no reconoce el acceso.',
      },
      remoteAddress: OFFICE_IP,
    });
    await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/commands`,
      headers: analyst.mutation,
      payload: { name: 'escalate', expectedRevision: JSON.parse(triaged.body).alert.revision },
      remoteAddress: OFFICE_IP,
    });

    // Forzar el despacho es un efecto externo: el analista no puede, el líder sí.
    const deniedDrain = await server().inject({
      method: 'POST',
      url: '/api/notifications/drain',
      headers: analyst.mutation,
      remoteAddress: OFFICE_IP,
    });
    const lead = await signIn('lider@qapaq.pe');
    // La pasada manual procesa un mensaje por llamada (cabe en el timeout del gateway): se
    // repite hasta que no quede nada reclamable.
    let drained = await server().inject({
      method: 'POST',
      url: '/api/notifications/drain',
      headers: lead.mutation,
      remoteAddress: OFFICE_IP,
    });
    for (let pass = 0; pass < 10 && JSON.parse(drained.body).results?.length > 0; pass += 1) {
      const next = await server().inject({
        method: 'POST',
        url: '/api/notifications/drain',
        headers: lead.mutation,
        remoteAddress: OFFICE_IP,
      });
      if (JSON.parse(next.body).results.length === 0) break;
      drained = next;
    }
    const listed = await server().inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });
    const attempts = JSON.parse(listed.body).items as { status: string }[];

    expect(deniedDrain.statusCode).not.toBe(201);
    expect(drained.statusCode).toBe(201);
    expect(attempts.length).toBeGreaterThan(0);
    // Sin destino Teams alcanzable el crítico no se pierde: queda pendiente o en fallback.
    expect(['pending', 'indeterminate', 'fallback', 'sent']).toContain(attempts[0]!.status);
  });
});

describe('B-03 · el callback devuelve al navegador a la consola', () => {
  /** Destino sin el aviso de sesión reemplazada, que depende de pruebas anteriores. */
  function destinationOf(response: { headers: Record<string, unknown> }): string {
    const url = new URL(response.headers.location as string, 'http://local');
    url.searchParams.delete('sessionNotice');
    return `${url.pathname}${url.search}`;
  }

  it('vuelve a la ruta pedida al iniciar la sesión', async () => {
    const { response } = await signIn('analista@qapaq.pe', undefined, {}, '/alerts?status=new');

    expect(response.statusCode).toBe(303);
    expect(destinationOf(response)).toBe('/alerts?status=new');
  });

  it.each([
    'https://evil.example/robar',
    '//evil.example/robar',
    '/\\evil.example',
    '/api/auth/logout',
    'alerts',
    `/${'a'.repeat(600)}`,
  ])('no redirige fuera de la consola: %s', async (returnTo) => {
    const { response } = await signIn('analista@qapaq.pe', undefined, {}, returnTo);

    expect(destinationOf(response)).toBe('/');
  });

  it('un fallo vuelve al mismo destino con código público y correlación', async () => {
    const { response } = await signIn('analista@qapaq.pe', REMOTE_IP, {}, '/console.html');
    const location = new URL(response.headers.location as string, 'http://local');

    expect(response.statusCode).toBe(303);
    expect(location.pathname).toBe('/console.html');
    expect(location.searchParams.get('authError')).toBe('PASSKEY_REQUIRED');
    expect(location.searchParams.get('correlationId')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers['set-cookie']).not.toContain('qapaq_session=');
  });

  it('avisa en el retorno cuando la nueva sesión cerró otra', async () => {
    await signIn('analista@qapaq.pe');
    const second = await signIn('analista@qapaq.pe');

    expect(second.response.headers.location).toBe('/?sessionNotice=superseded');
  });
});

describe('B-01 · CSRF en las mutaciones', () => {
  async function newAlert(recordId: string) {
    await ingest(recordId);
    return [...memorySoc().alertRows.values()][0]!;
  }

  function acknowledge(alertId: string, revision: number, headers: Record<string, string>) {
    return server().inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/commands`,
      headers,
      payload: { name: 'acknowledge', expectedRevision: revision },
      remoteAddress: OFFICE_IP,
    });
  }

  it('entrega un token distinto por sesión', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');

    expect(analyst.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(analyst.csrf).not.toBe(lead.csrf);
  });

  it('rechaza una mutación sin token y no ejecuta el comando', async () => {
    const alert = await newAlert('01890f47-7abc-7def-8abc-00000000b001');
    const analyst = await signIn('analista@qapaq.pe');

    const response = await acknowledge(alert.id, alert.revision, { cookie: analyst.cookie });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'REQUEST_NOT_VERIFIED',
      action: 'reload_resource',
    });
    expect(memorySoc().alertRows.get(`${alert.tenantId}|${alert.id}`)!.status).toBe('new');
  });

  it('rechaza el token de otra sesión', async () => {
    const alert = await newAlert('01890f47-7abc-7def-8abc-00000000b002');
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');

    const response = await acknowledge(alert.id, alert.revision, {
      cookie: analyst.cookie,
      'x-csrf-token': lead.csrf,
    });

    expect(response.statusCode).toBe(403);
  });

  it('rechaza una petición iniciada desde otro sitio aunque traiga token', async () => {
    const alert = await newAlert('01890f47-7abc-7def-8abc-00000000b003');
    const analyst = await signIn('analista@qapaq.pe');

    const response = await acknowledge(alert.id, alert.revision, {
      ...analyst.mutation,
      'sec-fetch-site': 'cross-site',
    });

    expect(response.statusCode).toBe(403);
  });

  it('acepta la mutación del mismo origen con su token', async () => {
    const alert = await newAlert('01890f47-7abc-7def-8abc-00000000b004');
    const analyst = await signIn('analista@qapaq.pe');

    const response = await acknowledge(alert.id, alert.revision, {
      ...analyst.mutation,
      'sec-fetch-site': 'same-origin',
    });

    expect(response.statusCode).toBe(201);
  });

  it('sin sesión responde 401 antes de evaluar el token', async () => {
    const alert = await newAlert('01890f47-7abc-7def-8abc-00000000b005');

    const response = await acknowledge(alert.id, alert.revision, {});

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).code).toBe('AUTH_REQUIRED');
  });

  it('otro sitio no puede cerrar la sesión de la persona', async () => {
    const analyst = await signIn('analista@qapaq.pe');

    const forged = await server().inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });
    const still = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(forged.statusCode).toBe(403);
    expect(still.statusCode).toBe(200);
  });
});

describe('B-02 · paginación por cursor de los listados', () => {
  async function listAlerts(cookie: string, query: string) {
    return server().inject({
      method: 'GET',
      url: `/api/alerts${query}`,
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
  }

  it('recorre todas las alertas por páginas sin repetir ni perder ninguna', async () => {
    for (let index = 1; index <= 5; index += 1) {
      await ingest(`01890f47-7abc-7def-8abc-00000000c00${index}`);
    }
    const analyst = await signIn('analista@qapaq.pe');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = JSON.parse((await listAlerts(analyst.cookie, query)).body) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('una alerta nueva entre páginas no desplaza las ya entregadas', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c101');
    await ingest('01890f47-7abc-7def-8abc-00000000c102');
    const analyst = await signIn('analista@qapaq.pe');
    const first = JSON.parse((await listAlerts(analyst.cookie, '?pageSize=1')).body);

    await ingest('01890f47-7abc-7def-8abc-00000000c1ff');
    const second = JSON.parse(
      (
        await listAlerts(
          analyst.cookie,
          `?pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).body,
    );

    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it('usa 50 por defecto y no devuelve cursor cuando no hay más', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c201');
    const analyst = await signIn('analista@qapaq.pe');
    const body = JSON.parse((await listAlerts(analyst.cookie, '')).body);

    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    expect(body.totalCount).toBe(1);
  });

  it('busca alertas en todo el conjunto y liga el cursor al término', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c251');
    await ingest('01890f47-7abc-7def-8abc-00000000c252');
    const analyst = await signIn('analista@qapaq.pe');
    const firstResponse = await listAlerts(analyst.cookie, '?q=Acceso+sospechoso&pageSize=1');
    const first = JSON.parse(firstResponse.body) as {
      items: { title: string }[];
      nextCursor: string;
      totalCount: number;
    };

    expect(first.totalCount).toBe(2);
    expect(first.items[0]?.title).toContain('Acceso sospechoso');
    expect(first.nextCursor).toBeTruthy();

    const pageTwo = await listAlerts(
      analyst.cookie,
      `?q=Acceso+sospechoso&pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(JSON.parse(pageTwo.body).items).toHaveLength(1);

    const changedFilter = await listAlerts(
      analyst.cookie,
      `?q=otro&pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(changedFilter.statusCode).toBe(422);
    expect(JSON.parse(changedFilter.body).fields).toContain('cursor');
  });

  it('limita la longitud de búsqueda del servidor', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const response = await listAlerts(analyst.cookie, `?q=${'a'.repeat(121)}`);

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).fields).toEqual(['q']);
  });

  it.each(['0', '201', 'abc', '-1', '1.5'])(
    'rechaza pageSize=%s en lugar de recortarlo',
    async (pageSize) => {
      const analyst = await signIn('analista@qapaq.pe');
      const response = await listAlerts(analyst.cookie, `?pageSize=${pageSize}`);

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body)).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: ['pageSize'],
      });
    },
  );

  it('rechaza un cursor alterado o de otro listado', async () => {
    for (let index = 1; index <= 2; index += 1) {
      await ingest(`01890f47-7abc-7def-8abc-00000000c30${index}`);
    }
    const analyst = await signIn('analista@qapaq.pe');
    const filtered = JSON.parse((await listAlerts(analyst.cookie, '?status=new&pageSize=1')).body);

    const reused = await listAlerts(
      analyst.cookie,
      `?pageSize=1&cursor=${encodeURIComponent(filtered.nextCursor)}`,
    );
    const garbage = await listAlerts(analyst.cookie, '?cursor=no-es-un-cursor');

    expect(reused.statusCode).toBe(422);
    expect(JSON.parse(reused.body).fields).toEqual(['cursor']);
    expect(garbage.statusCode).toBe(422);
  });

  it('pagina también incidentes y notificaciones', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const incidents = await server().inject({
      method: 'GET',
      url: '/api/incidents?pageSize=10',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });
    const notifications = await server().inject({
      method: 'GET',
      url: '/api/notifications?pageSize=500',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(JSON.parse(incidents.body)).toMatchObject({ items: [], nextCursor: null });
    expect(notifications.statusCode).toBe(422);
  });
});

describe('C-16 · correlación por entidad expuesta por la API', () => {
  async function alerts(cookie: string, query = '') {
    return server().inject({
      method: 'GET',
      url: `/api/alerts${query}`,
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
  }

  it('la alerta declara sus claves de entidad y referencia las relacionadas previas', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c401');
    await ingest('01890f47-7abc-7def-8abc-00000000c402');
    const analyst = await signIn('analista@qapaq.pe');
    const body = JSON.parse((await alerts(analyst.cookie)).body) as {
      items: {
        id: string;
        entities: { label: string }[];
        relatedAlertIds: string[];
        entityKeys?: unknown;
      }[];
    };

    expect(body.items).toHaveLength(2);
    expect(
      body.items.every((item) =>
        item.entities.some((entity) => entity.label === 'jperez@qapaq.pe'),
      ),
    ).toBe(true);
    // Las claves internas `user:`/`ip:` no salen de la API (D-10b).
    expect(body.items.every((item) => item.entityKeys === undefined)).toBe(true);
    // La segunda en llegar ve a la primera en su ventana; la primera no tenía previas.
    const later = body.items.find((item) => item.relatedAlertIds.length > 0);
    const earlier = body.items.find((item) => item.relatedAlertIds.length === 0);
    expect(later?.relatedAlertIds).toEqual([earlier?.id]);
  });

  it('pivota por referencia opaca y rechaza UPN o IP crudos en la URL (D-10b)', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c403');
    const analyst = await signIn('analista@qapaq.pe');
    const listed = JSON.parse((await alerts(analyst.cookie)).body) as {
      items: { entities: { ref: string; kind: string; label: string }[] }[];
    };
    const user = listed.items[0]!.entities.find((entity) => entity.kind === 'user')!;

    const mine = JSON.parse((await alerts(analyst.cookie, `?entity=${user.ref}`)).body) as {
      totalCount: number;
    };
    const unknownRef = JSON.parse(
      (await alerts(analyst.cookie, `?entity=ent_${'A'.repeat(22)}`)).body,
    ) as { totalCount: number };
    const rawUpn = await alerts(analyst.cookie, '?entity=user%3Ajperez%40qapaq.pe');

    expect(user.label).toBe('jperez@qapaq.pe');
    expect(user.ref).toMatch(/^ent_[A-Za-z0-9_-]{22}$/u);
    expect(user.ref).not.toContain('jperez');
    expect(mine.totalCount).toBe(1);
    expect(unknownRef.totalCount).toBe(0);
    expect(rawUpn.statusCode).toBe(422);
    expect(JSON.parse(rawUpn.body).fields).toEqual(['entity']);
  });

  it('acepta los estados reales de alerta como filtro', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c404');
    const analyst = await signIn('analista@qapaq.pe');

    const fresh = await alerts(analyst.cookie, '?status=new');
    const unknown = await alerts(analyst.cookie, '?status=contained');

    expect(fresh.statusCode).toBe(200);
    expect(JSON.parse(fresh.body).totalCount).toBe(1);
    expect(unknown.statusCode).toBe(422);
  });

  it('el despacho reclama de la cola durable y no vuelve a tomar lo publicado', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c405');
    const dependencies = runtime.dispatchDependencies();
    const now = runtime.now();

    const first = await dependencies.outbox.claimPending(50, now);
    for (const message of first) await dependencies.outbox.markPublished(message.messageId, now);
    const second = await dependencies.outbox.claimPending(50, now);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    expect(
      [...memorySoc().outboxState.values()].every((state) => state.status === 'published'),
    ).toBe(true);
  });

  it('un mensaje reclamado y no publicado vuelve a la cola al vencer el lease', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c406');
    const dependencies = runtime.dispatchDependencies();
    const now = runtime.now();

    const claimed = await dependencies.outbox.claimPending(50, now);
    const whileLeased = await dependencies.outbox.claimPending(50, now);
    // Tres minutos después el lease (2 min) venció: el despachador anterior se da por muerto.
    const afterLease = await dependencies.outbox.claimPending(
      50,
      new Date(now.getTime() + 180_000),
    );

    expect(claimed.length).toBeGreaterThan(0);
    expect(whileLeased).toHaveLength(0);
    expect(afterLease.map((message) => message.messageId)).toEqual(
      claimed.map((message) => message.messageId),
    );
  });
});

describe('Observabilidad · GET /api/operations/health por rol', () => {
  async function health(cookie: string) {
    return server().inject({
      method: 'GET',
      url: '/api/operations/health',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
  }

  it('el analista ve solo el resumen', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const body = JSON.parse((await health(analyst.cookie)).body);

    expect(Object.keys(body.sections)).toEqual(['summary']);
    expect(body.sections.summary.sourceCoverage).toBe('NO_DATA');
  });

  it('el líder ve resumen y SOC, pero no plataforma', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c501');
    const lead = await signIn('lider@qapaq.pe');
    const body = JSON.parse((await health(lead.cookie)).body);

    expect(Object.keys(body.sections).sort()).toEqual(['soc', 'summary']);
    expect(body.sections.soc).toMatchObject({ persistence: 'memory', dispatcherRunning: false });
    expect(body.sections.soc.outbox.pending).toBeGreaterThan(0);
    // El harness no arranca el bucle y usa memoria: se reporta, no se oculta.
    expect(body.sections.soc.degradedReasons).toEqual(
      expect.arrayContaining(['DISPATCHER_STOPPED', 'PERSISTENCE_EPHEMERAL']),
    );
  });

  it('el administrador de plataforma ve las tres secciones', async () => {
    const admin = await signIn('admin@qapaq.pe');
    const body = JSON.parse((await health(admin.cookie)).body);

    expect(Object.keys(body.sections).sort()).toEqual(['platform', 'soc', 'summary']);
    expect(body.sections.platform.databaseLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('el auditor no tiene acceso y no se revela la existencia de la ruta', async () => {
    const auditor = await signIn('auditor@qapaq.pe');
    const response = await health(auditor.cookie);

    expect(response.statusCode).not.toBe(200);
    expect(JSON.parse(response.body).code).toBe('RESOURCE_UNAVAILABLE');
  });

  it('la respuesta no contiene identidades ni IPs de las alertas', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000c502');
    const admin = await signIn('admin@qapaq.pe');
    const text = (await health(admin.cookie)).body;

    expect(text).not.toContain('jperez');
    expect(text).not.toContain('@qapaq.pe');
  });
});

describe('C-10(b) · administración de sesiones', () => {
  async function listSessions(cookie: string) {
    return server().inject({
      method: 'GET',
      url: '/api/admin/sessions',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
  }

  async function revoke(
    mutation: Record<string, string>,
    reference: string,
    payload: Record<string, unknown>,
  ) {
    return server().inject({
      method: 'POST',
      url: `/api/admin/sessions/${encodeURIComponent(reference)}/revoke`,
      headers: mutation,
      payload,
      remoteAddress: OFFICE_IP,
    });
  }

  type SessionRow = { ref: string; subjectId: string; current: boolean; revision: number };

  it('el analista y el líder no pueden ver sesiones', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');

    expect(JSON.parse((await listSessions(analyst.cookie)).body).code).toBe('RESOURCE_UNAVAILABLE');
    expect(JSON.parse((await listSessions(lead.cookie)).body).code).toBe('RESOURCE_UNAVAILABLE');
  });

  it('el administrador lista sesiones con referencias que no son cookies', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const admin = await signIn('admin@qapaq.pe');
    const body = JSON.parse((await listSessions(admin.cookie)).body) as { items: SessionRow[] };

    const own = body.items.find((row) => row.current);
    expect(own?.subjectId).toBe('local-platform-admin-1');
    expect(body.items.every((row) => /^h:[0-9a-f]{64}$/u.test(row.ref))).toBe(true);
    // La referencia nunca funciona como cookie de sesión.
    const target = body.items.find((row) => row.subjectId === 'local-analyst-1')!;
    const asCookie = await server().inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie: analyst.cookie.replace(/=[^;]+/u, `=${target.ref}`) },
      remoteAddress: OFFICE_IP,
    });
    expect(asCookie.statusCode).toBe(401);
  });

  it('revoca la sesión de otra persona con motivo, la deja sin acceso y lo audita', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const admin = await signIn('admin@qapaq.pe');
    const rows = JSON.parse((await listSessions(admin.cookie)).body).items as SessionRow[];
    const target = rows.find((row) => row.subjectId === 'local-analyst-1' && !row.current)!;

    const shortReason = await revoke(admin.mutation, target.ref, {
      reason: 'corto',
      expectedRevision: target.revision,
    });
    const revoked = await revoke(admin.mutation, target.ref, {
      reason: 'Equipo reportado como perdido por el usuario.',
      expectedRevision: target.revision,
    });
    const afterwards = await server().inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(shortReason.statusCode).toBe(422);
    expect(revoked.statusCode).toBe(201);
    expect(JSON.parse(revoked.body).session).toMatchObject({
      state: 'revoked',
      revocationReason: 'administrative',
    });
    expect(afterwards.statusCode).toBe(401);
    const audit = await memorySoc().allAudit();
    expect(audit.some((event) => event.action === 'access.session.revoked')).toBe(true);
  });

  it('no permite revocar la propia sesión ni actuar sin CSRF', async () => {
    const admin = await signIn('admin@qapaq.pe');
    const rows = JSON.parse((await listSessions(admin.cookie)).body).items as SessionRow[];
    const own = rows.find((row) => row.current)!;

    const self = await revoke(admin.mutation, own.ref, {
      reason: 'Prueba de auto-revocación bloqueada.',
      expectedRevision: own.revision,
    });
    const withoutCsrf = await revoke({ cookie: admin.cookie }, own.ref, {
      reason: 'Prueba sin token CSRF en la petición.',
      expectedRevision: own.revision,
    });

    expect(self.statusCode).toBe(409);
    expect(withoutCsrf.statusCode).toBe(403);
  });
});
