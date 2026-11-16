/**
 * Specs del BFF sobre HTTP real (inyección Fastify, sin red): C-17, C-18, C-25 y C-27.
 *
 * El recorrido se ejercita como lo hará el navegador: redirect al emisor, retorno con
 * código, cookie de sesión y llamadas autorizadas. Lo que se comprueba aquí no es que
 * las funciones de dominio hagan su trabajo —eso está en sus propios módulos— sino que
 * la frontera HTTP no relaje ninguna decisión.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecurityEventProviderError } from '@qapaq/connectors';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { buildApi } from '../src/bootstrap.js';
import { expiredOidcFlowCookie } from '../src/http/request-context.js';
import { SlidingWindowLimiter } from '../src/assistant/assistant-service.js';
import type { EventsReader } from '../src/runtime/events-reader.js';
import { wazuhRecordToEvent } from '../src/runtime/wazuh-ingestion.js';
import { createAttempt, type InMemoryAttemptStore } from '@qapaq/soar';
import type { InMemorySoc } from '@qapaq/soc';

import type {
  RuntimeDirectory,
  SecOpsRuntime,
  SignInDiagnostic,
} from '../src/runtime/secops-runtime.js';

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
const signInDiagnostics: SignInDiagnostic[] = [];
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
    method: 'POST',
    url: '/api/auth/callback',
    headers: { ...flowHeaders, 'content-type': 'application/x-www-form-urlencoded' },
    payload: callbackUrl.searchParams.toString(),
    remoteAddress,
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
  const built = await buildApi(
    ENVIRONMENT,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (diagnostic) => signInDiagnostics.push(diagnostic),
  );
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
  signInDiagnostics.length = 0;
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
  it('habilita la cookie cross-site segura requerida por form_post y mantiene Lax en local', () => {
    const state = 'a'.repeat(43);
    const secureCookie = expiredOidcFlowCookie(state, true);
    const localCookie = expiredOidcFlowCookie(state, false);

    expect(secureCookie).toContain('SameSite=None');
    expect(secureCookie).toContain('Secure');
    expect(localCookie).toContain('SameSite=Lax');
    expect(localCookie).not.toContain('Secure');
  });

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

  it('registra solo el AADSTS de un error OAuth y mantiene la respuesta pÃºblica genÃ©rica', async () => {
    const start = await server().inject({
      method: 'GET',
      url: '/api/auth/start',
      remoteAddress: OFFICE_IP,
    });
    const state = new URL(start.headers.location as string, 'http://local').searchParams.get(
      'state',
    );
    const flowCookie = cookiePair(start, 'qapaq_oidc_flow_');
    const description = 'AADSTS50011: redirect mismatch for analyst@example.test';
    const callback = await server().inject({
      method: 'POST',
      url: '/api/auth/callback',
      headers: {
        cookie: flowCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        state: state ?? '',
        error: 'access_denied',
        error_description: description,
      }).toString(),
      remoteAddress: OFFICE_IP,
    });

    expect(callback.statusCode).toBe(303);
    expect(authErrorOf(callback)).toBe('AUTH_FAILED');
    expect(String(callback.headers.location)).not.toContain('AADSTS50011');
    expect(String(callback.headers.location)).not.toContain('analyst@example.test');
    expect(signInDiagnostics.at(-1)).toMatchObject({
      stage: 'callback',
      code: 'PROVIDER_ERROR:AADSTS50011',
    });
    expect(JSON.stringify(signInDiagnostics)).not.toContain(description);
  });

  it('introspect entrega persona y roles al proxy del dashboard sin cuerpo', async () => {
    const { cookie } = await signIn('lider@qapaq.pe');
    const response = await server().inject({
      method: 'GET',
      url: '/api/auth/introspect',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-qapaq-user']).toMatch(/^[A-Za-z0-9._@+-]+$/u);
    expect(String(response.headers['x-qapaq-roles']).split(',')).toContain('qapaq.soc.lead');
  });

  it('introspect sin sesión responde 401 para que el proxy lleve al login QAPAQ', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/auth/introspect',
      remoteAddress: OFFICE_IP,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['x-qapaq-user']).toBeUndefined();
  });

  it('introspect deja fuera del dashboard a la sesión reemplazada por un nuevo inicio', async () => {
    const first = await signIn('lider@qapaq.pe');
    const second = await signIn('lider@qapaq.pe');
    const introspect = (cookie: string) =>
      server().inject({
        method: 'GET',
        url: '/api/auth/introspect',
        headers: { cookie },
        remoteAddress: OFFICE_IP,
      });

    expect((await introspect(first.cookie)).statusCode).toBe(401);
    expect((await introspect(second.cookie)).statusCode).toBe(204);
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
    expect(JSON.parse(ingested.body).reason).toBe('BELOW_THRESHOLD');
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

    // Las alertas vinculadas llegan resueltas y con la proyección de `GET /alerts`.
    const linked = await server().inject({
      method: 'GET',
      url: `/api/incidents/${encodeURIComponent(incidentId)}/alerts`,
      headers: { cookie: lead.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(linked.statusCode).toBe(200);
    expect(JSON.parse(linked.body)).toMatchObject({
      incidentId,
      items: [{ id: alert!.id, status: 'escalated', verdict: 'true_positive' }],
      nextCursor: null,
      totalCount: 1,
      unavailableCount: 0,
      truncated: false,
    });
    const missing = await server().inject({
      method: 'GET',
      url: '/api/incidents/no-existe/alerts',
      headers: { cookie: lead.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('RESOURCE_UNAVAILABLE');
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

describe('C-20 · acuse atómico de notificación', () => {
  async function deliveredAttempt(id: string) {
    const at = new Date('2026-11-12T10:00:00.000Z');
    const created = createAttempt({
      id,
      tenantId: runtime.tenantId,
      messageId: `message-${id}`,
      idempotencyKey: `key-${id}`,
      at,
    });
    const attempt = { ...created, status: 'sent' as const, sentAt: at };
    await runtime.notifications.save(attempt);
    return attempt;
  }

  async function acknowledge(id: string, mutation: Record<string, string>) {
    return server().inject({
      method: 'POST',
      url: `/api/notifications/${id}/acknowledge`,
      headers: mutation,
      remoteAddress: OFFICE_IP,
    });
  }

  it('cambia el estado y agrega el evento con actor, correlación y metadata mínima', async () => {
    const id = '0199bf33-0000-7000-8000-000000000101';
    const stale = await deliveredAttempt(id);
    const before = await runtime.soc.audit.head(runtime.tenantId);
    const analyst = await signIn('analista@qapaq.pe');
    const response = await acknowledge(id, analyst.mutation);
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'local-analyst-1' });
    expect(body.acknowledgedAt).toBeTruthy();
    const events = await runtime.soc.audit.range(
      runtime.tenantId,
      (before?.sequence ?? 0n) + 1n,
      10,
    );
    const acknowledgements = events.filter(
      (event) => event.action === 'soar.notification.acknowledged',
    );
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({
      action: 'soar.notification.acknowledged',
      actor: { id: 'local-analyst-1', type: 'user' },
      resource: { type: 'notification', id },
      outcome: 'succeeded',
      correlationId: body.correlationId,
      metadata: { previousStatus: 'sent' },
    });

    // El dispatcher puede terminar después de la respuesta humana con una copia vieja.
    await runtime.notifications.save(stale);
    await expect(runtime.notifications.byId(runtime.tenantId, id)).resolves.toMatchObject({
      status: 'acknowledged',
      acknowledgedBy: 'local-analyst-1',
    });
  });

  it('serializa dos solicitudes concurrentes y registra un solo acuse', async () => {
    const id = '0199bf33-0000-7000-8000-000000000102';
    await deliveredAttempt(id);
    const before = await runtime.soc.audit.head(runtime.tenantId);
    const analyst = await signIn('analista@qapaq.pe');
    const results = await Promise.all([
      acknowledge(id, analyst.mutation),
      acknowledge(id, analyst.mutation),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const events = await runtime.soc.audit.range(
      runtime.tenantId,
      (before?.sequence ?? 0n) + 1n,
      10,
    );
    expect(
      events.filter((event) => event.action === 'soar.notification.acknowledged'),
    ).toHaveLength(1);
  });

  it('revierte el estado si el append de auditoría falla', async () => {
    const id = '0199bf33-0000-7000-8000-000000000103';
    await deliveredAttempt(id);
    const analyst = await signIn('analista@qapaq.pe');
    vi.spyOn(runtime.soc.audit, 'head').mockRejectedValueOnce(new Error('AUDIT_STORE_UNAVAILABLE'));

    const response = await acknowledge(id, analyst.mutation);
    expect(response.statusCode).toBe(500);
    await expect(runtime.notifications.byId(runtime.tenantId, id)).resolves.toMatchObject({
      status: 'sent',
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
  });
});

describe('Observabilidad · GET /api/operations/health por rol', () => {
  async function withCorrelatorResponse(
    response: { readonly status: number; readonly body: unknown } | Error,
    run: (fetchSpy: ReturnType<typeof vi.spyOn>) => Promise<void>,
  ) {
    const original = runtime.correlatorRead;
    Object.defineProperty(runtime, 'correlatorRead', {
      configurable: true,
      writable: true,
      value: { baseUrl: 'http://correlator.internal:8080', token: 'test-correlator-read-token' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    try {
      await run(fetchSpy);
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(runtime, 'correlatorRead', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  }

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
    expect(body.sections.soc.correlator).toEqual({
      status: 'NO_DATA',
      ready: null,
      feedbackStatus: 'unconfigured',
      feedbackAgeSeconds: null,
      lastFeedbackSuccess: null,
    });
    expect(body.sections.soc.outboxToProviderAcceptanceMs).toMatchObject({
      status: 'NO_DATA',
      sampleCount: 0,
      p50: null,
      p95: null,
      p99: null,
    });
    expect(body.sections.soc.outbox.pending).toBeGreaterThan(0);
    expect(body.sections.soc.outbox).toMatchObject({
      expiredProcessing: 0,
      oldestExpiredLeaseAgeSeconds: null,
    });
    // El harness no arranca el bucle y usa memoria: se reporta, no se oculta.
    expect(body.sections.soc.degradedReasons).toEqual(
      expect.arrayContaining(['DISPATCHER_STOPPED', 'PERSISTENCE_EPHEMERAL']),
    );
  });

  it('proyecta solo los campos permitidos de /readyz para operadores SOC', async () => {
    const lead = await signIn('lider@qapaq.pe');
    const readyz = {
      ready: true,
      status: 'ready',
      feedbackReady: true,
      feedbackStatus: 'ready',
      feedbackAgeSeconds: 12.5,
      lastFeedbackSuccess: '2026-11-12T11:59:47.500Z',
      reason: 'must not be forwarded',
      debug: { token: 'must not be forwarded' },
    };

    await withCorrelatorResponse({ status: 200, body: readyz }, async () => {
      const response = await health(lead.cookie);
      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(body.sections.soc.correlator).toEqual({
        status: 'OK',
        ready: true,
        feedbackStatus: 'ready',
        feedbackAgeSeconds: 12.5,
        lastFeedbackSuccess: '2026-11-12T11:59:47.500Z',
      });
      expect(body.sections.soc.degradedReasons).not.toContain('CORRELATOR_NOT_READY');
      expect(response.body).not.toContain('must not be forwarded');
      expect(response.body).not.toContain('test-correlator-read-token');
    });
  });

  it('degrada solo SOC si /readyz falla o informa que el correlador no está listo', async () => {
    const lead = await signIn('lider@qapaq.pe');
    await withCorrelatorResponse(new Error('private transport detail'), async () => {
      const response = await health(lead.cookie);
      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(body.status).toBe('DEGRADED');
      expect(body.sections.soc.correlator).toEqual({
        status: 'DEGRADED',
        ready: null,
        feedbackStatus: 'unavailable',
        feedbackAgeSeconds: null,
        lastFeedbackSuccess: null,
      });
      expect(body.sections.soc.degradedReasons).toContain('CORRELATOR_UNREACHABLE');
      expect(response.body).not.toContain('private transport detail');
    });

    const leadAfter = await signIn('lider@qapaq.pe');
    await withCorrelatorResponse(
      {
        status: 503,
        body: {
          ready: false,
          status: 'degraded',
          feedbackReady: false,
          feedbackStatus: 'failed',
          feedbackAgeSeconds: 3,
          lastFeedbackSuccess: '2026-11-12T11:59:57.000Z',
        },
      },
      async () => {
        const response = await health(leadAfter.cookie);
        const body = JSON.parse(response.body);
        expect(response.statusCode).toBe(200);
        expect(body.sections.soc.correlator).toMatchObject({
          status: 'DEGRADED',
          ready: false,
          feedbackStatus: 'failed',
        });
        expect(body.sections.soc.degradedReasons).toContain('CORRELATOR_NOT_READY');
      },
    );

    await withCorrelatorResponse(
      { status: 200, body: { ready: 'yes', reason: 'bad body' } },
      async () => {
        const response = await health(leadAfter.cookie);
        const body = JSON.parse(response.body);
        expect(response.statusCode).toBe(200);
        expect(body.sections.soc.correlator.feedbackStatus).toBe('unavailable');
        expect(body.sections.soc.degradedReasons).toContain('CORRELATOR_UNREACHABLE');
        expect(response.body).not.toContain('bad body');
      },
    );
  });

  it('no expone métricas de la inbox Wazuh a un actor de otro tenant', async () => {
    const lead = await signIn('lider@qapaq.pe');
    const sessionId = decodeURIComponent(lead.cookie.slice('qapaq_session='.length));
    const session = await runtime.sessions.byId(sessionId);
    expect(session).toBeDefined();
    expect(session?.tenantId).toBe(runtime.sourceHealth?.key.tenantId);

    const metrics = {
      counts: { pending: 1, processing: 0, processed: 2, 'failed-terminal': 0 },
      oldestPendingAt: new Date('2026-11-12T09:00:00.000Z'),
      oldestProcessingAt: null,
      oldestUnresolvedAt: new Date('2026-11-12T09:00:00.000Z'),
      oldestTerminalAt: null,
      lastProcessedAt: new Date('2026-11-12T09:00:01.000Z'),
      expiredProcessing: 0,
      terminalFailuresRecent: 0,
      terminalWindowHours: 24 as const,
      sourceToReceiptMs: {
        windowHours: 24 as const,
        sampleCount: 2,
        clockSkewSamples: 0,
        sampleCapReached: false,
        p50: 10,
        p95: 20,
        p99: 20,
      },
      receiptToHandlerMs: {
        windowHours: 24 as const,
        sampleCount: 1,
        p50: 5,
        p95: 5,
        p99: 5,
      },
    };
    const readMetrics = vi.spyOn(runtime, 'wazuhPushInboxMetrics').mockResolvedValue(metrics);

    try {
      const ownTenantResponse = await health(lead.cookie);
      expect(JSON.parse(ownTenantResponse.body).sections.soc.wazuhPushInbox.counts.pending).toBe(1);

      readMetrics.mockClear();
      const currentBeforeTenantChange = await runtime.sessions.byId(sessionId);
      expect(currentBeforeTenantChange).toBeDefined();
      expect(
        await runtime.sessions.update(
          { ...currentBeforeTenantChange!, tenantId: 'tenant-outside-wazuh-source' },
          currentBeforeTenantChange!.revision,
        ),
      ).toBe(true);

      const otherTenantResponse = await health(lead.cookie);
      expect(JSON.parse(otherTenantResponse.body).sections.soc.wazuhPushInbox).toBeNull();
      expect(readMetrics).not.toHaveBeenCalled();
    } finally {
      const current = await runtime.sessions.byId(sessionId);
      if (current && current.tenantId !== session!.tenantId) {
        await runtime.sessions.update(
          { ...current, tenantId: session!.tenantId },
          current.revision,
        );
      }
      readMetrics.mockRestore();
    }
  });

  it('no consulta ni expone la salud del correlador a un actor de otro tenant', async () => {
    const lead = await signIn('lider@qapaq.pe');
    const sessionId = decodeURIComponent(lead.cookie.slice('qapaq_session='.length));
    const originalSession = await runtime.sessions.byId(sessionId);
    expect(originalSession?.tenantId).toBe(runtime.tenantId);
    expect(originalSession).toBeDefined();
    expect(
      await runtime.sessions.update(
        { ...originalSession!, tenantId: 'tenant-outside-correlator' },
        originalSession!.revision,
      ),
    ).toBe(true);

    try {
      await withCorrelatorResponse(
        {
          status: 200,
          body: {
            ready: true,
            status: 'ready',
            feedbackReady: true,
            feedbackStatus: 'ready',
            feedbackAgeSeconds: 1,
            lastFeedbackSuccess: '2026-11-12T12:00:00.000Z',
          },
        },
        async (fetchSpy) => {
          const response = await health(lead.cookie);
          const body = JSON.parse(response.body);
          expect(response.statusCode).toBe(200);
          expect(body.sections.soc.correlator).toEqual({
            status: 'NO_DATA',
            ready: null,
            feedbackStatus: 'unconfigured',
            feedbackAgeSeconds: null,
            lastFeedbackSuccess: null,
          });
          expect(fetchSpy).not.toHaveBeenCalled();
        },
      );
    } finally {
      const currentSession = await runtime.sessions.byId(sessionId);
      if (currentSession && currentSession.tenantId !== originalSession!.tenantId) {
        await runtime.sessions.update(
          { ...currentSession, tenantId: originalSession!.tenantId },
          currentSession.revision,
        );
      }
    }
  });

  it('el administrador de plataforma ve las tres secciones', async () => {
    const admin = await signIn('admin@qapaq.pe');
    const body = JSON.parse((await health(admin.cookie)).body);

    expect(Object.keys(body.sections).sort()).toEqual(['platform', 'soc', 'summary']);
    expect(body.sections.platform.databaseLatencyMs).toBeGreaterThanOrEqual(0);
    expect(body.sections.soc.outboxToProviderAcceptanceMs.acceptanceMeans).toContain(
      'does not mean a person read it',
    );
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

describe('Sprint 5 · tareas, bitácora y timeline del incidente', () => {
  /** Abre un caso desde una alerta crítica triada y escalada, todo por HTTP. */
  async function openIncidentAsLead(recordId: string) {
    await ingest(recordId);
    const lead = await signIn('lider@qapaq.pe');
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      server().inject({
        method,
        url,
        headers: method === 'GET' ? { cookie: lead.cookie } : lead.mutation,
        ...(payload ? { payload } : {}),
        remoteAddress: OFFICE_IP,
      });
    const [alert] = JSON.parse((await call('GET', '/api/alerts')).body).items as {
      id: string;
      revision: number;
    }[];
    let revision = alert!.revision;
    for (const command of [
      { name: 'acknowledge' },
      { name: 'triage', verdict: 'true_positive', note: 'Confirmado con el usuario afectado.' },
      { name: 'escalate' },
    ]) {
      const response = await call('POST', `/api/alerts/${alert!.id}/commands`, {
        ...command,
        expectedRevision: revision,
      });
      revision = JSON.parse(response.body).alert.revision;
    }
    const opened = await call('POST', '/api/incidents', {
      alertId: alert!.id,
      title: 'Regla de reenvío externa',
      severity: 'high',
      summary: 'Caso sintético para tareas y bitácora.',
      expectedAlertRevision: revision,
    });
    const incident = JSON.parse(opened.body).incident as { id: string; revision: number };
    return { lead, call, incident };
  }

  it('crea, mueve y lista tareas; una obligatoria abierta bloquea el cierre', async () => {
    const { call, incident } = await openIncidentAsLead('01890f47-7abc-7def-8abc-00000000c501');
    const base = `/api/incidents/${incident.id}`;

    const created = await call('POST', `${base}/tasks`, {
      title: 'Eliminar la regla de reenvío',
      required: true,
      dueAt: '2026-10-13T12:00:00.000Z',
    });
    expect(created.statusCode).toBe(201);
    const task = JSON.parse(created.body).task as { id: string; revision: number };
    expect(JSON.parse(created.body).task).toMatchObject({ status: 'open', required: true });

    let revision = incident.revision;
    for (const name of ['contain', 'resolve']) {
      const moved = await call('POST', `${base}/commands`, { name, expectedRevision: revision });
      revision = JSON.parse(moved.body).incident.revision;
    }
    const blocked = await call('POST', `${base}/commands`, {
      name: 'close',
      expectedRevision: revision,
      closureReason: 'Contenido y verificado con el usuario.',
    });
    expect(blocked.statusCode).toBe(422);

    const listed = await call('GET', `${base}/tasks`);
    expect(JSON.parse(listed.body)).toMatchObject({ totalCount: 1, openRequiredCount: 1 });

    const done = await call('POST', `${base}/tasks/${task.id}/commands`, {
      name: 'complete',
      expectedRevision: task.revision,
    });
    expect(JSON.parse(done.body).task).toMatchObject({ status: 'done' });
    const stale = await call('POST', `${base}/tasks/${task.id}/commands`, {
      name: 'reopen',
      expectedRevision: task.revision,
    });
    expect(stale.statusCode).toBe(409);

    const closed = await call('POST', `${base}/commands`, {
      name: 'close',
      expectedRevision: revision,
      closureReason: 'Contenido y verificado con el usuario.',
    });
    expect(JSON.parse(closed.body).incident).toMatchObject({ status: 'closed' });
  });

  it('la bitácora agrega y corrige sin editar, y el timeline une todo con su fuente de hora', async () => {
    const { call, incident } = await openIncidentAsLead('01890f47-7abc-7def-8abc-00000000c502');
    const base = `/api/incidents/${incident.id}`;

    const first = await call('POST', `${base}/notes`, { body: 'IP de origen 203.0.113.9.' });
    expect(first.statusCode).toBe(201);
    const firstId = JSON.parse(first.body).note.id as string;
    const correction = await call('POST', `${base}/notes`, {
      body: 'Corrección: la IP es 203.0.113.10.',
      correctsNoteId: firstId,
    });
    expect(JSON.parse(correction.body).note).toMatchObject({ correctsNoteId: firstId });

    const notes = JSON.parse((await call('GET', `${base}/notes`)).body);
    expect(notes.totalCount).toBe(2);
    // Dos notas en el mismo milisegundo empatan en la hora; se busca por id, no por posición.
    expect(notes.items.find((note: { id: string }) => note.id === firstId)).toMatchObject({
      body: 'IP de origen 203.0.113.9.',
    });

    const timeline = JSON.parse((await call('GET', `${base}/timeline`)).body) as {
      transitions: string;
      items: { kind: string; timeSource: string }[];
    };
    expect(timeline.transitions).toBe('included');
    const kinds = timeline.items.map((item) => item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['incident.opened', 'alert.linked', 'note.added']),
    );
    const linkedAlert = timeline.items.find((item) => item.kind === 'alert.linked') as
      { timeSource: string; at: string; recordedAt: string } | undefined;
    expect(linkedAlert?.timeSource).toBe('provider');
    // La alerta trae ambas horas: ocurrencia en la fuente y alta en QAPAQ.
    expect(Date.parse(linkedAlert!.recordedAt)).toBeGreaterThanOrEqual(Date.parse(linkedAlert!.at));
  });

  it('el auditor lee pero no escribe, y un id ajeno o inválido no revela nada', async () => {
    const { incident } = await openIncidentAsLead('01890f47-7abc-7def-8abc-00000000c503');
    const auditor = await signIn('auditor@qapaq.pe');
    const read = await server().inject({
      method: 'GET',
      url: `/api/incidents/${incident.id}/timeline`,
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(read.statusCode).toBe(200);
    const denied = await server().inject({
      method: 'POST',
      url: `/api/incidents/${incident.id}/notes`,
      headers: auditor.mutation,
      payload: { body: 'Intento de escritura del auditor.' },
      remoteAddress: OFFICE_IP,
    });
    expect(denied.statusCode).toBe(404);
    const invalid = await server().inject({
      method: 'GET',
      url: '/api/incidents/no-es-uuid/tasks',
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(invalid.statusCode).toBe(404);
    expect(JSON.parse(invalid.body).code).toBe('RESOURCE_UNAVAILABLE');
  });

  it('alertas vinculadas: deniega sin alerts.read, valida pageSize y declara el recorte', async () => {
    const { call, incident } = await openIncidentAsLead('01890f47-7abc-7def-8abc-00000000c504');
    const base = `/api/incidents/${incident.id}/alerts`;

    // El auditor lee incidentes pero no alertas: mismo 404 que un incidente inexistente.
    const auditor = await signIn('auditor@qapaq.pe');
    const denied = await server().inject({
      method: 'GET',
      url: base,
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(denied.statusCode).toBe(404);
    expect((await call('GET', `${base}?pageSize=0`)).statusCode).toBe(422);

    // 205 alertas sintéticas vinculadas: se resuelven 200 y la respuesta lo declara.
    const [seed] = [...memorySoc().alertRows.values()].filter(
      (alert) => alert.incidentId === incident.id,
    );
    for (let index = 0; index < 204; index += 1) {
      const id = `0190f47a-0000-7000-8000-${String(index).padStart(12, '0')}`;
      memorySoc().alertRows.set(`${seed!.tenantId}|${id}`, {
        ...seed!,
        id,
        occurredAt: new Date(seed!.occurredAt.getTime() - (index + 1) * 1_000),
      });
    }
    const pages: string[] = [];
    let cursor: string | null = null;
    let first: { totalCount: number; truncated: boolean; unavailableCount: number } | undefined;
    do {
      const response = await call(
        'GET',
        `${base}?pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      const body = JSON.parse(response.body) as {
        items: { id: string }[];
        nextCursor: string | null;
        totalCount: number;
        truncated: boolean;
        unavailableCount: number;
      };
      first ??= body;
      pages.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(first).toMatchObject({ totalCount: 205, truncated: true });
    expect(pages).toHaveLength(200);
    expect(new Set(pages).size).toBe(200);
  });
});

describe('S5-D10 · feed de cambios en vivo', () => {
  async function changes(cookie: string, after?: string) {
    const response = await server().inject({
      method: 'GET',
      url: `/api/changes${after === undefined ? '' : `?after=${after}`}`,
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
    return {
      status: response.statusCode,
      body: JSON.parse(response.body) as {
        cursor: string;
        resync: boolean;
        changes: { resource: { type: string; id: string }; kind: string }[];
      },
    };
  }

  it('anuncia la alerta nueva solo a quien puede leerla, sin contenido', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const auditor = await signIn('auditor@qapaq.pe');
    const start = (await changes(analyst.cookie)).body.cursor;
    const auditorStart = (await changes(auditor.cookie)).body.cursor;

    await ingest('01890f47-7abc-7def-8abc-00000000d001');

    const seen = await changes(analyst.cookie, start);
    expect(seen.status).toBe(200);
    const created = seen.body.changes.find((change) => change.resource.type === 'alert');
    expect(created).toMatchObject({ kind: 'created' });
    expect(Object.keys(created!).sort()).toEqual(['at', 'kind', 'resource', 'seq']);
    expect(BigInt(seen.body.cursor)).toBeGreaterThan(BigInt(start));

    // El auditor no tiene alerts.read: espera hasta el tope y no recibe la alerta.
    const hidden = await changes(auditor.cookie, auditorStart);
    expect(hidden.body.changes.filter((change) => change.resource.type === 'alert')).toEqual([]);
  });

  it('sin cambios retiene la petición y responde vacío antes del timeout del gateway', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const start = (await changes(analyst.cookie)).body.cursor;
    const began = Date.now();
    const idle = await changes(analyst.cookie, start);
    const elapsed = Date.now() - began;
    expect(idle.body).toMatchObject({ changes: [], resync: false, cursor: start });
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(3_500);
  });

  it('rechaza un cursor mal formado y exige sesión', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    expect((await changes(analyst.cookie, 'abc')).status).toBe(422);
    const anonymous = await server().inject({
      method: 'GET',
      url: '/api/changes',
      remoteAddress: OFFICE_IP,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Sprint 5 · fase 1 · GET /api/events', () => {
  type Mutable = { options: { events?: EventsReader } };
  const reads: Parameters<EventsReader['read']>[0][] = [];
  let failWith: Error | undefined;

  const fakeReader: EventsReader = {
    async read(request) {
      reads.push(request);
      if (failWith) throw failWith;
      const converted = wazuhRecordToEvent(
        {
          sourceRecordId: 'evt-http',
          dataset: 'wazuh-alerts',
          occurredAt: '2026-10-12T17:00:00.000Z',
          collectedAt: '2026-10-12T17:00:05.000Z',
          metadata: {},
          raw: {
            timestamp: '2026-10-12T17:00:00.000Z',
            id: 'evt-http',
            rule: {
              id: '100510',
              level: 12,
              description: 'Regla de reenvío',
              groups: ['office365'],
            },
            agent: { id: '000', name: 'wazuh-manager' },
          },
        },
        'tenant-http',
        'wazuh-indexer',
      );
      if (converted.status !== 'normalized') throw new Error('fixture');
      return {
        items: [{ event: converted.event, raw: { secreto: 'documento original' } }],
        unparsedCount: 0,
        nextCursor: null,
      };
    },
  };

  async function get(cookie: string, query = '') {
    const response = await server().inject({
      method: 'GET',
      url: `/api/events${query}`,
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }

  beforeEach(() => {
    reads.length = 0;
    failWith = undefined;
    (runtime as unknown as Mutable).options.events = fakeReader;
  });

  afterAll(() => {
    delete (runtime as unknown as Mutable).options.events;
  });

  it('el analista ve el evento normalizado sin el documento original; el lead, con él', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');
    const forAnalyst = await get(analyst.cookie, '?severity=critical,high&category=iam');
    expect(forAnalyst.status).toBe(200);
    expect(forAnalyst.body).toMatchObject({ status: 'ok', unparsedCount: 0, nextCursor: null });
    expect(forAnalyst.body.items[0]).toMatchObject({ severity: 'critical', category: ['iam'] });
    expect(forAnalyst.body.items[0]).not.toHaveProperty('raw');
    expect((await get(lead.cookie)).body.items[0].raw).toEqual({ secreto: 'documento original' });
    expect(reads[0]).toMatchObject({
      filters: { severity: ['critical', 'high'], category: ['iam'] },
    });
  });

  it('valida rango, tamaño de página y filtros sin aceptar lenguaje de consulta', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const tooWide = await get(
      analyst.cookie,
      '?from=2026-08-01T00:00:00.000Z&to=2026-10-12T00:00:00.000Z',
    );
    expect(tooWide.status).toBe(422);
    expect((await get(analyst.cookie, '?pageSize=500')).status).toBe(422);
    expect((await get(analyst.cookie, '?severity=rule.level:%3E10')).status).toBe(422);
    expect((await get(analyst.cookie, '?outcome=unknown')).status).toBe(422);
  });

  it('cursor incompatible es 422 y una caída del proveedor es 503 sin detalles', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    failWith = new SecurityEventProviderError('PROVIDER_CURSOR_INCOMPATIBLE', 'readPage', false);
    expect((await get(analyst.cookie, `?cursor=${'x'.repeat(32)}`)).status).toBe(422);
    failWith = new SecurityEventProviderError('PROVIDER_TIMEOUT', 'readPage', true, 'host interno');
    const degraded = await get(analyst.cookie);
    expect(degraded.status).toBe(503);
    expect(JSON.stringify(degraded.body)).not.toContain('host interno');
  });

  it('q (qapaq-events-v1) produce los mismos filtros, excluye los tipados y no repite errores', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const q = encodeURIComponent('Category:IAM and severity:critical,high');
    const parsed = await get(analyst.cookie, `?q=${q}`);
    expect(parsed.status).toBe(200);
    expect(parsed.body.query).toEqual({
      grammar: 'qapaq-events-v1',
      canonical: 'severity:high,critical AND category:iam',
    });
    expect(reads.at(-1)).toMatchObject({
      filters: { severity: ['high', 'critical'], category: ['iam'] },
    });

    const mixed = await get(analyst.cookie, `?q=${q}&severity=low`);
    expect(mixed.status).toBe(422);

    const injected = await get(analyst.cookie, `?q=${encodeURIComponent('source=* | where x')}`);
    expect(injected.status).toBe(422);
    expect(injected.body.fields).toEqual(['q']);
    expect(JSON.stringify(injected.body)).not.toContain('source=');
  });

  it('sin fuente configurada responde disabled y sin filas', async () => {
    delete (runtime as unknown as Mutable).options.events;
    const analyst = await signIn('analista@qapaq.pe');
    const disabled = await get(analyst.cookie);
    expect(disabled.body).toMatchObject({ status: 'disabled', items: [], nextCursor: null });
  });
});

describe('Sprint 5 · fase 2 · GET /api/sources/health', () => {
  async function health(cookie: string) {
    const response = await server().inject({
      method: 'GET',
      url: '/api/sources/health',
      headers: { cookie },
      remoteAddress: OFFICE_IP,
    });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }

  it('lead y auditor ven la fuente declarada como deshabilitada; el analista no accede', async () => {
    const lead = await health((await signIn('lider@qapaq.pe')).cookie);
    expect(lead.status).toBe(200);
    expect(lead.body.sources).toEqual([
      expect.objectContaining({
        sourceId: 'wazuh-indexer',
        enabled: false,
        state: 'disabled',
        reason: 'DISABLED',
        lastSuccessAt: null,
        subscriptions: null,
        transitions: [],
      }),
    ]);
    expect((await health((await signIn('auditor@qapaq.pe')).cookie)).status).toBe(200);
    expect((await health((await signIn('analista@qapaq.pe')).cookie)).status).toBe(404);
  });

  it('expone el desglose del último sondeo y conserva null en métricas históricas', async () => {
    const key = runtime.sourceHealth!.key;
    const attemptedAt = runtime.now();
    await runtime.soc.ingestion.recordObservation({
      id: '11111111-1111-4111-8111-111111111111',
      ...key,
      attemptedAt,
      completedAt: attemptedAt,
      outcome: 'success',
      recordsSeen: 4,
      normalized: 2,
      promoted: 1,
      quarantined: 1,
      duplicates: null,
      notPromoted: null,
      belowThreshold: 1,
      suppressed: 2,
      newestEventAt: null,
      errorClass: null,
    });
    const response = await health((await signIn('lider@qapaq.pe')).cookie);
    expect(response.body.sources[0].processing).toMatchObject({
      outcome: 'success',
      recordsSeen: 4,
      normalized: 2,
      promoted: 1,
      quarantined: 1,
      duplicates: null,
      notPromoted: null,
      belowThreshold: 1,
      suppressed: 2,
    });
  });
});

describe('Sprint 5 · fase 3 · GET /api/admin/users', () => {
  it('el admin ve el estado de la sincronización; sin padrón no se inventa nadie', async () => {
    const admin = await signIn('admin@qapaq.pe');
    const response = await server().inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: admin.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      sync: { mode: 'disabled', status: null, stale: false },
      items: [],
      totalCount: 0,
    });
  });

  it('Graph configurado sin permiso: «permiso faltante» en Miembros y Solicitudes, no un error', async () => {
    const pending: RuntimeDirectory = {
      mode: 'pending',
      intervalMs: 900_000,
      lastErrorCode: 'DIRECTORY_PERMISSION_MISSING',
      diagnostic: {
        status: 403,
        errorCode: 'Authorization_RequestDenied',
        requestId: 'graph-request-123',
        operation: 'resolveGroupId',
      },
      lastAttemptAt: new Date(),
      nextAttemptAt: new Date(Date.now() + 60_000),
    };
    Object.defineProperty(runtime, 'directory', { value: pending, configurable: true });
    try {
      const admin = await signIn('admin@qapaq.pe');
      const call = (url: string) =>
        server().inject({
          method: 'GET',
          url,
          headers: { cookie: admin.cookie },
          remoteAddress: OFFICE_IP,
        });
      const users = await call('/api/admin/users');
      expect(users.statusCode).toBe(200);
      expect(JSON.parse(users.body).sync).toMatchObject({
        mode: 'graph',
        status: 'failed',
        lastErrorClass: 'DIRECTORY_PERMISSION_MISSING',
        groupResolved: false,
        permissionMissing: true,
        diagnostic: {
          status: 403,
          errorCode: 'Authorization_RequestDenied',
          requestId: 'graph-request-123',
          operation: 'resolveGroupId',
        },
        stale: true,
      });
      const requests = await call('/api/admin/role-requests');
      expect(requests.statusCode).toBe(200);
      expect(JSON.parse(requests.body)).toMatchObject({
        items: [],
        nextCursor: null,
        directory: { status: 'pending', permissionMissing: true },
      });
      // Sin capability de roles sigue siendo indistinguible de un recurso inexistente.
      const lead = await signIn('lider@qapaq.pe');
      const hidden = await server().inject({
        method: 'GET',
        url: '/api/admin/role-requests',
        headers: { cookie: lead.cookie },
        remoteAddress: OFFICE_IP,
      });
      expect(hidden.statusCode).toBe(404);
    } finally {
      delete (runtime as unknown as { directory?: unknown }).directory;
    }
  });

  it('sin users.read responde igual que un recurso inexistente', async () => {
    const lead = await signIn('lider@qapaq.pe');
    for (const url of [
      '/api/admin/users',
      '/api/admin/users/11111111-1111-4111-8111-111111111111',
    ]) {
      const response = await server().inject({
        method: 'GET',
        url,
        headers: { cookie: lead.cookie },
        remoteAddress: OFFICE_IP,
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('Sprint 5 · avisos al dispositivo · /api/me/push', () => {
  const device = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/dispositivo-sintetico-1',
    keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
    label: 'Laptop del SOC',
  };

  it('cada persona registra, lista y quita solo sus dispositivos', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');
    const call = (who: typeof analyst, method: 'GET' | 'POST', url: string, payload?: object) =>
      server().inject({
        method,
        url,
        headers: method === 'GET' ? { cookie: who.cookie } : who.mutation,
        ...(payload ? { payload } : {}),
        remoteAddress: OFFICE_IP,
      });

    const config = JSON.parse((await call(analyst, 'GET', '/api/me/push/config')).body);
    expect(config).toMatchObject({ enabled: true, maximumDevices: 10 });
    expect(Buffer.from(config.vapidPublicKey, 'base64url')).toHaveLength(65);

    const created = await call(analyst, 'POST', '/api/me/push/subscriptions', device);
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).subscription.id as string;
    const listed = JSON.parse((await call(analyst, 'GET', '/api/me/push/subscriptions')).body);
    expect(listed.items).toEqual([
      expect.objectContaining({ id, label: 'Laptop del SOC', service: 'fcm.googleapis.com' }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('dispositivo-sintetico-1');

    // Otro usuario no puede quitar un dispositivo ajeno.
    expect((await call(lead, 'POST', `/api/me/push/subscriptions/${id}/revoke`)).statusCode).toBe(
      404,
    );
    expect(
      (await call(analyst, 'POST', `/api/me/push/subscriptions/${id}/revoke`)).statusCode,
    ).toBe(201);
    expect(
      JSON.parse((await call(analyst, 'GET', '/api/me/push/subscriptions')).body).items,
    ).toEqual([]);
  });

  it('rechaza endpoints que no son de un servicio de push y exige la capability', async () => {
    const analyst = await signIn('analista@qapaq.pe');
    const hostile = await server().inject({
      method: 'POST',
      url: '/api/me/push/subscriptions',
      headers: analyst.mutation,
      payload: { ...device, endpoint: 'https://atacante.example/recolector' },
      remoteAddress: OFFICE_IP,
    });
    expect(hostile.statusCode).toBe(422);
    expect(JSON.parse(hostile.body).fields).toEqual(['endpoint']);

    const auditor = await signIn('auditor@qapaq.pe');
    const denied = await server().inject({
      method: 'GET',
      url: '/api/me/push/config',
      headers: { cookie: auditor.cookie },
      remoteAddress: OFFICE_IP,
    });
    expect(denied.statusCode).toBe(404);
  });

  it('pendientes: las P1 abiertas recientes que la sesión puede ver, con enlace', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000e001');
    const analyst = await signIn('analista@qapaq.pe');
    const pending = JSON.parse(
      (
        await server().inject({
          method: 'GET',
          url: '/api/me/push/pending',
          headers: { cookie: analyst.cookie },
          remoteAddress: OFFICE_IP,
        })
      ).body,
    ) as { items: { type: string; url: string }[] };
    expect(Array.isArray(pending.items)).toBe(true);
    for (const item of pending.items)
      expect(item.url).toMatch(/^https:\/\/.+\/(alerts|incidents)\//u);
  });
});

describe('acceso con usuario y contraseña', () => {
  const PASSWORD = 'qapaq-dev-password';

  function submit(
    fields: Record<string, string>,
    headers: Record<string, string> = {},
    remoteAddress = officeIp,
  ) {
    return server().inject({
      method: 'POST',
      url: '/api/auth/password',
      remoteAddress,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  it('con credenciales válidas abre sesión y vuelve al destino pedido', async () => {
    const response = await submit({
      username: 'analista@qapaq.pe',
      password: PASSWORD,
      returnTo: '/app/qapaq-alerts',
    });
    expect(response.statusCode).toBe(303);
    // Puede añadir el aviso de sesión reemplazada si otra prueba abrió una antes.
    expect(new URL(response.headers.location as string, 'http://local').pathname).toBe(
      '/app/qapaq-alerts',
    );
    const cookie = cookiePair(response, 'qapaq_session=');
    expect(cookie).not.toBe('');
    const session = await server().inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
      remoteAddress: officeIp,
    });
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).roles).toEqual(['qapaq.soc.analyst']);
  });

  it('también acepta JSON', async () => {
    const response = await server().inject({
      method: 'POST',
      url: '/api/auth/password',
      remoteAddress: officeIp,
      payload: { username: 'Analista@QAPAQ.pe', password: PASSWORD },
    });
    expect(response.statusCode).toBe(303);
    expect(cookiePair(response, 'qapaq_session=')).not.toBe('');
  });

  it('una contraseña errónea y un usuario inexistente son indistinguibles', async () => {
    const wrong = await submit({ username: 'analista@qapaq.pe', password: 'no-es' });
    const unknown = await submit({ username: 'nadie@qapaq.pe', password: PASSWORD });
    for (const response of [wrong, unknown]) {
      expect(response.statusCode).toBe(303);
      expect(cookiePair(response, 'qapaq_session=')).toBe('');
      expect(authErrorOf(response)).toBe('AUTH_FAILED');
    }
  });

  it('sin rol asignado no entra aunque la contraseña sea correcta', async () => {
    const response = await submit({ username: 'sinrol@qapaq.pe', password: PASSWORD });
    expect(cookiePair(response, 'qapaq_session=')).toBe('');
    expect(authErrorOf(response)).toBe('AUTH_FAILED');
  });

  it('fuera de la red exige passkey: la contraseña sola no basta', async () => {
    const response = await submit(
      { username: 'analista@qapaq.pe', password: PASSWORD },
      {},
      REMOTE_IP,
    );
    expect(cookiePair(response, 'qapaq_session=')).toBe('');
    expect(authErrorOf(response)).not.toBeNull();
  });

  it('bloquea tras varios intentos fallidos aunque luego llegue la contraseña correcta', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submit({ username: 'auditor@qapaq.pe', password: 'incorrecta' });
    }
    const response = await submit({ username: 'auditor@qapaq.pe', password: PASSWORD });
    expect(cookiePair(response, 'qapaq_session=')).toBe('');
    expect(authErrorOf(response)).toBe('AUTH_FAILED');
  });

  it('rechaza peticiones de otro sitio (login CSRF)', async () => {
    const crossSite = await submit(
      { username: 'analista@qapaq.pe', password: PASSWORD },
      { 'sec-fetch-site': 'cross-site' },
    );
    const foreignOrigin = await submit(
      { username: 'analista@qapaq.pe', password: PASSWORD },
      { origin: 'https://evil.example', host: 'soc.qapaq.pe' },
    );
    for (const response of [crossSite, foreignOrigin]) {
      expect(cookiePair(response, 'qapaq_session=')).toBe('');
      expect(authErrorOf(response)).toBe('REQUEST_NOT_VERIFIED');
    }
  });

  it('no permite un destino fuera del origen', async () => {
    const response = await submit({
      username: 'analista@qapaq.pe',
      password: PASSWORD,
      returnTo: 'https://evil.example/',
    });
    expect(new URL(response.headers.location as string, 'http://local').pathname).toBe('/');
  });
});

describe('Qapaqzito · asistente de IA', () => {
  const usage = { inputTokens: 10, outputTokens: 5 };

  /** Modelo falso: pide una herramienta y responde con lo que esa herramienta devolvió. */
  function fakeAssistant(toolName: string, input: Record<string, unknown> = {}) {
    const seen: string[] = [];
    runtime.assistant = {
      config: {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        effort: 'medium',
        redactPii: true,
        apiKey: 'test',
        rateLimit: { max: 3, windowMs: 60_000 },
      },
      limiter: new SlidingWindowLimiter(3, 60_000),
      model: {
        async complete(request) {
          const last = request.messages[request.messages.length - 1];
          const resultBlock = Array.isArray(last?.content)
            ? last.content.find((block) => block.type === 'tool_result')
            : undefined;
          if (!resultBlock || resultBlock.type !== 'tool_result') {
            seen.push(...request.tools.map((tool) => tool.name));
            return {
              content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input }],
              stopReason: 'tool_use',
              usage,
            };
          }
          return {
            content: [{ type: 'text', text: `Resultado: ${resultBlock.content.slice(0, 400)}` }],
            stopReason: 'end_turn',
            usage,
          };
        },
      },
    };
    return seen;
  }

  async function ask(
    session: { cookie: string; csrf: string },
    message: string,
    extra: Record<string, string> = {},
  ) {
    return server().inject({
      method: 'POST',
      url: '/api/assistant/chat',
      remoteAddress: officeIp,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra },
      payload: { message, page: '/app/qapaq-alerts' },
    });
  }

  it('sin QAPAQ_QAPAQZITO_ENABLED no existe', async () => {
    runtime.assistant = undefined;
    const analyst = await signIn('analista@qapaq.pe');
    expect((await ask(analyst, 'hola')).statusCode).toBe(404);
    const config = await server().inject({
      method: 'GET',
      url: '/api/assistant/config',
      headers: { cookie: analyst.cookie },
      remoteAddress: officeIp,
    });
    expect(JSON.parse(config.body).enabled).toBe(false);
  });

  it('lee el SOC con la sesión de la persona y ve solo las herramientas de su rol', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000b001');
    const seen = fakeAssistant('find_alerts', { priority: 'P1' });
    const analyst = await signIn('analista@qapaq.pe');
    const response = await ask(analyst, '¿Qué alertas P1 hay?');
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.reply).toContain('DATOS DEL SOC');
    expect(body.steps).toEqual([{ tool: 'find_alerts', label: 'Buscando alertas', ok: true }]);
    expect(body.citations).toEqual([]);
    // Un analista no tiene permisos de auditoría ni de administración de usuarios.
    expect(seen).toContain('find_alerts');
    expect(seen).not.toContain('audit_events');
    expect(seen).not.toContain('list_users');
  });

  it('una herramienta fuera del rol sigue bloqueada por la API', async () => {
    fakeAssistant('audit_events');
    const analyst = await signIn('analista@qapaq.pe');
    const body = JSON.parse((await ask(analyst, 'auditoría')).body);
    // El modelo la pidió aunque no se le ofreció: se rechaza como herramienta desconocida.
    expect(body.steps).toEqual([
      { tool: 'audit_events', label: 'Herramienta desconocida', ok: false },
    ]);
  });

  it('exige el token CSRF y valida el cuerpo', async () => {
    fakeAssistant('find_alerts');
    const analyst = await signIn('analista@qapaq.pe');
    const noCsrf = await server().inject({
      method: 'POST',
      url: '/api/assistant/chat',
      remoteAddress: officeIp,
      headers: { cookie: analyst.cookie },
      payload: { message: 'hola' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const invalid = await server().inject({
      method: 'POST',
      url: '/api/assistant/chat',
      remoteAddress: officeIp,
      headers: { cookie: analyst.cookie, 'x-csrf-token': analyst.csrf },
      payload: { message: 12 },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it('limita las preguntas por persona y audita cada una sin guardar el texto', async () => {
    fakeAssistant('whoami');
    const analyst = await signIn('analista@qapaq.pe');
    for (let index = 0; index < 3; index += 1) {
      expect((await ask(analyst, `pregunta ${index}`)).statusCode).toBe(200);
    }
    expect((await ask(analyst, 'una más')).statusCode).toBe(429);
    const events = await runtime.audit.read({
      tenantId: runtime.tenantId,
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
      pageSize: 200,
      cursor: null,
      action: 'assistant.ask',
      actorId: null,
      resourceType: null,
      resourceId: null,
      outcome: [],
      includeSensitive: false,
    });
    const asks = events.events;
    // La auditoría es compartida entre pruebas: al menos las 3 de esta persona.
    expect(asks.length).toBeGreaterThanOrEqual(3);
    expect(
      JSON.stringify(asks, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain('pregunta');
  });
});
