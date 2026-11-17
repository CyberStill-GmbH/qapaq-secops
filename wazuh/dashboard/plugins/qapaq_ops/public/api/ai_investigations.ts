/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  AI_RUN_STATUSES,
  AiActivity,
  AiBudget,
  normalizeActivity,
  AiDigest,
  AiRunReport,
  AnalystSettingsInput,
  AnalystSettingsView,
  digestRangeError,
  AiRunDetail,
  AiRunPage,
  AiRunStatus,
  isValidAiRunId,
  isValidAlertId,
  normalizeBudget,
  normalizeDigest,
  normalizeRunReport,
  normalizeRunDetail,
  normalizeRunPage,
  normalizeSettingsView,
} from '../../common';
import { QapaqApiClient, QapaqApiError } from './client';

/**
 * Cliente del Analista IA (`/api/ai-investigations`, mismo origen, CSRF en las mutaciones).
 * Toda respuesta se normaliza antes de llegar a la vista. Un 404 / `RESOURCE_UNAVAILABLE` puede
 * significar «no publicado», «no habilitado» o «sin capacidad»: lo decide la vista con `can`.
 */

const BASE = '/ai-investigations';
export const AI_RUNS_PAGE_SIZE = 50;

export interface AiRunCommandResult {
  readonly run: AiRunDetail;
}

export interface AiRunStartResult extends AiRunCommandResult {
  /** `false`: ya existía una investigación idéntica y se reutilizó; `null`: el backend no lo dijo. */
  readonly created: boolean | null;
}

function runPath(id: string, action?: 'cancel' | 'retry' | 'report'): string {
  if (!isValidAiRunId(id)) throw new Error('Identificador de investigación no válido');
  return `${BASE}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
}

function revisionBody(expectedRevision: number): { expectedRevision: number } {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Revisión esperada no válida');
  }
  return { expectedRevision };
}

/** Una respuesta 2xx sin una corrida legible es una dependencia degradada, no un éxito. */
function detailFrom(body: unknown): AiRunDetail {
  const run = normalizeRunDetail((body as { run?: unknown } | null)?.run);
  if (!run) throw new QapaqApiError('DEPENDENCY_DEGRADED', 200, correlationOf(body));
  return run;
}

function correlationOf(body: unknown): string | null {
  const value = (body as { correlationId?: unknown } | null)?.correlationId;
  return typeof value === 'string' ? value : null;
}

export async function listAiRuns(
  api: QapaqApiClient,
  query: {
    readonly status?: AiRunStatus | null;
    readonly cursor?: string | null;
    readonly pageSize?: number;
  } = {},
): Promise<AiRunPage> {
  const status =
    query.status && (AI_RUN_STATUSES as readonly string[]).includes(query.status)
      ? query.status
      : undefined;
  const body = await api.get<unknown>(BASE, {
    status,
    cursor: query.cursor || undefined,
    pageSize: query.pageSize ?? AI_RUNS_PAGE_SIZE,
  });
  return normalizeRunPage(body);
}

export async function getAiBudget(api: QapaqApiClient): Promise<AiBudget> {
  return normalizeBudget(await api.get<unknown>(`${BASE}/budget`));
}

/** Panel «Actividad»: estado del analista, cola, día de Lima y feed de las últimas 24 h. */
export async function getAiActivity(api: QapaqApiClient): Promise<AiActivity> {
  const body = await api.get<unknown>(`${BASE}/activity`);
  const activity = normalizeActivity(body);
  if (!activity) throw new QapaqApiError('DEPENDENCY_DEGRADED', 200, correlationOf(body));
  return activity;
}

export async function getAiRun(api: QapaqApiClient, id: string): Promise<AiRunDetail> {
  return detailFrom(await api.get<unknown>(runPath(id)));
}

export async function startAiRun(api: QapaqApiClient, alertId: string): Promise<AiRunStartResult> {
  if (!isValidAlertId(alertId)) throw new Error('Identificador de alerta no válido');
  const body = await api.post<unknown>(BASE, { alertId });
  const created = (body as { created?: unknown } | null)?.created;
  return { run: detailFrom(body), created: typeof created === 'boolean' ? created : null };
}

export async function cancelAiRun(
  api: QapaqApiClient,
  id: string,
  expectedRevision: number,
): Promise<AiRunCommandResult> {
  const path = runPath(id, 'cancel');
  return { run: detailFrom(await api.post<unknown>(path, revisionBody(expectedRevision))) };
}

export async function retryAiRun(
  api: QapaqApiClient,
  id: string,
  expectedRevision: number,
): Promise<AiRunCommandResult> {
  const path = runPath(id, 'retry');
  return { run: detailFrom(await api.post<unknown>(path, revisionBody(expectedRevision))) };
}

/** 404 / RESOURCE_UNAVAILABLE: el analista no está publicado o habilitado en este entorno. */
export function isAnalystUnavailable(error: unknown): boolean {
  return (
    error instanceof QapaqApiError && (error.status === 404 || error.code === 'RESOURCE_UNAVAILABLE')
  );
}

/**
 * Configuración del analista. `settings`, `budget` y `digest` son rutas literales del backend:
 * `runPath` las rechaza como identificador de investigación.
 */
export async function getAiSettings(api: QapaqApiClient): Promise<AnalystSettingsView> {
  const body = await api.get<unknown>(`${BASE}/settings`);
  const view = normalizeSettingsView(body);
  // Una configuración ilegible no se edita ni se completa con valores por defecto.
  if (!view) throw new QapaqApiError('DEPENDENCY_DEGRADED', 200, correlationOf(body));
  return view;
}

export async function saveAiSettings(
  api: QapaqApiClient,
  settings: AnalystSettingsInput,
  expectedRevision: number,
): Promise<AnalystSettingsView> {
  const body = await api.put<unknown>(`${BASE}/settings`, {
    settings,
    ...revisionBody(expectedRevision),
  });
  // La respuesta del PUT no repite `canConfigure`: quien acaba de guardar puede configurar.
  const view = normalizeSettingsView({
    settings: (body as { settings?: unknown } | null)?.settings,
    canConfigure: true,
  });
  if (!view) throw new QapaqApiError('DEPENDENCY_DEGRADED', 200, correlationOf(body));
  return view;
}

export async function getAiRunReport(api: QapaqApiClient, id: string): Promise<AiRunReport> {
  const body = await api.get<unknown>(runPath(id, 'report'));
  const report = normalizeRunReport((body as { report?: unknown } | null)?.report, id);
  if (!report) throw new QapaqApiError('DEPENDENCY_DEGRADED', 200, correlationOf(body));
  return report;
}

/** Resumen del periodo; `from` y `to` son días `AAAA-MM-DD` (ambos incluidos). */
export async function getAiDigest(api: QapaqApiClient, from: string, to: string): Promise<AiDigest> {
  const invalid = digestRangeError(from, to);
  if (invalid) throw new Error(invalid);
  const body = await api.get<unknown>(`${BASE}/digest`, { from, to });
  const digest = normalizeDigest((body as { digest?: unknown } | null)?.digest);
  if (!digest) throw new QapaqApiError('DEPENDENCY_DEGRADED', 200, correlationOf(body));
  return digest;
}
