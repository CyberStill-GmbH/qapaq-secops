/**
 * Sprint 5 · fase 1 — compilador de filtros del explorador de eventos para el Indexer de Wazuh.
 *
 * Strategy inyectada en el proveedor de C-28: traduce filtros neutrales (vocabulario del
 * contrato `SecurityEvent`) a cláusulas `bool.filter` con las tablas inversas de la
 * normalización, de modo que filtrar y normalizar usan la misma definición.
 *
 * - Severidad: OR de rangos de `rule.level`, uno por banda pedida. Nunca un rango envolvente
 *   que incluya severidades no pedidas.
 * - Categoría y resultado: `terms` sobre `rule.groups`.
 * - Un valor fuera del catálogo o que no se puede empujar (`unclassified`, `unknown`) devuelve
 *   `undefined` y el proveedor rechaza la consulta.
 */

import { EVENT_ENTITY_FILTER_LIMITS, type EventFilters, type JsonObject } from '@qapaq/connectors';
import {
  NORMALIZED_SEVERITIES,
  SECURITY_EVENT_CATEGORIES,
  type SecurityEvent,
  type SecurityEventCategory,
} from '@qapaq/contracts';
import {
  wazuhGroupsForCategories,
  wazuhGroupsForOutcome,
  wazuhLevelRangesFor,
} from '@qapaq/telemetry/wazuh';

type Severity = SecurityEvent['severity']['normalized'];

export function compileWazuhEventFilters(filters: EventFilters): readonly JsonObject[] | undefined {
  const clauses: JsonObject[] = [];

  if (filters.severity && filters.severity.length > 0) {
    if (
      !filters.severity.every((value) =>
        (NORMALIZED_SEVERITIES as readonly string[]).includes(value),
      )
    )
      return undefined;
    const ranges = wazuhLevelRangesFor(filters.severity as Severity[]);
    clauses.push({
      bool: {
        should: ranges.map((range) => ({
          range: { 'rule.level': { gte: range.gte, lte: range.lte } },
        })),
        minimum_should_match: 1,
      },
    });
  }

  if (filters.category && filters.category.length > 0) {
    if (
      !filters.category.every((value) =>
        (SECURITY_EVENT_CATEGORIES as readonly string[]).includes(value),
      )
    )
      return undefined;
    const groups = wazuhGroupsForCategories(filters.category as SecurityEventCategory[]);
    if (!groups || groups.length === 0) return undefined;
    clauses.push({ terms: { 'rule.groups': [...groups] } });
  }

  if (filters.outcome) {
    const groups = wazuhGroupsForOutcome(filters.outcome as SecurityEvent['outcome']);
    if (!groups) return undefined;
    clauses.push({ terms: { 'rule.groups': [...groups] } });
  }

  if (filters.entities && filters.entities.length > 0) {
    const entityClause = compileEntityFilter(filters.entities);
    if (!entityClause) return undefined;
    clauses.push(entityClause);
  }

  return clauses;
}

/**
 * Campos de los que la normalización (`@qapaq/telemetry/wazuh`) toma usuario e IP, más los de
 * Windows. `full_log` (texto analizado) es el respaldo para formatos que no los separan.
 */
export const WAZUH_ENTITY_FIELDS = Object.freeze({
  user: [
    'data.srcuser',
    'data.dstuser',
    'data.office365.UserId',
    'data.win.eventdata.targetUserName',
    'data.win.eventdata.subjectUserName',
  ],
  ip: ['data.srcip', 'data.dstip', 'data.office365.ClientIP'],
});

const ENTITY_VALUE = /^[^\p{Cc}]+$/u;

/** OR de coincidencias exactas por entidad (usuario sin distinguir mayúsculas); nunca lenguaje de consulta. */
function compileEntityFilter(
  entities: NonNullable<EventFilters['entities']>,
): JsonObject | undefined {
  if (entities.length > EVENT_ENTITY_FILTER_LIMITS.maxEntities) return undefined;
  const should: JsonObject[] = [];
  for (const entity of entities) {
    const value = entity.value;
    if (
      (entity.kind !== 'user' && entity.kind !== 'ip') ||
      typeof value !== 'string' ||
      value.length < EVENT_ENTITY_FILTER_LIMITS.minChars ||
      value.length > EVENT_ENTITY_FILTER_LIMITS.maxChars ||
      !ENTITY_VALUE.test(value)
    )
      return undefined;
    for (const field of WAZUH_ENTITY_FIELDS[entity.kind]) {
      should.push(
        entity.kind === 'user'
          ? { term: { [field]: { value, case_insensitive: true } } }
          : { term: { [field]: value } },
      );
    }
    should.push({ match_phrase: { full_log: value } });
  }
  return { bool: { should, minimum_should_match: 1 } };
}
