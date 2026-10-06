import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const routes = JSON.parse(await readFile(new URL('routes.json', root), 'utf8'));
const applicationRoutes = JSON.parse(
  await readFile(new URL('application-routes.json', root), 'utf8'),
);
const template = await readFile(new URL('krakend.tmpl', root), 'utf8');
const compose = await readFile(new URL('compose.yaml', root), 'utf8');
const envExample = await readFile(new URL('.env.example', root), 'utf8');
const inventory = await readFile(
  new URL('../../../../docs/integrations/source-inventory.yaml', import.meta.url),
  'utf8',
);
const dashboard = JSON.parse(
  await readFile(
    new URL('../../../observability/grafana/dashboards/krakend-overview.json', import.meta.url),
    'utf8',
  ),
);

const declaredEndpoints = [...template.matchAll(/"endpoint"\s*:\s*"([^"]+)"/g)].map(
  (match) => match[1],
);
const declaredApiRoutes = [
  ...template.matchAll(
    /"endpoint"\s*:\s*"([^"]+)"[\s\S]*?"method"\s*:\s*"(GET|POST)"[\s\S]*?"url_pattern"\s*:\s*"([^"]+)"/g,
  ),
]
  .filter(([, path]) => path.startsWith('/api/'))
  .map(([, path, method, upstream]) => ({ path, method, upstream }));

test('C-28 Wazuh route inventory and KrakenD endpoint set remain identical', () => {
  const inventoryPaths = routes.routes.map(({ path }) => path.replaceAll('*', ':wildcard'));
  assert.equal(new Set(inventoryPaths).size, inventoryPaths.length, 'duplicate route path');
  assert.deepEqual(
    declaredEndpoints.filter((path) => path.startsWith('/wazuh/')).sort(),
    [...inventoryPaths].sort(),
  );
});

test('each C-28 route has explicit method, auth, rate, timeout, backend, classification and owner', () => {
  for (const route of routes.routes) {
    assert.match(route.path, /^\/(?!\/)/);
    assert.ok(['GET', 'POST'].includes(route.method));
    assert.equal(route.auth, 'jwt');
    assert.equal(route.rate_limit, 'provider-read');
    assert.equal(route.timeout, 'provider-read');
    assert.equal(route.backend, 'wazuh-indexer');
    assert.ok(route.classification);
    assert.ok(route.owner);
    assert.ok(!route.path.includes('*'), 'wildcard exposure is prohibited');
  }
});

test('application BFF allowlist matches explicit KrakenD proxy routes', () => {
  const expected = applicationRoutes.routes.map(({ path, method, upstream }) => ({
    path,
    method,
    upstream,
  }));
  assert.deepEqual(declaredApiRoutes, expected);
  assert.equal(
    new Set(expected.map(({ path, method }) => `${method} ${path}`)).size,
    expected.length,
  );
  for (const route of applicationRoutes.routes) {
    assert.ok(['api-session', 'none'].includes(route.auth));
    if (route.path.startsWith('/api/health/')) assert.equal(route.auth, 'none');
    else
      assert.equal(
        route.auth,
        'api-session',
        `${route.method} ${route.path} is authenticated by the API session contract`,
      );
    assert.equal(route.encoding, 'no-op', 'BFF must preserve redirects, cookies, status and body');
    assert.ok(!route.path.includes('*'), 'wildcard exposure is prohibited');
  }
  assert.match(template, /"input_headers": \[[^\]]*"Cookie"[^\]]*"Origin"[^\]]*"X-Csrf-Token"/s);
  assert.doesNotMatch(template, /"endpoint"\s*:\s*"\/api\/ingest\//);
});

test('configuration denies broad CORS, accepts no arbitrary upstream and keeps secrets out of tracked config', () => {
  assert.match(template, /"router":\s*\{\s*"disable_access_log":\s*true\s*\}/);
  assert.doesNotMatch(template, /security\/cors|allow_origins.*\*/);
  assert.doesNotMatch(template, /cache_ttl|cache\/http/);
  assert.doesNotMatch(template, /request\.URL|X-Forwarded-Host.*host/);
  assert.match(template, /"jwk_url": "\{\{ env "OIDC_JWKS_URL" \}\}"/);
  assert.match(template, /"disable_jwk_security": \{\{ env "OIDC_DISABLE_JWK_SECURITY" \}\}/);
  assert.match(envExample, /^OIDC_DISABLE_JWK_SECURITY=false$/m);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\[ALL\]/);
  assert.doesNotMatch(template, /Bearer\s+[A-Za-z0-9._-]{16,}|password\s*:/i);
});

test('finite timeout and bounded per-instance rate policy are explicitly wired', () => {
  assert.ok(template.includes('GATEWAY_ENDPOINT_TIMEOUT'));
  assert.match(template, /"client_max_rate"\s*:\s*\{\{ env "GATEWAY_RATE_PER_SECOND" \}\}/);
  assert.match(template, /"client_capacity"\s*:\s*\{\{ env "GATEWAY_RATE_BURST" \}\}/);
  assert.match(template, /"propagate_claims"\s*:\s*\[\["sub",\s*"X-Qapaq-Workload"\]\]/);
  assert.equal(
    (template.match(/"timeout": "\{\{ env "GATEWAY_ENDPOINT_TIMEOUT" \}\}"/g) ?? []).length,
    3 + applicationRoutes.routes.length,
  );
  assert.match(template, /"host": \[\s*"\{\{ env "QAPAQ_API_UPSTREAM" \}\}"\s*\]/);
});

test('production infrastructure dependencies stay explicitly TO_BE_PROVIDED', () => {
  for (const key of [
    'image_digest',
    'load_balancer',
    'secret_provider',
    'production_tls_certificate_ref',
    'production_oidc_issuer',
    'production_oidc_jwks_url',
    'production_oidc_audience',
    'wazuh_indexer_backend_url',
    'wazuh_indexer_ca_ref',
    'prometheus_scrape_target',
    'grafana_provisioning_destination',
  ]) {
    assert.match(inventory, new RegExp(`^  ${key}: TO_BE_PROVIDED$`, 'm'));
  }
  assert.match(inventory, /^  version: 3\.0\.0$/m);
});

test('Grafana dashboard reports normalized route rate, p50/p95/p99 and response classes', () => {
  const panelTitles = dashboard.panels.map(({ title }) => title);
  for (const title of [
    'Request rate by normalized route',
    'p50 latency by normalized route',
    'p95 latency by normalized route',
    'p99 latency by normalized route',
    'Auth, throttling and server errors',
  ]) {
    assert.ok(panelTitles.includes(title), `missing dashboard panel: ${title}`);
  }
  assert.ok(
    dashboard.panels.every((panel) =>
      panel.targets.every((target) => target.expr.includes('http_route')),
    ),
    'every dashboard query groups on the normalized route attribute',
  );
});
