export const CONFIGURATION_ERROR_CODES = [
  'CONFIG_PROFILE_INVALID',
  'CONFIG_REQUIRED_VALUE_MISSING',
  'CONFIG_VALUE_INVALID',
  'CONFIG_URL_INVALID',
  'CONFIG_DURATION_INVALID',
  'CONFIG_TLS_REQUIRED',
  'CONFIG_INSECURE_TRANSPORT',
  'CONFIG_LIMIT_INVALID',
  'SECRET_REFERENCE_INVALID',
  'SECRET_NOT_FOUND',
  'SECRET_ACCESS_DENIED',
  'SECRET_PROVIDER_UNAVAILABLE',
  'SECRET_RESOLUTION_FAILED',
] as const;

export type ConfigurationErrorCode = (typeof CONFIGURATION_ERROR_CODES)[number];
export type ConfigurationProfileName = 'development' | 'test' | 'production';

export interface ConfigurationErrorShape {
  readonly code: ConfigurationErrorCode;
  readonly message: string;
  readonly path: string;
  readonly profile?: ConfigurationProfileName;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class ConfigurationError extends Error {
  public readonly code: ConfigurationErrorCode;
  public readonly path: string;
  public readonly profile?: ConfigurationProfileName;
  public readonly details?: Readonly<Record<string, string | number | boolean>>;

  public constructor(shape: ConfigurationErrorShape) {
    super(shape.message);
    this.name = 'ConfigurationError';
    this.code = shape.code;
    this.path = shape.path;
    if (shape.profile !== undefined) this.profile = shape.profile;
    if (shape.details !== undefined) this.details = Object.freeze({ ...shape.details });
  }

  public toJSON(): ConfigurationErrorShape {
    return {
      code: this.code,
      message: this.message,
      path: this.path,
      ...(this.profile === undefined ? {} : { profile: this.profile }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function configurationError(
  code: ConfigurationErrorCode,
  path: string,
  profile?: ConfigurationProfileName,
  details?: Readonly<Record<string, string | number | boolean>>,
): ConfigurationError {
  const messages: Record<ConfigurationErrorCode, string> = {
    CONFIG_PROFILE_INVALID: 'El perfil de configuración no es válido.',
    CONFIG_REQUIRED_VALUE_MISSING: 'Falta un valor obligatorio de configuración.',
    CONFIG_VALUE_INVALID: 'Un valor de configuración no es válido.',
    CONFIG_URL_INVALID: 'Una URL de configuración no es válida.',
    CONFIG_DURATION_INVALID: 'Una duración de configuración no es válida.',
    CONFIG_TLS_REQUIRED: 'La política del perfil exige TLS.',
    CONFIG_INSECURE_TRANSPORT: 'El transporte configurado no está permitido.',
    CONFIG_LIMIT_INVALID: 'Un límite operativo no es válido.',
    SECRET_REFERENCE_INVALID: 'La referencia al secreto no es válida.',
    SECRET_NOT_FOUND: 'No se encontró un secreto obligatorio.',
    SECRET_ACCESS_DENIED: 'El acceso al secreto fue denegado.',
    SECRET_PROVIDER_UNAVAILABLE: 'El proveedor de secretos no está disponible.',
    SECRET_RESOLUTION_FAILED: 'No fue posible resolver un secreto obligatorio.',
  };
  return new ConfigurationError({
    code,
    message: messages[code],
    path,
    ...(profile ? { profile } : {}),
    ...(details ? { details } : {}),
  });
}
