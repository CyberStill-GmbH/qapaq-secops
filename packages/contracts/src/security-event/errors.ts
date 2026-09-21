export const SECURITY_EVENT_ERROR_CODES = [
  'UNSUPPORTED_SCHEMA_VERSION',
  'SCHEMA_VALIDATION_FAILED',
  'EXTENSION_LIMIT_EXCEEDED',
  'UNSAFE_EXTENSION_KEY',
] as const;

export type SecurityEventErrorCode = (typeof SECURITY_EVENT_ERROR_CODES)[number];

export interface SecurityEventValidationError {
  readonly code: SecurityEventErrorCode;
  readonly message: string;
  readonly path: string;
  readonly keyword: string;
  readonly schemaVersion?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class SecurityEventContractError extends Error {
  public readonly code: SecurityEventErrorCode;
  public readonly errors: readonly SecurityEventValidationError[];

  public constructor(errors: readonly SecurityEventValidationError[]) {
    super(errors[0]?.message ?? 'El evento de seguridad no cumple el contrato.');
    this.name = 'SecurityEventContractError';
    this.code = errors[0]?.code ?? 'SCHEMA_VALIDATION_FAILED';
    this.errors = Object.freeze([...errors]);
  }

  public toJSON(): Readonly<{
    code: SecurityEventErrorCode;
    message: string;
    errors: readonly SecurityEventValidationError[];
  }> {
    return { code: this.code, message: this.message, errors: this.errors };
  }
}
