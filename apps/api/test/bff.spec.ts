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
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const ENVIRONMENT = { QAPAQ_PROFILE: 'test' } as const;

const OFFICE_IP = '10.20.5.9';
const REMOTE_IP = '203.0.113.7';
const PROXY_IP = '172.31.0.5';

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
let stop: () => Promise<void>;

function server() {
  return application.getHttpAdapter().getInstance();
}

async function signIn(
  username: string,
  remoteAddress = OFFICE_IP,
  headers: Record<string, string> = {},
) {
  const start = await server().inject({
    method: 'GET',
    url: '/api/auth/start',
    remoteAddress,
    headers,
  });
  const state = new URL(start.headers.location as string, 'http://local').searchParams.get('state');
  const authorize = await server().inject({
    method: 'GET',
    url: `/api/auth/local/authorize?state=${encodeURIComponent(state ?? '')}&username=${encodeURIComponent(username)}`,
    remoteAddress,
    headers,
  });
  // El emisor local devuelve una ruta relativa: la API y la consola comparten origen.
  const callbackUrl = new URL(authorize.headers.location as string, 'http://local');
  const response = await server().inject({
    method: 'GET',
    url: `/api/auth/callback${callbackUrl.search}`,
    remoteAddress,
    headers,
  });
  const cookie = (response.headers['set-cookie'] as string | undefined)?.split(';')[0] ?? '';
  return { response, cookie, state };
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
  runtime.soc.alertRows.clear();
  runtime.soc.incidentRows.clear();
  runtime.soc.outboxRows.clear();
  runtime.outbox.rows.clear();
  runtime.notifications.rows.clear();
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
    expect(response.body).not.toContain('id_token');
  });

  it('abre sesión y devuelve una cookie HttpOnly con identificador opaco', async () => {
    const { response, cookie } = await signIn('analista@qapaq.pe');
    const header = response.headers['set-cookie'] as string;

    expect(response.statusCode).toBe(200);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('analista@qapaq.pe');
    expect(cookie.length).toBeGreaterThan(20);
    expect(JSON.parse(response.body).capabilities).toContain('alerts.triage');
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
    const authorize = await server().inject({
      method: 'GET',
      url: `/api/auth/local/authorize?state=${state}&username=analista%40qapaq.pe`,
      remoteAddress: OFFICE_IP,
    });
    const search = new URL(authorize.headers.location as string, 'http://local').search;

    const first = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${search}`,
      remoteAddress: OFFICE_IP,
    });
    const replay = await server().inject({
      method: 'GET',
      url: `/api/auth/callback${search}`,
      remoteAddress: OFFICE_IP,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).code).toBe('AUTH_FAILED');
  });

  it('cierra la sesión y la cookie deja de servir', async () => {
    const { cookie } = await signIn('analista@qapaq.pe');
    const logout = await server().inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
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

    expect(withoutPasskey.response.statusCode).toBe(401);
    expect(JSON.parse(withoutPasskey.response.body).code).toBe('PASSKEY_REQUIRED');

    const withPasskey = await signIn('lider@qapaq.pe', REMOTE_IP);

    expect(withPasskey.response.statusCode).toBe(200);
  });

  it('ignora un X-Forwarded-For forjado desde una conexión no confiable', async () => {
    const forged = await signIn('analista@qapaq.pe', REMOTE_IP, {
      'x-forwarded-for': OFFICE_IP,
    });

    expect(forged.response.statusCode).toBe(401);
    expect(JSON.parse(forged.response.body).code).toBe('PASSKEY_REQUIRED');
  });

  it('acepta la cadena cuando el proxy sí es confiable', async () => {
    const viaProxy = await signIn('analista@qapaq.pe', PROXY_IP, {
      'x-forwarded-for': `${OFFICE_IP}, ${PROXY_IP}`,
    });

    expect(viaProxy.response.statusCode).toBe(200);
  });

  it('rechaza una cadena de proxies que no identifica cliente', async () => {
    const opaque = await signIn('analista@qapaq.pe', PROXY_IP, {
      'x-forwarded-for': `${PROXY_IP}, ${PROXY_IP}`,
    });

    expect(opaque.response.statusCode).toBe(403);
    expect(JSON.parse(opaque.response.body).code).toBe('NETWORK_NOT_ALLOWED');
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
    const { response } = await signIn('sinrol@qapaq.pe');

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).message).toBe(
      'No fue posible iniciar sesión con esas credenciales.',
    );
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
    expect(runtime.soc.alertRows.size).toBe(0);
  });

  it('repetir la ingesta no crea una segunda alerta', async () => {
    await ingest('01890f47-7abc-7def-8abc-00000000a003');
    const repeated = await ingest('01890f47-7abc-7def-8abc-00000000a003');

    expect(JSON.parse(repeated.body).outcome).toBe('duplicate');
    expect(runtime.soc.alertRows.size).toBe(1);
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
      headers: { cookie: analyst.cookie },
      payload: { name: 'acknowledge', expectedRevision: alert!.revision },
      remoteAddress: OFFICE_IP,
    });
    const triaged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: { cookie: analyst.cookie },
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
      headers: { cookie: analyst.cookie },
      payload: { name: 'escalate', expectedRevision: JSON.parse(triaged.body).alert.revision },
      remoteAddress: OFFICE_IP,
    });

    const lead = await signIn('lider@qapaq.pe');
    const incident = await server().inject({
      method: 'POST',
      url: '/api/incidents',
      headers: { cookie: lead.cookie },
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
      headers: { cookie: analyst.cookie },
      payload,
      remoteAddress: OFFICE_IP,
    });
    const stale = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert!.id}/commands`,
      headers: { cookie: analyst.cookie },
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
    const existingId = [...runtime.soc.alertRows.values()][0]!.id;

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
    const alertId = [...runtime.soc.alertRows.values()][0]!.id;

    const response = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/commands`,
      headers: { cookie: analyst.cookie },
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
    const alert = [...runtime.soc.alertRows.values()][0]!;
    const acknowledged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/commands`,
      headers: { cookie: analyst.cookie },
      payload: { name: 'acknowledge', expectedRevision: alert.revision },
      remoteAddress: OFFICE_IP,
    });
    const triaged = await server().inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/commands`,
      headers: { cookie: analyst.cookie },
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
      headers: { cookie: analyst.cookie },
      payload: { name: 'escalate', expectedRevision: JSON.parse(triaged.body).alert.revision },
      remoteAddress: OFFICE_IP,
    });

    const drained = await server().inject({
      method: 'POST',
      url: '/api/notifications/drain',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });
    const listed = await server().inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: analyst.cookie },
      remoteAddress: OFFICE_IP,
    });
    const attempts = JSON.parse(listed.body).items as { status: string }[];

    expect(drained.statusCode).toBe(201);
    expect(attempts.length).toBeGreaterThan(0);
    // Sin destino Teams alcanzable el crítico no se pierde: queda pendiente o en fallback.
    expect(['pending', 'indeterminate', 'fallback', 'sent']).toContain(attempts[0]!.status);
  });
});
