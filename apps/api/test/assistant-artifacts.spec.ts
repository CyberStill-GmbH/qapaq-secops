/**
 * Informes de Qapaqzito por HTTP: evento SSE `artifact`, `artifacts` en la respuesta JSON y en el
 * historial, listado y descarga solo del dueño (404 neutro), cabeceras de descarga y auditoría
 * sin contenido.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ArtifactVault,
  InMemoryArtifactStore,
  InMemoryConversationStore,
  type AssistantModel,
  type ModelRequest,
} from '@qapaq/assistant';

import { buildApi } from '../src/bootstrap.js';
import { ConversationHistory } from '../src/assistant/conversation-history.js';
import { SlidingWindowLimiter } from '../src/assistant/assistant-service.js';
import type { ReportSpec, ReportsClient } from '../src/assistant/reports-client.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
let stop: () => Promise<void>;
let officeIp = '10.20.200.1';
let sequence = 0;
const clock = { now: new Date() };
const SECRET_BYTES = 'CONTENIDO-SECRETO-DEL-INFORME';
const PDF = new TextEncoder().encode(`%PDF-1.7 ${SECRET_BYTES}`);
const rendered: ReportSpec[] = [];

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
  expect(cookie).not.toBe('');
  return { cookie, csrf: JSON.parse(session.body).csrfToken as string };
}

type Person = Awaited<ReturnType<typeof signIn>>;

function call(
  person: Person,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) {
  return server().inject({
    method,
    url,
    remoteAddress: officeIp,
    headers: {
      cookie: person.cookie,
      ...(method !== 'GET' ? { 'x-csrf-token': person.csrf } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

/** Modelo falso: pide un informe de alertas y luego responde con un resumen corto. */
const reportingModel: AssistantModel = {
  async complete(request: ModelRequest) {
    const done = request.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
    );
    if (done) {
      return {
        content: [{ type: 'text', text: 'Listo: el informe queda adjunto.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      content: [
        {
          type: 'tool_use',
          id: 'tu_report',
          name: 'generate_report',
          input: {
            format: 'pdf',
            kind: 'alerts',
            title: 'Informe de prueba',
            narrative: { executiveSummary: 'Resumen' },
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};

const fakeReports: ReportsClient = {
  async render(spec) {
    rendered.push(spec);
    return { bytes: PDF, contentType: 'application/pdf', pages: 2 };
  },
};

function enableQapaqzito(options: { reports?: ReportsClient | undefined; withHistory?: boolean } = {}) {
  const vault = new ArtifactVault(new InMemoryArtifactStore(), () => clock.now);
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
    model: reportingModel,
    artifacts: vault,
    ...(options.reports === undefined && !('reports' in options) ? { reports: fakeReports } : {}),
    ...(options.reports ? { reports: options.reports } : {}),
    ...(options.withHistory === false
      ? {}
      : { history: new ConversationHistory(new InMemoryConversationStore(), 90, 0) }),
  };
  return vault;
}

async function auditEvents(action: string) {
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
  clock.now = new Date();
  rendered.length = 0;
});

describe('Qapaqzito · informes y artefactos', () => {
  it('el SSE emite `artifact` en cuanto se guarda, antes de `complete`, y la respuesta lo incluye', async () => {
    enableQapaqzito();
    const analyst = await signIn('analista@qapaq.pe');

    const streamed = await call(analyst, 'POST', '/api/assistant/chat/stream', {
      message: 'Hazme un informe PDF de las alertas de la semana',
    });
    expect(streamed.statusCode).toBe(200);
    const body = streamed.body;
    expect(body).toContain('"label":"Generando informe PDF"');
    const artifactAt = body.indexOf('event: artifact');
    expect(artifactAt).toBeGreaterThan(-1);
    expect(artifactAt).toBeLessThan(body.indexOf('event: complete'));
    const artifactData = /event: artifact\ndata: (.+)\n/u.exec(body)?.[1] ?? '{}';
    const ref = JSON.parse(artifactData);
    expect(ref).toMatchObject({ format: 'pdf', size: PDF.byteLength });
    expect(ref.url).toBe(`/api/assistant/artifacts/${ref.id}`);
    expect(ref.filename).toMatch(/^QAPAQ-informe-alertas-\d{4}-\d{2}-\d{2}-\d{4}\.pdf$/u);
    const complete = JSON.parse(/event: complete\ndata: (.+)\n/u.exec(body)?.[1] ?? '{}');
    expect(complete.artifacts).toEqual([ref]);
    expect(complete.reply).toContain('adjunto');
    // El contenido nunca viaja por el chat.
    expect(body).not.toContain(SECRET_BYTES);
    expect(rendered[0]).toMatchObject({
      kind: 'alerts',
      format: 'pdf',
      title: 'Informe de prueba',
    });
  });

  it('JSON: `artifacts` en la respuesta y en el historial guardado; descarga solo del dueño', async () => {
    const vault = enableQapaqzito();
    const ana = await signIn('analista@qapaq.pe');
    const lider = await signIn('lider@qapaq.pe');

    const asked = await call(ana, 'POST', '/api/assistant/chat', {
      message: 'Informe PDF de alertas',
    });
    expect(asked.statusCode).toBe(200);
    const reply = JSON.parse(asked.body);
    expect(reply.artifacts).toHaveLength(1);
    const [ref] = reply.artifacts;

    // Historial: el mensaje guardado conserva el enlace.
    const conversation = await call(
      ana,
      'GET',
      `/api/assistant/conversations/${reply.conversationId}`,
    );
    const messages = JSON.parse(conversation.body).messages as {
      role: string;
      artifacts?: unknown[];
    }[];
    expect(messages.find((m) => m.role === 'assistant')?.artifacts).toEqual([ref]);

    // Listado propio.
    const list = await call(ana, 'GET', '/api/assistant/artifacts');
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toMatchObject({ items: [ref] });
    expect(JSON.parse((await call(lider, 'GET', '/api/assistant/artifacts')).body).items).toEqual(
      [],
    );

    // Descarga con las cabeceras seguras.
    const file = await call(ana, 'GET', ref.url);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.toString()).toContain(SECRET_BYTES);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="${ref.filename}"; filename*=UTF-8''${ref.filename}`,
    );
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('no-store');

    // Otra persona, id inexistente y no-UUID: 404 neutro idéntico.
    const stranger = await call(lider, 'GET', ref.url);
    const missing = await call(
      ana,
      'GET',
      '/api/assistant/artifacts/00000000-0000-4000-8000-000000000000',
    );
    const malformed = await call(ana, 'GET', '/api/assistant/artifacts/no-es-uuid');
    for (const response of [stranger, missing, malformed]) expect(response.statusCode).toBe(404);
    expect(JSON.parse(stranger.body).code).toBe(JSON.parse(missing.body).code);
    expect(stranger.rawPayload.toString()).not.toContain(SECRET_BYTES);

    // Sin sesión: no autenticado.
    const anonymous = await server().inject({
      method: 'GET',
      url: ref.url,
      remoteAddress: officeIp,
    });
    expect(anonymous.statusCode).toBe(401);

    // Vencido: 404 y fuera del listado; el historial conserva la referencia.
    clock.now = new Date(Date.now() + 25 * 3_600_000);
    expect((await call(ana, 'GET', ref.url)).statusCode).toBe(404);
    expect(JSON.parse((await call(ana, 'GET', '/api/assistant/artifacts')).body).items).toEqual([]);
    expect(await vault.purgeExpired()).toBe(1);
  });

  it('audita creación y descarga con id, formato, tamaño y hash, nunca el contenido', async () => {
    enableQapaqzito();
    const ana = await signIn('analista@qapaq.pe');
    const reply = JSON.parse(
      (await call(ana, 'POST', '/api/assistant/chat', { message: 'Informe PDF' })).body,
    );
    const ref = reply.artifacts[0];
    await call(ana, 'GET', ref.url);

    const created = await auditEvents('assistant.artifact.create');
    const downloaded = await auditEvents('assistant.artifact.download');
    expect(created.some((event) => event.resource.id === ref.id)).toBe(true);
    expect(downloaded.some((event) => event.resource.id === ref.id)).toBe(true);
    const metadata = created.find((event) => event.resource.id === ref.id)?.metadata;
    expect(metadata).toMatchObject({
      kind: 'alerts',
      format: 'pdf',
      size: PDF.byteLength,
      pages: 2,
    });
    expect(String(metadata?.['sha256'])).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      JSON.stringify([created, downloaded], (_key, value) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain(SECRET_BYTES);
  });

  it('sin servicio de informes la herramienta responde unavailable y no hay artefactos', async () => {
    enableQapaqzito({ reports: undefined });
    // `reports` ausente a propósito.
    delete (runtime.assistant as { reports?: unknown }).reports;
    const ana = await signIn('analista@qapaq.pe');
    const reply = JSON.parse(
      (await call(ana, 'POST', '/api/assistant/chat', { message: 'Informe PDF' })).body,
    );
    expect(reply.artifacts).toBeUndefined();
    expect(reply.steps).toEqual([
      { tool: 'generate_report', label: 'Generando informe PDF', ok: false },
    ]);
    expect(rendered).toHaveLength(0);
  });

  it('con Qapaqzito sin almacén de archivos, los endpoints responden 404', async () => {
    enableQapaqzito();
    delete (runtime.assistant as { artifacts?: unknown }).artifacts;
    const ana = await signIn('analista@qapaq.pe');
    expect((await call(ana, 'GET', '/api/assistant/artifacts')).statusCode).toBe(404);
    expect(
      (await call(ana, 'GET', '/api/assistant/artifacts/00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
  });
});
