/**
 * C-27 — catálogo de errores de la API.
 *
 * Un error de QAPAQ es una respuesta de producto, no un volcado técnico. Cada entrada
 * declara: qué estado HTTP corresponde, qué se le dice a la persona, qué puede hacer y
 * dónde está documentado (`helpRef`). El `correlationId` viaja siempre, porque es lo
 * único que permite que soporte encuentre el rastro sin pedir capturas de pantalla.
 *
 * Dos reglas de seguridad gobiernan el catálogo:
 *
 * 1. **No enumeración**: "no existe" y "no tienes permiso" comparten código, estado y
 *    mensaje. Distinguirlos convierte la API en un oráculo de qué recursos existen.
 * 2. **Sin detalle interno**: el mensaje público no incluye nombres de tabla, rutas,
 *    versiones ni trazas. Ese detalle va a la auditoría y a la observabilidad.
 */

export const API_ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'SESSION_EXPIRED',
  'PASSKEY_REQUIRED',
  'NETWORK_NOT_ALLOWED',
  'REQUEST_NOT_VERIFIED',
  'STEP_UP_REQUIRED',
  'RATE_LIMITED',
  'RESOURCE_UNAVAILABLE',
  'STATE_CONFLICT',
  'VALIDATION_FAILED',
  'DEPENDENCY_DEGRADED',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_ACTIONS = [
  'sign_in_again',
  'register_passkey',
  'use_qapaq_network',
  'retry_later',
  'reload_resource',
  'correct_input',
  'contact_support',
] as const;
export type ApiErrorAction = (typeof API_ERROR_ACTIONS)[number];

export interface ApiErrorDefinition {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  /** Texto para la persona. Sin detalle técnico y sin confirmar existencia de recursos. */
  readonly publicMessage: string;
  readonly action: ApiErrorAction;
  readonly helpRef: string;
  /** `true` cuando repetir la misma operación puede funcionar sin cambiar nada. */
  readonly retriable: boolean;
}

const HELP_BASE = 'https://docs.qapaq.pe/secops/errores';

export const API_ERROR_CATALOG: Readonly<Record<ApiErrorCode, ApiErrorDefinition>> = Object.freeze({
  AUTH_REQUIRED: {
    code: 'AUTH_REQUIRED',
    httpStatus: 401,
    publicMessage: 'Inicie sesión para continuar.',
    action: 'sign_in_again',
    helpRef: `${HELP_BASE}#auth-required`,
    retriable: false,
  },
  AUTH_FAILED: {
    code: 'AUTH_FAILED',
    httpStatus: 401,
    publicMessage: 'No fue posible iniciar sesión con esas credenciales.',
    action: 'sign_in_again',
    helpRef: `${HELP_BASE}#auth-failed`,
    retriable: false,
  },
  SESSION_EXPIRED: {
    code: 'SESSION_EXPIRED',
    httpStatus: 401,
    publicMessage: 'Su sesión terminó. Vuelva a iniciar sesión.',
    action: 'sign_in_again',
    helpRef: `${HELP_BASE}#session-expired`,
    retriable: false,
  },
  PASSKEY_REQUIRED: {
    code: 'PASSKEY_REQUIRED',
    httpStatus: 401,
    publicMessage: 'Fuera de la red QAPAQ se requiere una passkey registrada.',
    action: 'register_passkey',
    helpRef: `${HELP_BASE}#passkey-required`,
    retriable: false,
  },
  NETWORK_NOT_ALLOWED: {
    code: 'NETWORK_NOT_ALLOWED',
    httpStatus: 403,
    publicMessage: 'No fue posible verificar el origen de la conexión.',
    action: 'use_qapaq_network',
    helpRef: `${HELP_BASE}#network-not-allowed`,
    retriable: false,
  },
  // Mutación sin token CSRF válido o iniciada desde otro sitio: no se ejecuta nada.
  REQUEST_NOT_VERIFIED: {
    code: 'REQUEST_NOT_VERIFIED',
    httpStatus: 403,
    publicMessage: 'No fue posible verificar la solicitud. Recargue la página e intente de nuevo.',
    action: 'reload_resource',
    helpRef: `${HELP_BASE}#request-not-verified`,
    retriable: false,
  },
  // Acción privilegiada sin evidencia de autenticación fuerte y reciente: no se ejecuta nada.
  // Volver a iniciar sesión no basta mientras el BFF no registre esa evidencia.
  STEP_UP_REQUIRED: {
    code: 'STEP_UP_REQUIRED',
    httpStatus: 403,
    publicMessage:
      'Esta acción requiere una verificación reciente de identidad que no está disponible.',
    action: 'contact_support',
    helpRef: `${HELP_BASE}#step-up-required`,
    retriable: false,
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    httpStatus: 429,
    publicMessage: 'Demasiados intentos. Vuelva a intentarlo más tarde.',
    action: 'retry_later',
    helpRef: `${HELP_BASE}#rate-limited`,
    retriable: true,
  },
  // Única respuesta para "no existe" y para "no autorizado": la API no enumera.
  RESOURCE_UNAVAILABLE: {
    code: 'RESOURCE_UNAVAILABLE',
    httpStatus: 404,
    publicMessage: 'El recurso solicitado no está disponible para su cuenta.',
    action: 'contact_support',
    helpRef: `${HELP_BASE}#resource-unavailable`,
    retriable: false,
  },
  STATE_CONFLICT: {
    code: 'STATE_CONFLICT',
    httpStatus: 409,
    publicMessage: 'El elemento cambió mientras trabajaba en él. Vuelva a cargarlo.',
    action: 'reload_resource',
    helpRef: `${HELP_BASE}#state-conflict`,
    retriable: true,
  },
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    httpStatus: 422,
    publicMessage: 'Revise los datos ingresados y vuelva a enviarlos.',
    action: 'correct_input',
    helpRef: `${HELP_BASE}#validation-failed`,
    retriable: false,
  },
  DEPENDENCY_DEGRADED: {
    code: 'DEPENDENCY_DEGRADED',
    httpStatus: 503,
    publicMessage: 'El servicio está degradado. Algunos datos pueden no estar actualizados.',
    action: 'retry_later',
    helpRef: `${HELP_BASE}#dependency-degraded`,
    retriable: true,
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    httpStatus: 500,
    publicMessage: 'Ocurrió un problema inesperado. El equipo ya fue notificado.',
    action: 'contact_support',
    helpRef: `${HELP_BASE}#internal-error`,
    retriable: true,
  },
});

export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly action: ApiErrorAction;
  readonly helpRef: string;
  readonly retriable: boolean;
  readonly correlationId: string;
  /** Campos con problema, solo para validación. Nunca lleva el valor recibido. */
  readonly fields?: readonly string[];
}

export function apiError(
  code: ApiErrorCode,
  correlationId: string,
  fields?: readonly string[],
): ApiErrorBody {
  const definition = API_ERROR_CATALOG[code];
  return {
    code: definition.code,
    message: definition.publicMessage,
    action: definition.action,
    helpRef: definition.helpRef,
    retriable: definition.retriable,
    correlationId,
    ...(fields && fields.length > 0 ? { fields: [...fields] } : {}),
  };
}
