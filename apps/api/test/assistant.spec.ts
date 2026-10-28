/**
 * Asistente Claude (Qapaqzito): seudonimización, autorización, topes y auditoría.
 *
 * El proveedor del modelo se sustituye por un cliente falso que guarda cada petición tal como
 * saldría hacia Anthropic. Lo que se comprueba es la frontera: que ningún UPN, correo, IP,
 * hostname ni nombre de persona viaje en claro, que la respuesta que ve el analista sí quede
 * re-resuelta, y que la autorización, el CSRF, el límite de tasa y la auditoría no se relajen.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Actor, Capability } from '@qapaq/access';
import type { InMemorySoc } from '@qapaq/soc';

import { buildApi } from '../src/bootstrap.js';
import {
  ASSISTANT_LIMITS,
  AssistantModelError,
  AssistantService,
  type AssistantModelClient,
} from '../src/runtime/assistant.js';
import { ConversationPseudonymizer } from '../src/runtime/assistant-pseudonymizer.js';
import { assistantToolsFor, runAssistantTool } from '../src/runtime/assistant-tools.js';
import { ENTITY_REF_PATTERN, entityRefFactory } from '../src/runtime/entity-refs.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const UPN = 'jperez@qapaq.pe';
const SOURCE_IP = '203.0.113.7';
const HOST = 'srv-app-01.qapaq.local';
const ANALYST_NAME = 'Ana Lista';
const ANALYST_EMAIL = 'analista@qapaq.pe';
/** Todo lo que no puede aparecer en ninguna petición hacia el proveedor. */
const CLEAR_VALUES = [UPN, SOURCE_IP, HOST, ANALYST_NAME, ANALYST_EMAIL, 'local-analyst-1'];

const refOf = entityRefFactory('assistant-spec-entity-ref-key-0000000000');

describe('seudonimización de la conversación', () => {
  it('reemplaza correos, IP, cuentas de dominio y hosts, y los re-resuelve para el analista', () => {
    const pseudonymizer = new ConversationPseudonymizer('tenant-1', refOf);
    const text = `Revisa ${UPN} (QAPAQ\\jperez) desde ${SOURCE_IP} y 2001:db8::7 en ${HOST}.`;

    const scrubbed = pseudonymizer.scrub(text);

    for (const value of [UPN, 'QAPAQ\\jperez', SOURCE_IP, '2001:db8::7', HOST]) {
      expect(scrubbed).not.toContain(value);
    }
    expect(scrubbed.match(/ent_[A-Za-z0-9_-]{22}/gu)).toHaveLength(5);
    expect(pseudonymizer.reveal(scrubbed)).toBe(text);
  });

  it('usa la misma referencia que la consola para las claves de C-16', () => {
    const pseudonymizer = new ConversationPseudonymizer('tenant-1', refOf);

    expect(pseudonymizer.scrub(UPN)).toBe(refOf('tenant-1', `user:${UPN}`));
    expect(pseudonymizer.scrub(SOURCE_IP)).toBe(refOf('tenant-1', `ip:${SOURCE_IP}`));
    // Mismo valor en otro tenant: otra referencia.
    expect(new ConversationPseudonymizer('tenant-2', refOf).scrub(UPN)).not.toBe(
      pseudonymizer.scrub(UPN),
    );
  });

  it('depura nombres de persona conocidos, con acentos y sin distinguir mayúsculas', () => {
    const pseudonymizer = new ConversationPseudonymizer('tenant-1', refOf);
    pseudonymizer.pseudonym('person', 'Aída Núñez');

    const scrubbed = pseudonymizer.scrub('Lo reportó AÍDA NÚÑEZ ayer; aída núñez confirmó.');

    expect(scrubbed).not.toMatch(/a[ií]da/iu);
    expect(scrubbed).toMatch(/^Lo reportó ent_[A-Za-z0-9_-]{22} ayer; ent_/u);
  });

  it('no toca horas, fechas, ids ni referencias ajenas', () => {
    const pseudonymizer = new ConversationPseudonymizer('tenant-1', refOf);
    const foreign = refOf('tenant-1', 'user:otra@qapaq.pe');
    const text = `A las 10:20:30 del 2026-10-08, alerta 7b0c3f7e-5d1a-4c55-9a7e-0e1f2a3b4c5d, ${foreign}.`;

    expect(pseudonymizer.scrub(text)).toBe(text);
    expect(pseudonymizer.reveal(text)).toBe(text);
  });

  it('un nombre conocido no corta un correo que lo contiene', () => {
    const pseudonymizer = new ConversationPseudonymizer('tenant-1', refOf);
    pseudonymizer.pseudonym('person', 'analista');

    const scrubbed = pseudonymizer.scrub(`escribe a ${ANALYST_EMAIL}`);

    expect(scrubbed).toBe(`escribe a ${refOf('tenant-1', `user:${ANALYST_EMAIL}`)}`);
    expect(pseudonymizer.reveal(scrubbed)).toBe(`escribe a ${ANALYST_EMAIL}`);
  });
});

/* ---------------------------------------------------------------- Harness HTTP */

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
let stop: () => Promise<void>;
let ipSequence = 0;

const server = () => application.getHttpAdapter().getInstance();
const memorySoc = () => runtime.soc as InMemorySoc;

async function signIn(username: string) {
  ipSequence += 1;
  const remoteAddress = `10.20.7.${ipSequence}`;
  const start = await server().inject({ method: 'GET', url: '/api/auth/start', remoteAddress });
  const startCookies = [start.headers['set-cookie'] ?? []].flat() as string[];
  const flowCookie = startCookies[0]?.split(';', 1)[0] ?? '';
  const state = new URL(start.headers.location as string, 'http://local').searchParams.get('state');
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
  const cookie =
    ([response.headers['set-cookie'] ?? []].flat() as string[])
      .find((value) => value.startsWith('qapaq_session='))
      ?.split(';', 1)[0] ?? '';
  const session = await server().inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie },
    remoteAddress,
  });
  const csrf = JSON.parse(session.body).csrfToken as string;
  return { remoteAddress, cookie, mutation: { cookie, 'x-csrf-token': csrf } };
}

function securityEvent(recordId: string) {
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
      normalized: 'critical',
      score: 95,
      originalValue: 14,
      originalLabel: 'critical',
      originalScale: 'wazuh-level-0-15',
      mappingId: 'qapaq.wazuh.severity',
      mappingVersion: '1.0.0',
    },
    category: ['intrusion_detection'],
    outcome: 'success',
    action: 'alert.created',
    entities: {
      identities: [{ kind: 'user', id: 'identity-1', principal: UPN }],
      resources: [
        { kind: 'ip', id: SOURCE_IP },
        { kind: 'host', id: 'host-1', name: HOST, type: 'endpoint' },
      ],
    },
    detection: {
      rule: {
        // El texto libre de la detección trae las entidades en claro, como en la vida real.
        id: '5716',
        name: `Acceso sospechoso de ${UPN} desde ${SOURCE_IP} hacia ${HOST}`,
        version: '1',
        provider: 'wazuh',
        groups: ['authentication_failed'],
      },
    },
    raw: { ref: `raw:${recordId}`, sha256: 'a'.repeat(64), mediaType: 'application/json', sizeBytes: 1 },
    provenance: {
      connector: 'qapaq-wazuh-indexer',
      connectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      mappingVersion: '1.0.0',
      timestampQuality: 'source',
      ingestionPath: [
        { kind: 'collector', vendor: 'Wazuh, Inc.', product: 'Wazuh', instanceId: 'siem-qapaq-lab' },
        { kind: 'adapter', vendor: 'QAPAQ', product: 'QAPAQ SecOps' },
      ],
    },
  };
}

function message(
  content: BetaMessage['content'],
  stopReason: BetaMessage['stop_reason'],
): BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1_000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

/** Cliente falso: guarda cada petición y responde con un guion. */
function scriptedClient(
  script: (params: MessageCreateParamsNonStreaming, call: number) => BetaMessage | Error,
) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const client: AssistantModelClient = {
    async createMessage(params) {
      // Copia profunda: el servicio sigue agregando al historial después de la llamada.
      requests.push(JSON.parse(JSON.stringify(params)) as MessageCreateParamsNonStreaming);
      const next = script(params, requests.length);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { client, requests };
}

/** Investiga la alerta abierta y responde citando las referencias que recibió. */
function investigatingScript(alertId: string) {
  return (params: MessageCreateParamsNonStreaming, call: number) => {
    if (call === 1) {
      return message(
        [
          { type: 'tool_use', id: 'toolu_1', name: 'get_alert', input: { alert_id: alertId } },
          { type: 'tool_use', id: 'toolu_2', name: 'soc_summary', input: {} },
        ] as BetaMessage['content'],
        'tool_use',
      );
    }
    const last = params.messages.at(-1)!;
    const results = Array.isArray(last.content) ? last.content : [];
    const detail = results.find(
      (block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_1',
    ) as { content: string } | undefined;
    const alert = JSON.parse(detail!.content) as { entities: { ref: string; kind: string }[] };
    const user = alert.entities.find((entity) => entity.kind === 'user')!.ref;
    const ip = alert.entities.find((entity) => entity.kind === 'ip')!.ref;
    return message(
      [{ type: 'text', text: `La cuenta ${user} inició sesión desde ${ip}.` }] as BetaMessage['content'],
      'end_turn',
    );
  };
}

function useAssistant(client?: AssistantModelClient, clock?: () => Date): AssistantService {
  const service = new AssistantService({
    ...(client ? { client } : {}),
    model: 'claude-sonnet-5-5',
    refOf: (tenantId, key) => runtime.entityRefOf(tenantId, key) ?? refOf(tenantId, key),
    soc: () => runtime.soc,
    ...(clock ? { clock } : {}),
  });
  (runtime as unknown as { options: { assistant?: AssistantService } }).options.assistant = service;
  return service;
}

let alertId: string;

beforeAll(async () => {
  const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
  application = built.application;
  runtime = built.runtime;
  stop = built.stop;
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  const ingested = await server().inject({
    method: 'POST',
    url: '/api/ingest/security-events',
    payload: securityEvent('01890f47-7abc-7def-8abc-00000000b001'),
    remoteAddress: '10.20.5.9',
  });
  expect(JSON.parse(ingested.body).fields ?? []).toEqual([]);
  expect(ingested.statusCode).toBe(201);
  const alerts = await memorySoc().listAlerts({ tenantId: runtime.tenantId });
  alertId = alerts.items[0]!.id;
});

afterAll(async () => {
  await stop();
});

describe('POST /api/assistant/messages · seudonimización de punta a punta', () => {
  it('ninguna entidad sale en claro hacia el proveedor y la respuesta llega re-resuelta', async () => {
    const { client, requests } = scriptedClient(investigatingScript(alertId));
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);

    const response = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: {
        message: `Soy ${ANALYST_NAME} (${ANALYST_EMAIL}). ¿Qué hizo ${UPN} desde ${SOURCE_IP} en ${HOST}?`,
        context: { alertId },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.reply.text).toBe(`La cuenta ${UPN} inició sesión desde ${SOURCE_IP}.`);
    expect(body.toolsUsed).toEqual(['get_alert', 'soc_summary']);
    expect(requests).toHaveLength(2);
    const outgoing = JSON.stringify(requests);
    for (const value of CLEAR_VALUES) expect(outgoing).not.toContain(value);
    expect(outgoing).toContain(alertId);
    expect(outgoing.match(/ent_[A-Za-z0-9_-]{22}/gu)?.length).toBeGreaterThan(3);
    // Modelo configurado, herramientas de solo lectura y reintento del proveedor ante rechazos.
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    expect(requests[0]!.tools!.map((tool) => (tool as { name: string }).name)).toEqual([
      'list_alerts',
      'get_alert',
      'related_alerts_by_entity',
      'soc_summary',
      'incident_log',
    ]);
  });

  it('el segundo turno reenvía el historial seudonimizado del servidor, no el del cliente', async () => {
    const { client, requests } = scriptedClient(investigatingScript(alertId));
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);
    const first = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: { message: `Resume la alerta ${alertId}` },
    });
    const { conversationId } = JSON.parse(first.body);
    const follow = scriptedClient(() =>
      message([{ type: 'text', text: 'Sin novedades.' }] as BetaMessage['content'], 'end_turn'),
    );
    useAssistantKeepingConversations(follow.client);

    const second = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: { conversationId, message: `¿Y ${UPN} tiene más alertas?` },
    });

    expect(second.statusCode).toBe(201);
    const history = follow.requests[0]!.messages;
    // Turno 1 (usuario, herramientas, respuesta) + turno 2 del usuario.
    expect(history.length).toBe(5);
    const outgoing = JSON.stringify(follow.requests);
    for (const value of CLEAR_VALUES) expect(outgoing).not.toContain(value);
    expect(requests.length).toBe(2);
  });
});

/** Mismo servicio con otro cliente: conserva las conversaciones abiertas. */
function useAssistantKeepingConversations(client: AssistantModelClient) {
  const current = runtime.assistant as unknown as { options: { client?: AssistantModelClient } };
  current.options = { ...current.options, client };
}

describe('POST /api/assistant/messages · autorización', () => {
  it('sin sesión responde 401 y sin token CSRF 403, sin llamar al proveedor', async () => {
    const { client, requests } = scriptedClient(investigatingScript(alertId));
    useAssistant(client);
    const anonymous = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      payload: { message: 'hola' },
    });
    const analyst = await signIn(ANALYST_EMAIL);
    const withoutCsrf = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: { cookie: analyst.cookie },
      remoteAddress: analyst.remoteAddress,
      payload: { message: 'hola' },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(withoutCsrf.statusCode).toBe(403);
    expect(JSON.parse(withoutCsrf.body).code).toBe('REQUEST_NOT_VERIFIED');
    expect(requests).toHaveLength(0);
  });

  it.each(['auditor@qapaq.pe', 'lider@qapaq.pe'])(
    'sin assistant.use (%s) responde como recurso inexistente',
    async (username) => {
      const { client, requests } = scriptedClient(investigatingScript(alertId));
      useAssistant(client);
      const person = await signIn(username);

      const [post, status] = await Promise.all([
        server().inject({
          method: 'POST',
          url: '/api/assistant/messages',
          headers: person.mutation,
          remoteAddress: person.remoteAddress,
          payload: { message: 'hola' },
        }),
        server().inject({
          method: 'GET',
          url: '/api/assistant/status',
          headers: { cookie: person.cookie },
          remoteAddress: person.remoteAddress,
        }),
      ]);

      expect(post.statusCode).toBe(404);
      expect(JSON.parse(post.body).code).toBe('RESOURCE_UNAVAILABLE');
      expect(status.statusCode).toBe(404);
      expect(requests).toHaveLength(0);
    },
  );

  it('la conversación de otra persona no se puede continuar', async () => {
    const { client } = scriptedClient(() =>
      message([{ type: 'text', text: 'Hola.' }] as BetaMessage['content'], 'end_turn'),
    );
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);
    const admin = await signIn('admin@qapaq.pe');
    const first = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: { message: 'hola' },
    });

    const hijack = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: admin.mutation,
      remoteAddress: admin.remoteAddress,
      payload: { conversationId: JSON.parse(first.body).conversationId, message: 'continúa' },
    });

    expect(hijack.statusCode).toBe(404);
    expect(JSON.parse(hijack.body).code).toBe('RESOURCE_UNAVAILABLE');
  });

  it('las herramientas vuelven a exigir la capability de lo que leen', async () => {
    const pseudonymizer = new ConversationPseudonymizer(runtime.tenantId, refOf);
    const actor = (capabilities: readonly Capability[], tenantId = runtime.tenantId): Actor => ({
      subjectId: 'spec-actor',
      tenantId,
      sessionId: 'spec-session',
      roles: [],
      capabilities: new Set(capabilities),
    });
    const context = (subject: Actor) => ({ actor: subject, soc: runtime.soc, pseudonymizer });

    // Solo `assistant.use`: no se ofrece ni se ejecuta ninguna herramienta.
    expect(assistantToolsFor(actor(['assistant.use']))).toEqual([]);
    await expect(
      runAssistantTool('get_alert', { alert_id: alertId }, context(actor(['assistant.use']))),
    ).resolves.toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
    // Con `alerts.read` de otro tenant, la alerta no existe.
    await expect(
      runAssistantTool(
        'get_alert',
        { alert_id: alertId },
        context(actor(['alerts.read'], 'otro-tenant')),
      ),
    ).resolves.toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
    // Herramientas inexistentes, entradas con campos de más y referencias que no son opacas.
    await expect(
      runAssistantTool('triage_alert', { alert_id: alertId }, context(actor(['alerts.read']))),
    ).resolves.toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
    await expect(
      runAssistantTool(
        'get_alert',
        { alert_id: alertId, sql: '1=1' },
        context(actor(['alerts.read'])),
      ),
    ).resolves.toEqual({ ok: false, code: 'VALIDATION_FAILED' });
    await expect(
      runAssistantTool(
        'related_alerts_by_entity',
        { entity_ref: UPN },
        context(actor(['alerts.read'])),
      ),
    ).resolves.toEqual({ ok: false, code: 'VALIDATION_FAILED' });
    // El resumen solo incluye las secciones que el actor puede leer.
    const summary = await runAssistantTool('soc_summary', {}, context(actor(['incidents.read'])));
    expect(summary.ok && Object.keys(summary.content as object)).toEqual(['activeIncidents']);
  });

  it('las alertas relacionadas se piden por la referencia opaca de la entidad', async () => {
    const pseudonymizer = new ConversationPseudonymizer(runtime.tenantId, refOf);
    const subject: Actor = {
      subjectId: 'spec-actor',
      tenantId: runtime.tenantId,
      sessionId: 'spec-session',
      roles: [],
      capabilities: new Set<Capability>(['alerts.read']),
    };
    const entityRef = runtime.entityRefOf(runtime.tenantId, `user:${UPN}`)!;
    expect(entityRef).toMatch(ENTITY_REF_PATTERN);

    const result = await runAssistantTool(
      'related_alerts_by_entity',
      { entity_ref: entityRef },
      { actor: subject, soc: runtime.soc, pseudonymizer },
    );

    expect(result.ok).toBe(true);
    const content = (result as { content: { total: number } }).content;
    expect(content.total).toBeGreaterThanOrEqual(1);
    for (const value of CLEAR_VALUES) expect(JSON.stringify(content)).not.toContain(value);
  });
});

describe('POST /api/assistant/messages · configuración, topes y fallos', () => {
  it('sin API key responde FEATURE_NOT_CONFIGURED y el estado lo declara', async () => {
    useAssistant(undefined);
    const analyst = await signIn(ANALYST_EMAIL);

    const status = await server().inject({
      method: 'GET',
      url: '/api/assistant/status',
      headers: { cookie: analyst.cookie },
      remoteAddress: analyst.remoteAddress,
    });
    const post = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: { message: 'hola' },
    });

    expect(JSON.parse(status.body)).toMatchObject({
      name: 'Qapaqzito',
      configured: false,
      model: null,
    });
    expect(post.statusCode).toBe(503);
    expect(JSON.parse(post.body)).toMatchObject({ code: 'FEATURE_NOT_CONFIGURED', retriable: false });
  });

  it('el API arranca sin API key y el asistente queda sin configurar', () => {
    // El harness construye el API con el perfil de pruebas, que no declara la key.
    expect(new AssistantService({ model: 'claude-sonnet-5-5', refOf, soc: () => runtime.soc }).configured).toBe(false);
  });

  it('valida el mensaje y el contexto antes de llamar al proveedor', async () => {
    const { client, requests } = scriptedClient(investigatingScript(alertId));
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);
    const send = (payload: unknown) =>
      server().inject({
        method: 'POST',
        url: '/api/assistant/messages',
        headers: analyst.mutation,
        remoteAddress: analyst.remoteAddress,
        payload: payload as Record<string, unknown>,
      });

    const responses = await Promise.all([
      send({ message: '   ' }),
      send({ message: 'x'.repeat(ASSISTANT_LIMITS.messageMaxLength + 1) }),
      send({ message: 'hola', context: { alertId: '../../etc' } }),
      send({ message: 42 }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).code).toBe('VALIDATION_FAILED');
    }
    expect(requests).toHaveLength(0);
  });

  it('limita la tasa por persona', async () => {
    const { client } = scriptedClient(() =>
      message([{ type: 'text', text: 'ok' }] as BetaMessage['content'], 'end_turn'),
    );
    useAssistant(client, () => new Date('2026-10-27T10:00:00.000Z'));
    const analyst = await signIn(ANALYST_EMAIL);
    const send = () =>
      server().inject({
        method: 'POST',
        url: '/api/assistant/messages',
        headers: analyst.mutation,
        remoteAddress: analyst.remoteAddress,
        payload: { message: 'hola' },
      });

    for (let index = 0; index < ASSISTANT_LIMITS.rateMaxMessages; index += 1) {
      expect((await send()).statusCode).toBe(201);
    }
    const limited = await send();

    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.body).code).toBe('RATE_LIMITED');
  });

  it('corta la vuelta de herramientas en el tope de llamadas y lo declara', async () => {
    const { client, requests } = scriptedClient(() =>
      message(
        [{ type: 'tool_use', id: `toolu_${Math.random()}`, name: 'soc_summary', input: {} }] as BetaMessage['content'],
        'tool_use',
      ),
    );
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);

    const response = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: { message: 'resume el SOC' },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).reply.truncated).toBe(true);
    expect(requests).toHaveLength(ASSISTANT_LIMITS.maxModelCalls);
    // Cada llamada pide como máximo el tope de salida por llamada.
    for (const request of requests) {
      expect(request.max_tokens).toBe(ASSISTANT_LIMITS.maxOutputTokensPerCall);
    }
  });

  it('un fallo del proveedor responde DEPENDENCY_DEGRADED y queda auditado sin contenido', async () => {
    const { client } = scriptedClient(() => new AssistantModelError('ASSISTANT_PROVIDER_529'));
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);

    const response = await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: analyst.mutation,
      remoteAddress: analyst.remoteAddress,
      payload: { message: `¿Qué pasó con ${UPN}?` },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).code).toBe('DEPENDENCY_DEGRADED');
    const failed = (await memorySoc().allAudit()).filter(
      (event) => event.action === 'assistant.message' && event.outcome === 'failed',
    );
    expect(failed.at(-1)?.reason).toBe('ASSISTANT_PROVIDER_529');
  });

  it('audita cada turno con actor, correlación, herramientas y tokens, sin texto ni entidades', async () => {
    const { client } = scriptedClient(investigatingScript(alertId));
    useAssistant(client);
    const analyst = await signIn(ANALYST_EMAIL);
    const correlationId = '5f0b6a1e-8c1d-4f6a-9b2e-3c4d5e6f7a8b';

    await server().inject({
      method: 'POST',
      url: '/api/assistant/messages',
      headers: { ...analyst.mutation, 'x-correlation-id': correlationId },
      remoteAddress: analyst.remoteAddress,
      payload: { message: `Investiga ${UPN} desde ${SOURCE_IP}` },
    });

    const event = (await memorySoc().allAudit()).find(
      (entry) => entry.action === 'assistant.message' && entry.correlationId === correlationId,
    );
    expect(event).toMatchObject({
      outcome: 'succeeded',
      actor: { id: 'local-analyst-1', type: 'user' },
      resource: { type: 'assistant_conversation' },
      metadata: {
        tools: ['get_alert', 'soc_summary'],
        toolCalls: 2,
        modelCalls: 2,
        inputTokens: 2_000,
        outputTokens: 400,
      },
    });
    const sealed = JSON.stringify(event, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const value of [UPN, SOURCE_IP, HOST, 'Investiga', 'inició sesión']) {
      expect(sealed).not.toContain(value);
    }
  });
});
