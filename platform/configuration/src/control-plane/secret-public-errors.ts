import type { SecretControlPlaneErrorCode } from './secret-lifecycle.types.js';

/**
 * Forma publicada de un error, conforme a `docs/reference/error-catalog.md`. `correlationId`
 * lo añade la capa de presentación; aquí solo vive la parte estable del contrato.
 */
export interface PublicSecretError {
  readonly code: string;
  readonly status: number;
  readonly helpRef: string;
  readonly retryable: boolean;
}

/**
 * Traducción de los códigos internos al catálogo publicado. La presentación HTTP de
 * Sprint 3 debe usar exclusivamente esta tabla: los códigos internos describen la
 * causa para diagnóstico y no se exponen tal cual, de modo que un cambio interno no
 * rompa el contrato externo ni revele la topología del control plane.
 *
 * Ningún mensaje se deriva del error interno: `docs/reference/error-catalog.md` fija el texto
 * seguro por `helpRef`.
 */
const PUBLIC_ERRORS: Readonly<Record<SecretControlPlaneErrorCode, PublicSecretError>> =
  Object.freeze({
    SECRET_REQUEST_INVALID: {
      code: 'REQUEST_INVALID',
      status: 400,
      helpRef: 'ERR-INPUT-001',
      retryable: false,
    },
    SECRET_UNAUTHENTICATED: {
      code: 'AUTH_REQUIRED',
      status: 401,
      helpRef: 'ERR-AUTH-001',
      retryable: false,
    },
    // 403/404 comparten código: el catálogo evita enumerar recursos existentes.
    SECRET_FORBIDDEN: {
      code: 'ACCESS_DENIED',
      status: 403,
      helpRef: 'ERR-AUTHZ-001',
      retryable: false,
    },
    SECRET_NOT_FOUND: {
      code: 'ACCESS_DENIED',
      status: 404,
      helpRef: 'ERR-AUTHZ-001',
      retryable: false,
    },
    SECRET_DUPLICATE: {
      code: 'RESOURCE_STATE_CONFLICT',
      status: 409,
      helpRef: 'ERR-STATE-001',
      retryable: false,
    },
    SECRET_TRANSITION_INVALID: {
      code: 'RESOURCE_STATE_CONFLICT',
      status: 409,
      helpRef: 'ERR-STATE-001',
      retryable: false,
    },
    SECRET_ROTATION_CONFLICT: {
      code: 'RESOURCE_STATE_CONFLICT',
      status: 409,
      helpRef: 'ERR-STATE-001',
      retryable: false,
    },
    SECRET_PROVIDER_REJECTED: {
      code: 'INTEGRATION_CREDENTIAL_REJECTED',
      status: 422,
      helpRef: 'ERR-SECRET-001',
      retryable: false,
    },
    SECRET_PROVIDER_UNAVAILABLE: {
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: true,
    },
    SECRET_PROVIDER_TIMEOUT: {
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: true,
    },
    SECRET_REVOCATION_FAILED: {
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: true,
    },
    SECRET_PERSISTENCE_FAILED: {
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-DEPENDENCY-001',
      retryable: true,
    },
    // Estado externo incierto: reintentar a ciegas podría duplicar una versión.
    // Requiere la reconciliación que el control plane ya registra.
    SECRET_EXTERNAL_STATE_INCONSISTENT: {
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: false,
    },
  });

export function toPublicSecretError(code: SecretControlPlaneErrorCode): PublicSecretError {
  return PUBLIC_ERRORS[code];
}
