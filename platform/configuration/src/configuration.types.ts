import type { ConfigurationProfileName } from './configuration.errors.js';
import type { SecretReference } from './secrets/index.js';

export class SecretValue {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  public reveal(): string {
    return this.#value;
  }

  public toJSON(): string {
    return '[REDACTED]';
  }

  public toString(): string {
    return '[REDACTED]';
  }
}

export interface SecretCredential {
  readonly reference: SecretReference;
  readonly value: SecretValue;
}

export interface ApiConfig {
  readonly profile: ConfigurationProfileName;
  readonly host: string;
  readonly port: number;
}

export interface PostgreSqlConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: SecretCredential;
  readonly tls: boolean;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly pool: Readonly<{ minimum: number; maximum: number }>;
}

/**
 * C-17 — persistencia del estado SOC del BFF. `memory` no sobrevive a un reinicio y solo
 * se admite donde el ambiente lo declara explícitamente.
 */
export type SocPersistenceConfig =
  | { readonly mode: 'memory' }
  | {
      readonly mode: 'postgres';
      readonly postgres: {
        readonly host: string;
        readonly port: number;
        readonly database: string;
        readonly username: string;
        readonly password: SecretValue;
        readonly tls: boolean;
        readonly connectionTimeoutMs: number;
        readonly statementTimeoutMs: number;
        readonly poolMaximum: number;
      };
    };

export interface RedisConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: SecretCredential;
  readonly database: number;
  readonly tls: boolean;
  readonly connectionTimeoutMs: number;
  readonly commandTimeoutMs: number;
  /** Cantidad máxima de reintentos adicionales, sin contar el intento inicial. */
  readonly retryLimit: number;
}

export interface MinioConfig {
  readonly endpoint: string;
  readonly port: number;
  readonly region: string;
  readonly rawBucket: string;
  readonly accessKey: SecretCredential;
  readonly secretKey: SecretCredential;
  readonly tls: boolean;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly retryLimit: number;
}

export interface WazuhGatewayConfig {
  readonly baseUrl: string;
  readonly accessToken: SecretCredential;
  readonly requestTimeoutMs: number;
  readonly retryLimit: number;
  readonly pageSize: number;
  readonly maximumPageSize: number;
  readonly dataset: string;
  readonly cursorSigningKey: SecretCredential;
  readonly cursorTtlMs: number;
  readonly maximumResponseBytes: number;
  readonly allowInsecureLocalhost: boolean;
}

export interface RuntimeConfig {
  readonly profile: ConfigurationProfileName;
  readonly api: ApiConfig;
  readonly postgres: PostgreSqlConfig;
  readonly redis: RedisConfig;
  readonly minio: MinioConfig;
  readonly wazuh: Readonly<{ gateway: WazuhGatewayConfig }>;
}

export interface WorkerConfig {
  readonly profile: ConfigurationProfileName;
  readonly redis: RedisConfig;
}

export interface ControlPlaneSecretConfig {
  readonly profile: ConfigurationProfileName;
  readonly providerType: string;
  readonly providerTimeoutMs: number;
  readonly fingerprintKey: SecretCredential;
}

export type EnvironmentInput = Readonly<Record<string, string | undefined>>;
