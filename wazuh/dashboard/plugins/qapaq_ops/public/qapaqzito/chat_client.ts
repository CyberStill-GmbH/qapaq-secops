/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { QapaqApiError } from '../api/client';
import type { QapaqApiClient } from '../api/client';

export interface QapaqzitoConfig {
  readonly enabled: boolean;
  readonly name: string;
  readonly readOnly?: boolean;
  readonly redactsPersonalData?: boolean;
  readonly provider?: 'bedrock' | 'anthropic';
  readonly model?: string;
  readonly effort?: string;
  readonly rateLimit?: number;
  readonly history?: boolean;
  readonly retentionDays?: number;
}

export type QapaqzitoConfigState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly config: QapaqzitoConfig }
  | { readonly status: 'unavailable' };

export interface QapaqzitoUsage {
  readonly period: { readonly from: string; readonly to: string; readonly days: number };
  readonly totals: {
    readonly requests: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly measured: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
  readonly models: readonly {
    readonly provider: string;
    readonly model: string;
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  }[];
  readonly nextCursor: string | null;
  readonly billing: 'not_connected';
}

export interface QapaqzitoStep {
  readonly tool: string;
  readonly label: string;
  readonly ok: boolean;
}

export interface QapaqzitoCitation {
  readonly kind: 'alert' | 'incident' | 'event' | 'source' | 'audit';
  readonly id: string;
  readonly label: string;
}

/** Archivo generado por Qapaqzito (informe PDF/Excel/CSV), guardado por la API durante 24 h. */
export interface ArtifactRef {
  readonly id: string;
  readonly filename: string;
  readonly format: 'pdf' | 'xlsx' | 'csv';
  readonly title: string;
  readonly size: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Ruta relativa de descarga (`/api/assistant/artifacts/<id>`); la consola la reconstruye. */
  readonly url: string;
}

const ARTIFACT_FORMATS: readonly string[] = ['pdf', 'xlsx', 'csv'];
const ARTIFACT_ID = /^[A-Za-z0-9-]{1,64}$/u;

/** Valida un artefacto recibido de la API (SSE o JSON); lo que no cumple el contrato se descarta. */
export function parseArtifactRef(value: unknown): ArtifactRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const { id, filename, format, title, size, createdAt, expiresAt, url } = item;
  if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) return null;
  if (typeof format !== 'string' || !ARTIFACT_FORMATS.includes(format)) return null;
  if (typeof filename !== 'string' || filename === '') return null;
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
  return {
    id,
    filename,
    format: format as ArtifactRef['format'],
    title: typeof title === 'string' && title !== '' ? title : filename,
    size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
    createdAt: typeof createdAt === 'string' ? createdAt : expiresAt,
    expiresAt,
    url: typeof url === 'string' ? url : '',
  };
}

export function parseArtifacts(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ArtifactRef[] = [];
  for (const entry of value) {
    const artifact = parseArtifactRef(entry);
    if (artifact && !seen.has(artifact.id)) {
      seen.add(artifact.id);
      result.push(artifact);
    }
  }
  return result;
}

export function mergeArtifacts(
  first: readonly ArtifactRef[],
  second: readonly ArtifactRef[],
): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const artifact of [...first, ...second])
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact);
  return Array.from(byId.values());
}

export interface QapaqzitoReply {
  readonly conversationId?: string;
  readonly title?: string;
  /** `false` si la respuesta no pudo guardarse en el historial. */
  readonly saved?: boolean;
  readonly reply: string;
  readonly outcome: 'answered' | 'budget' | 'refused' | 'truncated' | 'unverified';
  readonly steps: readonly QapaqzitoStep[];
  readonly citations: readonly QapaqzitoCitation[];
  /** Id del mensaje de Qapaqzito guardado (para la valoración 👍/👎); `null` si no se guardó. */
  readonly messageId?: string | null;
  /** Archivos generados en este turno (informes); también llegan por SSE como `artifact`. */
  readonly artifacts?: readonly ArtifactRef[];
}

/** Devoluciones de llamada opcionales del canal SSE más allá del progreso operativo. */
export interface QapaqzitoStreamHandlers {
  /** Un archivo quedó guardado (evento SSE `artifact`). */
  readonly onArtifact?: (artifact: ArtifactRef) => void;
  /** Fragmento de texto de la respuesta (evento SSE `delta`), si el servidor lo envía. */
  readonly onDelta?: (text: string) => void;
}

/** Sanea `artifacts` de una respuesta final y los une a los recibidos por SSE. */
export function withArtifacts(
  reply: QapaqzitoReply,
  streamed: readonly ArtifactRef[] = [],
): QapaqzitoReply {
  const artifacts = mergeArtifacts(parseArtifacts(reply.artifacts), streamed);
  const { artifacts: _ignored, ...rest } = reply;
  return artifacts.length > 0 ? { ...rest, artifacts } : rest;
}

export interface QapaqzitoTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type QapaqzitoProgressEvent =
  | { readonly type: 'transport_fallback' }
  | { readonly type: 'model_started'; readonly round: number }
  | { readonly type: 'tool_started'; readonly label: string }
  | { readonly type: 'tool_finished'; readonly label: string; readonly ok: boolean };

/** Cuántos turnos previos viajan con cada pregunta (la API vuelve a recortar). */
export const HISTORY_TURNS = 12;

export function fetchQapaqzitoConfig(api: QapaqApiClient): Promise<QapaqzitoConfig> {
  return api.get<QapaqzitoConfig>('/assistant/config');
}

/** A failed config request is an outage, never evidence that Qapaqzito is disabled. */
export async function loadQapaqzitoConfigState(api: QapaqApiClient): Promise<QapaqzitoConfigState> {
  try {
    return { status: 'ready', config: await fetchQapaqzitoConfig(api) };
  } catch {
    return { status: 'unavailable' };
  }
}

export function fetchQapaqzitoUsage(
  api: QapaqApiClient,
  query: { readonly from?: string; readonly to?: string; readonly cursor?: string } = {},
): Promise<QapaqzitoUsage> {
  return api.get<QapaqzitoUsage>('/assistant/usage', query);
}

export function askQapaqzito(
  api: QapaqApiClient,
  message: string,
  history: readonly QapaqzitoTurn[],
  page: string,
  conversationId?: string,
): Promise<QapaqzitoReply> {
  return api
    .post<QapaqzitoReply>('/assistant/chat', {
      message,
      // Con `conversationId` el servidor usa el historial guardado e ignora este.
      history: history.slice(-HISTORY_TURNS),
      page,
      ...(conversationId ? { conversationId } : {}),
    })
    .then((reply) => withArtifacts(reply));
}

/** Turnos nuevos por SSE: solo progreso operativo real y la respuesta final ya validada. */
export async function askQapaqzitoStream(
  api: QapaqApiClient,
  message: string,
  history: readonly QapaqzitoTurn[],
  page: string,
  onProgress: (event: QapaqzitoProgressEvent) => void,
  conversationId?: string,
  signal?: AbortSignal,
  handlers: QapaqzitoStreamHandlers = {},
): Promise<QapaqzitoReply> {
  let response: Response;
  try {
    response = await api.postStream(
      '/assistant/chat/stream',
      {
        message,
        history: history.slice(-HISTORY_TURNS),
        page,
        ...(conversationId ? { conversationId } : {}),
      },
      signal,
    );
  } catch (error) {
    // Only retry when a gateway explicitly rejected streaming before the QAPAQ
    // handler accepted the request. Status 0/5xx is ambiguous and must not
    // trigger a second model call.
    if (isPreAcceptStreamRejection(error)) {
      onProgress({ type: 'transport_fallback' });
      return askQapaqzito(api, message, history, page, conversationId);
    }
    throw error;
  }
  if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    const value: unknown = await response.json();
    if (isQapaqzitoReply(value)) return withArtifacts(value);
    throw new QapaqApiError('DEPENDENCY_DEGRADED', response.status, null);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: QapaqzitoReply | null = null;
  const streamedArtifacts: ArtifactRef[] = [];
  let streamError: QapaqApiError | null = null;
  const consumeFrame = (frame: string) => {
    let event = '';
    let data = '';
    for (const line of frame.split(/\r?\n/u)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!event || !data) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      streamError = new QapaqApiError('DEPENDENCY_DEGRADED', response.status, null);
      return;
    }
    if (event === 'progress') onProgress(value as QapaqzitoProgressEvent);
    else if (event === 'artifact') {
      // Un artefacto fuera de contrato se ignora: nunca debe romper la respuesta.
      const artifact = parseArtifactRef(value);
      if (artifact && !streamedArtifacts.some((known) => known.id === artifact.id)) {
        streamedArtifacts.push(artifact);
        handlers.onArtifact?.(artifact);
      }
    } else if (event === 'delta') {
      const text = (value as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text !== '') handlers.onDelta?.(text);
    } else if (event === 'complete') completed = value as QapaqzitoReply;
    else if (event === 'error') {
      const error = value as { code?: unknown; correlationId?: unknown; fields?: unknown };
      const code = typeof error.code === 'string' ? error.code : 'DEPENDENCY_DEGRADED';
      streamError = new QapaqApiError(
        code as ConstructorParameters<typeof QapaqApiError>[0],
        response.status,
        typeof error.correlationId === 'string' ? error.correlationId : null,
        Array.isArray(error.fields)
          ? error.fields.filter((item): item is string => typeof item === 'string')
          : [],
      );
    }
  };
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0].length ?? 2;
        buffer = buffer.slice(boundary + separator);
        consumeFrame(frame);
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeFrame(buffer);
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw streamError;
  if (!completed) throw new QapaqApiError('DEPENDENCY_DEGRADED', response.status, null);
  return withArtifacts(completed, streamedArtifacts);
}

function isPreAcceptStreamRejection(error: unknown): error is QapaqApiError {
  return (
    error instanceof QapaqApiError &&
    error.correlationId === null &&
    [404, 405, 406, 415, 501].includes(error.status)
  );
}

function isQapaqzitoReply(value: unknown): value is QapaqzitoReply {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const reply = value as Partial<QapaqzitoReply>;
  return (
    typeof reply.reply === 'string' &&
    ['answered', 'budget', 'refused', 'truncated', 'unverified'].includes(String(reply.outcome)) &&
    Array.isArray(reply.steps) &&
    Array.isArray(reply.citations)
  );
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

export interface ConversationList {
  readonly items: readonly ConversationSummary[];
  readonly nextCursor: string | null;
}

export interface StoredMessage {
  readonly id: string | number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly steps?: readonly QapaqzitoStep[];
  readonly citations?: readonly QapaqzitoCitation[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly tone?: 'error' | 'notice';
  readonly feedback?: QapaqzitoFeedback;
  readonly createdAt?: string;
}

export interface StoredConversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly StoredMessage[];
}

const ID = /^[A-Za-z0-9-]{1,64}$/u;

function conversationPath(id: string): string {
  if (!ID.test(id)) throw new Error('Identificador de conversación no válido');
  return `/assistant/conversations/${id}`;
}

export function listConversations(api: QapaqApiClient, cursor?: string): Promise<ConversationList> {
  return api.get<ConversationList>('/assistant/conversations', {
    pageSize: 30,
    ...(cursor ? { cursor } : {}),
  });
}

export async function getConversation(api: QapaqApiClient, id: string): Promise<StoredConversation> {
  const stored = await api.get<StoredConversation>(conversationPath(id));
  if (!Array.isArray(stored?.messages)) return stored;
  return {
    ...stored,
    messages: stored.messages.map((message) => {
      const { artifacts, ...rest } = message;
      const parsed = parseArtifacts(artifacts);
      return parsed.length > 0 ? { ...rest, artifacts: parsed } : rest;
    }),
  };
}

export async function deleteConversation(api: QapaqApiClient, id: string): Promise<void> {
  return api.delete<void>(conversationPath(id));
}

export type QapaqzitoFeedback = 'up' | 'down';

/** Guarda (o quita, con `null`) la valoración 👍/👎 de una respuesta, con la conversación. */
export function rateMessage(
  api: QapaqApiClient,
  conversationId: string,
  messageId: string,
  rating: QapaqzitoFeedback | null,
): Promise<void> {
  if (!ID.test(messageId)) return Promise.reject(new Error('Identificador de mensaje no válido'));
  return api.put<void>(`${conversationPath(conversationId)}/messages/${messageId}/feedback`, {
    rating,
  });
}

/** Archivos vigentes del usuario (GET /assistant/artifacts), para la lista «Archivos». */
export async function listArtifacts(api: QapaqApiClient): Promise<ArtifactRef[]> {
  const body = await api.get<{ items?: unknown }>('/assistant/artifacts');
  return parseArtifacts(body?.items);
}

export function deleteAllConversations(api: QapaqApiClient): Promise<void> {
  return api.delete<void>('/assistant/conversations');
}

/** «hace 5 min», «ayer»… para la lista del historial (sin dependencias de i18n). */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60000); // sin separador `_`: el webpack 4 de OSD 2.19 no lo parsea
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return then.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
}

/** Ruta de la consola para abrir lo que Qapaqzito citó; `null` si no hay vista para ese tipo. */
export function citationPath(citation: QapaqzitoCitation): string | null {
  switch (citation.kind) {
    case 'alert':
      return `/app/qapaq-alerts?id=${encodeURIComponent(citation.id)}`;
    case 'incident':
      return `/app/qapaq-incidents?id=${encodeURIComponent(citation.id)}`;
    case 'source':
      return '/app/qapaq-sources';
    case 'audit':
      return '/app/qapaq-audit';
    default:
      return null;
  }
}

export interface Suggestion {
  readonly title: string;
  readonly prompt: string;
}

const REPORT_PDF: Suggestion = {
  title: 'Informe PDF de alertas P1/P2',
  prompt: 'Genera un informe PDF de alertas P1/P2 de las últimas 24 h',
};

const REPORT_XLSX: Suggestion = {
  title: 'Excel de alertas abiertas',
  prompt: 'Exporta a Excel las alertas abiertas de esta semana',
};

/** Ejemplos según la página (siempre 4: dos de contexto y dos de informes). */
export function suggestionsFor(page: string): readonly Suggestion[] {
  if (page.includes('qapaq-incidents')) {
    return [
      {
        title: 'Incidentes activos',
        prompt: '¿Qué incidentes siguen activos y cuál es el más urgente?',
      },
      {
        title: 'Borrador ejecutivo',
        prompt:
          'Prepara un borrador ejecutivo del incidente abierto, con alcance confirmado, incertidumbres, cronología y fuentes citadas.',
      },
      REPORT_PDF,
      REPORT_XLSX,
    ];
  }
  if (page.includes('qapaq-alerts')) {
    return [
      {
        title: 'Priorizar cola',
        prompt:
          'Revisa las alertas abiertas recientes y destaca primero las que requieren atención, explicando evidencia y confianza. No cambies su prioridad.',
      },
      {
        title: 'Correlacionar actividad',
        prompt:
          'Investiga la alerta seleccionada y correlaciona actividad de sus entidades en la ventana relevante; separa hechos, hipótesis y brechas de telemetría.',
      },
      REPORT_PDF,
      REPORT_XLSX,
    ];
  }
  if (page.includes('qapaq-sources')) {
    return [
      {
        title: 'Salud de fuentes',
        prompt: '¿Hay fuentes de datos degradadas o sin eventos recientes?',
      },
      { title: 'Última recepción', prompt: '¿Cuándo llegó el último evento de cada fuente?' },
      REPORT_PDF,
      REPORT_XLSX,
    ];
  }
  if (page.includes('qapaq-audit')) {
    return [
      {
        title: 'Cambios de acceso',
        prompt: '¿Quién cambió roles o accesos en los últimos 7 días?',
      },
      { title: 'Integridad', prompt: 'Verifica la integridad de la cadena de auditoría.' },
      REPORT_PDF,
      REPORT_XLSX,
    ];
  }
  return [
    {
      title: 'Triage de la P1 más reciente',
      prompt:
        'Haz el triage de la alerta P1 abierta más reciente: evidencia, severidad, MITRE y acciones.',
    },
    {
      title: 'Resumen semanal del SOC',
      prompt:
        'Prepara el resumen semanal del SOC: alertas por prioridad y proveedor, incidentes activos y salud de las fuentes.',
    },
    REPORT_PDF,
    REPORT_XLSX,
  ];
}
