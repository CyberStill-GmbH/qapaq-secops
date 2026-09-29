export const SECRET_CONTROL_PLANE_ERROR_CODES = [
  'SECRET_REQUEST_INVALID',
  'SECRET_ALREADY_CONSUMED',
  'SECRET_AUTHORIZATION_DENIED',
  'SECRET_ALREADY_REGISTERED',
  'SECRET_NOT_REGISTERED',
  'SECRET_NOT_ACTIVE',
  'SECRET_ROTATION_CONFLICT',
  'SECRET_PROVIDER_REJECTED',
  'SECRET_PROVIDER_UNREACHABLE',
  'SECRET_RECONCILIATION_REQUIRED',
  'SECRET_AUDIT_WRITE_REQUIRED',
  'SECRET_OPERATION_FAILED',
] as const;

export type SecretControlPlaneErrorCode = (typeof SECRET_CONTROL_PLANE_ERROR_CODES)[number];

export type SecretLifecycleOperation = 'create' | 'rotate' | 'revoke' | 'readMetadata';

/**
 * Error del control plane. El mensaje es el propio código: no transporta el valor
 * enviado, el detalle del proveedor ni la referencia resuelta.
 */
export class SecretControlPlaneError extends Error {
  public readonly code: SecretControlPlaneErrorCode;
  public readonly path: string;
  public readonly retryable: boolean;

  public constructor(code: SecretControlPlaneErrorCode, path: string, retryable: boolean) {
    super(code);
    this.name = 'SecretControlPlaneError';
    this.code = code;
    this.path = path;
    this.retryable = retryable;
  }

  public toJSON(): Readonly<Record<string, string | boolean>> {
    return { code: this.code, path: this.path, retryable: this.retryable };
  }
}

const RETRYABLE: ReadonlySet<SecretControlPlaneErrorCode> = new Set([
  'SECRET_PROVIDER_UNREACHABLE',
  'SECRET_AUDIT_WRITE_REQUIRED',
]);

export function secretControlPlaneError(
  code: SecretControlPlaneErrorCode,
  path: string,
): SecretControlPlaneError {
  return new SecretControlPlaneError(code, path, RETRYABLE.has(code));
}

export interface PublicErrorMapping {
  readonly code: string;
  readonly status: number;
  readonly helpRef: string;
  readonly retryable: boolean;
}

/**
 * Traducción al catálogo público de `docs/error-catalog.md`. La presentación HTTP
 * de Sprint 3 debe usar exclusivamente esta tabla: los códigos internos describen
 * la causa para diagnóstico y no se publican tal cual.
 */
const PUBLIC_ERRORS: Readonly<Record<SecretControlPlaneErrorCode, PublicErrorMapping>> =
  Object.freeze({
    SECRET_REQUEST_INVALID: {
      code: 'REQUEST_INVALID',
      status: 400,
      helpRef: 'ERR-INPUT-001',
      retryable: false,
    },
    SECRET_ALREADY_CONSUMED: {
      code: 'REQUEST_INVALID',
      status: 400,
      helpRef: 'ERR-INPUT-001',
      retryable: false,
    },
    SECRET_AUTHORIZATION_DENIED: {
      code: 'ACCESS_DENIED',
      status: 403,
      helpRef: 'ERR-AUTHZ-001',
      retryable: false,
    },
    SECRET_ALREADY_REGISTERED: {
      code: 'RESOURCE_STATE_CONFLICT',
      status: 409,
      helpRef: 'ERR-STATE-001',
      retryable: false,
    },
    SECRET_NOT_REGISTERED: {
      code: 'ACCESS_DENIED',
      status: 404,
      helpRef: 'ERR-AUTHZ-001',
      retryable: false,
    },
    SECRET_NOT_ACTIVE: {
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
    SECRET_PROVIDER_UNREACHABLE: {
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: true,
    },
    SECRET_RECONCILIATION_REQUIRED: {
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: false,
    },
    SECRET_AUDIT_WRITE_REQUIRED: {
      code: 'AUDIT_WRITE_REQUIRED',
      status: 503,
      helpRef: 'ERR-AUDIT-001',
      retryable: true,
    },
    SECRET_OPERATION_FAILED: {
      code: 'UNEXPECTED_ERROR',
      status: 500,
      helpRef: 'ERR-INTERNAL-001',
      retryable: false,
    },
  });

export function toPublicError(code: SecretControlPlaneErrorCode): PublicErrorMapping {
  return PUBLIC_ERRORS[code];
}
