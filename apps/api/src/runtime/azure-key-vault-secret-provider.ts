import {
  parseSecretReference,
  SecretProviderError,
  type SecretProvider,
  type SecretReference,
} from '@qapaq/configuration';

const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/u;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IMDS_TOKEN_ENDPOINT = 'http://169.254.169.254/metadata/identity/oauth2/token';
const KEY_VAULT_RESOURCE = 'https://vault.azure.net';
const KEY_VAULT_API_VERSION = '7.4';
const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface KeyVaultSecretReader {
  getSecret(
    name: string,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<{ readonly value?: string }>;
}

type HttpStatusError = Error & { readonly statusCode: number };

function httpStatusError(statusCode: number): HttpStatusError {
  return Object.assign(new Error('Azure service request failed.'), { statusCode });
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
  }
  if (!response.body) throw new SecretProviderError('SECRET_RESOLUTION_FAILED');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
  }
}

interface ManagedIdentityTokenResponse {
  readonly access_token?: unknown;
  readonly expires_on?: unknown;
  readonly token_type?: unknown;
}

/** Uses the VM's link-local IMDS endpoint and keeps its short-lived token in memory only. */
class ManagedIdentityKeyVaultSecretReader implements KeyVaultSecretReader {
  readonly #vaultUri: URL;
  readonly #clientId: string;
  #cachedToken: { readonly value: string; readonly expiresAt: number } | undefined;

  public constructor(vaultUri: URL, clientId: string) {
    this.#vaultUri = vaultUri;
    this.#clientId = clientId;
  }

  public async getSecret(
    name: string,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<{ readonly value?: string }> {
    const token = await this.#getAccessToken(options.abortSignal);
    const secretUrl = new URL(
      `/secrets/${encodeURIComponent(name)}?api-version=${KEY_VAULT_API_VERSION}`,
      this.#vaultUri,
    );
    const response = await fetch(secretUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: options.abortSignal,
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw httpStatusError(response.status);
    const body = (await readJsonBounded(response)) as { readonly value?: unknown };
    return typeof body.value === 'string' ? { value: body.value } : {};
  }

  async #getAccessToken(signal: AbortSignal): Promise<string> {
    const cached = this.#cachedToken;
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.value;

    const tokenUrl = new URL(IMDS_TOKEN_ENDPOINT);
    tokenUrl.searchParams.set('api-version', '2018-02-01');
    tokenUrl.searchParams.set('resource', KEY_VAULT_RESOURCE);
    tokenUrl.searchParams.set('client_id', this.#clientId);
    const response = await fetch(tokenUrl, {
      method: 'GET',
      headers: { Metadata: 'true' },
      signal,
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw httpStatusError(response.status);

    const tokenBody: unknown = await readJsonBounded(response);
    if (typeof tokenBody !== 'object' || tokenBody === null || Array.isArray(tokenBody)) {
      throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
    }
    const body = tokenBody as ManagedIdentityTokenResponse;
    if (
      typeof body.access_token !== 'string' ||
      body.access_token.length === 0 ||
      (typeof body.expires_on !== 'string' && typeof body.expires_on !== 'number') ||
      body.token_type !== 'Bearer'
    ) {
      throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
    }
    const expiresAtSeconds = Number(body.expires_on);
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds * 1_000 <= Date.now()) {
      throw new SecretProviderError('SECRET_RESOLUTION_FAILED');
    }
    this.#cachedToken = { value: body.access_token, expiresAt: expiresAtSeconds * 1_000 };
    return body.access_token;
  }
}

function secretErrorCode(error: unknown): ConstructorParameters<typeof SecretProviderError>[0] {
  if (error instanceof SecretProviderError) return error.code;
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

  const client = new ManagedIdentityKeyVaultSecretReader(vaultUri, options.managedIdentityClientId);
  return new AzureKeyVaultSecretProvider(client, options.timeoutMs);
}
