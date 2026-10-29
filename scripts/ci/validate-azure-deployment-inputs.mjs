import { isIP } from 'node:net';
import { createHash as nodeCreateHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/u;
const SECRET_URI =
  /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/u;
const SENSITIVE_ENV_NAME =
  /(PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|CONNECTION_STRING|AUTHORIZATION)/u;
const MIN_DASHBOARD_INGRESS_PREFIX = 24;

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

function ipv4CidrHost(cidr, hostOffset) {
  const [address, prefix, ...extra] = String(cidr).split('/');
  if (extra.length || !prefix || isIP(address) !== 4 || !/^\d+$/u.test(prefix)) return null;
  const prefixLength = Number(prefix);
  if (prefixLength < 0 || prefixLength > 32 || !Number.isInteger(hostOffset)) return null;
  const octets = address.split('.').map(Number);
  const ip = octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  const blockSize = 1n << BigInt(32 - prefixLength);
  const mask = prefixLength === 0 ? 0n : (1n << 32n) - blockSize;
  const network = ip & mask;
  const host = network + BigInt(hostOffset);
  if (host < network || host >= network + blockSize) return null;
  return [24n, 16n, 8n, 0n].map((shift) => Number((host >> shift) & 255n)).join('.');
}

function validateRestrictedIngressCidrs(cidrs, label) {
  if (!Array.isArray(cidrs)) fail(`${label} must be an array of CIDRs.`);
  for (const cidr of cidrs) {
    const range = ipv4Range(cidr);
    if (!range || range.prefix < MIN_DASHBOARD_INGRESS_PREFIX) {
      fail(
        `${label} entries must be aligned IPv4 CIDRs no broader than /${MIN_DASHBOARD_INGRESS_PREFIX}.`,
      );
    }
  }
}

function validateDashboardIngressCidrs(cidrs) {
  validateRestrictedIngressCidrs(cidrs, 'siem_host.dashboard_ingress_cidrs');
}

function validateProviderIngestion(value, wazuhSecretNames) {
  if (value === undefined) return;
  object(value, 'siem_host.provider_ingestion');
  const providerKeys = [
    'sophos_enabled',
    'sophos_tenant_id',
    'sophos_data_region',
    'cato_enabled',
    'cato_account_id',
  ];
  exactKeys(value, [], providerKeys, 'siem_host.provider_ingestion');

  for (const item of Object.values(value)) {
    if (typeof item !== 'string' || /[\r\n]/u.test(item)) {
      fail('siem_host.provider_ingestion values must be single-line strings.');
    }
  }

  const sophosEnabled = value.sophos_enabled ?? 'false';
  const catoEnabled = value.cato_enabled ?? 'false';
  if (!['true', 'false'].includes(sophosEnabled) || !['true', 'false'].includes(catoEnabled)) {
    fail('siem_host.provider_ingestion flags must be the strings true or false.');
  }

  if (sophosEnabled === 'true') {
    const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (
      !guidPattern.test(value.sophos_tenant_id ?? '') ||
      !/^[a-z0-9-]{2,32}$/u.test(value.sophos_data_region ?? '') ||
      !Object.hasOwn(wazuhSecretNames, 'sophos-client-id') ||
      !Object.hasOwn(wazuhSecretNames, 'sophos-client-secret')
    ) {
      fail(
        'siem_host.provider_ingestion Sophos requires a tenant GUID, data region, and Key Vault secret names.',
      );
    }
  }

  if (catoEnabled === 'true') {
    if (
      !/^[0-9]{1,20}$/u.test(value.cato_account_id ?? '') ||
      !Object.hasOwn(wazuhSecretNames, 'cato-api-key')
    ) {
      fail(
        'siem_host.provider_ingestion Cato requires an account ID and a Key Vault API key name.',
      );
    }
  }
}

function isUsableAnkayHostAddress(address, env) {
  const host = ipv4Number(address);
  const subnet = ipv4Range(subnetCidr(effectiveAddressSpace(env), 11, 1));
  if (host === null || !subnet) return false;
  // Azure reserves the first four addresses and the final address in every subnet.
  return host >= subnet.start + 4n && host < subnet.end;
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

function ipv4Number(value) {
  if (isIP(value) !== 4) return null;
  return value.split('.').reduce((number, octet) => (number << 8n) | BigInt(octet), 0n);
}

function ipv4Text(value) {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
}

function ipv4Range(cidr) {
  if (!validCidr(cidr)) return null;
  const [address, prefixText] = cidr.split('/');
  if (isIP(address) !== 4) return null;
  const prefix = Number(prefixText);
  const hostBits = 32 - prefix;
  const blockSize = 1n << BigInt(hostBits);
  const addressNumber = ipv4Number(address);
  const start = (addressNumber / blockSize) * blockSize;
  if (addressNumber !== start) return null;
  return { start, end: start + blockSize - 1n, prefix };
}

function subnetCidr(parentCidr, newBits, netNum) {
  const parent = ipv4Range(parentCidr);
  if (!parent || parent.prefix + newBits > 32) fail('Terraform subnet layout must be IPv4.');
  const prefix = parent.prefix + newBits;
  const blockSize = 1n << BigInt(32 - prefix);
  const start = parent.start + BigInt(netNum) * blockSize;
  return `${ipv4Text(start)}/${prefix}`;
}

function rangesOverlap(leftCidr, rightCidr) {
  const left = ipv4Range(leftCidr);
  const right = ipv4Range(rightCidr);
  return Boolean(left && right && left.start <= right.end && right.start <= left.end);
}

function effectiveAddressSpace(env) {
  if (typeof env.TF_VAR_address_space === 'string' && env.TF_VAR_address_space.trim()) {
    return env.TF_VAR_address_space.trim();
  }

  // EUS2 passes the versioned profile file to Terraform instead of exporting
  // every tfvars field into the job environment. Read only its non-secret
  // address_space value so preflight checks the exact profile being planned.
  const profilePath = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../infra/azure/profiles/demo-eus2.tfvars',
  );
  try {
    const profile = readFileSync(profilePath, 'utf8');
    const match = profile.match(/^\s*address_space\s*=\s*"([^"]+)"\s*$/mu);
    if (match) return match[1];
  } catch {
    // Non-repository callers use the Terraform root's documented default.
  }
  return '10.80.0.0/16';
}

function validateSiemSubnet(siem, env) {
  const vnetCidr = effectiveAddressSpace(env);
  const vnet = ipv4Range(vnetCidr);
  const subnet = ipv4Range(siem.address_prefix);
  if (!subnet) fail('siem_host.address_prefix must be a network-aligned IPv4 CIDR.');
  if (!vnet || vnet.prefix !== 16)
    fail('The configured Azure VNet address_space must be a valid IPv4 /16 CIDR.');
  if (subnet.start < vnet.start || subnet.end > vnet.end) {
    fail('siem_host.address_prefix must be wholly contained in the configured Azure VNet.');
  }

  const reserved = [
    ['Container Apps', subnetCidr(vnetCidr, 11, 0)],
    ['Ankay', subnetCidr(vnetCidr, 11, 1)],
    ['KrakenD', subnetCidr(vnetCidr, 11, 2)],
    ['PostgreSQL', subnetCidr(vnetCidr, 12, 256)],
    ['Private Endpoints', subnetCidr(vnetCidr, 12, 257)],
    ['Azure Firewall', subnetCidr(vnetCidr, 10, 256)],
  ];
  const collisions = reserved
    .filter(([, cidr]) => rangesOverlap(siem.address_prefix, cidr))
    .map(([name]) => name);
  if (collisions.length > 0) {
    fail(`siem_host.address_prefix overlaps reserved subnets: ${collisions.join(', ')}.`);
  }
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

function validateSiem(siem, env = process.env) {
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
  exactKeys(
    siem,
    required,
    ['provider_ingestion', 'private_ip_address', 'agent_public_cidrs'],
    'siem_host',
  );
  if (
    !validCidr(siem.address_prefix) ||
    !isPrivateRfc1918(siem.address_prefix.split('/')[0]) ||
    Number(siem.address_prefix.split('/')[1]) > 27
  )
    fail('siem_host.address_prefix must be a private IPv4 subnet with at least 32 addresses.');
  validateSiemSubnet(siem, env);
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
  if (!Array.isArray(siem.dashboard_ingress_cidrs))
    fail('siem_host.dashboard_ingress_cidrs must be an array of CIDRs.');
  validateDashboardIngressCidrs(siem.dashboard_ingress_cidrs);
  if (siem.agent_public_cidrs !== undefined) {
    validateRestrictedIngressCidrs(siem.agent_public_cidrs, 'siem_host.agent_public_cidrs');
  }
  if (!Array.isArray(siem.agent_ingress_cidrs) || !siem.agent_ingress_cidrs.every(validCidr))
    fail('siem_host.agent_ingress_cidrs must be an array of valid CIDRs.');
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
  validateProviderIngestion(siem.provider_ingestion, siem.wazuh_secret_names);
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

function validateAnkay(ankay, siem, registry, env = process.env) {
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
    'secret_names',
    'docker_package_versions',
  ];
  exactKeys(ankay, required, ['data_disk_size_gb', 'app_images'], 'ankay_host');
  if (!isPrivateRfc1918(ankay.private_ip_address))
    fail('ankay_host.private_ip_address must be an RFC1918 private IPv4 address.');
  if (!isUsableAnkayHostAddress(ankay.private_ip_address, env))
    fail(
      'ankay_host.private_ip_address must be a usable Azure host address in the reserved Ankay subnet.',
    );
  if (
    typeof ankay.admin_ssh_public_key !== 'string' ||
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/u.test(
      ankay.admin_ssh_public_key,
    )
  )
    fail('ankay_host.admin_ssh_public_key must be a public SSH key.');
  // Única familia con cuota en la suscripción EUS2 (el SIEM ya usa 4 de 10 vCPU EBDSv5).
  if (!['Standard_E2bds_v5', 'Standard_E4bds_v5'].includes(ankay.vm_size))
    fail('ankay_host.vm_size must be Standard_E2bds_v5 or Standard_E4bds_v5.');
  if (
    typeof ankay.ubuntu_image_version !== 'string' ||
    !/^(?:24\.04\.\d{9}|\d{8}(?:\.\d+)?)$/u.test(ankay.ubuntu_image_version)
  )
    fail('ankay_host.ubuntu_image_version must pin an exact Ubuntu 24.04 image version.');
  if (
    Object.hasOwn(ankay, 'data_disk_size_gb') &&
    (!Number.isInteger(ankay.data_disk_size_gb) || ankay.data_disk_size_gb < 64)
  )
    fail('ankay_host.data_disk_size_gb must be an integer of at least 64.');
  validateImages(
    ankay.container_images,
    registry,
    ['docker-guard', 'frontend', 'backend', 'orborus', 'opensearch', 'worker'],
    'ankay_host.container_images',
  );
  if (Object.hasOwn(ankay, 'app_images')) {
    object(ankay.app_images, 'ankay_host.app_images');
    for (const [tag, image] of Object.entries(ankay.app_images)) {
      if (!/^ankay\/apps:[a-z0-9-]+_\d+\.\d+\.\d+$/u.test(tag))
        fail(`ankay_host.app_images key ${tag} must be ankay/apps:<app>_<x.y.z>.`);
      digestImage(image, registry, `ankay_host.app_images.${tag}`);
    }
  }
  nonEmptyString(ankay.compose_yaml, 'ankay_host.compose_yaml');
  if (typeof ankay.compose_sha256 !== 'string' || !SHA256.test(ankay.compose_sha256))
    fail('ankay_host.compose_sha256 must be lowercase SHA-256.');
  stringMap(
    ankay.secret_names,
    'ankay_host.secret_names',
    /^[A-Z][A-Z0-9_]{0,127}$/u,
    /^[A-Za-z0-9-]{1,127}$/u,
  );
  if (Object.keys(ankay.secret_names).length === 0)
    fail(
      'ankay_host.secret_names must map runtime environment variables to pre-created Key Vault secret names.',
    );
  object(ankay.docker_package_versions, 'ankay_host.docker_package_versions');
  exactKeys(
    ankay.docker_package_versions,
    [
      'docker-ce',
      'docker-ce-cli',
      'containerd.io',
      'docker-buildx-plugin',
      'docker-compose-plugin',
      'azure-cli',
    ],
    [],
    'ankay_host.docker_package_versions',
  );
  for (const [packageName, version] of Object.entries(ankay.docker_package_versions)) {
    if (typeof version !== 'string' || !/^[A-Za-z0-9:.+~_-]{1,80}$/u.test(version))
      fail(
        `ankay_host.docker_package_versions.${packageName} must be a fixed apt package version.`,
      );
  }
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

function validateKrakendGateway(gateway, siem, registry) {
  if (gateway === null) return;
  object(gateway, 'krakend_gateway');
  if (siem === null)
    fail('krakend_gateway requires a configured siem_host for its private Indexer proxy.');
  exactKeys(
    gateway,
    [
      'image',
      'tenant_id',
      'client_scope',
      'core_client_id',
      'indexer_reader_secret_name',
      'indexer_proxy_ca_secret_name',
    ],
    [],
    'krakend_gateway',
  );
  digestImage(gateway.image, registry, 'krakend_gateway.image');
  const imageName = gateway.image.split('@sha256:')[0].split('/').at(-1);
  if (imageName !== 'qapaq-secops-krakend')
    fail('krakend_gateway.image must use the qapaq-secops-krakend ACR repository.');
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (
    typeof gateway.tenant_id !== 'string' ||
    !guidPattern.test(gateway.tenant_id) ||
    typeof gateway.core_client_id !== 'string' ||
    !guidPattern.test(gateway.core_client_id) ||
    typeof gateway.client_scope !== 'string' ||
    !/^api:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\.default$/iu.test(
      gateway.client_scope,
    )
  )
    fail('krakend_gateway tenant, core client and app scope must use valid Entra identifiers.');
  const secretNamePattern = /^[A-Za-z0-9-]{1,127}$/u;
  for (const key of ['indexer_reader_secret_name', 'indexer_proxy_ca_secret_name']) {
    if (typeof gateway[key] !== 'string' || !secretNamePattern.test(gateway[key]))
      fail(`krakend_gateway.${key} must be a Key Vault secret name, never a value.`);
  }
  if (gateway.indexer_reader_secret_name === gateway.indexer_proxy_ca_secret_name)
    fail('krakend_gateway requires two distinct Key Vault secret names.');
  if (
    gateway.indexer_reader_secret_name !== 'wazuh-reader-b64' ||
    gateway.indexer_proxy_ca_secret_name !== 'wazuh-proxy-ca'
  )
    fail(
      'krakend_gateway must use the two exact EUS2 bootstrap secret references allowed by the protected seeder.',
    );
  const privateIp = siem.private_ip_address;
  if (
    typeof privateIp !== 'string' ||
    isIP(privateIp) !== 4 ||
    !isPrivateRfc1918(privateIp) ||
    privateIp !== ipv4CidrHost(siem.address_prefix, 4)
  )
    fail('krakend_gateway requires the stable SIEM private IP reserved as host .4 in its subnet.');
  const existingNames = new Set([
    ...Object.values(siem.core_secret_names),
    ...Object.values(siem.wazuh_secret_names),
  ]);
  if (
    existingNames.has(gateway.indexer_reader_secret_name) ||
    existingNames.has(gateway.indexer_proxy_ca_secret_name)
  )
    fail(
      'krakend_gateway must use dedicated Key Vault names for its reader and proxy certificate.',
    );
  if (!Object.hasOwn(siem.core_secret_names, 'QAPAQ_ENTRA_CLIENT_SECRET'))
    fail('krakend_gateway requires QAPAQ_ENTRA_CLIENT_SECRET by Key Vault name in siem_host.');
  if (
    siem.core_environment.QAPAQ_ENTRA_TENANT_ID !== gateway.tenant_id ||
    siem.core_environment.QAPAQ_ENTRA_CLIENT_ID !== gateway.core_client_id
  )
    fail('krakend_gateway Entra tenant/client IDs must match the QAPAQ Core configuration.');
  if (
    siem.core_environment.QAPAQ_INGESTION_SOURCE !== undefined &&
    siem.core_environment.QAPAQ_INGESTION_SOURCE !== 'wazuh'
  )
    fail('krakend_gateway requires QAPAQ_INGESTION_SOURCE=wazuh.');
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
  const krakendGateway = jsonEnv(env, 'TF_VAR_krakend_gateway', 'null');
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
  validateSiem(siem, env);
  validateAnkay(ankay, siem, registry, env);
  validateKrakendGateway(krakendGateway, siem, registry);
  validateKeyVaultIds(keyVaultIds);
  return {
    enableRuntime: enableRuntime === 'true',
    hasSiem: siem !== null,
    hasAnkay: ankay !== null,
    hasKrakendGateway: krakendGateway !== null,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = validateDeploymentInputs();
    console.log(
      `Azure deployment inputs valid: runtime=${result.enableRuntime}, siem_host=${result.hasSiem}, ankay_host=${result.hasAnkay}, krakend_gateway=${result.hasKrakendGateway}.`,
    );
  } catch (error) {
    console.error(`Azure deployment inputs rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
