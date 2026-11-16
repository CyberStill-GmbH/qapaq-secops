/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { Alert, Priority } from '../../common';

/** Contexto del correlador que la API agrega a cada alerta de «requieren atención». */
export interface AttentionInfo {
  readonly score: number;
  readonly why: string | null;
  readonly entityRisk: number | null;
}

export type AttentionAlert = Alert & { readonly attention?: AttentionInfo };

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

/** Orden histórico (prioridad y luego más reciente): el de respaldo sin correlador. */
export function sortByPriorityThenRecency(items: readonly Alert[], limit: number): AttentionAlert[] {
  return [...items]
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        b.occurredAt.localeCompare(a.occurredAt),
    )
    .slice(0, limit);
}

interface AttentionApi {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

/**
 * Alertas abiertas por atención (prioridad + riesgo de entidad + cadena, según la API). Si la
 * ruta falla, no existe (API anterior) o devuelve algo inesperado, usa el orden histórico sobre
 * `fallback`: la vista general nunca muestra un error por esto.
 */
export async function loadAttentionTop(
  api: AttentionApi,
  fallback: readonly Alert[],
  limit: number,
): Promise<AttentionAlert[]> {
  try {
    const response = await api.get<{ items?: unknown }>('/risk/attention', { limit });
    if (Array.isArray(response.items) && response.items.length > 0) {
      return (response.items as AttentionAlert[]).slice(0, limit);
    }
  } catch {
    // degradar al orden histórico
  }
  return sortByPriorityThenRecency(fallback, limit);
}
