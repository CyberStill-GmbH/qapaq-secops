import { ManagedIdentityCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import {
  parseSecretReference,
  SecretProviderError,
  type SecretProvider,
  type SecretReference,
} from '@qapaq/configuration';

const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/u;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface KeyVaultSecretReader {
  getSecret(
    name: string,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<{ readonly value?: string }>;
}

function secretErrorCode(error: unknown): ConstructorParameters<typeof SecretProviderError>[0] {
  if (typeof error !== 'object' || error === null) return 'SECRET_PROVIDER_UNAVAILABLE';
  const record = error as {
    readonly statusCode?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
  };
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : undefined;

  if (statusCode === 404) return 'SECRET_NOT_FOUND';
  if (statusCode === 401 || statusCode === 403) return 'SECRET_ACCESS_DENIED';
  if (
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500) ||
    record.name === 'AbortError' ||
    record.name === 'TimeoutError' ||
    record.code === 'ABORT_ERR'
  ) {
    return 'SECRET_PROVIDER_UNAVAILABLE';
  }
  if (statusCode === undefined) return 'SECRET_PROVIDER_UNAVAILABLE';
  return 'SECRET_RESOLUTION_FAILED';
}

/**
 * Key Vault runtime reader for the SIEM VM's user-assigned Managed Identity.
 * It only resolves named secret references; it cannot enumerate, create, rotate,
 * or revoke Key Vault entries.
 */
export class AzureKeyVaultSecretProvider implements SecretProvider {
  readonly #client: KeyVaultSecretReader;
  readonly #timeoutMs: number;

  public constructor(client: KeyVaultSecretReader, timeoutMs = 5_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
    }
    this.#client = client;
    this.#timeoutMs = timeoutMs;
  }

  public async resolve(reference: SecretReference): Promise<string> {
    let parsedReference: SecretReference;
    try {
      parsedReference = parseSecretReference(reference);
    } catch {
      throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
    }
    if (!parsedReference.startsWith('secret://keyvault/')) {
      throw new SecretProviderError('SECRET_NOT_FOUND');
    }

    const name = parsedReference.slice('secret://keyvault/'.length);
    if (!SECRET_NAME_PATTERN.test(name)) throw new SecretProviderError('SECRET_RESOLUTION_FAILED');

    try {
      const secret = await this.#client.getSecret(name, {
        abortSignal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (typeof secret.value !== 'string' || secret.value.length === 0) {
        throw new SecretProviderError('SECRET_NOT_FOUND');
      }
      return secret.value;
    } catch (error) {
      if (error instanceof SecretProviderError) throw error;
      throw new SecretProviderError(secretErrorCode(error));
    }
  }
}

export function createAzureKeyVaultSecretProvider(options: {
  readonly vaultUri: string;
  readonly managedIdentityClientId: string;
  readonly timeoutMs: number;
}): AzureKeyVaultSecretProvider {
  let vaultUri: URL;
  try {
    vaultUri = new URL(options.vaultUri);
  } catch {
    throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
  }

  if (
    vaultUri.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.vault\.azure\.net$/iu.test(vaultUri.hostname) ||
    (vaultUri.pathname !== '' && vaultUri.pathname !== '/') ||
    vaultUri.username !== '' ||
    vaultUri.password !== '' ||
    vaultUri.port !== '' ||
    vaultUri.search !== '' ||
    vaultUri.hash !== '' ||
    !CLIENT_ID_PATTERN.test(options.managedIdentityClientId)
  ) {
    throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
  }

  const credential = new ManagedIdentityCredential(options.managedIdentityClientId);
  const client = new SecretClient(vaultUri.origin, credential, {
    retryOptions: { maxRetries: 0 },
  });
  return new AzureKeyVaultSecretProvider(client, options.timeoutMs);
}
