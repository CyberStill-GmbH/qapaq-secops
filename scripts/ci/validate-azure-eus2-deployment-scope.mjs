import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const expectedAcr = 'qapaqsecopsdemoeus3a2405f3.azurecr.io';

function parseJson(env, name) {
  try {
    return JSON.parse(env[name] ?? 'null');
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateEus2DeploymentScope(env = process.env) {
  const scope = env.DEPLOYMENT_SCOPE;
  const runtime = env.TF_VAR_enable_runtime;
  const siem = parseJson(env, 'TF_VAR_siem_host');
  const ankay = parseJson(env, 'TF_VAR_ankay_host');

  requireThat(
    ['foundation', 'siem', 'soc'].includes(scope),
    'DEPLOYMENT_SCOPE must be foundation, siem, or soc.',
  );
  requireThat(
    runtime === 'false',
    'All current EUS2 scopes require AZURE_EUS2_ENABLE_RUNTIME=false; the generic Container Apps edge is not the QAPAQ SIEM frontend.',
  );

  if (scope === 'foundation') {
    requireThat(
      siem === null && ankay === null,
      'Foundation scope refuses SIEM/Ankay host profiles.',
    );
  }

  if (scope === 'siem') {
    requireThat(
      siem !== null && ankay === null,
      'SIEM-first scope requires a SIEM host profile and refuses an Ankay host.',
    );
  }

  if (scope === 'soc') {
    requireThat(
      env.AZURE_ACR_LOGIN_SERVER === expectedAcr,
      'Wazuh plus Ankay scope requires the East US 2 demo ACR, not a registry from another environment.',
    );
    requireThat(
      siem !== null && ankay !== null,
      'Wazuh plus Ankay scope requires complete SIEM and Ankay host profiles.',
    );
  }

  return { scope, runtimeEnabled: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = validateEus2DeploymentScope();
    console.log(
      `East US 2 deployment scope valid: ${result.scope}; generic runtime disabled.`,
    );
  } catch (error) {
    console.error(`East US 2 deployment scope rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
