import { configurationError } from '../configuration.errors.js';
import { CONFIGURATION_LIMITS } from '../limits.js';

const SECRET_REFERENCE_PATTERN =
  /^secret:\/\/[a-z][a-z0-9-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;

declare const secretReferenceBrand: unique symbol;
export type SecretReference = string & { readonly [secretReferenceBrand]: true };

export function parseSecretReference(value: unknown, path = 'secretRef'): SecretReference {
  if (
    typeof value !== 'string' ||
    value.length > CONFIGURATION_LIMITS.secretReferenceMaximumLength ||
    !SECRET_REFERENCE_PATTERN.test(value) ||
    value.includes('/../') ||
    value.endsWith('/..')
  ) {
    throw configurationError('SECRET_REFERENCE_INVALID', path);
  }
  return value as SecretReference;
}

export function secretReferenceNamespace(reference: SecretReference): string {
  return reference.slice('secret://'.length, reference.indexOf('/', 'secret://'.length));
}
