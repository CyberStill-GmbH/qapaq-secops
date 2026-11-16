/**
 * Analista IA de punta a punta en memoria (HTTP real por inyección de Fastify, sin red ni
 * proveedor): alerta ingerida → trabajo → resolución determinista → expediente por GET →
 * informe. Más el listado MCP de las herramientas del analista.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InMemorySoc } from '@qapaq/soc';

import { buildApi } from '../src/bootstrap.js';
import { dispatchMcpRequest } from '../src/assistant/mcp-protocol.js';
import { buildSocTools } from '../src/assistant/soc-tools.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
let stop: () => Promise<void>;
const IP = '10.20.9.9';

function server() {
  return application.getHttpAdapter().getInstance();
}

async function signIn(username: string) {
  const start = await server().inject({ method: 'GET', url: '/api/auth/start', remoteAddress: IP });
  const header = start.headers['set-cookie'];
  const flowCookie = (Array.isArray(header) ? header[0] : header)?.split(';', 1)[0] ?? '';
  const state = new URL(start.headers.location as string, 'http://local').searchParams.get('state');
  const authorize = await server().inject({
    method: 'GET',
    url: `/api/auth/local/authorize?state=${encodeURIComponent(state ?? '')}&username=${encodeURIComponent(username)}`,
    remoteAddress: IP,
    headers: { cookie: flowCookie },
  });
  const callback = new URL(authorize.headers.location as string, 'http://local');
  const response = await server().inject({
    method: 'POST',
    url: '/api/auth/callback',
    headers: { cookie: flowCookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: callback.searchParams.toString(),
    remoteAddress: IP,
  });
  const cookies = response.headers['set-cookie'];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies as string] : [];
  const cookie = list.find((value) => value.startsWith('qapaq_session='))?.split(';', 1)[0] ?? '';
  const session = await server().inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie },
    remoteAddress: IP,
  });
  const csrf = JSON.parse(session.body).csrfToken as string;
  return { read: { cookie }, write: { cookie, 'x-csrf-token': csrf } };
}

function securityEvent(recordId: string) {
  return {
    schemaVersion: '1.0.0',
    recordId,
    eventUid: `siem-qapaq-lab:alerts:${recordId}`,
    eventUidType: 'native',
    kind: 'alert',
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    observedAt: new Date(Date.now() - 59_000).toISOString(),
    receivedAt: new Date(Date.now() - 58_000).toISOString(),
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
    raw: { ref: `raw:${recordId}`, sha256: 'a'.repeat(64), mediaType: 'application/json', sizeBytes: 1024 },
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

beforeAll(async () => {
  // Analista activo sin techo diario: todo se resuelve sin modelo (no hay llamadas al proveedor).
  const built = await buildApi(
    { QAPAQ_PROFILE: 'test', QAPAQ_ANALYST_ENABLED: 'true', AWS_REGION: 'us-east-1' },
    () => {},
  );
  application = built.application;
  runtime = built.runtime;
  stop = built.stop;
  await application.init();
  await server().ready();
  runtime.detectionContext = {
    privilegedIdentities: new Set(['jperez@qapaq.pe']),
    criticalAssets: new Set(['host-1']),
  };
});

afterAll(async () => {
  await stop();
});

describe('Analista IA de punta a punta (memoria)', () => {
  it('alerta ingerida → trabajo → resolución determinista → expediente y informe', async () => {
    const admin = await signIn('admin@qapaq.pe');
    const analyst = await signIn('analista@qapaq.pe');

    // Apagado en ajustes: la consola ve el estado y la revisión 0.
    const initial = await server().inject({
      method: 'GET',
      url: '/api/ai-investigations/settings',
      headers: admin.read,
      remoteAddress: IP,
    });
    expect(initial.statusCode).toBe(200);
    const view = JSON.parse(initial.body);
    expect(view).toMatchObject({ canConfigure: true, settings: { enabled: false, revision: 0 } });

    const { revision: _r, updatedAt: _u, updatedBy: _b, ...current } = view.settings;
    const { maxImmediatePerHour: _m, ...review } = current.review;
    const saved = await server().inject({
      method: 'PUT',
      url: '/api/ai-investigations/settings',
      headers: { ...admin.write, 'content-type': 'application/json' },
      payload: { settings: { ...current, review, enabled: true, mode: 'assisted' }, expectedRevision: 0 },
      remoteAddress: IP,
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ canConfigure: true, settings: { revision: 1, mode: 'assisted' } });

    // El analista no puede configurar.
    const denied = await server().inject({
      method: 'PUT',
      url: '/api/ai-investigations/settings',
      headers: { ...analyst.write, 'content-type': 'application/json' },
      payload: { settings: current, expectedRevision: 1 },
      remoteAddress: IP,
    });
    expect(denied.statusCode).toBe(404);

    const ingested = await server().inject({
      method: 'POST',
      url: '/api/ingest/security-events',
      payload: securityEvent('01890f47-7abc-7def-8abc-00000000ae01'),
      remoteAddress: IP,
    });
    expect(ingested.statusCode, ingested.body).toBeLessThan(300);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await server().inject({
      method: 'GET',
      url: '/api/ai-investigations?pageSize=10',
      headers: analyst.read,
      remoteAddress: IP,
    });
    expect(listed.statusCode).toBe(200);
    const page = JSON.parse(listed.body);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ status: 'queued', trigger: 'system' });

    expect(await runtime.analyst!.runOnce()).toBe('processed');

    const detail = await server().inject({
      method: 'GET',
      url: `/api/ai-investigations/${page.items[0].id}`,
      headers: analyst.read,
      remoteAddress: IP,
    });
    expect(detail.statusCode).toBe(200);
    const run = JSON.parse(detail.body).run;
    expect(run).toMatchObject({ inference: 'none', mode: 'assisted' });
    expect(['completed', 'partial', 'requires_review']).toContain(run.status);
    expect(run.result.deterministic.reasons).toContain('INFERENCE_DISABLED');
    expect(run.invocations).toEqual([]);
    expect(run.events.length).toBeGreaterThan(3);
    expect(JSON.stringify(run)).not.toContain('jperez@qapaq.pe');

    const report = await server().inject({
      method: 'GET',
      url: `/api/ai-investigations/${run.id}/report`,
      headers: analyst.read,
      remoteAddress: IP,
    });
    expect(report.statusCode).toBe(200);
    const body = JSON.parse(report.body).report;
    expect(body.filename).toBe(`expediente-analista-${run.id}.md`);
    expect(body.markdown).toContain('# Expediente del Analista IA');

    const budget = await server().inject({
      method: 'GET',
      url: '/api/ai-investigations/budget',
      headers: analyst.read,
      remoteAddress: IP,
    });
    expect(JSON.parse(budget.body)).toMatchObject({
      enabled: true,
      mode: 'assisted',
      inferenceEnabled: false,
      billing: 'not_connected',
      runs: { withoutInference: 1 },
    });

    // En modo asistido la alerta no cambió.
    const alert = [...(runtime.soc as InMemorySoc).alertRows.values()][0]!;
    expect(alert.status).toBe('new');
  });
});

describe('herramientas MCP del analista', () => {
  const get = async () => ({ status: 200, body: { items: [] } });

  it('se ofrecen según capacidad y start_investigation no es de solo lectura', async () => {
    const reader = buildSocTools(get, { roles: [], capabilities: ['investigations.read'] }, {
      startInvestigation: async () => ({ ok: true, data: {} }),
    });
    const names = reader.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_investigations', 'get_investigation_run', 'get_investigation_report']),
    );
    expect(names).not.toContain('start_investigation');

    const runner = buildSocTools(
      get,
      { roles: [], capabilities: ['investigations.read', 'investigations.run'] },
      { startInvestigation: async (alertId) => ({ ok: true, data: { alertId } }) },
    );
    const listing = (await dispatchMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, runner)) as {
      result: { tools: { name: string; description: string; annotations: { readOnlyHint: boolean } }[] };
    };
    const start = listing.result.tools.find((tool) => tool.name === 'start_investigation')!;
    expect(start.annotations.readOnlyHint).toBe(false);
    expect(start.description).toMatch(/confirmación explícita/u);
    expect(listing.result.tools.find((tool) => tool.name === 'get_investigation_run')?.annotations.readOnlyHint).toBe(true);
    const called = (await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_investigation', arguments: { alertId: 'abc-1' } } },
      runner,
    )) as { result: { content: { text: string }[] } };
    expect(JSON.parse(called.result.content[0]!.text)).toEqual({ alertId: 'abc-1' });

    const none = buildSocTools(get, { roles: [], capabilities: ['alerts.read'] });
    expect(none.map((tool) => tool.name)).not.toContain('list_investigations');
  });
});
