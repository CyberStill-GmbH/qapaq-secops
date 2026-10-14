/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { AlertEntity } from './api_contract';

/**
 * Enlace profundo de una alerta QAPAQ a Discover (sección SIEM), filtrado por la entidad y
 * por una ventana de tiempo alrededor del evento.
 *
 * OSD 2.19 sirve Discover en `data-explorer/discover` con estado rison en el *hash*
 * (`_a`, `_g`, `_q`). El valor de la entidad (UPN o IP) va solo en el fragmento: el navegador
 * no lo envía al servidor ni queda en los registros del proxy.
 */

/** Patrón de índice que el plugin de Wazuh crea por defecto (id = título). */
export const ALERTS_INDEX_PATTERN = 'wazuh-alerts-*';

/** Campos del índice de alertas por tipo de entidad (normalización de qapaq-secops/telemetry). */
const ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  user: ['data.office365.UserId'],
  ip: ['data.office365.ClientIP', 'data.srcip'],
  host: ['agent.name'],
};

/** Ventana por defecto: 1 h antes y 1 h después del evento. */
const WINDOW_MS = 60 * 60 * 1000;

/** Cadena rison: siempre entre comillas; `!` → `!!` y `'` → `!'`. */
export function risonString(value: string): string {
  return `'${value.replace(/!/gu, '!!').replace(/'/gu, "!'")}'`;
}

/** Literal entre comillas dobles de KQL/DQL: escapa `\` y `"`. */
export function kqlQuoted(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export function entityQuery(entity: AlertEntity): string | null {
  const fields = ENTITY_FIELDS[entity.kind];
  if (!fields || !entity.label) return null;
  return fields.map((field) => `${field}:${kqlQuoted(entity.label)}`).join(' or ');
}

export function discoverUrlForEntity(
  basePath: string,
  entity: AlertEntity,
  occurredAt: string,
  windowMs: number = WINDOW_MS,
): string | null {
  const query = entityQuery(entity);
  const at = Date.parse(occurredAt);
  if (!query || Number.isNaN(at)) return null;
  const from = new Date(at - windowMs).toISOString();
  const to = new Date(at + windowMs).toISOString();
  const app = `(discover:(columns:!(_source),isDirty:!f,sort:!()),metadata:(indexPattern:${risonString(
    ALERTS_INDEX_PATTERN,
  )},view:discover))`;
  const global = `(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:${risonString(
    from,
  )},to:${risonString(to)}))`;
  const q = `(filters:!(),query:(language:kuery,query:${risonString(query)}))`;
  return `${basePath}/app/data-explorer/discover#?_a=${encodeURIComponent(
    app,
  )}&_g=${encodeURIComponent(global)}&_q=${encodeURIComponent(q)}`;
}
