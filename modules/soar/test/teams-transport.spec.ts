import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTeamsMessage, FORBIDDEN_PAYLOAD_KEYS } from '../src/teams-payload.js';
import { TeamsWorkflowTransport } from '../src/teams-adapter.js';
import { clientRequestIdFor } from '../src/notification.js';

const AT = new Date('2026-10-08T09:00:00.000Z');

const message = buildTeamsMessage({
  tenantId: 'tenant-1',
  messageType: 'soc.incident.opened',
  aggregateType: 'incident',
  aggregateId: 'inc-1',
  title: 'Acceso no autorizado a srv-app-01',
  severity: 'critical',
  occurredAt: AT,
  consoleBaseUrl: 'https://soc.qapaq.pe/',
  clientRequestId: clientRequestIdFor('tenant-1', 'key-1'),
});

interface Received {
  readonly clientRequestId: string | undefined;
  readonly body: string;
}

let server: Server;
let baseUrl: string;
let behaviour: (path: string) => { status: number; delayMs?: number } = () => ({ status: 202 });
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        clientRequestId: request.headers['client-request-id'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const { status, delayMs } = behaviour(request.url ?? '/');
      const reply = () => {
        response.statusCode = status;
        response.end('{}');
      };
      if (delayMs) setTimeout(reply, delayMs).unref();
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('Sin puerto.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function transport(timeoutMs = 2_000) {
  return new TeamsWorkflowTransport({
    workflowUrl: `${baseUrl}/workflow?sig=secreto-firmado`,
    destinationRef: 'teams:canal-soc',
    timeoutMs,
  });
}

describe('C-20 · carga del canal', () => {
  it('construye una tarjeta adaptativa con enlace a la consola', () => {
    const card = message.attachments[0].content as { actions: { url: string }[] };

    expect(card.actions[0]?.url).toBe('https://soc.qapaq.pe/incidents/inc-1');
    expect(message.qapaq.clientRequestId).toBe(clientRequestIdFor('tenant-1', 'key-1'));
  });

  it('no incluye crudo, identidades ni material sensible', () => {
    const serialized = JSON.stringify(message).toLowerCase();

    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      expect(serialized, `campo prohibido ${key}`).not.toContain(`"${key.toLowerCase()}"`);
    }
  });
});

describe('C-20 · transporte real sobre HTTP', () => {
  it('entrega y propaga el identificador de cliente en la cabecera', async () => {
    behaviour = () => ({ status: 202 });
    received.length = 0;

    const outcome = await transport().send(message, message.qapaq.clientRequestId);

    expect(outcome).toMatchObject({ delivered: true, httpStatus: 202 });
    expect(received[0]?.clientRequestId).toBe(message.qapaq.clientRequestId);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: 'message' });
  });

  it('clasifica 429 y 500 como transitorios', async () => {
    for (const status of [429, 500]) {
      behaviour = () => ({ status });
      const outcome = await transport().send(message, message.qapaq.clientRequestId);

      expect(outcome.failure).toMatchObject({ class: 'transient', httpStatus: status });
    }
  });

  it('clasifica 503 y 504 como ambiguos', async () => {
    for (const status of [503, 504]) {
      behaviour = () => ({ status });
      const outcome = await transport().send(message, message.qapaq.clientRequestId);

      expect(outcome.failure?.class, `estado ${status}`).toBe('ambiguous');
    }
  });

  it('clasifica 400 y 403 como permanentes', async () => {
    for (const status of [400, 403]) {
      behaviour = () => ({ status });
      const outcome = await transport().send(message, message.qapaq.clientRequestId);

      expect(outcome.failure?.class, `estado ${status}`).toBe('permanent');
    }
  });

  it('trata el timeout como ambiguo, no como fallo de entrega', async () => {
    behaviour = () => ({ status: 202, delayMs: 300 });

    const outcome = await transport(80).send(message, message.qapaq.clientRequestId);

    expect(outcome.delivered).toBe(false);
    expect(outcome.failure).toMatchObject({ class: 'ambiguous', code: 'REQUEST_TIMEOUT' });
  });

  it('no filtra la URL firmada del workflow en el error', async () => {
    behaviour = () => ({ status: 403 });

    const outcome = await transport().send(message, message.qapaq.clientRequestId);

    expect(JSON.stringify(outcome)).not.toContain('secreto-firmado');
  });

  it('marca como transitorio un destino inaccesible', async () => {
    const unreachable = new TeamsWorkflowTransport({
      workflowUrl: 'http://127.0.0.1:1/workflow',
      destinationRef: 'teams:canal-soc',
      timeoutMs: 1_000,
    });

    const outcome = await unreachable.send(message, message.qapaq.clientRequestId);

    expect(outcome.delivered).toBe(false);
    expect(outcome.failure?.class).toBe('transient');
  });
});
