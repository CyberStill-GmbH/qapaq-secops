/**
 * Herramienta `generate_report`: obtención de datos con la sesión de la persona, ReportSpec v1,
 * resultado corto hacia el modelo, permisos y cliente HTTP del servicio de informes.
 */

import { describe, expect, it, vi } from 'vitest';
import { ArtifactVault, InMemoryArtifactStore } from '@qapaq/assistant';

import {
  buildReportTool,
  clampNarrative,
  type StoredReport,
} from '../src/assistant/report-tool.js';
import {
  ReportsError,
  createReportsClient,
  type ReportSpec,
  type ReportsClient,
} from '../src/assistant/reports-client.js';
import type { InternalGet } from '../src/assistant/soc-tools.js';

const NOW = new Date('2026-11-13T17:00:00Z');
const owner = { tenantId: 't1', ownerId: 'ana' };
const PDF = new TextEncoder().encode('%PDF-1.7 fake');

function alert(id: string, priority: string, title: string, occurredAt: string, extra = {}) {
  return {
    id,
    title,
    priority,
    score: 70,
    status: 'new',
    assigneeId: null,
    occurredAt,
    entities: [{ ref: 'ent_x', kind: 'user', label: 'ana@qapaq.pe' }],
    reasons: [{ code: 'R1', detail: 'Volumen anómalo' }],
    relatedAlertIds: [],
    ...extra,
  };
}

function fakeReports() {
  const specs: ReportSpec[] = [];
  const client: ReportsClient = {
    async render(spec) {
      specs.push(spec);
      return { bytes: PDF, contentType: 'application/pdf', pages: 3 };
    },
  };
  return { client, specs };
}

function setup(options: {
  get: InternalGet;
  capabilities?: string[];
  reports?: ReportsClient | undefined;
  stored?: StoredReport[];
}) {
  const vault = new ArtifactVault(new InMemoryArtifactStore(), () => NOW);
  const tool = buildReportTool({
    get: options.get,
    capabilities: new Set(options.capabilities ?? ['alerts.read', 'incidents.read', 'events.read']),
    displayName: 'Ana Analista',
    consoleBaseUrl: 'https://soc.qapaq.pe/',
    now: () => NOW,
    reports: options.reports,
    vault,
    owner,
    onStored: (report) => {
      options.stored?.push(report);
    },
  });
  return { tool, vault };
}

const alertsGet: InternalGet = async (url) => {
  if (url.startsWith('/api/alerts?')) {
    // Como la API real: `priority` filtra en el servidor.
    const priority = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('priority');
    const items = [
      alert('a-4', 'P1', 'QAPAQ Cloudflare: oleada', '2026-11-13T15:00:00Z'),
      alert('a-3', 'P2', 'QAPAQ Snyk: vulnerabilidad', '2026-11-13T02:00:00Z', {
        status: 'closed',
      }),
      alert('a-2', 'P1', 'QAPAQ Cloudflare: oleada', '2026-11-12T20:00:00Z'),
      alert('a-1', 'P3', 'QAPAQ AWS: CloudTrail', '2026-10-01T20:00:00Z'),
    ].filter((item) => !priority || item['priority'] === priority);
    return { status: 200, body: { items, nextCursor: null } };
  }
  return { status: 404, body: null };
};

describe('generate_report · kind=alerts', () => {
  it('arma ReportSpec v1 con KPIs, gráficos, tablas y narrativa; el modelo recibe un resultado corto', async () => {
    const { client, specs } = fakeReports();
    const stored: StoredReport[] = [];
    const { tool, vault } = setup({ get: alertsGet, reports: client, stored });
    expect(tool.labelFor?.({ format: 'pdf' })).toBe('Generando informe PDF');
    expect(tool.labelFor?.({ format: 'xlsx' })).toBe('Generando informe Excel');

    const outcome = await tool.run({
      format: 'pdf',
      kind: 'alerts',
      title: 'Informe semanal',
      scope: { from: '2026-11-06T00:00:00Z', to: '2026-11-13T17:00:00Z', priorities: ['P1', 'P2'] },
      narrative: {
        executiveSummary: 'Resumen de <script>alert(1)</script> ana@qapaq.pe con datos reales',
        findings: 'Dos P1 de Cloudflare.',
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Resultado corto: sin título, sin entidades ni contenido.
    expect(outcome.data).toMatchObject({
      format: 'pdf',
      rows: 3,
      pages: 3,
      attached: true,
    });
    const text = JSON.stringify(outcome.data);
    expect(text).not.toContain('ana@qapaq.pe');
    expect(text).not.toContain('Informe semanal');
    expect(text.length).toBeLessThan(400);
    expect((outcome.data as { filename: string }).filename).toBe(
      'QAPAQ-informe-alertas-2026-11-13-1200.pdf',
    );

    const spec = specs[0]!;
    expect(spec).toMatchObject({
      version: 1,
      format: 'pdf',
      kind: 'alerts',
      title: 'Informe semanal',
      generatedBy: 'Ana Analista',
      timeZone: 'America/Lima',
      classification: 'Confidencial · uso interno QAPAQ',
      period: { from: '2026-11-06T00:00:00.000Z', to: '2026-11-13T17:00:00.000Z' },
    });
    expect(spec.kpis.length).toBeLessThanOrEqual(8);
    expect(spec.kpis.find((kpi) => kpi.label === 'Alertas')?.value).toBe('3');
    expect(spec.kpis.find((kpi) => kpi.label === 'Alertas P1')?.value).toBe('2');
    // Solo las prioridades del alcance: sin KPIs en cero de P3/P4 que no se pidieron.
    expect(spec.kpis.find((kpi) => kpi.label === 'Alertas P3')).toBeUndefined();
    // Narrativa del modelo primero, sin HTML, con el valor real (es la descarga de la persona).
    const [summary, findings] = spec.sections;
    expect(summary).toMatchObject({ type: 'markdown', heading: 'Resumen ejecutivo' });
    expect((summary as { body: string }).body).not.toContain('<script>');
    expect((summary as { body: string }).body).toContain('ana@qapaq.pe');
    expect(findings).toMatchObject({ type: 'markdown', heading: 'Hallazgos' });
    const bar = spec.sections.find(
      (section) => section.type === 'chart' && section.chart === 'bar',
    );
    expect(bar).toMatchObject({ type: 'chart', series: [{ label: 'P1' }, { label: 'P2' }] });
    const primary = spec.sections.find((section) => section.type === 'table' && section.primary);
    expect(primary).toMatchObject({ type: 'table', heading: 'Alertas' });
    const rows = (primary as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map((row) => row['priority'])).toEqual(['P1', 'P2', 'P1']);
    expect(rows[0]?.['link']).toBe('https://soc.qapaq.pe/app/qapaq-alerts?id=a-4&investigate=1');
    expect(
      spec.sections.some((s) => s.type === 'table' && s.heading === 'Reglas más frecuentes'),
    ).toBe(true);
    expect(spec.sources[0]).toContain('QAPAQ SOC API');

    // El archivo quedó guardado para la persona.
    expect(stored).toHaveLength(1);
    expect(await vault.get(owner, stored[0]!.artifact.id)).toMatchObject({ size: PDF.byteLength });
    expect(stored[0]).toMatchObject({ kind: 'alerts', format: 'pdf', rows: 3, pages: 3 });
  });

  it('miles de P3 recientes no tapan las P1/P2 del periodo (incidente 2026-11-13)', async () => {
    const { client, specs } = fakeReports();
    const p3 = Array.from({ length: 200 }, (_, index) =>
      alert(`p3-${index}`, 'P3', 'QAPAQ M365: actividad', '2026-11-13T16:00:00Z'),
    );
    const older = Array.from({ length: 40 }, (_, index) =>
      alert(`p2-${index}`, 'P2', 'QAPAQ SharePoint: descarga masiva', '2026-11-10T12:00:00Z'),
    );
    const get: InternalGet = async (url) => {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      const priority = query.get('priority');
      if (!priority) {
        // Sin filtro: páginas eternas de P3 recientes (lo que hacía agotar el tope).
        return { status: 200, body: { items: p3, nextCursor: 'more' } };
      }
      return { status: 200, body: { items: priority === 'P2' ? older : [], nextCursor: null } };
    };
    const { tool } = setup({ get, reports: client });
    const outcome = await tool.run({
      format: 'pdf',
      kind: 'alerts',
      title: 'P1 y P2',
      scope: { from: '2026-11-06T00:00:00Z', to: '2026-11-13T17:00:00Z', priorities: ['P1', 'P2'] },
    });
    expect(outcome.ok).toBe(true);
    expect(specs[0]!.kpis.find((kpi) => kpi.label === 'Alertas')?.value).toBe('40');
    expect(specs[0]!.kpis.find((kpi) => kpi.label === 'Alertas P2')?.value).toBe('40');
  });

  it('sin servicio de informes responde unavailable', async () => {
    const { tool } = setup({ get: alertsGet, reports: undefined });
    const outcome = await tool.run({ format: 'pdf', kind: 'alerts' });
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: string }).error).toMatch(/^unavailable:/u);
  });

  it('sin la capacidad de lectura responde forbidden y no llama al servicio', async () => {
    const { client, specs } = fakeReports();
    const { tool } = setup({ get: alertsGet, reports: client, capabilities: ['events.read'] });
    const outcome = await tool.run({ format: 'xlsx', kind: 'alerts' });
    expect((outcome as { error: string }).error).toMatch(/^forbidden:/u);
    expect(specs).toHaveLength(0);
  });

  it('valida el alcance (periodo, prioridades) sin tocar el servicio', async () => {
    const { client, specs } = fakeReports();
    const { tool } = setup({ get: alertsGet, reports: client });
    expect(
      await tool.run({ format: 'csv', kind: 'alerts', scope: { from: '2025-01-01T00:00:00Z' } }),
    ).toMatchObject({ ok: false });
    expect(
      await tool.run({ format: 'csv', kind: 'alerts', scope: { priorities: ['P9'] } }),
    ).toMatchObject({ ok: false });
    expect(await tool.run({ format: 'doc', kind: 'alerts' })).toMatchObject({ ok: false });
    expect(specs).toHaveLength(0);
  });

  it('un fallo del servicio de informes sale como unavailable sin detalles', async () => {
    const failing: ReportsClient = {
      async render() {
        throw new ReportsError('TIMEOUT');
      },
    };
    const { tool, vault } = setup({ get: alertsGet, reports: failing });
    const outcome = await tool.run({ format: 'pdf', kind: 'alerts' });
    expect((outcome as { error: string }).error).toMatch(/^unavailable:/u);
    expect(await vault.list(owner)).toEqual([]);
  });
});

describe('generate_report · investigation e incident', () => {
  const get: InternalGet = async (url) => {
    if (url === '/api/alerts/a-9') {
      return {
        status: 200,
        body: {
          alert: alert(
            'a-9',
            'P1',
            'QAPAQ Microsoft 365: inicio sospechoso',
            '2026-11-13T15:00:00Z',
            {
              relatedAlertIds: ['a-8'],
            },
          ),
        },
      };
    }
    if (url === '/api/alerts/a-8') {
      return {
        status: 200,
        body: { alert: alert('a-8', 'P2', 'QAPAQ Entra: MFA', '2026-11-13T14:40:00Z') },
      };
    }
    if (url.startsWith('/api/events?')) {
      return {
        status: 200,
        body: {
          items: [
            {
              recordId: 'e1',
              occurredAt: '2026-11-13T14:59:00Z',
              severity: 'high',
              category: 'authentication',
              outcome: 'failure',
              title: 'Login fallido',
              identities: [{ kind: 'user', principal: 'ana@qapaq.pe' }],
              resources: [],
            },
            {
              recordId: 'e2',
              occurredAt: '2026-11-13T14:58:00Z',
              severity: 'low',
              category: 'network',
              outcome: 'success',
              title: 'Otro usuario',
              identities: [{ kind: 'user', principal: 'luis@qapaq.pe' }],
              resources: [],
            },
          ],
          nextCursor: null,
        },
      };
    }
    if (url === '/api/incidents/i-1') {
      return {
        status: 200,
        body: {
          incident: {
            id: 'i-1',
            title: 'Cuenta comprometida',
            severity: 'high',
            status: 'investigating',
            summary: 'Resumen',
            openedAt: '2026-11-13T10:00:00Z',
            closedAt: null,
          },
        },
      };
    }
    if (url.startsWith('/api/incidents/i-1/alerts')) {
      return {
        status: 200,
        body: { items: [alert('a-9', 'P1', 'Alerta vinculada', '2026-11-13T15:00:00Z')] },
      };
    }
    if (url.startsWith('/api/incidents/i-1/timeline')) {
      return {
        status: 200,
        body: {
          items: [
            { id: 'x', kind: 'incident.opened', at: '2026-11-13T10:00:00Z', summary: 'Abierto' },
          ],
        },
      };
    }
    if (url.startsWith('/api/incidents/i-1/tasks')) {
      return {
        status: 200,
        body: { items: [{ title: 'Revisar MFA', status: 'open', required: true }] },
      };
    }
    if (url.startsWith('/api/incidents/i-1/notes')) {
      return {
        status: 200,
        body: { items: [{ createdAt: '2026-11-13T11:00:00Z', body: 'Nota' }] },
      };
    }
    return { status: 404, body: null };
  };

  it('investigation: detalle, entidades, relacionadas, eventos filtrados por entidad y cronología', async () => {
    const { client, specs } = fakeReports();
    const { tool } = setup({ get, reports: client });
    const outcome = await tool.run({
      format: 'pdf',
      kind: 'investigation',
      scope: { alertId: 'a-9', window: '1h' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.citations).toEqual([
      { kind: 'alert', id: 'a-9', label: 'QAPAQ Microsoft 365: inicio sospechoso' },
    ]);
    const spec = specs[0]!;
    const events = spec.sections.find(
      (s) => s.type === 'table' && s.heading === 'Eventos relacionados',
    );
    expect((events as { rows: unknown[] }).rows).toHaveLength(1);
    expect(
      spec.sections.some((s) => s.type === 'table' && s.heading === 'Alertas relacionadas'),
    ).toBe(true);
    const timeline = spec.sections.find((s) => s.type === 'timeline') as {
      items: { title: string }[];
    };
    expect(timeline.items.map((item) => item.title)).toEqual([
      'Alerta: QAPAQ Entra: MFA',
      'Evento: Login fallido',
      'Alerta: QAPAQ Microsoft 365: inicio sospechoso',
    ]);
    expect(spec.kpis.find((kpi) => kpi.label === 'Eventos relacionados')?.value).toBe('1');
  });

  it('investigation: sin events.read lo declara y sigue; alerta inexistente es forbidden', async () => {
    const { client, specs } = fakeReports();
    const { tool } = setup({ get, reports: client, capabilities: ['alerts.read'] });
    expect(
      (await tool.run({ format: 'pdf', kind: 'investigation', scope: { alertId: 'a-9' } })).ok,
    ).toBe(true);
    const events = specs[0]!.sections.find(
      (s) => s.type === 'table' && s.heading === 'Eventos relacionados',
    );
    expect((events as { note: string }).note).toContain('no tiene permiso');
    const missing = await tool.run({
      format: 'pdf',
      kind: 'investigation',
      scope: { alertId: 'nope' },
    });
    expect((missing as { error: string }).error).toMatch(/^forbidden:/u);
  });

  it('incident: alertas, tareas, notas y cronología', async () => {
    const { client, specs } = fakeReports();
    const { tool } = setup({ get, reports: client });
    const outcome = await tool.run({
      format: 'xlsx',
      kind: 'incident',
      scope: { incidentId: 'i-1' },
    });
    expect(outcome.ok).toBe(true);
    const headings = specs[0]!.sections.map((s) => s.heading);
    expect(headings).toEqual([
      'Detalle del incidente',
      'Alertas vinculadas',
      'Tareas',
      'Notas de investigación',
      'Cronología',
    ]);
    expect(specs[0]!.kpis.find((kpi) => kpi.label === 'Tareas abiertas')?.value).toBe('1');
  });

  it('incident sin incidents.read es forbidden', async () => {
    const { client } = fakeReports();
    const { tool } = setup({ get, reports: client, capabilities: ['alerts.read'] });
    const outcome = await tool.run({
      format: 'pdf',
      kind: 'incident',
      scope: { incidentId: 'i-1' },
    });
    expect((outcome as { error: string }).error).toMatch(/^forbidden:/u);
  });
});

describe('narrativa del modelo', () => {
  it('quita HTML y limita la longitud', () => {
    expect(clampNarrative('Hola <b>mundo</b> <img src=x onerror=1>', 100)).toBe('Hola mundo');
    expect(clampNarrative('x'.repeat(50), 10)).toHaveLength(10);
    expect(clampNarrative(42, 10)).toBe('');
  });
});

describe('cliente del servicio de informes', () => {
  const spec = { version: 1 } as unknown as ReportSpec;

  it('sin URL o token está apagado', () => {
    expect(createReportsClient({})).toBeUndefined();
    expect(createReportsClient({ QAPAQ_REPORTS_URL: 'http://reports:8090' })).toBeUndefined();
    expect(createReportsClient({ QAPAQ_REPORTS_TOKEN: 'x'.repeat(20) })).toBeUndefined();
  });

  it('envía bearer a /render y devuelve bytes, tipo y páginas', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(PDF, {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'x-qapaq-report-pages': '4' },
        }),
    );
    const client = createReportsClient(
      { QAPAQ_REPORTS_URL: 'http://reports:8090/', QAPAQ_REPORTS_TOKEN: 'secret-token-value-123' },
      fetchMock,
    )!;
    const result = await client.render(spec);
    expect(result).toMatchObject({ contentType: 'application/pdf', pages: 4 });
    expect(result.bytes.byteLength).toBe(PDF.byteLength);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; method: string },
    ];
    expect(url).toBe('http://reports:8090/render');
    expect(init.method).toBe('POST');
    expect(init.headers['authorization']).toBe('Bearer secret-token-value-123');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('los 4xx no se reintentan y se mapean a un código', async () => {
    for (const [status, code] of [
      [400, 'SPEC_INVALID'],
      [401, 'UNAUTHORIZED'],
      [413, 'TOO_LARGE'],
      [422, 'RENDER_FAILED'],
    ] as const) {
      const fetchMock = vi.fn(async () => new Response('{}', { status }));
      const client = createReportsClient(
        { QAPAQ_REPORTS_URL: 'http://reports:8090', QAPAQ_REPORTS_TOKEN: 'secret-token-value-123' },
        fetchMock,
      )!;
      await expect(client.render(spec)).rejects.toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('red caída y tiempo agotado se distinguen', async () => {
    const down = createReportsClient(
      { QAPAQ_REPORTS_URL: 'http://reports:8090', QAPAQ_REPORTS_TOKEN: 'secret-token-value-123' },
      async () => {
        throw new TypeError('fetch failed');
      },
    )!;
    await expect(down.render(spec)).rejects.toMatchObject({ code: 'UNREACHABLE' });
    const slow = createReportsClient(
      { QAPAQ_REPORTS_URL: 'http://reports:8090', QAPAQ_REPORTS_TOKEN: 'secret-token-value-123' },
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        }),
      20,
    )!;
    await expect(slow.render(spec)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
