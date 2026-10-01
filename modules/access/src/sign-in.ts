/**
 * C-18/C-25 — política de admisión de una autenticación.
 *
 * Reúne en un solo punto las cuatro condiciones que deciden si una persona entra:
 * origen de red, bloqueo por abuso, validez del `id_token` y método de autenticación.
 *
 * La regla de método es la aprobada para QAPAQ: dentro de la red basta MFA; fuera se
 * exige passkey (FIDO2) porque la contraseña más OTP es justamente lo que el phishing
 * resistente a passkey no supera. Una cadena de proxies no confiable no es "fuera": es
 * una petición cuyo origen no se puede afirmar, y se rechaza.
 */

import type { IdTokenClaims } from './id-token.js';
import type { NetworkDecisionCode } from './network.js';

/** Métodos que Entra reporta en `amr` para una credencial resistente a phishing. */
export const PASSKEY_AMR_VALUES = ['fido', 'hwk', 'phr'] as const;
export const MFA_AMR_VALUES = ['mfa', 'ngcmfa', 'otp', 'rsa', ...PASSKEY_AMR_VALUES] as const;

export const SIGN_IN_DENIAL_REASONS = [
  'NETWORK_UNTRUSTED',
  'LOCKED_OUT',
  'RATE_LIMITED',
  'TOKEN_INVALID',
  'PASSKEY_REQUIRED',
  'MFA_REQUIRED',
  'NO_ROLE_ASSIGNED',
] as const;
export type SignInDenialReason = (typeof SIGN_IN_DENIAL_REASONS)[number];

export interface AuthenticationPolicy {
  readonly requiredAmr: readonly string[];
  readonly denialReason: Extract<SignInDenialReason, 'PASSKEY_REQUIRED' | 'MFA_REQUIRED'>;
}

export function policyForNetwork(decision: NetworkDecisionCode): AuthenticationPolicy | undefined {
  if (decision === 'untrusted_chain') return undefined;
  return decision === 'inside'
    ? { requiredAmr: [...MFA_AMR_VALUES], denialReason: 'MFA_REQUIRED' }
    : { requiredAmr: [...PASSKEY_AMR_VALUES], denialReason: 'PASSKEY_REQUIRED' };
}

export interface SignInContext {
  readonly network: NetworkDecisionCode;
  readonly locked: boolean;
  readonly rateLimited: boolean;
  readonly claims?: IdTokenClaims;
  readonly tokenError?: string;
  readonly roles: readonly string[];
  readonly capabilities: ReadonlySet<string>;
}

export type SignInDecision =
  | { readonly admitted: true; readonly requiredAmr: readonly string[] }
  | {
      readonly admitted: false;
      readonly reason: SignInDenialReason;
      /**
       * Mensaje para la persona. Deliberadamente idéntico entre `TOKEN_INVALID`,
       * `LOCKED_OUT` y `NO_ROLE_ASSIGNED`: el borde no revela si la cuenta existe,
       * si está bloqueada o si carece de rol (C-27, no enumeración).
       */
      readonly publicMessage: string;
    };

const GENERIC_DENIAL = 'No fue posible iniciar sesión con esas credenciales.';

export function decideSignIn(context: SignInContext): SignInDecision {
  if (context.rateLimited) {
    return {
      admitted: false,
      reason: 'RATE_LIMITED',
      publicMessage: 'Demasiados intentos. Vuelva a intentarlo más tarde.',
    };
  }
  const policy = policyForNetwork(context.network);
  if (!policy) {
    return {
      admitted: false,
      reason: 'NETWORK_UNTRUSTED',
      publicMessage: 'No fue posible verificar el origen de la conexión.',
    };
  }
  if (context.locked) {
    return { admitted: false, reason: 'LOCKED_OUT', publicMessage: GENERIC_DENIAL };
  }
  if (!context.claims) {
    return { admitted: false, reason: 'TOKEN_INVALID', publicMessage: GENERIC_DENIAL };
  }
  const amr = context.claims.amr ?? [];
  if (!policy.requiredAmr.some((method) => amr.includes(method))) {
    return {
      admitted: false,
      reason: policy.denialReason,
      publicMessage:
        policy.denialReason === 'PASSKEY_REQUIRED'
          ? 'Fuera de la red QAPAQ se requiere una passkey registrada.'
          : 'Se requiere autenticación multifactor.',
    };
  }
  if (context.capabilities.size === 0) {
    return { admitted: false, reason: 'NO_ROLE_ASSIGNED', publicMessage: GENERIC_DENIAL };
  }
  return { admitted: true, requiredAmr: policy.requiredAmr };
}
