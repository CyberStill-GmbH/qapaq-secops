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
    TF_VAR_key_vault_secret_ids: '{}',
    ...overrides,
  };
}

function siemHost(overrides = {}) {
  return {
    address_prefix: '10.80.0.64/27',
    vm_size: 'Standard_F4s_v2',
    admin_ssh_public_key: publicKey,
    ubuntu_image_version: '24.04.202601010',
    data_disk_size_gb: 128,
    dashboard_ingress_cidrs: [],
    agent_ingress_cidrs: ['10.80.0.0/16'],
    core_secret_names: {
      QAPAQ_ENTRA_CLIENT_SECRET: 'entra-client-secret',
      QAPAQ_TEAMS_WORKFLOW_URL: 'teams-workflow-url',
    },
    wazuh_secret_names: {
      'dashboard-password': 'wazuh-dashboard-password',
      'office365-client-secret': 'office365-client-secret',
      'wazuh-install-files.tar.b64': 'wazuh-install-files-tar-b64',
    },
    core_environment: { QAPAQ_ENTRA_CLIENT_SECRET_REF: 'secret://keyvault/entra-client-secret' },
    office365: {
      tenant_id: '45f2f938-dbe3-4a3e-8a54-930893f94ef8',
      client_id: '336d44fe-b99d-4cfd-9c6e-0ed2d7e48998',
      api_type: 'commercial',
      enable_dlp: false,
    },
    bootstrap_bundle_blob_url: 'https://qapaqdata.blob.core.windows.net/releases/siem.tar.gz',
    bootstrap_bundle_sha256: sha,
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
  });
});

test('accepts a complete SIEM configuration with Key Vault names and an immutable bundle reference', () => {
  assert.deepEqual(
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(siemHost()) })),
    {
      enableRuntime: false,
      hasSiem: true,
      hasAnkay: false,
    },
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
    ['10.81.0.0/27', /contained in the EUS2 VNet/u],
    ['10.80.0.0/27', /reserved Container Apps subnet/u],
    ['10.80.0.32/27', /reserved Ankay subnet/u],
    ['10.80.16.0/27', /reserved PostgreSQL subnet/u],
    ['10.80.64.0/26', /reserved Azure Firewall subnet/u],
    ['10.80.0.0/16', /reserved Container Apps subnet/u],
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

test('Dashboard ingress accepts aligned IPv4 /24 or narrower and rejects broad or unaligned ranges', () => {
  const allowed = siemHost({ dashboard_ingress_cidrs: ['198.51.100.0/24', '203.0.113.25/32'] });
  assert.doesNotThrow(() =>
    validateDeploymentInputs(baseEnv({ TF_VAR_siem_host: JSON.stringify(allowed) })),
  );

  for (const cidr of ['198.51.0.0/16', '198.51.100.0/23', '198.51.100.25/24', '2001:db8::/64']) {
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
      /usable Azure host address in 10\.80\.0\.32\/27/u,
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
