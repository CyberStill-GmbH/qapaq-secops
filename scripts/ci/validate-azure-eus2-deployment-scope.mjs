import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

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

function parseIpv4Cidr(cidr, label) {
  requireThat(typeof cidr === 'string', `${label} must be an IPv4 CIDR.`);
  const [address, prefixText, ...extra] = cidr.split('/');
  requireThat(
    extra.length === 0 && prefixText && isIP(address) === 4 && /^\d+$/u.test(prefixText),
    `${label} must be a valid IPv4 CIDR.`,
  );
  const prefix = Number(prefixText);
  requireThat(prefix >= 0 && prefix <= 32, `${label} must be a valid IPv4 CIDR.`);
  const ip = address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  const size = 1n << BigInt(32 - prefix);
  const mask = prefix === 0 ? 0n : (1n << 32n) - size;
  const start = ip & mask;
  requireThat(start === ip, `${label} must use its canonical network address.`);
  return { start, end: start + size - 1n, size, prefix };
}

function cidrAt(vnet, additionalPrefix, index) {
  const prefix = vnet.prefix + additionalPrefix;
  const size = 1n << BigInt(32 - prefix);
  const start = vnet.start + BigInt(index) * size;
  return { start, end: start + size - 1n, size, prefix };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function validateSiemSubnet(siem, addressSpace, krakendEnabled) {
  if (siem === null) return;
  const vnet = parseIpv4Cidr(addressSpace, 'TF_VAR_address_space');
  requireThat(vnet.prefix === 16, 'The EUS2 VNet must remain the committed /16 address space.');
  const subnet = parseIpv4Cidr(siem.address_prefix, 'siem_host.address_prefix');
  requireThat(subnet.prefix <= 27, 'siem_host.address_prefix must be /27 or larger.');
  requireThat(
    subnet.start >= vnet.start && subnet.end <= vnet.end,
    'siem_host.address_prefix must be fully contained in the EUS2 VNet.',
  );
  const reserved = [
    ['ACA', cidrAt(vnet, 11, 0)],
    ['Ankay', cidrAt(vnet, 11, 1)],
    ['KrakenD', cidrAt(vnet, 11, 2)],
    ['PostgreSQL', cidrAt(vnet, 12, 256)],
    ['Private Endpoints', cidrAt(vnet, 12, 257)],
    ['Azure Firewall', cidrAt(vnet, 10, 256)],
  ];
  for (const [name, range] of reserved) {
    requireThat(
      !rangesOverlap(subnet, range),
      `siem_host.address_prefix overlaps the reserved ${name} subnet.`,
    );
  }
  const privateIp = siem.private_ip_address;
  const hostFour = subnet.start + 4n;
  const address = [24n, 16n, 8n, 0n]
    .map((shift) => Number((hostFour >> shift) & 255n))
    .join('.');
  if (krakendEnabled || privateIp !== undefined && privateIp !== null) {
    requireThat(
      typeof privateIp === 'string' && isIP(privateIp) === 4 && privateIp === address,
      'siem_host.private_ip_address must be the reserved .4 host in address_prefix when KrakenD is enabled.',
    );
  }
}

export function validateEus2DeploymentScope(env = process.env) {
  const scope = env.DEPLOYMENT_SCOPE;
  const runtime = env.TF_VAR_enable_runtime;
  const siem = parseJson(env, 'TF_VAR_siem_host');
  const ankay = parseJson(env, 'TF_VAR_ankay_host');
  const krakend = parseJson(env, 'TF_VAR_krakend_gateway');

  requireThat(
    ['foundation', 'siem', 'soc'].includes(scope),
    'DEPLOYMENT_SCOPE must be foundation, siem, or soc.',
  );
  validateSiemSubnet(siem, env.TF_VAR_address_space ?? '10.80.0.0/16', krakend !== null);
  requireThat(
    runtime === 'false',
    'All current EUS2 scopes require AZURE_EUS2_ENABLE_RUNTIME=false; the generic Container Apps edge is not the QAPAQ SIEM frontend.',
  );

  if (scope === 'foundation') {
    requireThat(
      siem === null && ankay === null && krakend === null,
      'Foundation scope refuses SIEM, Ankay, and KrakenD host profiles.',
    );
  }

  if (scope === 'siem') {
    requireThat(
      siem !== null && ankay === null,
      'SIEM-first scope requires a SIEM host profile and refuses an Ankay host.',
    );
    if (krakend !== null) {
      requireThat(
        env.AZURE_ACR_LOGIN_SERVER === expectedAcr,
        'KrakenD requires the East US 2 demo ACR, not a registry from another environment.',
      );
    }
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

  if (krakend !== null)
    requireThat(siem !== null, 'KrakenD requires an enabled SIEM host profile.');
  if (krakend !== null) {
    requireThat(
      krakend.indexer_reader_secret_name === 'wazuh-reader-b64' &&
        krakend.indexer_proxy_ca_secret_name === 'wazuh-proxy-ca',
      'KrakenD requires the two pre-seeded EUS2 Indexer Key Vault references.',
    );
  }

  return { scope, runtimeEnabled: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = validateEus2DeploymentScope();
    console.log(`East US 2 deployment scope valid: ${result.scope}; generic runtime disabled.`);
  } catch (error) {
    console.error(`East US 2 deployment scope rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
