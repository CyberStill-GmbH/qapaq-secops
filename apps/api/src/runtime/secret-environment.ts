import {
  ConfigurationError,
  parseSecretReference,
  type ConfigurationErrorCode,
  type EnvironmentInput,
  type SecretProvider,
} from '@qapaq/configuration';
import { createAzureKeyVaultSecretProvider } from './azure-key-vault-secret-provider.js';

const API_SECRET_REFERENCES = [
  ['QAPAQ_ENTRA_CLIENT_SECRET_REF', 'QAPAQ_ENTRA_CLIENT_SECRET'],
  ['QAPAQ_POSTGRES_PASSWORD_REF', 'QAPAQ_POSTGRES_PASSWORD'],
  ['QAPAQ_ENTITY_REF_KEY_REF', 'QAPAQ_ENTITY_REF_KEY'],
  ['QAPAQ_TEAMS_WORKFLOW_URL_REF', 'QAPAQ_TEAMS_WORKFLOW_URL'],
  ['QAPAQ_VAPID_PRIVATE_KEY_REF', 'QAPAQ_VAPID_PRIVATE_KEY'],
  ['QAPAQ_VIRUSTOTAL_API_KEY_REF', 'QAPAQ_VIRUSTOTAL_API_KEY'],
] as const;

/**
 * Secretos de integraciones opcionales: si la referencia no se puede resolver (secreto ausente,
 * sin permiso, Key Vault caído), la integración queda sin configurar y el API arranca igual. El
 * resto de referencias son obligatorias: sin ellas el proceso no sirve.
 */
const OPTIONAL_SECRET_REFERENCES: ReadonlySet<string> = new Set(['QAPAQ_VIRUSTOTAL_API_KEY_REF']);

const KEY_VAULT_PROVIDER_TYPE = 'azure-key-vault';
const DEFAULT_SECRET_PROVIDER_TIMEOUT_MS = 5_000;

function fail(code: ConfigurationErrorCode, path: string): never {
  throw new ConfigurationError({
    code,
    message: 'La configuración de secretos del proceso no es válida.',
    path,
    profile: 'production',
  });
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SECRET_PROVIDER_TIMEOUT_MS;
  const match = /^(\d{1,6})(ms|s|m)$/u.exec(value);
  if (!match) fail('CONFIG_DURATION_INVALID', 'QAPAQ_SECRET_PROVIDER_TIMEOUT');
  const amount = Number(match[1]);
  const milliseconds = amount * (match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 100 || milliseconds > 120_000) {
    fail('CONFIG_DURATION_INVALID', 'QAPAQ_SECRET_PROVIDER_TIMEOUT');
  }
  return milliseconds;
}

function configuredKeyVaultReferences(environment: EnvironmentInput) {
  return API_SECRET_REFERENCES.flatMap(([referenceName, valueName]) => {
    const reference = environment[referenceName];
    return reference === undefined || reference === ''
      ? []
      : [{ referenceName, valueName, reference: parseSecretReference(reference, referenceName) }];
  });
}

/**
 * Resolves only secret references consumed by the current API composition. AWS and
 * local deployments that do not opt in to Key Vault retain their current environment
 * contract; Azure values are held only in this in-memory process copy.
 */
export async function resolveApiSecretEnvironment(
  environment: EnvironmentInput,
  providerFactory?: (environment: EnvironmentInput) => SecretProvider,
  /** Referencia opcional que no se pudo resolver; solo su nombre, nunca el valor. */
  onOptionalSecretUnavailable?: (referenceName: string) => void,
): Promise<EnvironmentInput> {
  const providerType = environment['QAPAQ_SECRET_PROVIDER_TYPE'];
  const hasKeyVaultReference = API_SECRET_REFERENCES.some(([referenceName]) =>
    environment[referenceName]?.startsWith('secret://keyvault/'),
  );

  if (providerType !== KEY_VAULT_PROVIDER_TYPE && !hasKeyVaultReference) return environment;
  if (providerType !== KEY_VAULT_PROVIDER_TYPE) {
    fail('SECRET_PROVIDER_UNAVAILABLE', 'QAPAQ_SECRET_PROVIDER_TYPE');
  }
  const references = configuredKeyVaultReferences(environment);
  if (references.length === 0) {
    fail('CONFIG_REQUIRED_VALUE_MISSING', 'QAPAQ_ENTRA_CLIENT_SECRET_REF');
  }

  for (const { referenceName, reference } of references) {
    if (!reference.startsWith('secret://keyvault/')) {
      fail('SECRET_REFERENCE_INVALID', referenceName);
    }
  }

  for (const [, valueName] of API_SECRET_REFERENCES) {
    if (environment[valueName] !== undefined && environment[valueName] !== '') {
      fail('CONFIG_VALUE_INVALID', valueName);
    }
  }

  const provider = providerFactory
    ? providerFactory(environment)
    : createAzureKeyVaultSecretProvider({
        vaultUri: environment['QAPAQ_SECRET_PROVIDER_ENDPOINT'] ?? '',
        managedIdentityClientId: environment['AZURE_CLIENT_ID'] ?? '',
        timeoutMs: parseTimeout(environment['QAPAQ_SECRET_PROVIDER_TIMEOUT']),
      });
  const resolved: Record<string, string | undefined> = { ...environment };
  for (const { referenceName, valueName, reference } of references) {
    if (!OPTIONAL_SECRET_REFERENCES.has(referenceName)) {
      resolved[valueName] = await provider.resolve(reference);
      continue;
    }
    try {
      resolved[valueName] = await provider.resolve(reference);
    } catch {
      onOptionalSecretUnavailable?.(referenceName);
    }
  }
  return Object.freeze(resolved);
}
