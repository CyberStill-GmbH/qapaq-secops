/**
 * Adapter de reputación por hash con fixtures sintéticos: ninguna prueba sale a la red.
 */

import { describe, expect, it } from 'vitest';

import {
  createVirusTotalFileReputationProvider,
  FileReputationProviderError,
  type FileReputationErrorCode,
} from '../src/public/index.js';

const KEY = 'a1'.repeat(32);
const SHA256 = 'ab'.repeat(32);
const MD5 = '0f'.repeat(16);

function report(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: SHA256,
      type: 'file',
      links: { self: `https://www.virustotal.com/api/v3/files/${SHA256}` },
      attributes: {
        first_submission_date: 1_600_000_000,
        last_analysis_date: 1_760_000_000,
        last_analysis_stats: {
          malicious: 5,
          suspicious: 1,
          undetected: 60,
          harmless: 4,
          timeout: 2,
          'type-unsupported': 7,
          failure: 1,
        },
        popular_threat_classification: {
          suggested_threat_label: 'ransomware.synthetic/lab',
          popular_threat_category: [
            { count: 9, value: 'ransomware' },
            { count: 2, value: 'trojan' },
          ],
          popular_threat_name: [{ count: 4, value: 'synthetic' }, { value: '<script>' }],
        },
        names: ['no-debe-salir.exe'],
        ...overrides,
      },
    },
  };
}

function providerWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = createVirusTotalFileReputationProvider({
    apiKey: KEY,
    timeoutMs: 200,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    },
  });
  return { provider, calls };
}

async function failureOf(promise: Promise<unknown>): Promise<FileReputationProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FileReputationProviderError) return error;
    throw error;
  }
  throw new Error('se esperaba un FileReputationProviderError');
}

describe('reputación por hash · consulta', () => {
  it('hace un único GET al endpoint de archivos con la clave en cabecera', async () => {
    const { provider, calls } = providerWith(() => Response.json(report()));
    await provider.lookup({ algorithm: 'sha256', value: SHA256 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://www.virustotal.com/api/v3/files/${SHA256}`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.redirect).toBe('error');
    expect(new Headers(calls[0]!.init.headers).get('x-apikey')).toBe(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
  });

  it('normaliza detecciones, fechas, etiquetas y enlace a la ficha pública', async () => {
    const { provider } = providerWith(() => Response.json(report()));
    const result = await provider.lookup({ algorithm: 'md5', value: MD5 });

    expect(result).toEqual({
      status: 'found',
      reputation: {
        detections: 6,
        // Solo motores con veredicto: timeouts, fallos y tipos no soportados no cuentan.
        engines: 70,
        firstSeenAt: '2020-09-13T12:26:40.000Z',
        lastAnalysisAt: '2025-10-09T08:53:20.000Z',
        threatLabels: ['ransomware.synthetic/lab', 'ransomware', 'trojan', 'synthetic', 'script'],
        // Se busca por MD5, pero la ficha se enlaza por el SHA-256 del reporte.
        reportUrl: `https://www.virustotal.com/gui/file/${SHA256}`,
      },
    });
    expect(JSON.stringify(result)).not.toContain('no-debe-salir');
  });

  it('acota las etiquetas y tolera fechas ausentes', async () => {
    const { provider } = providerWith(() =>
      Response.json(
        report({
          first_submission_date: undefined,
          last_analysis_date: -5,
          popular_threat_classification: {
            popular_threat_name: Array.from({ length: 20 }, (_, index) => ({
              value: `familia-${index}-${'x'.repeat(80)}`,
            })),
          },
        }),
      ),
    );
    const result = await provider.lookup({ algorithm: 'sha256', value: SHA256 });

    if (result.status !== 'found') throw new Error('se esperaba found');
    expect(result.reputation.firstSeenAt).toBeNull();
    expect(result.reputation.lastAnalysisAt).toBeNull();
    expect(result.reputation.threatLabels).toHaveLength(10);
    for (const label of result.reputation.threatLabels)
      expect(label.length).toBeLessThanOrEqual(64);
  });

  it('un 404 es hash desconocido, no un error', async () => {
    const { provider } = providerWith(() =>
      Response.json({ error: { code: 'NotFoundError', message: 'x' } }, { status: 404 }),
    );
    await expect(provider.lookup({ algorithm: 'sha256', value: SHA256 })).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('rechaza un hash mal formado sin salir a la red', async () => {
    const { provider, calls } = providerWith(() => Response.json(report()));
    for (const value of [`${SHA256}/../../urls`, 'AB'.repeat(32), 'zz'.repeat(32), MD5]) {
      const error = await failureOf(provider.lookup({ algorithm: 'sha256', value }));
      expect(error.code).toBe('REPUTATION_QUERY_REJECTED');
    }
    expect(calls).toHaveLength(0);
  });

  it('no se construye con una clave con forma inválida', () => {
    expect(() => createVirusTotalFileReputationProvider({ apiKey: 'clave con espacios' })).toThrow(
      FileReputationProviderError,
    );
  });
});

describe('reputación por hash · fallos', () => {
  it.each<[number, FileReputationErrorCode, boolean]>([
    [401, 'REPUTATION_AUTHENTICATION_FAILED', false],
    [403, 'REPUTATION_AUTHENTICATION_FAILED', false],
    [429, 'REPUTATION_RATE_LIMITED', true],
    [400, 'REPUTATION_QUERY_REJECTED', false],
    [500, 'REPUTATION_UNAVAILABLE', true],
    [503, 'REPUTATION_UNAVAILABLE', true],
  ])('HTTP %i → %s', async (status, code, retryable) => {
    const { provider } = providerWith(
      () => new Response('{}', { status, headers: { 'retry-after': '30' } }),
    );
    const error = await failureOf(provider.lookup({ algorithm: 'sha256', value: SHA256 }));

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    if (status === 429) expect(error.retryAfterMs).toBe(30_000);
  });

  it('un error de red es servicio no disponible', async () => {
    const { provider } = providerWith(() => {
      throw new TypeError('fetch failed');
    });
    const error = await failureOf(provider.lookup({ algorithm: 'sha256', value: SHA256 }));
    expect(error.code).toBe('REPUTATION_UNAVAILABLE');
  });

  it('corta por timeout', async () => {
    const { provider } = providerWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const error = await failureOf(provider.lookup({ algorithm: 'sha256', value: SHA256 }));
    expect(error.code).toBe('REPUTATION_TIMEOUT');
  });

  it('rechaza respuestas que no son un reporte de archivo o que exceden el tamaño', async () => {
    const malformed = providerWith(() => new Response('<html>', { status: 200 }));
    const wrongShape = providerWith(() => Response.json({ data: { type: 'url', attributes: {} } }));
    const oversized = providerWith(
      () =>
        new Response('{}', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }),
    );

    for (const { provider } of [malformed, wrongShape, oversized]) {
      const error = await failureOf(provider.lookup({ algorithm: 'sha256', value: SHA256 }));
      expect(error.code).toBe('REPUTATION_RESPONSE_INVALID');
    }
  });
});
