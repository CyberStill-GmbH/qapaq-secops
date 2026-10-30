import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateDeploymentInputs } from './validate-azure-deployment-inputs.mjs';

const registry = 'qapaqdemo.azurecr.io';
const sha = 'a'.repeat(64);
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2VLZXlOb3RTZWNyZXQ= test';

function baseEnv(overrides = {}) {
  return {
    AZURE_ACR_LOGIN_SERVER: registry,
    TF_VAR_enable_runtime: 'false',
    TF_VAR_container_images: '{}',
    TF_VAR_siem_host: 'null',
    TF_VAR_ankay_host: 'null',
    TF_VAR_krakend_gateway: 'null',
    TF_VAR_key_vault_secret_ids: '{}',
    ...overrides,
  };
}

function siemHost(overrides = {}) {
  return {
    address_prefix: '10.80.16.32/27',
    private_ip_address: '10.80.16.36',
    vm_size: 'Standard_F4s_v2',
    admin_ssh_public_key: publicKey,
    ubuntu_image_version: '24.04.202601010',
    data_disk_size_gb: 128,
    dashboard_ingress_cidrs: [],
    agent_ingress_cidrs: ['10.80.0.0/16'],
    agent_public_cidrs: ['203.0.113.25/32'],
    core_secret_names: {
      QAPAQ_ENTRA_CLIENT_SECRET: 'entra-client-secret',
      QAPAQ_TEAMS_WORKFLOW_URL: 'teams-workflow-url',
    },
    wazuh_secret_names: {
      'dashboard-password': 'wazuh-dashboard-password',
      'office365-client-secret': 'office365-client-secret',
      'wazuh-install-files.tar.b64': 'wazuh-install-files-tar-b64',
    },
    core_environment: {
      QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://keyvault/entra-client-secret',
      QAPAQ_ENTRA_TENANT_ID: '45f2f938-dbe3-4a3e-8a54-930893f94ef8',
      QAPAQ_ENTRA_CLIENT_ID: '336d44fe-b99d-4cfd-9c6e-0ed2d7e48998',
      QAPAQ_INGESTION_SOURCE: 'wazuh',
    },
    office365: {
      tenant_id: '11111111-1111-4111-8111-111111111111',
      client_id: '22222222-2222-4222-8222-222222222222',
      api_type: 'commercial',
      enable_dlp: false,
    },
    bootstrap_bundle_blob_url: 'https://qapaqdata.blob.core.windows.net/releases/siem.tar.gz',
    bootstrap_bundle_sha256: sha,
    ...overrides,
  };
}

function krakendGateway(overrides = {}) {
  return {
    image: registry + '/qapaq-secops-krakend@sha256:' + sha,
    tenant_id: '45f2f938-dbe3-4a3e-8a54-930893f94ef8',
    client_scope: 'api://00000000-0000-4000-8000-000000000002/.default',
    core_client_id: '336d44fe-b99d-4cfd-9c6e-0ed2d7e48998',
    indexer_reader_secret_name: 'wazuh-reader-b64',
    indexer_proxy_ca_secret_name: 'wazuh-proxy-ca',
    ...overrides,
  };
}

function digestMap(names) {
  return Object.fromEntries(names.map((name) => [name, `${registry}/${name}@sha256:${sha}`]));
}

test('defaults keep generic runtime, SIEM and Ankay disabled', () => {
  assert.deepEqual(validateDeploymentInputs({}), {
    enableRuntime: false,
    hasSiem: false,
    hasAnkay: false,
    hasKrakendGateway: false,
  });
});

test('accepts a complete SIEM configuration with Key Vault names and an immutable bundle reference', () => {
  assert.deepEqual(
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(siemHost()) })),
    {
      enableRuntime: false,
      hasSiem: true,
      hasAnkay: false,
      hasKrakendGateway: false,
    },
  );
});

test('accepts an opt-in private KrakenD profile with SIEM, matching Entra config, and exact Key Vault names', () => {
  assert.deepEqual(
    validateDeploymentInputs(
      baseEnv({
        TF_VAR_siem_host: JSON.stringify(siemHost()),
        TF_VAR_krakend_gateway: JSON.stringify(krakendGateway()),
      }),
    ),
    {
      enableRuntime: false,
      hasSiem: true,
      hasAnkay: false,
      hasKrakendGateway: true,
    },
  );
});

test('rejects KrakenD without SIEM, mismatched Core identity, wrong secret names, or unstable SIEM IP', () => {
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({ TF_VAR_krakend_gateway: JSON.stringify(krakendGateway()) }),
      ),
    /requires a configured siem_host/u,
  );

  const invalidGateways = [
    krakendGateway({ core_client_id: '00000000-0000-4000-8000-000000000999' }),
    krakendGateway({ indexer_reader_secret_name: 'arbitrary-secret' }),
    krakendGateway({ image: 'qapaqdemo.azurecr.io/krakend:latest' }),
    krakendGateway({ client_scope: 'not-an-app-scope' }),
  ];
  for (const gateway of invalidGateways) {
    assert.throws(() =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_siem_host: JSON.stringify(siemHost()),
          TF_VAR_krakend_gateway: JSON.stringify(gateway),
        }),
      ),
    );
  }
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_siem_host: JSON.stringify(siemHost({ private_ip_address: '10.80.16.37' })),
          TF_VAR_krakend_gateway: JSON.stringify(krakendGateway()),
        }),
      ),
    /stable SIEM private IP/u,
  );
});

test('rejects SIEM subnets that overlap any subnet reserved by the Azure network module', () => {
  const reservedPrefixes = [
    { cidr: '10.80.0.0/27', reason: /Container Apps/u },
    { cidr: '10.80.0.32/27', reason: /Ankay/u },
    { cidr: '10.80.0.64/27', reason: /KrakenD/u },
    {
      cidr: '10.80.16.0/27',
      reason: /PostgreSQL, Private Endpoints/u,
    },
    { cidr: '10.80.64.0/26', reason: /Azure Firewall/u },
  ];

  for (const { cidr: address_prefix, reason } of reservedPrefixes) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_address_space: '10.80.0.0/16',
            TF_VAR_siem_host: JSON.stringify(siemHost({ address_prefix })),
          }),
        ),
      reason,
      `${address_prefix} must not be accepted as a SIEM subnet`,
    );
  }
});

test('rejects a SIEM subnet outside the configured VNet or with host bits set', () => {
  for (const address_prefix of ['10.81.0.0/27', '10.80.16.33/27']) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_address_space: '10.80.0.0/16',
            TF_VAR_siem_host: JSON.stringify(siemHost({ address_prefix })),
          }),
        ),
      /contained in the configured Azure VNet|network-aligned IPv4 CIDR/u,
      `${address_prefix} must not be accepted as a SIEM subnet`,
    );
  }
});

test('computes reserved subnets from a non-default address_space supplied by the deployment', () => {
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_address_space: '10.90.0.0/16',
          TF_VAR_siem_host: JSON.stringify(siemHost({ address_prefix: '10.90.16.0/27' })),
        }),
      ),
    /overlaps reserved subnets: PostgreSQL/u,
  );
});

test('rejects malformed JSON and missing required SIEM fields without echoing input values', () => {
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: '{invalid-secret-shaped-input}' })),
    /valid JSON/u,
  );
  const invalid = siemHost();
  delete invalid.bootstrap_bundle_sha256;
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(invalid) })),
    /missing or unsupported fields/u,
  );
});

test('rejects public addresses for private SIEM and Ankay network endpoints', () => {
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_siem_host: JSON.stringify(siemHost({ address_prefix: '8.8.8.0/27' })),
        }),
      ),
    /private IPv4 subnet/u,
  );
});

test('SIEM subnet must be aligned, inside the EUS2 VNet, and disjoint from reserved subnets', () => {
  const cases = [
    ['10.80.0.65/27', /network-aligned/u],
    ['10.81.0.0/27', /contained in the configured Azure VNet/u],
    ['10.80.0.0/27', /overlaps reserved subnets: Container Apps/u],
    ['10.80.0.32/27', /overlaps reserved subnets: Ankay/u],
    ['10.80.0.64/27', /overlaps reserved subnets: KrakenD/u],
    ['10.80.16.0/27', /overlaps reserved subnets: PostgreSQL, Private Endpoints/u],
    ['10.80.64.0/26', /overlaps reserved subnets: Azure Firewall/u],
    ['10.80.0.0/16', /overlaps reserved subnets: Container Apps/u],
  ];

  for (const [addressPrefix, message] of cases) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost({ address_prefix: addressPrefix })),
          }),
        ),
      message,
      `expected ${addressPrefix} to be rejected`,
    );
  }

  assert.doesNotThrow(() =>
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(siemHost()) })),
  );
});

test('Dashboard ingress accepts public IPv4 or aligned /24 allowlists and rejects broad or unaligned ranges', () => {
  const allowed = siemHost({ dashboard_ingress_cidrs: ['198.51.100.0/24', '203.0.113.25/32'] });
  assert.doesNotThrow(() =>
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(allowed) })),
  );
  assert.doesNotThrow(() =>
    validateDeploymentInputs(
      baseEnv({
        TF_VAR_siem_host: JSON.stringify(siemHost({ dashboard_ingress_cidrs: ['0.0.0.0/0'] })),
      }),
    ),
  );

  for (const cidr of [
    '0.0.0.0/1',
    '198.51.0.0/16',
    '198.51.100.0/23',
    '198.51.100.25/24',
    '2001:db8::/0',
    '2001:db8::/64',
  ]) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost({ dashboard_ingress_cidrs: [cidr] })),
          }),
        ),
      /aligned IPv4 CIDRs no broader than \/24/u,
      `expected ${cidr} to be rejected`,
    );
  }

  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_siem_host: JSON.stringify(
            siemHost({ dashboard_ingress_cidrs: ['0.0.0.0/0', '198.51.100.25/32'] }),
          ),
        }),
      ),
    /must use 0\.0\.0\.0\/0 alone/u,
  );
});

test('public agent DNAT sources are restricted to aligned IPv4 allowlists no broader than /24', () => {
  assert.doesNotThrow(() =>
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(siemHost()) })),
  );

  for (const cidr of ['0.0.0.0/0', '198.51.100.0/23', '198.51.100.25/24', '2001:db8::/64']) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost({ agent_public_cidrs: [cidr] })),
          }),
        ),
      /agent_public_cidrs entries must be aligned IPv4 CIDRs no broader than \/24/u,
      `expected ${cidr} to be rejected`,
    );
  }
});

test('accepts the Qapaqzito Key Vault secret name without exposing its API key', () => {
  assert.doesNotThrow(() =>
    validateDeploymentInputs(
      baseEnv({
        TF_VAR_siem_host: JSON.stringify(siemHost({ assistant_secret_name: 'qapaq-anthropic-api-key' })),
      }),
    ),
  );
});

test('rejects malformed Qapaqzito secret names and clear API-key-shaped values', () => {
  const invalidValues = [
    '',
    'secret_with_underscore',
    'sk-ant-api03-not-a-real-key',
    'x'.repeat(128),
    42,
  ];
  for (const assistant_secret_name of invalidValues) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost({ assistant_secret_name })),
          }),
        ),
      /assistant_secret_name must be a Key Vault secret name, never an API key value/u,
    );
  }
});
test('SIEM accepts the optional closed provider_ingestion map and valid connector flags', () => {
  const providerIngestion = {
    sophos_enabled: 'true',
    sophos_tenant_id: '33333333-3333-4333-8333-333333333333',
    sophos_data_region: 'eu-west-1',
    cato_enabled: 'true',
    cato_account_id: '123456789',
  };
  const valid = siemHost({
    provider_ingestion: providerIngestion,
    wazuh_secret_names: {
      ...siemHost().wazuh_secret_names,
      'sophos-client-id': 'sophos-client-id',
      'sophos-client-secret': 'sophos-client-secret',
      'cato-api-key': 'cato-api-key',
    },
  });
  assert.doesNotThrow(() =>
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(valid) })),
  );
});

test('provider_ingestion rejects unsupported keys, invalid flags, and non-string values', () => {
  const invalidCases = [
    [{ sophos_enabled: 'false', unsupported: 'value' }, /unsupported fields/u],
    [{ sophos_enabled: 'yes' }, /flags must be the strings true or false/u],
    [{ cato_enabled: true }, /single-line strings/u],
    [{ cato_account_id: '123\n456' }, /single-line strings/u],
  ];

  for (const [providerIngestion, expectedError] of invalidCases) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost({ provider_ingestion: providerIngestion })),
          }),
        ),
      expectedError,
    );
  }
});

test('enabled Sophos and Cato require their non-secret identifiers and Key Vault name mappings', () => {
  const cases = [
    [{ sophos_enabled: 'true' }, /Sophos requires a tenant GUID/u],
    [{ cato_enabled: 'true', cato_account_id: '12345' }, /Cato requires an account ID/u],
  ];

  for (const [providerIngestion, expectedError] of cases) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost({ provider_ingestion: providerIngestion })),
          }),
        ),
      expectedError,
    );
  }
});

test('requires a Key Vault-backed Office 365 client secret and valid non-secret config', () => {
  const invalidSecretMap = siemHost();
  delete invalidSecretMap.wazuh_secret_names['office365-client-secret'];
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(invalidSecretMap) })),
    /must map office365-client-secret/u,
  );

  const invalidClient = siemHost({
    office365: { ...siemHost().office365, client_id: 'not-a-guid' },
  });
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(invalidClient) })),
    /must be GUIDs/u,
  );
});

test('requires the Wazuh certificate/password archive before enabling host creation', () => {
  const missingInstallArchive = siemHost();
  delete missingInstallArchive.wazuh_secret_names['wazuh-install-files.tar.b64'];
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({ TF_VAR_siem_host: JSON.stringify(missingInstallArchive) }),
      ),
    /must map wazuh-install-files\.tar\.b64/u,
  );
});

test('requires the signed Teams Workflow URL from Key Vault and rejects it in plain environment config', () => {
  const missingTeamsSecret = siemHost();
  delete missingTeamsSecret.core_secret_names.QAPAQ_TEAMS_WORKFLOW_URL;
  assert.throws(
    () =>
      validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(missingTeamsSecret) })),
    /must reference the Teams Workflow URL by Key Vault name/u,
  );

  const plainTeamsUrl = siemHost({
    core_environment: {
      ...siemHost().core_environment,
      QAPAQ_TEAMS_WORKFLOW_URL: 'https://example.logic.azure.com/workflow/signed-token',
    },
  });
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(plainTeamsUrl) })),
    /may not contain the signed Teams Workflow URL/u,
  );
});

test('generic Container Apps cannot be used as a replacement for the SIEM host', () => {
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_enable_runtime: 'true',
          TF_VAR_container_images: JSON.stringify(
            digestMap(['edge', 'web', 'gateway', 'api', 'worker']),
          ),
        }),
      ),
    /cannot substitute for siem_host/u,
  );
});

test('runtime images must be complete and pinned to the configured ACR by SHA-256', () => {
  const images = digestMap(['edge', 'web', 'gateway', 'api', 'worker']);
  assert.doesNotThrow(() =>
    validateDeploymentInputs(
      baseEnv({
        TF_VAR_enable_runtime: 'true',
        TF_VAR_siem_host: JSON.stringify(siemHost()),
        TF_VAR_container_images: JSON.stringify(images),
      }),
    ),
  );
  images.api = `${registry}/api:latest`;
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_enable_runtime: 'true',
          TF_VAR_siem_host: JSON.stringify(siemHost()),
          TF_VAR_container_images: JSON.stringify(images),
        }),
      ),
    /SHA-256 digest/u,
  );
});

test('Key Vault references must be versioned IDs and may not contain values', () => {
  const ids = {
    api: {
      QAPAQ_ENTRA_CLIENT_SECRET:
        'https://qapaq.vault.azure.net/secrets/entra-client-secret/version123',
    },
  };
  assert.doesNotThrow(() =>
    validateDeploymentInputs(baseEnv({ TF_VAR_key_vault_secret_ids: JSON.stringify(ids) })),
  );
  ids.api.QAPAQ_ENTRA_CLIENT_SECRET = 'plaintext-secret-value';
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_key_vault_secret_ids: JSON.stringify(ids) })),
    /versioned HTTPS Key Vault secret IDs/u,
  );
});

test('Ankay requires SIEM, six registry digests, and Compose whose hash matches', () => {
  const compose =
    'services:\n  frontend:\n    image: qapaqdemo.azurecr.io/frontend@sha256:' + sha + '\n';
  const ankay = {
    private_ip_address: '10.80.0.36',
    admin_ssh_public_key: publicKey,
    vm_size: 'Standard_D4s_v5',
    ubuntu_image_version: '20260101.0',
    container_images: digestMap([
      'shuffle-security',
      'frontend',
      'backend',
      'orborus',
      'opensearch',
      'worker',
    ]),
    compose_yaml: compose,
    compose_sha256: createHash('sha256').update(compose).digest('hex'),
    secret_names: { SHUFFLE_OPENSEARCH_PASSWORD: 'ankay-opensearch-password' },
    docker_package_versions: {
      'docker-ce': '5:1.2.3-1',
      'docker-ce-cli': '5:1.2.3-1',
      'containerd.io': '1.2.3-1',
      'docker-buildx-plugin': '1.2.3-1',
      'docker-compose-plugin': '1.2.3-1',
      'azure-cli': '1.2.3-1',
    },
  };
  const env = baseEnv({
    TF_VAR_siem_host: JSON.stringify(siemHost()),
    TF_VAR_ankay_host: JSON.stringify(ankay),
  });
  assert.deepEqual(validateDeploymentInputs(env), {
    enableRuntime: false,
    hasSiem: true,
    hasAnkay: true,
    hasKrakendGateway: false,
  });
  for (const privateIpAddress of ['10.80.0.35', '10.80.0.63', '10.80.0.64']) {
    assert.throws(
      () =>
        validateDeploymentInputs(
          baseEnv({
            TF_VAR_siem_host: JSON.stringify(siemHost()),
            TF_VAR_ankay_host: JSON.stringify({ ...ankay, private_ip_address: privateIpAddress }),
          }),
        ),
      /usable Azure host address in the reserved Ankay subnet/u,
      `expected ${privateIpAddress} to be rejected`,
    );
  }
  ankay.compose_sha256 = sha;
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_siem_host: JSON.stringify(siemHost()),
          TF_VAR_ankay_host: JSON.stringify(ankay),
        }),
      ),
    /does not match compose_yaml/u,
  );
});

test('Ankay cannot be enabled without SIEM and literal Compose credentials are rejected', () => {
  const compose =
    'services:\n  backend:\n    environment:\n      AWS_ACCESS_KEY_ID: literal-access-key\n';
  const ankay = {
    private_ip_address: '10.80.0.36',
    admin_ssh_public_key: publicKey,
    vm_size: 'Standard_D4s_v5',
    ubuntu_image_version: '20260101.0',
    container_images: digestMap([
      'shuffle-security',
      'frontend',
      'backend',
      'orborus',
      'opensearch',
      'worker',
    ]),
    compose_yaml: compose,
    compose_sha256: createHash('sha256').update(compose).digest('hex'),
    secret_names: { SHUFFLE_OPENSEARCH_PASSWORD: 'ankay-opensearch-password' },
    docker_package_versions: {
      'docker-ce': '5:1.2.3-1',
      'docker-ce-cli': '5:1.2.3-1',
      'containerd.io': '1.2.3-1',
      'docker-buildx-plugin': '1.2.3-1',
      'docker-compose-plugin': '1.2.3-1',
      'azure-cli': '1.2.3-1',
    },
  };
  assert.throws(
    () => validateDeploymentInputs(baseEnv({ TF_VAR_ankay_host: JSON.stringify(ankay) })),
    /requires a configured siem_host/u,
  );
  assert.throws(
    () =>
      validateDeploymentInputs(
        baseEnv({
          TF_VAR_siem_host: JSON.stringify(siemHost()),
          TF_VAR_ankay_host: JSON.stringify(ankay),
        }),
      ),
    /literal credential/u,
  );
});
