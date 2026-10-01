/**
 * C-27 — traducción de fallos de dominio a la respuesta pública.
 *
 * Nada que venga del dominio llega al cliente sin pasar por aquí. Esto es lo que impide
 * que un mensaje interno —el nombre de una tabla, una ruta, un motivo de denegación—
 * se filtre en una respuesta. El motivo real se conserva en la auditoría, donde sí tiene
 * lectores autorizados.
 */

import { HttpException } from '@nestjs/common';
import { API_ERROR_CATALOG, apiError, type ApiErrorCode } from '@qapaq/contracts';
import type { SocFailureCode } from '@qapaq/soc';
import type { SignInDenialReason } from '@qapaq/access';

export class ApiError extends HttpException {
  public constructor(code: ApiErrorCode, correlationId: string, fields?: readonly string[]) {
    super(apiError(code, correlationId, fields), API_ERROR_CATALOG[code].httpStatus);
  }
}

/**
 * `FORBIDDEN` y `NOT_FOUND` colapsan en la misma respuesta: la API no confirma la
 * existencia de un recurso al que la persona no tiene acceso.
 */
export function fromSocFailure(code: SocFailureCode, correlationId: string): ApiError {
  const mapping: Readonly<Record<SocFailureCode, ApiErrorCode>> = {
    FORBIDDEN: 'RESOURCE_UNAVAILABLE',
    NOT_FOUND: 'RESOURCE_UNAVAILABLE',
    CONFLICT: 'STATE_CONFLICT',
    INVALID_COMMAND: 'VALIDATION_FAILED',
  };
  return new ApiError(mapping[code], correlationId);
}

export function fromSignInDenial(reason: SignInDenialReason, correlationId: string): ApiError {
  const mapping: Readonly<Record<SignInDenialReason, ApiErrorCode>> = {
    NETWORK_UNTRUSTED: 'NETWORK_NOT_ALLOWED',
    LOCKED_OUT: 'AUTH_FAILED',
    RATE_LIMITED: 'RATE_LIMITED',
    TOKEN_INVALID: 'AUTH_FAILED',
    PASSKEY_REQUIRED: 'PASSKEY_REQUIRED',
    MFA_REQUIRED: 'AUTH_FAILED',
    NO_ROLE_ASSIGNED: 'AUTH_FAILED',
  };
  return new ApiError(mapping[reason], correlationId);
}
