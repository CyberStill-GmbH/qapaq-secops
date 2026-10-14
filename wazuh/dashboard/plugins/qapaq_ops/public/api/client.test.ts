/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { buildQuery, QapaqApiClient, QapaqApiError } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const SESSION = {
  subjectId: 'oid-1',
  displayName: 'Ana',
  email: 'ana@qapaq.pe',
  tenantId: 't',
  roles: ['qapaq.soc.analyst'],
  capabilities: ['alerts.read'],
  amr: ['mfa'],
  csrfToken: 'csrf-123',
  correlationId: 'c',
};

describe('buildQuery', () => {
  it('omite vacíos y une listas con coma', () => {
    expect(buildQuery({ status: 'open', q: '', priority: ['P1', 'P2'], cursor: null })).toBe(
      '?status=open&priority=P1%2CP2',
    );
    expect(buildQuery({})).toBe('');
  });
});

describe('QapaqApiClient', () => {
  it('las mutaciones llevan el token CSRF de la sesión y la cookie del mismo origen', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return url.endsWith('/auth/session')
        ? jsonResponse(200, SESSION)
        : jsonResponse(200, { ok: 1 });
    }) as unknown as typeof fetch;
    const client = new QapaqApiClient({ apiPrefix: '/api', basePath: '', fetchImpl });

    await client.post('/alerts/a1/commands', { name: 'acknowledge', expectedRevision: 3 });

    const [url, init] = calls[1];
    expect(url).toBe('/api/alerts/a1/commands');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'acknowledge', expectedRevision: 3 });
  });

  it('traduce el cuerpo del catálogo y conserva la referencia de correlación', async () => {
    const fetchImpl = (async () =>
      jsonResponse(409, {
        code: 'STATE_CONFLICT',
        message: 'x',
        correlationId: 'corr-9',
      })) as unknown as typeof fetch;
    const client = new QapaqApiClient({ apiPrefix: '/api', basePath: '', fetchImpl });

    await expect(client.get('/alerts/a1')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      correlationId: 'corr-9',
      message: 'El elemento cambió mientras trabajaba en él. Vuelva a cargarlo.',
    });
  });

  it('una respuesta ajena al catálogo se clasifica por estado', async () => {
    const fetchImpl = (async () => jsonResponse(502, '<html>')) as unknown as typeof fetch;
    const client = new QapaqApiClient({ apiPrefix: '/api', basePath: '', fetchImpl });
    await expect(client.get('/sources/health')).rejects.toBeInstanceOf(QapaqApiError);
    await expect(client.get('/sources/health')).rejects.toMatchObject({
      code: 'DEPENDENCY_DEGRADED',
    });
  });

  it('sin sesión lleva al login QAPAQ con el destino actual', async () => {
    const redirect = jest.fn();
    const fetchImpl = (async () =>
      jsonResponse(401, { code: 'AUTH_REQUIRED' })) as unknown as typeof fetch;
    const client = new QapaqApiClient({
      apiPrefix: '/api',
      basePath: '/dash',
      fetchImpl,
      redirect,
      currentUrl: () => '/dash/app/qapaq-alerts?id=a1',
    });

    await expect(client.get('/alerts')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(redirect).toHaveBeenCalledWith(
      '/dash/qapaq/login?nextUrl=%2Fdash%2Fapp%2Fqapaq-alerts%3Fid%3Da1',
    );
  });

  it('un fallo de red se informa como dependencia degradada, no como error interno', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    const client = new QapaqApiClient({ apiPrefix: '/api', basePath: '', fetchImpl });
    await expect(client.get('/alerts')).rejects.toMatchObject({ code: 'DEPENDENCY_DEGRADED' });
  });
});
