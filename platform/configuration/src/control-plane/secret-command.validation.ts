import { CONFIGURATION_LIMITS } from '../limits.js';
import { SENSITIVE_KEY_PATTERN } from '../redaction/sensitive-keys.js';
import {
  parseSecretReference,
  secretReferenceNamespace,
  type SecretReference,
} from '../secrets/index.js';
import { secretControlPlaneError } from './secret-lifecycle.errors.js';
import type { SecretLabels, SecretOperationContext } from './secret-lifecycle.types.js';

const PURPOSE_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:@-]{1,127}$/u;
const LABEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

function ensure(condition: boolean, path: string): void {
  if (!condition) throw secretControlPlaneError('SECRET_REQUEST_INVALID', path);
}

export function validateReference(value: unknown): SecretReference {
  try {
    return parseSecretReference(value, 'reference');
  } catch {
    throw secretControlPlaneError('SECRET_REQUEST_INVALID', 'reference');
  }
}

export function validatePurpose(value: unknown): string {
  ensure(typeof value === 'string' && PURPOSE_PATTERN.test(value), 'purpose');
  return value as string;
}

export function validateOwner(value: unknown): string {
  ensure(
    typeof value === 'string' &&
      value.length <= CONFIGURATION_LIMITS.secretOwnerMaximumLength &&
      OWNER_PATTERN.test(value),
    'owner',
  );
  return value as string;
}

/**
 * Las etiquetas son el único campo libre persistido, por lo que se restringen para
 * que no puedan usarse como almacén encubierto: clave con forma no sensible, valor
 * corto y charset imprimible sin saltos de línea.
 */
export function validateLabels(value: unknown): SecretLabels {
  if (value === undefined) return Object.freeze({});
  ensure(typeof value === 'object' && value !== null && !Array.isArray(value), 'labels');
  const entries = Object.entries(value as Record<string, unknown>);
  ensure(entries.length <= CONFIGURATION_LIMITS.secretLabelMaximumEntries, 'labels');
  const labels: Record<string, string> = {};
  for (const [key, entry] of entries) {
    ensure(LABEL_KEY_PATTERN.test(key), `labels.${key}`);
    ensure(!SENSITIVE_KEY_PATTERN.test(key), `labels.${key}`);
    ensure(
      typeof entry === 'string' &&
        entry.length <= CONFIGURATION_LIMITS.secretLabelMaximumLength &&
        LABEL_VALUE_PATTERN.test(entry),
      `labels.${key}`,
    );
    labels[key] = entry as string;
  }
  return Object.freeze(labels);
}

export function validateContext(context: SecretOperationContext): SecretOperationContext {
  ensure(IDENTIFIER_PATTERN.test(context.requestId), 'requestId');
  ensure(IDENTIFIER_PATTERN.test(context.correlationId), 'correlationId');
  ensure(
    context.actor.actorType === 'human' || context.actor.actorType === 'service',
    'actor.actorType',
  );
  ensure(
    typeof context.actor.actorId === 'string' && OWNER_PATTERN.test(context.actor.actorId),
    'actor.actorId',
  );
  ensure(
    context.occurredAt instanceof Date && !Number.isNaN(context.occurredAt.getTime()),
    'occurredAt',
  );
  return context;
}

export function validateExpiry(value: unknown, now: Date): Date | undefined {
  if (value === undefined) return undefined;
  ensure(value instanceof Date && !Number.isNaN((value as Date).getTime()), 'expiresAt');
  ensure((value as Date).getTime() > now.getTime(), 'expiresAt');
  return value as Date;
}

export function namespaceOf(reference: SecretReference): string {
  return secretReferenceNamespace(reference);
}
