import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEus2DeploymentScope } from './validate-azure-eus2-deployment-scope.mjs';

const baseEnv = {
  TF_VAR_enable_runtime: 'false',
  TF_VAR_siem_host: 'null',
  TF_VAR_ankay_host: 'null',
  TF_VAR_krakend_gateway: 'null',
  TF_VAR_address_space: '10.80.0.0/16',
};

const siemHost = (address_prefix = '10.80.32.0/27') => ({
  address_prefix,
  private_ip_address: `${address_prefix.split('/')[0].split('.').slice(0, 3).join('.')}.4`,
});

const krakendGateway = {
  image: 'qapaqsecopsdemoeus3a2405f3.azurecr.io/qapaq-secops-krakend@sha256:' + 'a'.repeat(64),
  indexer_reader_secret_name: 'wazuh-reader-b64',
  indexer_proxy_ca_secret_name: 'wazuh-proxy-ca',
};

test('foundation requires no SIEM or Ankay host and keeps generic runtime disabled', () => {
  assert.deepEqual(validateEus2DeploymentScope({ ...baseEnv, DEPLOYMENT_SCOPE: 'foundation' }), {
    scope: 'foundation',
    runtimeEnabled: false,
  });
});

test('siem scope allows Wazuh first and keeps Ankay absent', () => {
  assert.deepEqual(
    validateEus2DeploymentScope({
      ...baseEnv,
      DEPLOYMENT_SCOPE: 'siem',
      TF_VAR_siem_host: JSON.stringify(siemHost()),
    }),
    { scope: 'siem', runtimeEnabled: false },
  );
});

test('SIEM-only scope permits dynamic address; KrakenD requires the reserved static .4 address', () => {
  const { private_ip_address: _privateIp, ...dynamicSiem } = siemHost();
  assert.doesNotThrow(() =>
    validateEus2DeploymentScope({
      ...baseEnv,
      DEPLOYMENT_SCOPE: 'siem',
      TF_VAR_siem_host: JSON.stringify(dynamicSiem),
    }),
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'siem',
        TF_VAR_siem_host: JSON.stringify(dynamicSiem),
        TF_VAR_krakend_gateway: JSON.stringify(krakendGateway),
        AZURE_ACR_LOGIN_SERVER: 'qapaqsecopsdemoeus3a2405f3.azurecr.io',
      }),
    /reserved \.4 host/u,
  );
});

test('soc scope allows Wazuh plus Ankay without enabling generic Container Apps', () => {
  assert.deepEqual(
    validateEus2DeploymentScope({
      ...baseEnv,
      DEPLOYMENT_SCOPE: 'soc',
      TF_VAR_siem_host: JSON.stringify(siemHost()),
      TF_VAR_ankay_host: '{}',
      AZURE_ACR_LOGIN_SERVER: 'qapaqsecopsdemoeus3a2405f3.azurecr.io',
    }),
    { scope: 'soc', runtimeEnabled: false },
  );
});

test('rejects enabling the separate generic public runtime in every current scope', () => {
  for (const scope of ['foundation', 'siem', 'soc']) {
    assert.throws(
      () =>
        validateEus2DeploymentScope({
          ...baseEnv,
          DEPLOYMENT_SCOPE: scope,
          TF_VAR_enable_runtime: 'true',
        }),
      /generic Container Apps edge is not the QAPAQ SIEM frontend/u,
    );
  }
});

test('rejects partial and cross-environment SOC profiles', () => {
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'soc',
        TF_VAR_siem_host: JSON.stringify(siemHost()),
        TF_VAR_ankay_host: '{}',
        AZURE_ACR_LOGIN_SERVER: 'qapaqsecopsdemoeus.azurecr.io',
      }),
    /East US 2 demo ACR/u,
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'soc',
        AZURE_ACR_LOGIN_SERVER: 'qapaqsecopsdemoeus3a2405f3.azurecr.io',
      }),
    /complete SIEM and Ankay/u,
  );
});

test('rejects profiles that conflict with the selected stage', () => {
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'foundation',
        TF_VAR_siem_host: JSON.stringify(siemHost()),
      }),
    /Foundation scope refuses/u,
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'siem',
        TF_VAR_siem_host: JSON.stringify(siemHost()),
        TF_VAR_ankay_host: '{}',
      }),
    /requires a SIEM host profile and refuses an Ankay/u,
  );
});

test('EUS2 SIEM subnet must be contained and must avoid every reserved network block', () => {
  assert.doesNotThrow(() =>
    validateEus2DeploymentScope({
      ...baseEnv,
      DEPLOYMENT_SCOPE: 'siem',
      TF_VAR_siem_host: JSON.stringify(siemHost('10.80.32.0/27')),
    }),
  );
  for (const cidr of [
    '10.80.0.0/27',
    '10.80.0.32/27',
    '10.80.0.64/27',
    '10.80.16.0/27',
    '10.80.64.0/26',
    '10.81.1.0/27',
    '10.80.0.0/26',
  ]) {
    assert.throws(
      () =>
        validateEus2DeploymentScope({
          ...baseEnv,
          DEPLOYMENT_SCOPE: 'siem',
          TF_VAR_siem_host: JSON.stringify(siemHost(cidr)),
        }),
      /contained in the EUS2 VNet|overlaps the reserved/u,
      cidr,
    );
  }
});

test('KrakenD can be wired only with an EUS2 ACR and an enabled SIEM', () => {
  assert.doesNotThrow(() =>
    validateEus2DeploymentScope({
      ...baseEnv,
      DEPLOYMENT_SCOPE: 'siem',
      TF_VAR_siem_host: JSON.stringify(siemHost()),
      TF_VAR_krakend_gateway: JSON.stringify(krakendGateway),
      AZURE_ACR_LOGIN_SERVER: 'qapaqsecopsdemoeus3a2405f3.azurecr.io',
    }),
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'foundation',
        TF_VAR_krakend_gateway: JSON.stringify(krakendGateway),
      }),
    /Foundation scope refuses/u,
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'siem',
        TF_VAR_siem_host: JSON.stringify(siemHost()),
        TF_VAR_krakend_gateway: JSON.stringify(krakendGateway),
        AZURE_ACR_LOGIN_SERVER: 'other.azurecr.io',
      }),
    /East US 2 demo ACR/u,
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'siem',
        TF_VAR_siem_host: JSON.stringify(siemHost()),
        TF_VAR_krakend_gateway: JSON.stringify({
          ...krakendGateway,
          indexer_reader_secret_name: 'arbitrary-secret',
        }),
        AZURE_ACR_LOGIN_SERVER: 'qapaqsecopsdemoeus3a2405f3.azurecr.io',
      }),
    /pre-seeded EUS2/u,
  );
});

test('rejects malformed profile JSON without echoing input', () => {
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'siem',
        TF_VAR_siem_host: '{bad json}',
      }),
    /TF_VAR_siem_host must be valid JSON/u,
  );
});
