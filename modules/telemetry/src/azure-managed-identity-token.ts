const IMDS_TOKEN_ENDPOINT = 'http://169.254.169.254/metadata/identity/oauth2/token';
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Bearer token for one Azure resource; the value is only placed in an Authorization header. */
export interface AzureAccessTokenSource {
  getToken(signal: AbortSignal): Promise<string>;
}

export class AzureManagedIdentityError extends Error {
  constructor(readonly code: 'TOKEN_UNAVAILABLE' | 'TOKEN_INVALID') {
    super('Managed identity token request failed.');
    this.name = 'AzureManagedIdentityError';
  }
}

export interface ManagedIdentityTokenSourceOptions {
  /** Client ID of the VM's user-assigned identity. */
  readonly clientId: string;
  /** Azure resource audience, for example `https://storage.azure.com/`. */
  readonly resource: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new AzureManagedIdentityError('TOKEN_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AzureManagedIdentityError('TOKEN_INVALID');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Token source over the VM's link-local IMDS endpoint. The token stays in process memory, is
 * refreshed one minute before expiry and concurrent callers share a single in-flight request.
 */
export function createManagedIdentityTokenSource(
  options: ManagedIdentityTokenSourceOptions,
): AzureAccessTokenSource {
  if (!CLIENT_ID_PATTERN.test(options.clientId))
    throw new Error('Managed identity client ID must be a GUID');
  const resource = new URL(options.resource);
  if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search)
    throw new Error('Managed identity resource must be an HTTPS audience');
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { readonly value: string; readonly expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const request = async (signal: AbortSignal): Promise<string> => {
    const url = new URL(IMDS_TOKEN_ENDPOINT);
    url.searchParams.set('api-version', '2018-02-01');
    url.searchParams.set('resource', options.resource);
    url.searchParams.set('client_id', options.clientId);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Metadata: 'true' },
        signal,
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw new AzureManagedIdentityError('TOKEN_UNAVAILABLE');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AzureManagedIdentityError('TOKEN_UNAVAILABLE');
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(response, MAX_TOKEN_RESPONSE_BYTES));
    } catch (error) {
      if (error instanceof AzureManagedIdentityError) throw error;
      throw new AzureManagedIdentityError('TOKEN_INVALID');
    }
    const token = body as { access_token?: unknown; expires_on?: unknown; token_type?: unknown };
    const expiresOn = Number(token.expires_on);
    if (
      typeof token.access_token !== 'string' ||
      token.access_token.length === 0 ||
      token.token_type !== 'Bearer' ||
      !Number.isSafeInteger(expiresOn) ||
      expiresOn * 1_000 <= now()
    )
      throw new AzureManagedIdentityError('TOKEN_INVALID');
    cached = { value: token.access_token, expiresAt: expiresOn * 1_000 };
    return token.access_token;
  };

  return {
    getToken(signal) {
      if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now())
        return Promise.resolve(cached.value);
      inFlight ??= request(signal).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
