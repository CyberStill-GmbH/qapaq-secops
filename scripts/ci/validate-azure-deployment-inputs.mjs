import { isIP } from 'node:net';
import { createHash as nodeCreateHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/u;
const SECRET_URI =
  /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/u;
const SENSITIVE_ENV_NAME =
  /(PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|CONNECTION_STRING|AUTHORIZATION)/u;

function fail(message) {
  throw new Error(message);
}

function jsonEnv(env, name, fallback) {
  const raw = env[name] ?? fallback;
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${name} must contain valid JSON.`);
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be a JSON object.`);
  return value;
}

function exactKeys(value, required, optional, label) {
  const keys = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = keys.filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length || unknown.length) {
    fail(
      `${label} has missing or unsupported fields (missing: ${missing.join(', ') || 'none'}; unsupported: ${unknown.join(', ') || 'none'}).`,
    );
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '')
    fail(`${label} must be a non-empty string.`);
  return value;
}

function validCidr(value) {
  if (typeof value !== 'string') return false;
  const [address, prefix, ...extra] = value.split('/');
  if (extra.length || !prefix || !/^\d+$/u.test(prefix)) return false;
  const version = isIP(address);
  return version !== 0 && Number(prefix) <= (version === 4 ? 32 : 128);
}

function isPrivateRfc1918(value) {
  if (isIP(value) !== 4) return false;
  const octets = value.split('.').map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function digestImage(image, registry, label) {
  if (typeof image !== 'string' || !image.includes('@sha256:'))
    fail(`${label} must be pinned to an OCI SHA-256 digest.`);
  const [reference, digest, ...extra] = image.split('@sha256:');
  if (extra.length || !SHA256.test(digest) || !reference.startsWith(`${registry}/`)) {
    fail(`${label} must use the configured ACR and a lowercase 64-character SHA-256 digest.`);
  }
}

function stringMap(value, label, keyPattern, valuePattern) {
  object(value, label);
  for (const [key, item] of Object.entries(value)) {
    if (!keyPattern.test(key) || typeof item !== 'string' || !valuePattern.test(item)) {
      fail(`${label} contains an invalid key or value reference.`);
    }
  }
}

function validateImages(images, registry, required, label) {
  object(images, label);
  exactKeys(images, required, [], label);
  if (!registry || !/^[a-z0-9]{5,50}\.azurecr\.io$/u.test(registry))
    fail(
      'AZURE_ACR_LOGIN_SERVER must identify the configured ACR before publishing runtime images.',
    );
  for (const name of required) digestImage(images[name], registry, `${label}.${name}`);
}

function validateSiem(siem) {
  if (siem === null) return;
  object(siem, 'siem_host');
  const required = [
    'address_prefix',
    'vm_size',
    'admin_ssh_public_key',
    'ubuntu_image_version',
    'data_disk_size_gb',
    'dashboard_ingress_cidrs',
    'agent_ingress_cidrs',
    'core_secret_names',
    'wazuh_secret_names',
    'core_environment',
    'office365',
    'bootstrap_bundle_blob_url',
    'bootstrap_bundle_sha256',
  ];
  exactKeys(siem, required, [], 'siem_host');
  if (
    !validCidr(siem.address_prefix) ||
    !isPrivateRfc1918(siem.address_prefix.split('/')[0]) ||
    Number(siem.address_prefix.split('/')[1]) > 27
  )
    fail('siem_host.address_prefix must be a private IPv4 subnet with at least 32 addresses.');
  nonEmptyString(siem.vm_size, 'siem_host.vm_size');
  if (
    typeof siem.admin_ssh_public_key !== 'string' ||
    !/^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+(?: .*)?$/u.test(siem.admin_ssh_public_key)
  )
    fail('siem_host.admin_ssh_public_key must be a public SSH key.');
  if (
    typeof siem.ubuntu_image_version !== 'string' ||
    !/^24\.04\.\d+$/u.test(siem.ubuntu_image_version)
  )
    fail('siem_host.ubuntu_image_version must pin Ubuntu 24.04 to a numeric version.');
  if (!Number.isInteger(siem.data_disk_size_gb) || siem.data_disk_size_gb < 32)
    fail('siem_host.data_disk_size_gb must be an integer of at least 32.');
  for (const field of ['dashboard_ingress_cidrs', 'agent_ingress_cidrs']) {
    if (!Array.isArray(siem[field]) || !siem[field].every(validCidr))
      fail(`siem_host.${field} must be an array of valid CIDRs.`);
  }
  stringMap(
    siem.core_secret_names,
    'siem_host.core_secret_names',
    /^[A-Z][A-Z0-9_]{0,127}$/u,
    /^[A-Za-z0-9-]{1,127}$/u,
  );
  stringMap(
    siem.wazuh_secret_names,
    'siem_host.wazuh_secret_names',
    /^[A-Za-z0-9._-]{1,100}$/u,
    /^[A-Za-z0-9-]{1,127}$/u,
  );
  if (Object.keys(siem.wazuh_secret_names).length === 0)
    fail('siem_host.wazuh_secret_names must reference Wazuh bootstrap secrets by Key Vault name.');
  if (!Object.hasOwn(siem.wazuh_secret_names, 'office365-client-secret'))
    fail(
      'siem_host.wazuh_secret_names must map office365-client-secret to a pre-created Key Vault secret.',
    );
  if (!Object.hasOwn(siem.wazuh_secret_names, 'wazuh-install-files.tar.b64'))
    fail(
      'siem_host.wazuh_secret_names must map wazuh-install-files.tar.b64 to a pre-created Key Vault secret.',
    );
  object(siem.office365, 'siem_host.office365');
  exactKeys(
    siem.office365,
    ['tenant_id', 'client_id', 'api_type', 'enable_dlp'],
    [],
    'siem_host.office365',
  );
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (!guidPattern.test(siem.office365.tenant_id) || !guidPattern.test(siem.office365.client_id))
    fail('siem_host.office365 tenant_id and client_id must be GUIDs.');
  if (
    !['commercial', 'gcc', 'gcc-high'].includes(siem.office365.api_type) ||
    typeof siem.office365.enable_dlp !== 'boolean'
  )
    fail('siem_host.office365 api_type or enable_dlp is invalid.');
  if (!Object.hasOwn(siem.core_secret_names, 'QAPAQ_ENTRA_CLIENT_SECRET'))
    fail('siem_host.core_secret_names must reference the Entra client secret by Key Vault name.');
  if (!Object.hasOwn(siem.core_secret_names, 'QAPAQ_TEAMS_WORKFLOW_URL'))
    fail('siem_host.core_secret_names must reference the Teams Workflow URL by Key Vault name.');
  if (Object.hasOwn(siem.core_secret_names, 'QAPAQ_ENTRA_CLIENT_SECRET_REF'))
    fail('siem_host.core_secret_names must contain names only, not secret reference pseudo-keys.');
  stringMap(
    siem.core_environment,
    'siem_host.core_environment',
    /^[A-Z][A-Z0-9_]{0,127}$/u,
    /^[^\r\n]*$/u,
  );
  for (const key of Object.keys(siem.core_environment)) {
    if (key === 'QAPAQ_TEAMS_WORKFLOW_URL')
      fail(
        'siem_host.core_environment may not contain the signed Teams Workflow URL; map its Key Vault secret name in core_secret_names.',
      );
    if (key !== 'QAPAQ_ENTRA_CLIENT_SECRET_REF' && SENSITIVE_ENV_NAME.test(key))
      fail(
        'siem_host.core_environment may not contain values under sensitive environment-variable names.',
      );
  }
  const entraRef = siem.core_environment.QAPAQ_ENTRA_CLIENT_SECRET_REF;
  if (
    typeof entraRef !== 'string' ||
    !/^secret:\/\/keyvault\/[A-Za-z0-9][A-Za-z0-9-]{0,126}$/u.test(entraRef) ||
    entraRef.slice('secret://keyvault/'.length) !== siem.core_secret_names.QAPAQ_ENTRA_CLIENT_SECRET
  ) {
    fail(
      'siem_host.core_environment must reference the same Key Vault Entra secret name as core_secret_names.',
    );
  }
  if (
    typeof siem.bootstrap_bundle_blob_url !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+\.blob\.core\.windows\.net\/[^?]+$/u.test(
      siem.bootstrap_bundle_blob_url,
    )
  )
    fail(
      'siem_host.bootstrap_bundle_blob_url must be an HTTPS Blob URL without SAS/query parameters.',
    );
  if (
    typeof siem.bootstrap_bundle_sha256 !== 'string' ||
    !SHA256.test(siem.bootstrap_bundle_sha256)
  )
    fail('siem_host.bootstrap_bundle_sha256 must be lowercase SHA-256.');
}

function validateAnkay(ankay, siem, registry) {
  if (ankay === null) return;
  object(ankay, 'ankay_host');
  if (siem === null)
    fail('ankay_host requires a configured siem_host; Ankay cannot replace the SIEM.');
  const required = [
    'private_ip_address',
    'admin_ssh_public_key',
    'vm_size',
    'ubuntu_image_version',
    'container_images',
    'compose_yaml',
    'compose_sha256',
  ];
  exactKeys(ankay, required, ['data_disk_size_gb'], 'ankay_host');
  if (!isPrivateRfc1918(ankay.private_ip_address))
    fail('ankay_host.private_ip_address must be an RFC1918 private IPv4 address.');
  if (
    typeof ankay.admin_ssh_public_key !== 'string' ||
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/u.test(
      ankay.admin_ssh_public_key,
    )
  )
    fail('ankay_host.admin_ssh_public_key must be a public SSH key.');
  nonEmptyString(ankay.vm_size, 'ankay_host.vm_size');
  if (
    typeof ankay.ubuntu_image_version !== 'string' ||
    !/^\d{8}(?:\.\d+)?$/u.test(ankay.ubuntu_image_version)
  )
    fail('ankay_host.ubuntu_image_version must pin a numeric Ubuntu image version.');
  if (
    Object.hasOwn(ankay, 'data_disk_size_gb') &&
    (!Number.isInteger(ankay.data_disk_size_gb) || ankay.data_disk_size_gb < 32)
  )
    fail('ankay_host.data_disk_size_gb must be an integer of at least 32.');
  validateImages(
    ankay.container_images,
    registry,
    ['shuffle-security', 'frontend', 'backend', 'orborus', 'opensearch', 'worker'],
    'ankay_host.container_images',
  );
  nonEmptyString(ankay.compose_yaml, 'ankay_host.compose_yaml');
  if (typeof ankay.compose_sha256 !== 'string' || !SHA256.test(ankay.compose_sha256))
    fail('ankay_host.compose_sha256 must be lowercase SHA-256.');
  const actual = nodeCreateHash('sha256').update(ankay.compose_yaml).digest('hex');
  if (actual !== ankay.compose_sha256)
    fail('ankay_host.compose_sha256 does not match compose_yaml.');
  if (
    /^\s*(?:-\s*)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY(?:_ID)?|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|CONNECTION_STRING|AUTHORIZATION)(?:_[A-Z0-9_]+)?\s*[:=]\s*(?!\$\{|\$[A-Z_])[^\s#][^\r\n]*$/imu.test(
      ankay.compose_yaml,
    )
  )
    fail(
      'ankay_host.compose_yaml appears to contain a literal credential; use secret references and keep values in Key Vault.',
    );
}

function validateKeyVaultIds(ids) {
  object(ids, 'key_vault_secret_ids');
  for (const [service, refs] of Object.entries(ids)) {
    if (!['edge', 'web', 'gateway', 'api', 'worker'].includes(service))
      fail('key_vault_secret_ids contains an unsupported runtime service key.');
    object(refs, `key_vault_secret_ids.${service}`);
    for (const [name, uri] of Object.entries(refs)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(name) ||
        typeof uri !== 'string' ||
        !SECRET_URI.test(uri)
      ) {
        fail(
          'key_vault_secret_ids must contain only versioned HTTPS Key Vault secret IDs, never secret values.',
        );
      }
    }
  }
}

export function validateDeploymentInputs(env = process.env) {
  const enableRuntime = env.TF_VAR_enable_runtime ?? 'false';
  if (enableRuntime !== 'true' && enableRuntime !== 'false')
    fail('AZURE_ENABLE_RUNTIME must be the literal true or false.');
  const registry = env.AZURE_ACR_LOGIN_SERVER ?? '';
  const images = jsonEnv(env, 'TF_VAR_container_images', '{}');
  const siem = jsonEnv(env, 'TF_VAR_siem_host', 'null');
  const ankay = jsonEnv(env, 'TF_VAR_ankay_host', 'null');
  const keyVaultIds = jsonEnv(env, 'TF_VAR_key_vault_secret_ids', '{}');
  if (Object.keys(object(images, 'container_images')).length)
    validateImages(
      images,
      registry,
      ['edge', 'web', 'gateway', 'api', 'worker'],
      'container_images',
    );
  if (enableRuntime === 'true') {
    if (siem === null)
      fail(
        'AZURE_ENABLE_RUNTIME cannot substitute for siem_host; configure SIEM explicitly first.',
      );
    validateImages(
      images,
      registry,
      ['edge', 'web', 'gateway', 'api', 'worker'],
      'container_images',
    );
  }
  validateSiem(siem);
  validateAnkay(ankay, siem, registry);
  validateKeyVaultIds(keyVaultIds);
  return {
    enableRuntime: enableRuntime === 'true',
    hasSiem: siem !== null,
    hasAnkay: ankay !== null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = validateDeploymentInputs();
    console.log(
      `Azure deployment inputs valid: runtime=${result.enableRuntime}, siem_host=${result.hasSiem}, ankay_host=${result.hasAnkay}.`,
    );
  } catch (error) {
    console.error(`Azure deployment inputs rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
