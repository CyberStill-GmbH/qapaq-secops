/**
 * Historial de conversaciones de Qapaqzito por HTTP: crear, continuar, listar, leer, renombrar y
 * borrar; aislamiento por dueño (ni un administrador ve lo ajeno), CSRF, paginación, historial
 * apagado, retención y que el historial guardado reemplace al que envía el cliente.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  DEFAULT_ASSISTANT_LIMITS,
  InMemoryConversationStore,
  type AssistantModel,
  type ConversationStore,
  type ModelRequest,
} from '@qapaq/assistant';

import { buildApi } from '../src/bootstrap.js';
import {
  AssistantConfigError,
  loadAssistantHistoryConfig,
} from '../src/assistant/assistant-config.js';
import {
  SlidingWindowLimiter,
  createAssistantService,
} from '../src/assistant/assistant-service.js';
import {
  ConversationHistory,
  assistantConversationStoreFor,
} from '../src/assistant/conversation-history.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

describe('configuración del historial de Qapaqzito', () => {
  it('activo por defecto con 90 días de retención', () => {
    expect(loadAssistantHistoryConfig({})).toEqual({ enabled: true, retentionDays: 90 });
    expect(
      loadAssistantHistoryConfig({
        QAPAQ_QAPAQZITO_HISTORY_ENABLED: 'false',
        QAPAQ_QAPAQZITO_RETENTION_DAYS: '365',
      }),
    ).toEqual({ enabled: false, retentionDays: 365 });
    expect(loadAssistantHistoryConfig({ QAPAQ_QAPAQZITO_RETENTION_DAYS: '1' }).retentionDays).toBe(1);
  });

  it('rechaza valores inválidos', () => {
    for (const env of [
      { QAPAQ_QAPAQZITO_HISTORY_ENABLED: 'si' },
      { QAPAQ_QAPAQZITO_RETENTION_DAYS: '0' },
      { QAPAQ_QAPAQZITO_RETENTION_DAYS: '366' },
      { QAPAQ_QAPAQZITO_RETENTION_DAYS: '30.5' },
      { QAPAQ_QAPAQZITO_RETENTION_DAYS: '-1' },
      { QAPAQ_QAPAQZITO_RETENTION_DAYS: 'noventa' },
    ]) {
      expect(() => loadAssistantHistoryConfig(env)).toThrow(AssistantConfigError);
    }
  });

  it('el servicio solo lleva historial si está activo y hay almacén', async () => {
    const env = { QAPAQ_QAPAQZITO_ENABLED: 'true', AWS_REGION: 'us-east-1' };
    const model = () => ({}) as AssistantModel;
    const store = await assistantConversationStoreFor(env);
    expect(store).toBeInstanceOf(InMemoryConversationStore);
    expect(createAssistantService(env, model, store)?.history?.retentionDays).toBe(90);
    expect(createAssistantService(env, model)?.history).toBeUndefined();
    const off = { ...env, QAPAQ_QAPAQZITO_HISTORY_ENABLED: 'false' };
    expect(await assistantConversationStoreFor(off)).toBeUndefined();
    expect(createAssistantService(off, model, store)?.history).toBeUndefined();
    expect(await assistantConversationStoreFor({})).toBeUndefined();
  });

  it('selecciona el presupuesto del turno desde el entorno validado por el entrypoint', () => {
    const model = () => ({}) as AssistantModel;
    const ec2 = createAssistantService(
      { QAPAQ_QAPAQZITO_ENABLED: 'true', AWS_REGION: 'us-east-1' },
      model,
    );
    const lambda = createAssistantService(
      {
        QAPAQ_QAPAQZITO_ENABLED: 'true',
        AWS_REGION: 'us-east-1',
        AWS_LAMBDA_FUNCTION_NAME: 'qapaq-api',
      },
      model,
    );
    expect(ec2?.limits.deadlineMs).toBe(55_000);
    expect(lambda?.limits).toBe(DEFAULT_ASSISTANT_LIMITS);
  });
});

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
let stop: () => Promise<void>;
let officeIp = '10.20.200.1';
let sequence = 0;
/** Lo que el modelo recibió en la última llamada (para verificar el historial usado). */
let lastRequest: ModelRequest | undefined;

function server() {
  return application.getHttpAdapter().getInstance();
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
  const cookie =
    cookiesOf(response)
      .find((value) => value.startsWith('qapaq_session='))
      ?.split(';', 1)[0] ?? '';
  const session = await server().inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie },
    remoteAddress: officeIp,
  });
  const csrf = JSON.parse(session.body).csrfToken as string;
  expect(cookie).not.toBe('');
  return { cookie, csrf };
}

type Person = Awaited<ReturnType<typeof signIn>>;

function request(
  person: Person,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  withCsrf = true,
) {
  return server().inject({
    method,
    url,
    remoteAddress: officeIp,
    headers: {
      cookie: person.cookie,
      ...(withCsrf && method !== 'GET' ? { 'x-csrf-token': person.csrf } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

function ask(person: Person, message: string, extra: Record<string, unknown> = {}) {
  return request(person, 'POST', '/api/assistant/chat', { message, ...extra });
}

/** Modelo falso: responde sin herramientas y deja ver qué historial recibió. */
const model: AssistantModel = {
  async complete(modelRequest) {
    lastRequest = modelRequest;
    return {
      content: [{ type: 'text', text: `Respuesta ${modelRequest.messages.length}` }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};

function enableQapaqzito(
  store: ConversationStore | undefined,
  retentionDays = 90,
  selectedModel: AssistantModel = model,
) {
  runtime.assistant = {
    config: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'medium',
      redactPii: true,
      apiKey: 'test',
      rateLimit: { max: 100, windowMs: 60_000 },
    },
    limiter: new SlidingWindowLimiter(100, 60_000),
    model: selectedModel,
    ...(store ? { history: new ConversationHistory(store, retentionDays, 0) } : {}),
  };
}

async function auditActions(action: string) {
  const page = await runtime.audit.read({
    tenantId: runtime.tenantId,
    from: new Date(Date.now() - 3_600_000),
    to: new Date(Date.now() + 3_600_000),
    pageSize: 200,
    cursor: null,
    action,
    actorId: null,
    resourceType: null,
    resourceId: null,
    outcome: [],
    includeSensitive: true,
  });
  return page.events;
}

beforeAll(async () => {
  const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
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
  sequence += 1;
  officeIp = `10.20.${200 + Math.floor(sequence / 250)}.${(sequence % 250) + 1}`;
  lastRequest = undefined;
});

describe('Qapaqzito · historial de conversaciones', () => {
  const privateThinking = 'PRIVATE_MODEL_THINKING_SENTINEL ana@qapaq.pe';
  const modelWithThinking: AssistantModel = {
    async complete() {
      return {
        content: [
          { type: 'thinking', thinking: privateThinking, signature: 'private-signature' },
          { type: 'text', text: 'Respuesta revisable con evidencia.' },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  it('no expone ni persiste thinking en POST ni en el historial', async () => {
    const store = new InMemoryConversationStore();
    enableQapaqzito(store, 90, modelWithThinking);
    const analyst = await signIn('analista@qapaq.pe');

    const posted = await ask(analyst, 'Revisa a ana@qapaq.pe');
    expect(posted.statusCode).toBe(200);
    const response = JSON.parse(posted.body);
    expect(response).not.toHaveProperty('reasoning');
    expect(posted.body).not.toContain(privateThinking);
    expect(posted.body).not.toContain('private-signature');

    const owner = { tenantId: runtime.tenantId, ownerId: 'local-analyst-1' };
    const saved = await store.get(owner, response.conversationId);
    expect(saved?.messages[1]).not.toHaveProperty('reasoning');
    expect(JSON.stringify(saved?.messages)).not.toContain(privateThinking);

    const history = await request(
      analyst,
      'GET',
      `/api/assistant/conversations/${response.conversationId}`,
    );
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(privateThinking);
    expect(JSON.parse(history.body).messages[1]).not.toHaveProperty('reasoning');
  });

  it('el SSE expone progreso curado y resultado, nunca bloques thinking', async () => {
    enableQapaqzito(undefined, 90, modelWithThinking);
    const analyst = await signIn('analista@qapaq.pe');

    const streamed = await request(analyst, 'POST', '/api/assistant/chat/stream', {
      message: 'Revisa a ana@qapaq.pe',
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toContain('text/event-stream');
    expect(streamed.body).toContain('event: progress');
    expect(streamed.body).toContain('"type":"model_started"');
    expect(streamed.body).toContain('event: complete');
    expect(streamed.body).toContain('Respuesta revisable con evidencia.');
    expect(streamed.body).not.toContain(privateThinking);
    expect(streamed.body).not.toContain('private-signature');
    expect(streamed.body).not.toContain('"reasoning"');
  });

  it('crea, continúa, lista, lee, renombra y borra; el guardado reemplaza al historial del cliente', async () => {
    enableQapaqzito(new InMemoryConversationStore());
    const analyst = await signIn('analista@qapaq.pe');

    const first = await ask(analyst, '¿Qué alertas\nP1 hay abiertas hoy?', {
      history: [
        { role: 'user', content: 'contexto del cliente' },
        { role: 'assistant', content: 'ok' },
      ],
    });
    expect(first.statusCode).toBe(200);
    const created = JSON.parse(first.body);
    expect(created).toMatchObject({ saved: true, title: '¿Qué alertas P1 hay abiertas hoy?' });
    expect(created.conversationId).toMatch(/^[0-9a-f-]{36}$/u);

    // Con conversationId el servidor usa lo guardado e ignora lo que mande el cliente.
    const second = await ask(analyst, 'y ¿las P2?', {
      conversationId: created.conversationId,
      history: [{ role: 'user', content: 'INYECTADO por el cliente' }],
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toMatchObject({
      conversationId: created.conversationId,
      title: created.title,
      saved: true,
    });
    const sent = JSON.stringify(lastRequest?.messages);
    expect(sent).toContain('¿Qué alertas');
    expect(sent).not.toContain('INYECTADO');
    expect(sent).not.toContain('contexto del cliente');

    const list = JSON.parse((await request(analyst, 'GET', '/api/assistant/conversations')).body);
    expect(list.items).toEqual([
      {
        id: created.conversationId,
        title: created.title,
        updatedAt: expect.any(String),
        messageCount: 4,
      },
    ]);
    expect(list.nextCursor).toBeNull();

    const detail = await request(
      analyst,
      'GET',
      `/api/assistant/conversations/${created.conversationId}`,
    );
    expect(detail.statusCode).toBe(200);
    const body = JSON.parse(detail.body);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(body.messages[1]).toMatchObject({
      text: 'Respuesta 1',
      steps: [],
      citations: [],
      createdAt: expect.any(String),
    });
    expect(body.messages[1]).not.toHaveProperty('reasoning');

    const renamed = await request(
      analyst,
      'PATCH',
      `/api/assistant/conversations/${created.conversationId}`,
      { title: '  Revisión\nP1 ' },
    );
    expect(renamed.statusCode).toBe(200);
    expect(JSON.parse(renamed.body).title).toBe('Revisión P1');
    expect(
      (
        await request(analyst, 'PATCH', `/api/assistant/conversations/${created.conversationId}`, {
          title: 'x'.repeat(81),
        })
      ).statusCode,
    ).toBe(422);

    const removed = await request(
      analyst,
      'DELETE',
      `/api/assistant/conversations/${created.conversationId}`,
    );
    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(removed.body).deleted).toBe(1);
    expect(
      (await request(analyst, 'GET', `/api/assistant/conversations/${created.conversationId}`))
        .statusCode,
    ).toBe(404);
    // Continuar una conversación borrada responde como inexistente.
    expect(
      (await ask(analyst, 'sigo', { conversationId: created.conversationId })).statusCode,
    ).toBe(404);

    const deletes = await auditActions('assistant.conversation.delete');
    const mine = deletes.filter((event) => event.resource.id === created.conversationId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.metadata).toEqual({ count: 1 });
    // La auditoría no lleva texto de la conversación.
    expect(JSON.stringify(deletes, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(
      /alertas|Revisión/u,
    );
  });

  it('guarda la valoración 👍/👎 de una respuesta con la conversación y la audita sin texto', async () => {
    enableQapaqzito(new InMemoryConversationStore());
    const analyst = await signIn('analista@qapaq.pe');
    const created = JSON.parse((await ask(analyst, '¿Hay alertas P1?')).body);
    expect(created.messageId).toMatch(/^[0-9a-f-]{36}$/u);
    const url = `/api/assistant/conversations/${created.conversationId}/messages/${created.messageId}/feedback`;
    expect((await request(analyst, 'PUT', url, { rating: 'meh' })).statusCode).toBe(422);
    expect((await request(analyst, 'PUT', url, { rating: 'down' }, false)).statusCode).toBe(403);
    const rated = await request(analyst, 'PUT', url, { rating: 'down' });
    expect(rated.statusCode).toBe(200);
    expect(JSON.parse(rated.body)).toMatchObject({ rating: 'down' });
    const detail = JSON.parse(
      (await request(analyst, 'GET', `/api/assistant/conversations/${created.conversationId}`))
        .body,
    );
    expect(detail.messages[1]).toMatchObject({ id: created.messageId, feedback: 'down' });
    const stranger = await signIn('lider@qapaq.pe');
    expect((await request(stranger, 'PUT', url, { rating: 'up' })).statusCode).toBe(404);
    const audited = await auditActions('assistant.feedback');
    expect(audited.at(-1)).toMatchObject({ metadata: { rating: 'down' } });
    expect(
      JSON.stringify(audited, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain('¿Hay alertas P1?');
  });

  it('nadie más que el dueño ve, continúa, renombra o borra una conversación, ni un administrador', async () => {
    enableQapaqzito(new InMemoryConversationStore());
    const analyst = await signIn('analista@qapaq.pe');
    const lead = await signIn('lider@qapaq.pe');
    const admin = await signIn('admin@qapaq.pe');
    const created = JSON.parse((await ask(analyst, 'secreto de Ana')).body);
    const url = `/api/assistant/conversations/${created.conversationId}`;
    // El administrador sí usa Qapaqzito (no es un 404 por falta de permisos): solo no ve lo ajeno.
    expect(JSON.parse((await ask(admin, 'lo mío')).body).saved).toBe(true);

    for (const stranger of [lead, admin]) {
      const read = await request(stranger, 'GET', url);
      expect(read.statusCode).toBe(404);
      expect(JSON.parse(read.body).code).toBe('RESOURCE_UNAVAILABLE');
      expect(
        (await ask(stranger, 'continúo lo ajeno', { conversationId: created.conversationId }))
          .statusCode,
      ).toBe(404);
      expect((await request(stranger, 'PATCH', url, { title: 'mío' })).statusCode).toBe(404);
      expect((await request(stranger, 'DELETE', url)).statusCode).toBe(404);
      const list = JSON.parse(
        (await request(stranger, 'GET', '/api/assistant/conversations')).body,
      );
      expect(JSON.stringify(list.items)).not.toContain(created.conversationId);
      // Borrar "todo lo mío" no toca lo ajeno.
      await request(stranger, 'DELETE', '/api/assistant/conversations');
    }
    // Un id inexistente responde igual que uno ajeno (sin enumerar).
    const missing = await request(
      lead,
      'GET',
      '/api/assistant/conversations/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.statusCode).toBe(404);
    expect((await request(lead, 'GET', '/api/assistant/conversations/no-es-uuid')).statusCode).toBe(
      404,
    );

    const detail = JSON.parse((await request(analyst, 'GET', url)).body);
    expect(detail.title).toBe('secreto de Ana');
    expect(detail.messages).toHaveLength(2);
  });

  it('las mutaciones exigen CSRF y todo exige sesión', async () => {
    enableQapaqzito(new InMemoryConversationStore());
    const analyst = await signIn('analista@qapaq.pe');
    const created = JSON.parse((await ask(analyst, 'hola')).body);
    const url = `/api/assistant/conversations/${created.conversationId}`;
    expect((await request(analyst, 'PATCH', url, { title: 'x' }, false)).statusCode).toBe(403);
    expect((await request(analyst, 'DELETE', url, undefined, false)).statusCode).toBe(403);
    expect(
      (await request(analyst, 'DELETE', '/api/assistant/conversations', undefined, false))
        .statusCode,
    ).toBe(403);
    const anonymous = await server().inject({
      method: 'GET',
      url: '/api/assistant/conversations',
      remoteAddress: officeIp,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await request(analyst, 'GET', url)).statusCode).toBe(200);
  });

  it('valida conversationId y pagina el listado por cursor', async () => {
    enableQapaqzito(new InMemoryConversationStore());
    const analyst = await signIn('analista@qapaq.pe');
    expect((await ask(analyst, 'hola', { conversationId: 'no-es-uuid' })).statusCode).toBe(422);
    for (let index = 0; index < 5; index += 1) {
      expect((await ask(analyst, `pregunta ${index}`)).statusCode).toBe(200);
    }
    const first = JSON.parse(
      (await request(analyst, 'GET', '/api/assistant/conversations?pageSize=2')).body,
    );
    expect(first.items).toHaveLength(2);
    const second = JSON.parse(
      (
        await request(
          analyst,
          'GET',
          `/api/assistant/conversations?pageSize=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).body,
    );
    const third = JSON.parse(
      (
        await request(
          analyst,
          'GET',
          `/api/assistant/conversations?pageSize=2&cursor=${encodeURIComponent(second.nextCursor)}`,
        )
      ).body,
    );
    const paged = [...first.items, ...second.items, ...third.items];
    const whole = JSON.parse(
      (await request(analyst, 'GET', '/api/assistant/conversations')).body,
    ).items;
    // Mismo orden que el listado completo (más recientes primero), sin duplicar ni perder.
    expect(paged).toEqual(whole);
    expect(new Set(paged.map((item: { id: string }) => item.id)).size).toBe(5);
    for (let index = 1; index < paged.length; index += 1) {
      expect(paged[index - 1].updatedAt >= paged[index].updatedAt).toBe(true);
    }
    expect(third.nextCursor).toBeNull();
    expect(
      (await request(analyst, 'GET', '/api/assistant/conversations?pageSize=500')).statusCode,
    ).toBe(422);

    const all = await request(analyst, 'DELETE', '/api/assistant/conversations');
    expect(JSON.parse(all.body).deleted).toBe(5);
    expect(
      JSON.parse((await request(analyst, 'GET', '/api/assistant/conversations')).body).items,
    ).toEqual([]);
  });

  it('con el historial apagado el chat funciona sin guardar y los endpoints responden 404', async () => {
    enableQapaqzito(undefined);
    const analyst = await signIn('analista@qapaq.pe');
    const reply = await ask(analyst, 'hola', {
      history: [
        { role: 'user', content: 'pregunta previa' },
        { role: 'assistant', content: 'respuesta previa' },
      ],
    });
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({
      saved: false,
      conversationId: null,
      title: null,
    });
    // Sin historial, el del cliente sigue sirviendo (compatibilidad).
    expect(JSON.stringify(lastRequest?.messages)).toContain('pregunta previa');
    expect((await request(analyst, 'GET', '/api/assistant/conversations')).statusCode).toBe(404);
    expect(
      (
        await ask(analyst, 'sigo', {
          conversationId: '00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
    const config = JSON.parse((await request(analyst, 'GET', '/api/assistant/config')).body);
    expect(config).toMatchObject({ enabled: true, history: false });
  });

  it('si falla el guardado, la respuesta sale igual con saved: false', async () => {
    const store = new InMemoryConversationStore();
    store.create = async () => {
      throw new Error('base caída');
    };
    enableQapaqzito(store);
    const analyst = await signIn('analista@qapaq.pe');
    const reply = await ask(analyst, 'hola');
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({
      reply: 'Respuesta 1',
      saved: false,
      conversationId: null,
    });
  });

  it('una conversación llena (200 mensajes) se rechaza antes de llamar al modelo', async () => {
    const store = new InMemoryConversationStore();
    enableQapaqzito(store);
    const analyst = await signIn('analista@qapaq.pe');
    const created = JSON.parse((await ask(analyst, 'hola')).body);
    const owner = { tenantId: runtime.tenantId, ownerId: 'local-analyst-1' };
    for (let index = 0; index < 99; index += 1) {
      await store.append(
        owner,
        created.conversationId,
        [
          { id: `u${index}`, role: 'user', text: 'p', createdAt: new Date() },
          { id: `a${index}`, role: 'assistant', text: 'r', createdAt: new Date() },
        ],
        new Date(),
      );
    }
    lastRequest = undefined;
    const full = await ask(analyst, 'una más', { conversationId: created.conversationId });
    expect(full.statusCode).toBe(422);
    expect(JSON.parse(full.body).fields).toEqual(['messageLimit']);
    expect(lastRequest).toBeUndefined();
  });

  it('la retención purga de verdad lo inactivo y lo audita con conteos', async () => {
    const store = new InMemoryConversationStore();
    enableQapaqzito(store, 30);
    const analyst = await signIn('analista@qapaq.pe');
    const owner = { tenantId: runtime.tenantId, ownerId: 'local-analyst-1' };
    const old = new Date(runtime.now().getTime() - 31 * 86_400_000);
    await store.create(owner, {
      id: '00000000-0000-4000-8000-0000000000aa',
      title: 'vieja',
      createdAt: old,
      messages: [{ id: 'm1', role: 'user', text: 'antigua', createdAt: old }],
    });
    const recent = JSON.parse((await ask(analyst, 'reciente')).body);
    const list = JSON.parse((await request(analyst, 'GET', '/api/assistant/conversations')).body);
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([recent.conversationId]);
    expect(await store.get(owner, '00000000-0000-4000-8000-0000000000aa')).toBeUndefined();
    const purges = await auditActions('assistant.conversation.purge');
    expect(purges.some((event) => event.metadata?.['count'] === 1)).toBe(true);
    expect(
      JSON.stringify(purges, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain('antigua');
  });
});
