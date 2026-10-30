import {
  ConfigurationError,
  SecretProviderError,
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
] as const;

/**
 * La API key del asistente es opcional: si no se puede leer, el API arranca igual y el asistente
 * responde `FEATURE_NOT_CONFIGURED`. Por eso no está en la lista de arriba, donde cualquier fallo
 * detiene el arranque.
 */
const ASSISTANT_SECRET_REFERENCE = [
  'QAPAQ_ANTHROPIC_API_KEY_REF',
  'QAPAQ_ANTHROPIC_API_KEY',
] as const;

/**
 * Nombre convenido del secreto en Key Vault cuando el despliegue no declara la referencia.
 *
 * El host SIEM de Azure arma `core.env` con un allowlist que viaja en el `custom_data` de la VM:
 * agregarle `QAPAQ_ANTHROPIC_API_KEY_REF` obligaría a reemplazar la VM. Con el nombre convenido,
 * el asistente se enciende cargando el secreto y concediendo lectura sobre él (Terraform), sin
 * tocar el bootstrap. Sin ese permiso la lectura falla con `SECRET_ACCESS_DENIED` y el asistente
 * queda deshabilitado; nada más cambia.
 */
export const DEFAULT_ASSISTANT_SECRET_REFERENCE = 'secret://keyvault/qapaq-anthropic-api-key';

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
  options: {
    /** Un secreto opcional no se pudo leer: variable y código, nunca el valor ni el nombre. */
    readonly onOptionalSecretUnavailable?: (variable: string, code: string) => void;
  } = {},
): Promise<EnvironmentInput> {
  const providerType = environment['QAPAQ_SECRET_PROVIDER_TYPE'];
  const hasKeyVaultReference = [...API_SECRET_REFERENCES, ASSISTANT_SECRET_REFERENCE].some(
    ([referenceName]) => environment[referenceName]?.startsWith('secret://keyvault/'),
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

  for (const [, valueName] of [...API_SECRET_REFERENCES, ASSISTANT_SECRET_REFERENCE]) {
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
  for (const { valueName, reference } of references) {
    resolved[valueName] = await provider.resolve(reference);
  }
  const [assistantReferenceName, assistantValueName] = ASSISTANT_SECRET_REFERENCE;
  const declared = environment[assistantReferenceName];
  const assistantReference = parseSecretReference(
    declared === undefined || declared === '' ? DEFAULT_ASSISTANT_SECRET_REFERENCE : declared,
    assistantReferenceName,
  );
  // Una referencia declarada fuera de Key Vault es un error de despliegue, no un secreto ausente.
  if (!assistantReference.startsWith('secret://keyvault/')) {
    fail('SECRET_REFERENCE_INVALID', assistantReferenceName);
  }
  try {
    resolved[assistantValueName] = await provider.resolve(assistantReference);
  } catch (error) {
    options.onOptionalSecretUnavailable?.(
      assistantValueName,
      error instanceof SecretProviderError ? error.code : 'SECRET_RESOLUTION_FAILED',
    );
  }
  return Object.freeze(resolved);
}
