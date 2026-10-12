/**
 * C-16 — contexto de negocio para la priorización QAPAQ.
 *
 * Wazuh decide que algo es una alerta; QAPAQ decide qué merece atención primero. Esa
 * decisión depende de datos que el SIEM no tiene: quién es administrador, qué cuentas
 * son de emergencia (break-glass), qué activos son críticos y qué reglas se aceptaron
 * como benignas. Sin este contexto la priorización solo reetiqueta el nivel de la regla.
 *
 * Fuente: variables de entorno del despliegue, nunca el repositorio (R-20). Los valores
 * son identificadores operativos —UPN, IDs de activo, IDs de regla—, no secretos, pero sí
 * datos internos: se cargan por ambiente y no se registran en logs.
 *
 * Reglas de validación:
 *
 * - Todas las listas son opcionales: un ambiente sin contexto arranca y prioriza solo por
 *   severidad, que es el comportamiento anterior. Lo que no se admite es contexto mal
 *   formado: falla al arrancar en lugar de ignorar entradas en silencio.
 * - Identidades y activos se comparan sin distinguir mayúsculas (los UPN de Entra no las
 *   distinguen), por eso se normalizan a minúsculas aquí y una sola vez.
 * - Una regla benigna exige referencia documental (`id:referencia`): suprimir una regla
 *   sin acuerdo trazable es apagar una detección sin dejar rastro.
 */

import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { optionalString } from './environment.schema.js';

export const DETECTION_CONTEXT_LIMITS = Object.freeze({
  /** Una lista mayor indica que se está usando la variable como inventario: no es su lugar. */
  maximumEntries: 500,
  maximumEntryLength: 320,
  maximumReferenceLength: 128,
});

export interface KnownBenignRule {
  readonly ruleId: string;
  /** Ticket, acta o cambio aprobado que justifica la supresión. */
  readonly reference: string;
}

export interface DetectionContextConfig {
  readonly privilegedIdentities: readonly string[];
  readonly breakGlassIdentities: readonly string[];
  readonly criticalAssets: readonly string[];
  readonly internetFacingAssets: readonly string[];
  readonly knownBenignRules: readonly KnownBenignRule[];
}

/** Sin espacios ni separadores de lista dentro de una entrada. */
const ENTRY_PATTERN = /^[^\s,;]+$/u;
const RULE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

function parseEntries(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
  name: string,
): readonly string[] {
  const raw = optionalString(environment, profile, name);
  if (raw === undefined) return Object.freeze([]);
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length > DETECTION_CONTEXT_LIMITS.maximumEntries) {
    throw configurationError('CONFIG_LIMIT_INVALID', name, profile.name, {
      maximum: DETECTION_CONTEXT_LIMITS.maximumEntries,
    });
  }
  for (const entry of entries) {
    if (entry.length > DETECTION_CONTEXT_LIMITS.maximumEntryLength || !ENTRY_PATTERN.test(entry)) {
      throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
    }
  }
  return Object.freeze([...new Set(entries)]);
}

function lowerCased(entries: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(entries.map((entry) => entry.toLowerCase()))]);
}

function parseKnownBenignRules(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): readonly KnownBenignRule[] {
  const name = 'QAPAQ_DETECTION_KNOWN_BENIGN_RULES';
  const rules = parseEntries(environment, profile, name).map((entry) => {
    const separator = entry.indexOf(':');
    const ruleId = separator > 0 ? entry.slice(0, separator) : '';
    const reference = separator > 0 ? entry.slice(separator + 1) : '';
    if (
      !RULE_ID_PATTERN.test(ruleId) ||
      reference.length === 0 ||
      reference.length > DETECTION_CONTEXT_LIMITS.maximumReferenceLength
    ) {
      throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
    }
    return Object.freeze({ ruleId, reference });
  });
  const ids = rules.map((rule) => rule.ruleId);
  if (new Set(ids).size !== ids.length) {
    throw configurationError('CONFIG_VALUE_INVALID', name, profile.name);
  }
  return Object.freeze(rules);
}

export function parseDetectionContext(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): DetectionContextConfig {
  const privilegedIdentities = lowerCased(
    parseEntries(environment, profile, 'QAPAQ_DETECTION_PRIVILEGED_IDENTITIES'),
  );
  const breakGlassIdentities = lowerCased(
    parseEntries(environment, profile, 'QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES'),
  );
  return {
    // Una cuenta break-glass es privilegiada por definición; se agrega para que basten
    // las dos variables sin tener que repetir la cuenta en ambas.
    privilegedIdentities: Object.freeze([
      ...new Set([...privilegedIdentities, ...breakGlassIdentities]),
    ]),
    breakGlassIdentities,
    criticalAssets: lowerCased(
      parseEntries(environment, profile, 'QAPAQ_DETECTION_CRITICAL_ASSETS'),
    ),
    internetFacingAssets: lowerCased(
      parseEntries(environment, profile, 'QAPAQ_DETECTION_INTERNET_FACING_ASSETS'),
    ),
    knownBenignRules: parseKnownBenignRules(environment, profile),
  };
}
