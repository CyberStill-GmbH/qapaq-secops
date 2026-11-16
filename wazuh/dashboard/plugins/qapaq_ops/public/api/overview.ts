/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { OVERVIEW_ROUTE, OverviewResponse, RESPOND_PATH } from '../../common';
import { QapaqApiError } from './client';

/**
 * Ruta del propio plugin en OSD (no la API QAPAQ): el servidor del dashboard consulta el Indexer
 * con la identidad de quien mira. Un GET no necesita `osd-xsrf`; se envía igual por si el
 * dashboard lo exige en el futuro.
 */
export async function fetchOverview(
  basePath: string,
  fetchImpl: typeof fetch = (...args) => window.fetch(...args),
): Promise<OverviewResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${basePath}${OVERVIEW_ROUTE}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'osd-xsrf': 'true' },
      cache: 'no-store',
    });
  } catch {
    throw new QapaqApiError('DEPENDENCY_DEGRADED', 0, null);
  }
  if (!response.ok) {
    throw new QapaqApiError(
      response.status === 401 ? 'AUTH_REQUIRED' : 'DEPENDENCY_DEGRADED',
      response.status,
      null,
    );
  }
  return (await response.json()) as OverviewResponse;
}

/** ¿Responde Ankay detrás del edge? Solo el estado HTTP; no lee el contenido. */
export async function probeRespond(
  basePath: string,
  fetchImpl: typeof fetch = (...args) => window.fetch(...args),
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${basePath}${RESPOND_PATH}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
    });
    return response.ok;
  } catch {
    return false;
  }
}
