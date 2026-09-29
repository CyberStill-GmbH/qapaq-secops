import type { SecretReference } from '../secrets/secret-reference.js';

export type SecretLifecycleProviderErrorCode =
  'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT' | 'PROVIDER_REJECTED' | 'PROVIDER_CONFLICT';

export class SecretLifecycleProviderError extends Error {
  public constructor(public readonly code: SecretLifecycleProviderErrorCode) {
    super(code);
    this.name = 'SecretLifecycleProviderError';
  }
}

export interface ProviderSecretVersion {
  readonly providerRef: SecretReference;
  readonly providerVersion: string;
  readonly expiresAt?: string;
}

export interface ProviderRevocation {
  readonly providerRef: SecretReference;
  readonly revoked: true;
}

export interface SecretLifecycleProvider {
  readonly providerType: string;
  create(input: {
    readonly secretId: string;
    readonly logicalName: string;
    readonly material: Uint8Array;
    readonly operationId: string;
    readonly expiresAt?: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSecretVersion>;
  rotate(input: {
    readonly secretId: string;
    readonly currentRef: SecretReference;
    readonly material: Uint8Array;
    readonly operationId: string;
    readonly expiresAt?: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderSecretVersion>;
  revoke(input: {
    readonly secretId: string;
    readonly providerRef: SecretReference;
    readonly operationId: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderRevocation>;
}
