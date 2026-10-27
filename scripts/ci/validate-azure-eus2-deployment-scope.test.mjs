import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEus2DeploymentScope } from './validate-azure-eus2-deployment-scope.mjs';

const baseEnv = {
  TF_VAR_enable_runtime: 'false',
  TF_VAR_siem_host: 'null',
  TF_VAR_ankay_host: 'null',
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
      TF_VAR_siem_host: '{}',
    }),
    { scope: 'siem', runtimeEnabled: false },
  );
});

test('soc scope allows Wazuh plus Ankay without enabling generic Container Apps', () => {
  assert.deepEqual(
    validateEus2DeploymentScope({
      ...baseEnv,
      DEPLOYMENT_SCOPE: 'soc',
      TF_VAR_siem_host: '{}',
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
        TF_VAR_siem_host: '{}',
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
        TF_VAR_siem_host: '{}',
      }),
    /Foundation scope refuses/u,
  );
  assert.throws(
    () =>
      validateEus2DeploymentScope({
        ...baseEnv,
        DEPLOYMENT_SCOPE: 'siem',
        TF_VAR_siem_host: '{}',
        TF_VAR_ankay_host: '{}',
      }),
    /requires a SIEM host profile and refuses an Ankay/u,
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
