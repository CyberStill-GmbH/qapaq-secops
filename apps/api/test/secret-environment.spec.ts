import {
  parseSecretReference,
  type EnvironmentInput,
  type SecretProvider,
} from '@qapaq/configuration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AzureKeyVaultSecretProvider,
  createAzureKeyVaultSecretProvider,
} from '../src/runtime/azure-key-vault-secret-provider.js';
import { resolveApiSecretEnvironment } from '../src/runtime/secret-environment.js';

const syntheticManagedIdentity = '11111111-1111-4111-8111-111111111111';
const syntheticVaultUri = 'https://kv-qapaq.vault.azure.net';

function imdsTokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: 'synthetic-managed-identity-token',
      expires_on: String(Math.floor(Date.now() / 1_000) + 3_600),
      token_type: 'Bearer',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function azureKeyVaultProvider(timeoutMs = 5_000): AzureKeyVaultSecretProvider {
  return createAzureKeyVaultSecretProvider({
    vaultUri: syntheticVaultUri,
    managedIdentityClientId: syntheticManagedIdentity,
    timeoutMs,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AzureKeyVaultSecretProvider', () => {
  it('reads one named key-vault secret with an abort deadline', async () => {
    const getSecret = vi.fn(
      async (_name: string, options: { readonly abortSignal: AbortSignal }) => {
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
        return { value: 'synthetic-secret' };
      },
    );
    const provider = new AzureKeyVaultSecretProvider({ getSecret });

    await expect(
      provider.resolve(parseSecretReference('secret://keyvault/entra-client-secret')),
    ).resolves.toBe('synthetic-secret');
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith('entra-client-secret', {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('rejects references outside the keyvault namespace and unsafe names', async () => {
    const getSecret = vi.fn();
    const provider = new AzureKeyVaultSecretProvider({ getSecret });

    await expect(
      provider.resolve(parseSecretReference('secret://environment/ENTRA_SECRET')),
    ).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
    });
    await expect(
      provider.resolve(parseSecretReference('secret://keyvault/path/name')),
    ).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
    });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each([
    [{ statusCode: 404 }, 'SECRET_NOT_FOUND'],
    [{ statusCode: 403 }, 'SECRET_ACCESS_DENIED'],
    [{ statusCode: 429 }, 'SECRET_PROVIDER_UNAVAILABLE'],
    [{ statusCode: 503 }, 'SECRET_PROVIDER_UNAVAILABLE'],
    [{ name: 'AbortError' }, 'SECRET_PROVIDER_UNAVAILABLE'],
    [{ statusCode: 400 }, 'SECRET_RESOLUTION_FAILED'],
  ])('normalizes remote failure without retaining its response text', async (error, code) => {
    const provider = new AzureKeyVaultSecretProvider({
      getSecret: async () => {
        throw { ...error, message: 'synthetic-secret-must-not-leak' };
      },
    });

    await expect(
      provider.resolve(parseSecretReference('secret://keyvault/entra-client-secret')),
    ).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining('synthetic-secret-must-not-leak'),
    });
  });

  it('maps an expired request deadline to provider unavailable', async () => {
    const provider = new AzureKeyVaultSecretProvider(
      {
        getSecret: async (_name, { abortSignal }) =>
          await new Promise((_, reject) => {
            abortSignal.addEventListener('abort', () => reject({ name: 'AbortError' }), {
              once: true,
            });
          }),
      },
      100,
    );

    await expect(
      provider.resolve(parseSecretReference('secret://keyvault/entra-client-secret')),
    ).rejects.toMatchObject({
      code: 'SECRET_PROVIDER_UNAVAILABLE',
    });
  });

  it('only accepts the approved vault URI and user-assigned identity shape', () => {
    expect(() =>
      createAzureKeyVaultSecretProvider({
        vaultUri: 'http://kv-qapaq.vault.azure.net',
        managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
        timeoutMs: 5_000,
      }),
    ).toThrow();

    expect(() =>
      createAzureKeyVaultSecretProvider({
        vaultUri: 'https://example.com',
        managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
        timeoutMs: 5_000,
      }),
    ).toThrow();

    expect(() =>
      createAzureKeyVaultSecretProvider({
        vaultUri: 'https://kv-qapaq.vault.azure.net:8443',
        managedIdentityClientId: '11111111-1111-4111-8111-111111111111',
        timeoutMs: 5_000,
      }),
    ).toThrow();

    expect(() =>
      createAzureKeyVaultSecretProvider({
        vaultUri: 'https://kv-qapaq.vault.azure.net',
        managedIdentityClientId: 'not-a-client-id',
        timeoutMs: 5_000,
      }),
    ).toThrow();
  });

  it('requests a bounded Key Vault secret through fixed IMDS and caches the short-lived token', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '169.254.169.254') return imdsTokenResponse();
      return new Response(JSON.stringify({ value: 'synthetic-key-vault-secret' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = azureKeyVaultProvider();

    await expect(
      provider.resolve(parseSecretReference('secret://keyvault/entra-client-secret')),
    ).resolves.toBe('synthetic-key-vault-secret');
    await expect(
      provider.resolve(parseSecretReference('secret://keyvault/postgres-password')),
    ).resolves.toBe('synthetic-key-vault-secret');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const imdsUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(imdsUrl.origin + imdsUrl.pathname).toBe(
      'http://169.254.169.254/metadata/identity/oauth2/token',
    );
    expect(imdsUrl.searchParams.get('client_id')).toBe(syntheticManagedIdentity);
    expect(imdsUrl.searchParams.get('resource')).toBe('https://vault.azure.net');
    const imdsOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(imdsOptions.headers).get('Metadata')).toBe('true');
    expect(imdsOptions.redirect).toBe('error');
    expect(imdsOptions.cache).toBe('no-store');
    const vaultUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(vaultUrl.origin).toBe(syntheticVaultUri);
    expect(vaultUrl.pathname).toBe('/secrets/entra-client-secret');
    const vaultOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(vaultOptions.headers).get('authorization')).toBe(
      'Bearer synthetic-managed-identity-token',
    );
    expect(vaultOptions.redirect).toBe('error');
    expect(vaultOptions.cache).toBe('no-store');
  });

  it.each([
    [403, 'SECRET_ACCESS_DENIED'],
    [404, 'SECRET_NOT_FOUND'],
  ])(
    'normalizes Key Vault HTTP %s without returning the response body',
    async (statusCode, code) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(imdsTokenResponse())
        .mockResolvedValueOnce(
          new Response('synthetic-secret-response-body', { status: statusCode }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        azureKeyVaultProvider().resolve(
          parseSecretReference('secret://keyvault/entra-client-secret'),
        ),
      ).rejects.toMatchObject({
        code,
        message: expect.not.stringContaining('synthetic-secret-response-body'),
      });
    },
  );

  it('rejects malformed and oversized service responses without exposing their bodies', async () => {
    const invalidJsonFetch = vi
      .fn()
      .mockResolvedValueOnce(imdsTokenResponse())
      .mockResolvedValueOnce(new Response('synthetic-invalid-json-secret', { status: 200 }));
    vi.stubGlobal('fetch', invalidJsonFetch);
    await expect(
      azureKeyVaultProvider().resolve(
        parseSecretReference('secret://keyvault/entra-client-secret'),
      ),
    ).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      message: expect.not.stringContaining('synthetic-invalid-json-secret'),
    });

    const oversizedFetch = vi
      .fn()
      .mockResolvedValueOnce(imdsTokenResponse())
      .mockResolvedValueOnce(
        new Response('too-large', {
          status: 200,
          headers: { 'content-length': String(64 * 1024 + 1) },
        }),
      );
    vi.stubGlobal('fetch', oversizedFetch);
    await expect(
      azureKeyVaultProvider().resolve(
        parseSecretReference('secret://keyvault/entra-client-secret'),
      ),
    ).rejects.toMatchObject({ code: 'SECRET_RESOLUTION_FAILED' });
  });

  it('rejects redirects and enforces one timeout across IMDS and Key Vault', async () => {
    const redirectFetch = vi
      .fn()
      .mockResolvedValueOnce(imdsTokenResponse())
      .mockRejectedValueOnce(new TypeError('synthetic redirect target'));
    vi.stubGlobal('fetch', redirectFetch);
    await expect(
      azureKeyVaultProvider().resolve(
        parseSecretReference('secret://keyvault/entra-client-secret'),
      ),
    ).rejects.toMatchObject({
      code: 'SECRET_PROVIDER_UNAVAILABLE',
      message: expect.not.stringContaining('synthetic redirect target'),
    });

    const timeoutFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timeout', 'AbortError')),
            {
              once: true,
            },
          );
        }),
    );
    vi.stubGlobal('fetch', timeoutFetch);
    await expect(
      azureKeyVaultProvider(100).resolve(
        parseSecretReference('secret://keyvault/entra-client-secret'),
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PROVIDER_UNAVAILABLE' });
    expect(timeoutFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('resolveApiSecretEnvironment', () => {
  const keyVaultEnvironment: EnvironmentInput = {
    QAPAQ_PROFILE: 'production',
    QAPAQ_SECRET_PROVIDER_TYPE: 'azure-key-vault',
    QAPAQ_SECRET_PROVIDER_ENDPOINT: 'https://kv-qapaq.vault.azure.net',
    QAPAQ_SECRET_PROVIDER_TIMEOUT: '5s',
    AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
    QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://keyvault/entra-client-secret',
    QAPAQ_POSTGRES_PASSWORD_REF: 'secret://keyvault/postgres-runtime-password',
    QAPAQ_ENTITY_REF_KEY_REF: 'secret://keyvault/entity-ref-key',
    QAPAQ_TEAMS_WORKFLOW_URL_REF: 'secret://keyvault/teams-workflow-url',
    QAPAQ_VAPID_PRIVATE_KEY_REF: 'secret://keyvault/vapid-private-key',
  };

  it('resolves only current API secret consumers and leaves the source environment unchanged', async () => {
    const resolvedReferences: string[] = [];
    const provider: SecretProvider = {
      resolve: async (reference) => {
        resolvedReferences.push(reference);
        return `synthetic-value:${reference.split('/').at(-1)}`;
      },
    };

    const result = await resolveApiSecretEnvironment(keyVaultEnvironment, () => provider);

    expect(resolvedReferences).toHaveLength(5);
    expect(result.QAPAQ_ENTRA_CLIENT_SECRET).toBe('synthetic-value:entra-client-secret');
    expect(result.QAPAQ_POSTGRES_PASSWORD).toBe('synthetic-value:postgres-runtime-password');
    expect(result.QAPAQ_ENTITY_REF_KEY).toBe('synthetic-value:entity-ref-key');
    expect(result.QAPAQ_TEAMS_WORKFLOW_URL).toBe('synthetic-value:teams-workflow-url');
    expect(result.QAPAQ_VAPID_PRIVATE_KEY).toBe('synthetic-value:vapid-private-key');
    expect(keyVaultEnvironment.QAPAQ_ENTRA_CLIENT_SECRET).toBeUndefined();
    expect(keyVaultEnvironment.QAPAQ_ENTRA_CLIENT_SECRET_REF).toBe(
      'secret://keyvault/entra-client-secret',
    );
  });

  it('preserves the existing AWS/local raw-environment path when Key Vault is not selected', async () => {
    const environment: EnvironmentInput = {
      QAPAQ_PROFILE: 'production',
      QAPAQ_ENTRA_CLIENT_SECRET: 'existing-aws-secret',
      QAPAQ_ENTRA_CLIENT_SECRET_REF: 'legacy-provider-specific-reference',
    };
    const providerFactory = vi.fn(() => ({ resolve: vi.fn() }));

    await expect(resolveApiSecretEnvironment(environment, providerFactory)).resolves.toBe(
      environment,
    );
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('fails closed when a Key Vault ref is present without the explicit Azure provider', async () => {
    const environment: EnvironmentInput = {
      QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://keyvault/entra-client-secret',
    };

    await expect(resolveApiSecretEnvironment(environment)).rejects.toMatchObject({
      code: 'SECRET_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects plaintext and reference duplication', async () => {
    const environment = {
      ...keyVaultEnvironment,
      QAPAQ_ENTRA_CLIENT_SECRET: 'plaintext-must-not-be-used',
    };
    const providerFactory = vi.fn(() => ({ resolve: vi.fn() }));

    await expect(resolveApiSecretEnvironment(environment, providerFactory)).rejects.toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
    });
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('rejects every plaintext API secret in Azure mode even when a ref is omitted', async () => {
    const environment = {
      ...keyVaultEnvironment,
      QAPAQ_POSTGRES_PASSWORD_REF: undefined,
      QAPAQ_POSTGRES_PASSWORD: 'plaintext-must-not-be-used',
    };

    await expect(
      resolveApiSecretEnvironment(environment, () => ({ resolve: vi.fn() })),
    ).rejects.toMatchObject({
      code: 'CONFIG_VALUE_INVALID',
      path: 'QAPAQ_POSTGRES_PASSWORD',
    });
  });

  it('rejects references outside the keyvault namespace in Azure mode', async () => {
    const environment = {
      ...keyVaultEnvironment,
      QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://environment/ENTRA_CLIENT_SECRET',
    };
    const providerFactory = vi.fn(() => ({ resolve: vi.fn() }));

    await expect(resolveApiSecretEnvironment(environment, providerFactory)).rejects.toMatchObject({
      code: 'SECRET_REFERENCE_INVALID',
    });
    expect(providerFactory).not.toHaveBeenCalled();
  });
});
