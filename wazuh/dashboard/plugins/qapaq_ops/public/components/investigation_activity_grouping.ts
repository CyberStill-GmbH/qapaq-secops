/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { InvestigationEventSummary } from '../../common';

/** A temporal cluster for review; it does not imply causality or a message thread. */
export interface InvestigationActivityGroup {
  readonly entity: string;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly events: readonly InvestigationEventSummary[];
}

export const DEFAULT_ACTIVITY_GAP_MS = 15 * 60 * 1000;
export const INVESTIGATION_ACTIVITY_CSV_HEADER = Object.freeze([
  'Tipo',
  'Entidad coincidente',
  'Primera observación UTC',
  'Última observación UTC',
  'Eventos',
  'Fuentes',
  'Reglas',
  'IDs de eventos',
]);

/**
 * Group summaries that share a matched entity and are at most `gapMs` apart.
 * An event matching multiple queried entities appears in each matching entity group.
 */
export function groupInvestigationActivity(
  events: readonly InvestigationEventSummary[],
  gapMs = DEFAULT_ACTIVITY_GAP_MS,
): InvestigationActivityGroup[] {
  const allowedGap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : DEFAULT_ACTIVITY_GAP_MS;
  const byEntity = new Map<string, InvestigationEventSummary[]>();
  for (const event of events) {
    const timestamp = Date.parse(event.at);
    if (!Number.isFinite(timestamp)) continue;
    for (const entity of new Set(event.matched)) {
      const list = byEntity.get(entity) ?? [];
      list.push(event);
      byEntity.set(entity, list);
    }
  }

  const groups: InvestigationActivityGroup[] = [];
  for (const [entity, items] of byEntity) {
    const ordered = [...items].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    let bucket: InvestigationEventSummary[] = [];
    const flush = () => {
      if (bucket.length === 0) return;
      groups.push({
        entity,
        firstAt: bucket[0]!.at,
        lastAt: bucket[bucket.length - 1]!.at,
        events: bucket,
      });
      bucket = [];
    };
    for (const event of ordered) {
      const previous = bucket[bucket.length - 1];
      if (previous && Date.parse(event.at) - Date.parse(previous.at) > allowedGap) flush();
      bucket.push(event);
    }
    flush();
  }
  return groups.sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt));
}

/** Spreadsheet rows that can be appended to the investigation CSV export. */
export function investigationActivityCsvRows(
  groups: readonly InvestigationActivityGroup[],
): readonly (readonly string[])[] {
  return groups.map((group) => [
    'Grupo de actividad temporal',
    group.entity,
    group.firstAt,
    group.lastAt,
    String(group.events.length),
    [...new Set(group.events.map((event) => event.vendor))].sort().join(' | '),
    [...new Set(group.events.map((event) => event.ruleId))].sort().join(' | '),
    group.events.map((event) => event.id).join(' | '),
  ]);
}
