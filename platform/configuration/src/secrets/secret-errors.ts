import {
  ConfigurationError,
  configurationError,
  type ConfigurationProfileName,
} from '../configuration.errors.js';

export type SecretProviderErrorCode =
  | 'SECRET_NOT_FOUND'
  | 'SECRET_ACCESS_DENIED'
  | 'SECRET_PROVIDER_UNAVAILABLE'
  | 'SECRET_RESOLUTION_FAILED';

export class SecretProviderError extends Error {
  public readonly code: SecretProviderErrorCode;

  public constructor(code: SecretProviderErrorCode) {
    super('El proveedor de secretos no pudo completar la operación.');
    this.name = 'SecretProviderError';
    this.code = code;
  }
}

export function normalizeSecretError(
  error: unknown,
  path: string,
  profile: ConfigurationProfileName,
): ConfigurationError {
  if (error instanceof SecretProviderError) return configurationError(error.code, path, profile);
  return configurationError('SECRET_RESOLUTION_FAILED', path, profile);
}
