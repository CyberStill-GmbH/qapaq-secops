/**
 * Cliente del servicio de informes (`services/qapaq-reports`, `POST /render`) y tipos de
 * ReportSpec v1 (contrato compartido API ↔ servicio).
 *
 * Sin `QAPAQ_REPORTS_URL` + `QAPAQ_REPORTS_TOKEN` la función está apagada: `createReportsClient`
 * devuelve `undefined` y la herramienta `generate_report` responde `unavailable`. Tiempo máximo
 * de 90 s por render; los 4xx no se reintentan (un 5xx o un corte de red tampoco: el render es
 * costoso y la persona puede pedirlo de nuevo).
 */

export type ReportFormat = 'pdf' | 'xlsx' | 'csv';
export type ReportKind = 'alerts' | 'investigation' | 'incident' | 'custom';

export type ReportColumnKind = 'text' | 'datetime' | 'number' | 'priority' | 'link';

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: ReportColumnKind;
}

export type ReportCell = string | number | null;

export interface ReportKpi {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export interface ReportMarkdownSection {
  readonly type: 'markdown';
  readonly heading: string;
  readonly body: string;
}

export interface ReportTableSection {
  readonly type: 'table';
  readonly heading: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly Readonly<Record<string, ReportCell>>[];
  readonly note?: string;
  readonly primary?: boolean;
}

export interface ReportChartSection {
  readonly type: 'chart';
  readonly heading: string;
  readonly chart: 'bar' | 'line' | 'donut';
  readonly series: readonly {
    readonly label: string;
    readonly points: readonly { readonly x: string; readonly y: number }[];
  }[];
}

export interface ReportTimelineSection {
  readonly type: 'timeline';
  readonly heading: string;
  readonly items: readonly {
    readonly at: string;
    readonly title: string;
    readonly detail?: string;
    readonly priority?: string;
  }[];
}

export type ReportSection =
  ReportMarkdownSection | ReportTableSection | ReportChartSection | ReportTimelineSection;

export interface ReportSpec {
  readonly version: 1;
  readonly format: ReportFormat;
  readonly kind: ReportKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly timeZone: string;
  readonly classification: string;
  readonly period?: { readonly from: string; readonly to: string };
  readonly kpis: readonly ReportKpi[];
  readonly sections: readonly ReportSection[];
  readonly sources: readonly string[];
}

export interface RenderedReport {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly pages?: number;
}

export type ReportsErrorCode =
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'UNAUTHORIZED'
  | 'SPEC_INVALID'
  | 'TOO_LARGE'
  | 'RENDER_FAILED'
  | 'BAD_RESPONSE';

export class ReportsError extends Error {
  public constructor(public readonly code: ReportsErrorCode) {
    super(code);
    this.name = 'ReportsError';
  }
}

export interface ReportsClient {
  render(spec: ReportSpec, signal?: AbortSignal): Promise<RenderedReport>;
}

export const REPORTS_TIMEOUT_MS = 90_000;
/** Tope del cuerpo de respuesta que se acepta del servicio (artefacto + margen). */
export const REPORTS_MAX_RESPONSE_BYTES = 26 * 1024 * 1024;

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

/** `undefined` si el servicio no está configurado (función apagada). */
export function createReportsClient(
  environment: Readonly<Record<string, string | undefined>>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = REPORTS_TIMEOUT_MS,
): ReportsClient | undefined {
  const url = environment['QAPAQ_REPORTS_URL'];
  const token = environment['QAPAQ_REPORTS_TOKEN'];
  if (!url || !token) return undefined;
  const endpoint = `${url.replace(/\/+$/u, '')}/render`;
  return {
    async render(spec, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: '*/*',
          },
          body: JSON.stringify(spec),
          signal: combined,
        });
      } catch {
        throw new ReportsError(timeout.aborted ? 'TIMEOUT' : 'UNREACHABLE');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ReportsError('UNAUTHORIZED');
      }
      if (response.status === 400) throw new ReportsError('SPEC_INVALID');
      if (response.status === 413) throw new ReportsError('TOO_LARGE');
      if (response.status === 422) throw new ReportsError('RENDER_FAILED');
      if (response.status !== 200) throw new ReportsError('UNREACHABLE');
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > REPORTS_MAX_RESPONSE_BYTES) throw new ReportsError('TOO_LARGE');
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        throw new ReportsError(timeout.aborted ? 'TIMEOUT' : 'BAD_RESPONSE');
      }
      if (bytes.byteLength === 0) throw new ReportsError('BAD_RESPONSE');
      const pagesHeader = Number(response.headers.get('x-qapaq-report-pages') ?? '');
      return {
        bytes,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        ...(Number.isInteger(pagesHeader) && pagesHeader > 0 ? { pages: pagesHeader } : {}),
      };
    },
  };
}
