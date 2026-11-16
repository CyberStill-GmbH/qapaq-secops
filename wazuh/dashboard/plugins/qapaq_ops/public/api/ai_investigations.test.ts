/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { AnalystSettingsInput } from '../../common';
import {
  cancelAiRun,
  getAiBudget,
  getAiDigest,
  getAiRun,
  getAiRunReport,
  getAiSettings,
  isAnalystUnavailable,
  listAiRuns,
  retryAiRun,
  saveAiSettings,
  startAiRun,
} from './ai_investigations';
import { QapaqApiClient, QapaqApiError } from './client';

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
  capabilities: ['investigations.read', 'investigations.run'],
  amr: ['mfa'],
  csrfToken: 'csrf-123',
  correlationId: 'c',
};

const RUN = {
  id: 'run-1',
  status: 'queued',
  subject: { kind: 'alert', id: 'a-1', title: 'Alerta' },
  revision: 0,
};

const SETTINGS_INPUT: AnalystSettingsInput = {
  enabled: true,
  mode: 'assisted',
  scope: { priorities: ['P1', 'P2'], inferenceMinPriority: 'P2' },
  actions: {
    escalate: false,
    requestReview: true,
    acknowledge: false,
    closeBenign: false,
    attachReport: false,
  },
  escalation: { minConfidence: 'high', priorities: ['P1'] },
  closeBenign: { maxPriority: 'P4', minHistory: 5 },
  review: { notifyPriorities: ['P1'], notifyOnStatuses: ['failed'] },
  budget: { dailyCeilingMicroUsd: null, maxOutputTokens: 1500, advancedTierEnabled: false },
  reports: { perRun: true, digest: 'off', digestHourLima: 8 },
  instructions: '',
};

function harness(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<[string, RequestInit]> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return url.endsWith('/auth/session') ? jsonResponse(200, SESSION) : respond(url, init);
  }) as unknown as typeof fetch;
  const api = new QapaqApiClient({ apiPrefix: '/api', basePath: '', fetchImpl });
  const requests = () => calls.filter(([url]) => !url.endsWith('/auth/session'));
  return { api, requests };
}

describe('cliente del Analista IA', () => {
  it('lista con filtro, cursor y tamaño de página; ignora un estado inventado', async () => {
    const { api, requests } = harness(() =>
      jsonResponse(200, { correlationId: 'c', items: [RUN], nextCursor: null }),
    );
    const page = await listAiRuns(api, { status: 'running', cursor: 'abc/=' });
    expect(page.items[0].id).toBe('run-1');
    await listAiRuns(api, { status: 'bogus' as never });
    const urls = requests().map(([url]) => url);
    expect(urls[0]).toBe('/api/ai-investigations?status=running&cursor=abc%2F%3D&pageSize=50');
    expect(urls[1]).toBe('/api/ai-investigations?pageSize=50');
    expect(requests()[0][1].method).toBe('GET');
  });

  it('consulta presupuesto, expediente e informe en sus rutas', async () => {
    const { api, requests } = harness((url) =>
      url.endsWith('/budget')
        ? jsonResponse(200, { correlationId: 'c', mode: 'shadow', day: {} })
        : url.endsWith('/report')
          ? jsonResponse(200, {
              correlationId: 'c',
              report: { filename: 'run 1.md', markdown: '# Informe', generatedAt: null },
            })
          : jsonResponse(200, { correlationId: 'c', run: RUN }),
    );
    expect((await getAiBudget(api)).mode).toBe('shadow');
    expect((await getAiRun(api, 'run:1')).id).toBe('run-1');
    expect(await getAiRunReport(api, 'run-1')).toMatchObject({
      filename: 'run-1.md',
      markdown: '# Informe',
    });
    expect(requests().map(([url]) => url)).toEqual([
      '/api/ai-investigations/budget',
      '/api/ai-investigations/run%3A1',
      '/api/ai-investigations/run-1/report',
    ]);
  });

  it('rechaza ids inválidos y rutas literales antes de llamar al servidor', async () => {
    const { api, requests } = harness(() => jsonResponse(200, { run: RUN }));
    for (const id of ['budget', 'settings', 'digest', 'a/b', '../x', '', 'con espacio']) {
      await expect(getAiRun(api, id)).rejects.toThrow('no válido');
      await expect(cancelAiRun(api, id, 1)).rejects.toThrow('no válido');
      await expect(getAiRunReport(api, id)).rejects.toThrow('no válido');
    }
    await expect(startAiRun(api, 'a b')).rejects.toThrow('no válido');
    await expect(retryAiRun(api, 'run-1', -1)).rejects.toThrow('Revisión');
    await expect(retryAiRun(api, 'run-1', 1.5)).rejects.toThrow('Revisión');
    expect(requests()).toHaveLength(0);
  });

  it('iniciar envía alertId con CSRF y distingue creada de reutilizada', async () => {
    let created: unknown = true;
    const { api, requests } = harness(() =>
      jsonResponse(200, { correlationId: 'c', run: RUN, created }),
    );
    expect((await startAiRun(api, 'a-1')).created).toBe(true);
    created = false;
    expect((await startAiRun(api, 'a-1')).created).toBe(false);
    created = undefined;
    expect((await startAiRun(api, 'a-1')).created).toBeNull();
    const [url, init] = requests()[0];
    expect(url).toBe('/api/ai-investigations');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
    expect(JSON.parse(String(init.body))).toEqual({ alertId: 'a-1' });
  });

  it('detener y reintentar envían expectedRevision con CSRF', async () => {
    const { api, requests } = harness(() => jsonResponse(200, { correlationId: 'c', run: RUN }));
    await cancelAiRun(api, 'run-1', 7);
    await retryAiRun(api, 'run-1', 0);
    const [cancel, retry] = requests();
    expect(cancel[0]).toBe('/api/ai-investigations/run-1/cancel');
    expect(JSON.parse(String(cancel[1].body))).toEqual({ expectedRevision: 7 });
    expect((cancel[1].headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
    expect(retry[0]).toBe('/api/ai-investigations/run-1/retry');
    expect(JSON.parse(String(retry[1].body))).toEqual({ expectedRevision: 0 });
    expect(retry[1].method).toBe('POST');
  });

  it('un 2xx sin corrida legible es dependencia degradada, no éxito', async () => {
    const { api } = harness(() => jsonResponse(200, { correlationId: 'corr-1', run: {} }));
    await expect(getAiRun(api, 'run-1')).rejects.toMatchObject({
      code: 'DEPENDENCY_DEGRADED',
      correlationId: 'corr-1',
    });
  });

  it('propaga STATE_CONFLICT y reconoce el 404 como «no publicado»', async () => {
    const conflict = harness(() =>
      jsonResponse(409, { code: 'STATE_CONFLICT', correlationId: 'c9' }),
    );
    await expect(cancelAiRun(conflict.api, 'run-1', 1)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    const missing = harness(() => jsonResponse(404, '<html>'));
    const error = await listAiRuns(missing.api).catch((failure) => failure);
    expect(isAnalystUnavailable(error)).toBe(true);
    expect(isAnalystUnavailable(new QapaqApiError('INTERNAL_ERROR', 500, null))).toBe(false);
    expect(isAnalystUnavailable(new Error('x'))).toBe(false);
  });

  it('lee y guarda la configuración con PUT, CSRF y expectedRevision', async () => {
    const stored = { ...SETTINGS_INPUT, revision: 3, updatedAt: null, updatedBy: null };
    const { api, requests } = harness((_url, init) =>
      init.method === 'PUT'
        ? jsonResponse(200, { correlationId: 'c', settings: { ...stored, revision: 4 } })
        : jsonResponse(200, { correlationId: 'c', settings: stored, canConfigure: false }),
    );
    const view = await getAiSettings(api);
    expect(view.canConfigure).toBe(false);
    expect(view.settings.revision).toBe(3);
    const saved = await saveAiSettings(api, SETTINGS_INPUT, 3);
    expect(saved.settings.revision).toBe(4);
    const [url, init] = requests()[1];
    expect(url).toBe('/api/ai-investigations/settings');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
    const body = JSON.parse(String(init.body));
    expect(body.expectedRevision).toBe(3);
    expect(body.settings).toEqual(SETTINGS_INPUT);
    expect(body.settings).not.toHaveProperty('revision');
    expect(body.settings.budget.dailyCeilingMicroUsd).toBeNull();
  });

  it('una configuración ilegible no se entrega a la vista', async () => {
    const { api } = harness(() =>
      jsonResponse(200, { correlationId: 'c', settings: { mode: 'shadow' }, canConfigure: true }),
    );
    await expect(getAiSettings(api)).rejects.toMatchObject({ code: 'DEPENDENCY_DEGRADED' });
  });

  it('pide el resumen del periodo y valida las fechas antes', async () => {
    const { api, requests } = harness(() =>
      jsonResponse(200, {
        correlationId: 'c',
        digest: { from: '2026-11-07', to: '2026-11-13', totals: { runs: 3 }, markdown: '# R' },
      }),
    );
    const digest = await getAiDigest(api, '2026-11-07', '2026-11-13');
    expect(digest.totals.runs).toBe(3);
    expect(requests()[0][0]).toBe('/api/ai-investigations/digest?from=2026-11-07&to=2026-11-13');
    await expect(getAiDigest(api, '2026-11-14', '2026-11-13')).rejects.toThrow('posterior');
    expect(requests()).toHaveLength(1);
  });
});
