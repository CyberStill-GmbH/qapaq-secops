import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const gatewayDir = new URL('../', import.meta.url);
const composeFile = fileURLToPath(new URL('compose.yaml', gatewayDir));
const envFile = fileURLToPath(new URL('.env.example', gatewayDir));
const benchmarkFile = fileURLToPath(new URL('../benchmark.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const c10Probe = fileURLToPath(
  new URL('../../../../modules/connectors/test/c28-live-probe.ts', import.meta.url),
);
const tsxCli = fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const gatewayUrl = 'http://127.0.0.1:18080';
const identity = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = identity.privateKey;
const kid = 'c28-test-only-key';
const publicJwk = identity.publicKey.export({ format: 'jwk' });
Object.assign(publicJwk, { kid, alg: 'RS256', use: 'sig' });

const jwksServer = createServer((request, response) => {
  if (request.url !== '/jwks') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=30',
  });
  response.end(JSON.stringify({ keys: [publicJwk] }));
});
jwksServer.listen(0, '0.0.0.0');
await once(jwksServer, 'listening');
const jwksPort = jwksServer.address().port;
const issuer = `http://host.docker.internal:${jwksPort}/`;

function runCompose(args, rateOverrides = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, ...args],
    {
      cwd: fileURLToPath(gatewayDir),
      encoding: 'utf8',
      env: {
        ...process.env,
        GATEWAY_ENDPOINT_TIMEOUT: '4s',
        GATEWAY_RATE_PER_SECOND: rateOverrides.perSecond ?? '20000',
        GATEWAY_RATE_BURST: rateOverrides.burst ?? '40000',
        GATEWAY_METRICS_PORT: '9091',
        OIDC_JWKS_URL: `${issuer}jwks`,
        OIDC_DISABLE_JWK_SECURITY: 'true',
        OIDC_ISSUER: issuer,
        OIDC_AUDIENCE: 'qapaq-provider-gateway',
        WAZUH_INDEXER_URL: 'http://mock-indexer:9200',
        WAZUH_INDEXER_CA_FILE: '',
        WAZUH_BASIC_AUTH_B64: 'dGVzdDp0ZXN0',
        WAZUH_INDEX_PATTERN: 'wazuh-alerts-*',
      },
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `docker compose ${args[0]} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
  );
}

function makeToken({
  audience = 'qapaq-provider-gateway',
  tokenIssuer = issuer,
  subject = 'test-qapaq-worker',
} = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'RS256', typ: 'JWT', kid });
  const payload = encode({
    iss: tokenIssuer,
    aud: audience,
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const signingInput = `${head}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

async function request(
  path,
  { token = makeToken(), method = 'POST', body = {}, headers = {}, timeoutMs = 7000 } = {},
) {
  const init = {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  return fetch(`${gatewayUrl}${path}`, init);
}

async function waitForGateway() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/wazuh/_cluster/health', { method: 'GET' });
      if (response.status === 200) return;
    } catch {
      // Startup/readiness retry, bounded by the overall deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('gateway did not become ready within 60 seconds');
}

try {
  runCompose(['run', '--rm', 'gateway', 'check', '-t', '-n', '-c', '/etc/krakend/krakend.tmpl']);
  runCompose(['up', '-d', '--wait', 'mock-indexer', 'gateway']);
  await waitForGateway();

  const absent = await request('/wazuh/_search', { token: '', body: {} });
  assert.equal(absent.status, 401, 'missing token must be unauthorized');
  const invalid = await request('/wazuh/_search', { token: 'not.a.jwt', body: {} });
  assert.equal(invalid.status, 401, 'invalid token must be unauthorized');
  const wrongAudience = await request('/wazuh/_search', {
    token: makeToken({ audience: 'wrong' }),
    body: {},
  });
  assert.equal(wrongAudience.status, 401, 'wrong audience must be unauthorized');

  const allowed = await request('/wazuh/_search', { body: {} });
  assert.equal(allowed.status, 200, 'valid identity should reach the read-only backend');
  assert.equal(
    allowed.headers.get('x-internal-topology'),
    null,
    'backend topology header must be filtered',
  );

  const adapterProbe = spawnSync(process.execPath, [tsxCli, c10Probe], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      C10_GATEWAY_BASE_URL: gatewayUrl,
      C10_GATEWAY_ACCESS_TOKEN: makeToken({ subject: 'c10-adapter-worker' }),
    },
    timeout: 15_000,
  });
  if (adapterProbe.error) throw adapterProbe.error;
  assert.equal(adapterProbe.status, 0, `C-10 adapter probe failed: ${adapterProbe.stderr}`);
  assert.match(adapterProbe.stdout, /C-10 -> C-28 -> controlled Wazuh Indexer: PASS/);

  let metricText = '';
  const scrapeDeadline = Date.now() + 20_000;
  while (Date.now() < scrapeDeadline) {
    const scrape = await fetch('http://127.0.0.1:19091/metrics', {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(scrape.status, 200, 'private Prometheus scrape endpoint must be available');
    metricText = await scrape.text();
    if (metricText.includes('http_server_duration_count')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.match(metricText, /http_server_duration_count/);
  assert.match(metricText, /http_route="\/wazuh\/_search"/);

  const benchmark = spawnSync(
    process.execPath,
    [benchmarkFile, '--confirm-nonprod=true', '--concurrency=4', '--duration-seconds=2'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        BENCHMARK_URL: `${gatewayUrl}/wazuh/_search`,
        BENCHMARK_BEARER_TOKEN: makeToken({ subject: 'benchmark-worker' }),
        BENCHMARK_SCENARIO: 'healthy',
      },
      timeout: 15_000,
    },
  );
  if (benchmark.error) throw benchmark.error;
  assert.equal(benchmark.status, 0, `healthy benchmark failed: ${benchmark.stderr}`);
  const benchmarkResult = JSON.parse(benchmark.stdout);
  assert.ok(benchmarkResult.requests > 0, 'benchmark must make requests');
  assert.equal(benchmarkResult.errorRate, 0, 'healthy benchmark must be error-free');
  assert.deepEqual(benchmarkResult.statusCounts, { 200: benchmarkResult.requests });
  console.log(`C-28 healthy benchmark: ${JSON.stringify(benchmarkResult)}`);

  runCompose(['up', '-d', '--wait', 'gateway'], { perSecond: '2', burst: '2' });
  await waitForGateway();

  const throttled = await Promise.all(
    Array.from({ length: 12 }, () => request('/wazuh/_search', { body: {} })),
  );
  assert.ok(
    throttled.some((response) => response.status === 429),
    'burst above per-identity token bucket must return 429',
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const forbidden = await request('/wazuh/_search', {
    token: makeToken({ subject: 'test-forbidden-worker' }),
    body: { controlStatus: 403 },
  });
  assert.equal(forbidden.status, 403, 'authenticated authorization failure must remain 403');
  for (const status of [429, 500, 502, 503, 504]) {
    const response = await request('/wazuh/_search', {
      token: makeToken({ subject: `test-upstream-${status}-worker` }),
      body: { controlStatus: status },
    });
    assert.equal(response.status, status, `upstream ${status} must not be remapped`);
    if (status >= 500) await new Promise((resolve) => setTimeout(resolve, 5500));
  }

  const timeout = await request('/wazuh/_search', { body: { controlStatus: 'slow' } });
  assert.ok(
    timeout.status >= 500,
    `backend timeout should be controlled 5xx, got ${timeout.status}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 5500));
  try {
    const reset = await request('/wazuh/_search', { body: { controlStatus: 'reset' } });
    assert.ok(
      reset.status >= 500,
      `connection reset should be controlled 5xx, got ${reset.status}`,
    );
  } catch (error) {
    assert.ok(
      error instanceof TypeError,
      'a connection reset may surface as a fetch transport error',
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 5500));

  const unknown = await request('/unregistered', { method: 'GET' });
  assert.equal(unknown.status, 404, 'unknown route must not reach a backend');
  const unsupported = await request('/wazuh/_cluster/health', { method: 'PUT' });
  assert.ok(
    unsupported.status >= 400 && unsupported.status < 500,
    'unsupported method must be 4xx',
  );

  runCompose(['stop', 'mock-indexer']);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const unavailable = await request('/wazuh/_search', { body: {} });
  assert.ok(
    unavailable.status >= 500,
    `unavailable backend should be controlled 5xx, got ${unavailable.status}`,
  );
  runCompose(['start', 'mock-indexer']);
  await new Promise((resolve) => setTimeout(resolve, 5500));
  const recovered = await request('/wazuh/_cluster/health', { method: 'GET' });
  assert.equal(recovered.status, 200, 'gateway must recover after backend returns');

  console.log(
    'C-28 runtime integration: PASS (401, 403, 429, 5xx, timeout, reset, 404, method, filtering, recovery)',
  );
} finally {
  try {
    runCompose(['down', '--remove-orphans']);
  } catch {
    /* preserve original failure */
  }
  jwksServer.close();
}
