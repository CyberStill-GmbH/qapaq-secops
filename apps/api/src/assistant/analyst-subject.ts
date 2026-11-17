/**
 * Analista IA — detalles estructurados del evento de la alerta, por lista blanca y por dominio.
 *
 * Las alertas sin usuario ni IP (vulnerabilidades, salud de plataforma, FIM, rootcheck) traen
 * lo importante en campos del registro Wazuh (`data.qapaq.vuln.*`, `data.qapaq.health.*`,
 * `syscheck.*`…). Aquí se toma SOLO esa lista blanca del evento de la propia alerta, con
 * cadenas enmascaradas y recortadas; el registro crudo nunca sale del API.
 */

import type { EvidenceDomain, EvidenceSubject } from '@qapaq/assistant';
import type { JsonObject, JsonValue } from '@qapaq/connectors';
import { maskText } from '@qapaq/soar';

const MAX_DETAILS = 20;
const MAX_TEXT = 200;

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function scalar(value: JsonValue | undefined): string | number | boolean | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const flat = value.replace(/\p{Cc}+/gu, ' ').trim();
    return flat.length > 0 ? maskText(flat).slice(0, MAX_TEXT) : null;
  }
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string').slice(0, 8);
    return items.length > 0 ? maskText(items.join(', ')).slice(0, MAX_TEXT) : null;
  }
  return null;
}

/** Copia los campos escalares de un objeto (o solo los pedidos), con prefijo. */
function pick(
  out: Record<string, string | number | boolean>,
  source: JsonObject | null,
  prefix: string,
  keys?: readonly string[],
): void {
  if (!source) return;
  for (const key of keys ?? Object.keys(source)) {
    if (Object.keys(out).length >= MAX_DETAILS) return;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/u.test(key)) continue;
    const value = scalar(source[key]);
    if (value !== null) out[`${prefix}${key}`] = value;
  }
}

const HEALTH_KEYS = ['check', 'status', 'severity', 'component', 'summary', 'source', 'last_seen'];
const SYSCHECK_KEYS = ['path', 'event', 'changed_attributes', 'size_after', 'uname_after', 'gname_after', 'mtime_after'];

/** Dominio y detalles del evento de la alerta. `groups`: grupos de la regla (conocimiento SOC). */
export function subjectFromRaw(
  raw: JsonObject | null,
  groups: readonly string[] = [],
  hasIdentity = false,
): EvidenceSubject {
  const details: Record<string, string | number | boolean> = {};
  const data = object(raw?.['data']);
  const qapaq = object(data?.['qapaq']);
  const vuln = object(qapaq?.['vuln']);
  const health = object(qapaq?.['health']);
  const syscheck = object(raw?.['syscheck']);
  const snyk = object(data?.['snyk']);
  let domain: EvidenceDomain = 'generic';

  if (vuln) {
    domain = 'vulnerability';
    pick(details, vuln, '');
  } else if (snyk || groups.includes('qapaq_vulnerability') || groups.includes('vulnerability-detector')) {
    domain = 'vulnerability';
    const issue = object(snyk?.['issue']);
    pick(details, issue, '', ['severity', 'title', 'type', 'status', 'isFixable', 'isUpgradable', 'isPatchable', 'exploitMaturity', 'priorityScore', 'cve', 'cvssScore']);
    pick(details, object(snyk?.['project']), 'project_', ['name', 'type']);
    pick(details, object(data?.['vulnerability']), '', ['cve', 'severity', 'title']);
  } else if (health || groups.includes('qapaq_platform')) {
    domain = 'platform';
    pick(details, health, '', HEALTH_KEYS);
  } else if (syscheck || groups.includes('syscheck')) {
    domain = 'file_integrity';
    pick(details, syscheck, '', SYSCHECK_KEYS);
    const audit = object(syscheck?.['audit']);
    pick(details, object(audit?.['process']), 'process_', ['name']);
  } else if (groups.includes('rootcheck')) {
    domain = 'rootcheck';
    pick(details, data, '', ['title', 'file']);
    const fullLog = scalar(raw?.['full_log']);
    if (fullLog !== null) details['full_log'] = fullLog;
  } else if (hasIdentity) {
    domain = 'identity';
    pick(details, object(data?.['office365']), '', ['Operation', 'Workload', 'ResultStatus', 'LogonType']);
  }
  const rule = object(raw?.['rule']);
  if (rule && Object.keys(details).length < MAX_DETAILS) {
    const level = rule['level'];
    if (typeof level === 'number') details['rule_level'] = level;
  }
  return { domain, details };
}
