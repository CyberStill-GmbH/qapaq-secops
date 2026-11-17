/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  askQapaqzito,
  askQapaqzitoStream,
  getConversation,
  listArtifacts,
  parseArtifactRef,
  parseArtifacts,
  suggestionsFor,
} from './chat_client';
import type { QapaqApiClient } from '../api/client';

const ANSWER = { reply: 'ok', outcome: 'answered', steps: [], citations: [] } as const;

function streamResponse(chunks: readonly string[]): Response {
  let index = 0;
  const reader = {
    read: jest.fn(async () => {
      const chunk = chunks[index++];
      if (chunk === undefined) return { done: true, value: undefined };
      return { done: false, value: new TextEncoder().encode(chunk) };
    }),
    releaseLock: jest.fn(),
  };
  return {
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: { getReader: () => reader },
  } as unknown as Response;
}

const ARTIFACT = {
  id: '5b1d6b9e-3b0e-4d44-9d52-0a1b2c3d4e5f',
  filename: 'QAPAQ-informe-alertas-2026-11-13-1200.pdf',
  format: 'pdf',
  title: 'Informe de alertas P1/P2',
  size: 183204,
  createdAt: '2026-11-13T17:00:00.000Z',
  expiresAt: '2026-11-14T17:00:00.000Z',
  url: '/api/assistant/artifacts/5b1d6b9e-3b0e-4d44-9d52-0a1b2c3d4e5f',
};

describe('artefactos (informes) en el stream', () => {
  it('parsea event: artifact, avisa en vivo y los une a la respuesta final', async () => {
    const onArtifact = jest.fn();
    const onProgress = jest.fn();
    const api = {
      postStream: async () =>
        streamResponse([
          'event: progress\ndata: {"type":"tool_started","label":"Generando informe PDF"}\n\n',
          `event: artifact\ndata: ${JSON.stringify(ARTIFACT)}\n\n`,
          `event: complete\ndata: ${JSON.stringify(ANSWER)}\n\n`,
        ]),
    } as unknown as QapaqApiClient;

    const reply = await askQapaqzitoStream(
      api,
      'genera un informe',
      [],
      '/app/home',
      onProgress,
      undefined,
      undefined,
      { onArtifact },
    );
    expect(onArtifact).toHaveBeenCalledTimes(1);
    expect(onArtifact).toHaveBeenCalledWith(ARTIFACT);
    // El artefacto NO es progreso de herramientas: no contamina la línea de actividad.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(reply.artifacts).toEqual([ARTIFACT]);
  });

  it('no duplica un artefacto que llega por SSE y otra vez en la respuesta final', async () => {
    const onArtifact = jest.fn();
    const api = {
      postStream: async () =>
        streamResponse([
          `event: artifact\ndata: ${JSON.stringify(ARTIFACT)}\n\n`,
          `event: complete\ndata: ${JSON.stringify({ ...ANSWER, artifacts: [ARTIFACT] })}\n\n`,
        ]),
    } as unknown as QapaqApiClient;
    const reply = await askQapaqzitoStream(api, 'q', [], '/', jest.fn(), undefined, undefined, {
      onArtifact,
    });
    expect(onArtifact).toHaveBeenCalledTimes(1);
    expect(reply.artifacts).toHaveLength(1);
  });

  it('ignora artefactos fuera de contrato sin romper la respuesta', async () => {
    const onArtifact = jest.fn();
    const api = {
      postStream: async () =>
        streamResponse([
          'event: artifact\ndata: {"id":"../../etc/passwd","format":"pdf","filename":"x.pdf","expiresAt":"2026-11-14T00:00:00Z"}\n\n',
          'event: artifact\ndata: {"id":"ok-1","format":"exe","filename":"x.exe","expiresAt":"2026-11-14T00:00:00Z"}\n\n',
          `event: complete\ndata: ${JSON.stringify(ANSWER)}\n\n`,
        ]),
    } as unknown as QapaqApiClient;
    const reply = await askQapaqzitoStream(api, 'q', [], '/', jest.fn(), undefined, undefined, {
      onArtifact,
    });
    expect(onArtifact).not.toHaveBeenCalled();
    expect(reply).toEqual(ANSWER);
  });

  it('conserva artefactos de la respuesta JSON (fallback) y descarta los inválidos', async () => {
    const api = {
      postStream: async () =>
        ({
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ ...ANSWER, artifacts: [ARTIFACT, { id: 'x' }] }),
        }) as unknown as Response,
    } as unknown as QapaqApiClient;
    const reply = await askQapaqzitoStream(api, 'q', [], '/', jest.fn());
    expect(reply.artifacts).toEqual([ARTIFACT]);

    const post = jest.fn().mockResolvedValue({ ...ANSWER, artifacts: [ARTIFACT] });
    expect((await askQapaqzito({ post } as unknown as QapaqApiClient, 'q', [], '/')).artifacts).toEqual([
      ARTIFACT,
    ]);
  });

  it('entrega fragmentos de texto (event: delta) si el servidor los envía', async () => {
    const onDelta = jest.fn();
    const api = {
      postStream: async () =>
        streamResponse([
          'event: delta\ndata: {"text":"Hola"}\n\n',
          'event: delta\ndata: {"text":" mundo"}\n\n',
          `event: complete\ndata: ${JSON.stringify(ANSWER)}\n\n`,
        ]),
    } as unknown as QapaqApiClient;
    await askQapaqzitoStream(api, 'q', [], '/', jest.fn(), undefined, undefined, { onDelta });
    expect(onDelta.mock.calls).toEqual([['Hola'], [' mundo']]);
  });

  it('parseArtifactRef exige id seguro, formato conocido y vencimiento válido', () => {
    expect(parseArtifactRef(ARTIFACT)).toEqual(ARTIFACT);
    expect(parseArtifactRef({ ...ARTIFACT, title: undefined })?.title).toBe(ARTIFACT.filename);
    expect(parseArtifactRef({ ...ARTIFACT, size: -1 })?.size).toBe(0);
    expect(parseArtifactRef({ ...ARTIFACT, expiresAt: 'ayer' })).toBeNull();
    expect(parseArtifactRef({ ...ARTIFACT, format: 'docx' })).toBeNull();
    expect(parseArtifactRef(null)).toBeNull();
    expect(parseArtifacts('no es lista')).toEqual([]);
  });

  it('listArtifacts y getConversation sanean artefactos de la API', async () => {
    const api = {
      get: jest.fn(async (path: string) =>
        path === '/assistant/artifacts'
          ? { correlationId: 'c', items: [ARTIFACT, { id: 'bad id' }] }
          : {
              id: 'c1',
              title: 't',
              createdAt: '',
              updatedAt: '',
              messages: [
                { id: 'm1', role: 'assistant', text: 'ok', artifacts: [ARTIFACT, 7] },
                { id: 'm2', role: 'user', text: 'hola' },
              ],
            },
      ),
    } as unknown as QapaqApiClient;
    expect(await listArtifacts(api)).toEqual([ARTIFACT]);
    const stored = await getConversation(api, 'c1');
    expect(stored.messages[0]?.artifacts).toEqual([ARTIFACT]);
    expect(stored.messages[1]).not.toHaveProperty('artifacts');
  });

  it('siempre ofrece 4 sugerencias, con los informes PDF y Excel', () => {
    const pages = ['/app/home', '/app/qapaq-alerts', '/app/qapaq-incidents', '/app/qapaq-sources'];
    for (const page of [...pages, '/app/qapaq-audit']) {
      const items = suggestionsFor(page);
      expect(items).toHaveLength(4);
      expect(items.map((item) => item.prompt)).toEqual(
        expect.arrayContaining([
          'Genera un informe PDF de alertas P1/P2 de las últimas 24 h',
          'Exporta a Excel las alertas abiertas de esta semana',
        ]),
      );
    }
  });
});
