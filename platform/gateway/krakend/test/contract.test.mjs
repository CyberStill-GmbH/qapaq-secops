import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const routes = JSON.parse(await readFile(new URL('routes.json', root), 'utf8'));
const applicationRoutes = JSON.parse(
  await readFile(new URL('application-routes.json', root), 'utf8'),
);
const template = await readFile(new URL('krakend.tmpl', root), 'utf8');
const azureIngestionTemplate = await readFile(
  new URL('krakend-azure-ingestion.tmpl', root),
  'utf8',
);
const socController = await readFile(
  new URL('../../../../apps/api/src/soc/soc.controller.ts', import.meta.url),
  'utf8',
);
const auditController = await readFile(
  new URL('../../../../apps/api/src/soc/audit.controller.ts', import.meta.url),
  'utf8',
);
const eventsController = await readFile(
  new URL('../../../../apps/api/src/soc/events.controller.ts', import.meta.url),
  'utf8',
);
const paginationSource = await readFile(
  new URL('../../../../apps/api/src/http/pagination.ts', import.meta.url),
  'utf8',
);
const compose = await readFile(new URL('compose.yaml', root), 'utf8');
const envExample = await readFile(new URL('.env.example', root), 'utf8');
const inventory = await readFile(
  new URL('../../../../docs/reference/source-inventory.yaml', import.meta.url),
  'utf8',
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

test('Azure SIEM gateway exposes only authenticated Wazuh ingestion routes', () => {
  const endpoints = [
    ...azureIngestionTemplate.matchAll(/"endpoint"\s*:\s*"([^"]+)"/g),
  ].map(([, path]) => path);
  assert.deepEqual(endpoints, ['/wazuh/_cluster/health', '/wazuh/_search']);
  assert.equal((azureIngestionTemplate.match(/"auth\/validator"/g) ?? []).length, 2);
  assert.equal((azureIngestionTemplate.match(/"jwk_url"/g) ?? []).length, 2);
  assert.equal((azureIngestionTemplate.match(/"issuer"/g) ?? []).length, 2);
  assert.equal((azureIngestionTemplate.match(/"audience"/g) ?? []).length, 2);
  assert.match(azureIngestionTemplate, /"disable_jwk_security": false/);
  assert.match(azureIngestionTemplate, /WAZUH_INDEXER_CA_FILE/);
  assert.match(azureIngestionTemplate, /WAZUH_BASIC_AUTH_B64/);
  assert.match(azureIngestionTemplate, /WAZUH_INDEX_PATTERN/);
  assert.doesNotMatch(azureIngestionTemplate, /\/api\//);
  assert.doesNotMatch(azureIngestionTemplate, /QAPAQ_API_UPSTREAM/);
  assert.doesNotMatch(azureIngestionTemplate, /127\.0\.0\.1|localhost/);
  assert.doesNotMatch(azureIngestionTemplate, /"endpoint"\s*:\s*"\/wazuh\/\*"/);
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

test('Indexer response headers do not expose backend topology or implementation', () => {
  const blacklist =
    /"header\.Blacklist":\s*\{\s*"scope":\s*\["response"\],\s*"names":\s*\["X-Internal-Topology",\s*"Server",\s*"X-Powered-By"\]/g;
  assert.equal([...template.matchAll(blacklist)].length, 2);
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

test('SOC query allowlists match controller @Query contracts and are forwarded by KrakenD', () => {
  const pageQueryBody = paginationSource.match(/interface PageQuery\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(pageQueryBody, 'PageQuery declaration must remain readable by the contract check');
  const pageQueryKeys = [...pageQueryBody.matchAll(/readonly\s+(\w+)\??:/g)].map(([, key]) => key);
  const queryKeys = (controller, methodName) => {
    const method = controller.match(
      new RegExp(
        `@Get\\(["']${methodName}["']\\)([\\s\\S]*?)(?=\\n  @(?:Get|Post|Put|Patch|Delete)\\(|\\n})`,
      ),
    )?.[1];
    assert.ok(method, `GET ${methodName} decorator must be found`);
    const queryType = method.match(/@Query\(\)\s*query:\s*([\s\S]*?),?\s*\n?\s*\)/)?.[1];
    assert.ok(queryType, `@Query type for ${methodName} must be explicit`);
    return [
      ...new Set([
        ...(queryType.includes('PageQuery') ? pageQueryKeys : []),
        ...[...queryType.matchAll(/\b(\w+)\??\s*:/g)].map(([, key]) => key),
      ]),
    ].sort();
  };
  const contracts = [
    { path: '/api/alerts', controller: socController, method: 'alerts' },
    { path: '/api/incidents', controller: socController, method: 'incidents' },
    {
      path: '/api/incidents/{id}/alerts',
      controller: socController,
      method: 'incidents/:id/alerts',
    },
    { path: '/api/events', controller: eventsController, method: 'events' },
    { path: '/api/audit/events', controller: auditController, method: 'events' },
  ];

  for (const contract of contracts) {
    const route = applicationRoutes.routes.find(
      ({ path, method }) => path === contract.path && method === 'GET',
    );
    assert.ok(route, `missing GET ${contract.path} allowlist entry`);
    assert.deepEqual(
      [...route.query_parameters].sort(),
      queryKeys(contract.controller, contract.method),
      `GET ${contract.path} query allowlist differs from its controller`,
    );
    const endpointStart = template.indexOf(`"endpoint": "${contract.path}"`);
    assert.notEqual(endpointStart, -1, `missing KrakenD endpoint ${contract.path}`);
    const endpointEnd = template.indexOf('\n    },\n    {', endpointStart);
    const endpoint = template.slice(
      endpointStart,
      endpointEnd === -1 ? template.length : endpointEnd,
    );
    const forwarded = [...endpoint.matchAll(/"input_query_strings":\s*\[([\s\S]*?)\]/g)][0]?.[1];
    assert.ok(forwarded !== undefined, `missing query forwarding for ${contract.path}`);
    assert.deepEqual(
      [...forwarded.matchAll(/"([^"]+)"/g)].map(([, key]) => key).sort(),
      queryKeys(contract.controller, contract.method),
      `KrakenD does not forward the complete query contract for ${contract.path}`,
    );
  }
});

test('incident detail is proxied and manual notification drain has a 15 second timeout', () => {
  assert.ok(
    applicationRoutes.routes.some(
      ({ path, method, upstream }) =>
        path === '/api/incidents/{id}' && method === 'GET' && upstream === '/api/incidents/{id}',
    ),
  );
  assert.match(
    template,
    /"endpoint":\s*"\/api\/notifications\/drain",\s*"method":\s*"POST",\s*"timeout":\s*"15s"/,
  );
});

test('operational health is exposed only as a session-authenticated read route', () => {
  assert.ok(
    applicationRoutes.routes.some(
      ({ path, method, upstream, auth, query_parameters }) =>
        path === '/api/operations/health' &&
        method === 'GET' &&
        upstream === '/api/operations/health' &&
        auth === 'api-session' &&
        query_parameters.length === 0,
    ),
  );
  assert.match(
    template,
    /"endpoint":\s*"\/api\/operations\/health",\s*"method":\s*"GET"[\s\S]*?"url_pattern":\s*"\/api\/operations\/health"/,
  );
});

test('administrative session list and revocation preserve the BFF session and CSRF contract', () => {
  const list = applicationRoutes.routes.find(
    ({ path, method }) => path === '/api/admin/sessions' && method === 'GET',
  );
  assert.ok(list, 'missing authenticated administrative session list');
  assert.equal(list.auth, 'api-session');
  assert.deepEqual([...list.query_parameters].sort(), ['cursor', 'pageSize']);
  assert.match(
    template,
    /"endpoint":\s*"\/api\/admin\/sessions",\s*"method":\s*"GET"[\s\S]*?"input_query_strings":\s*\["pageSize",\s*"cursor"\][\s\S]*?"url_pattern":\s*"\/api\/admin\/sessions"/,
  );

  const revoke = applicationRoutes.routes.find(
    ({ path, method }) => path === '/api/admin/sessions/{ref}/revoke' && method === 'POST',
  );
  assert.ok(revoke, 'missing administrative session revocation');
  assert.equal(revoke.auth, 'api-session');
  assert.deepEqual(revoke.query_parameters, []);
  assert.match(
    template,
    /"endpoint":\s*"\/api\/admin\/sessions\/\{ref\}\/revoke",\s*"method":\s*"POST"[\s\S]*?"input_query_strings":\s*\[\][\s\S]*?"url_pattern":\s*"\/api\/admin\/sessions\/\{ref\}\/revoke"/,
  );
  assert.match(
    template,
    /"input_headers":\s*\[[^\]]*"Cookie"[^\]]*"X-Csrf-Token"/s,
    'session cookie and CSRF token must reach the API',
  );
});

test('role-grant requests are session-authenticated and expose no direct grant mutation', () => {
  const expected = [
    ['GET', '/api/admin/users/{oid}/role-grant', []],
    ['POST', '/api/admin/users/{oid}/role-requests', []],
    ['GET', '/api/admin/role-requests', ['status', 'pageSize', 'cursor']],
    ['POST', '/api/admin/role-requests/{requestId}/approve', []],
    ['POST', '/api/admin/role-requests/{requestId}/reject', []],
  ];
  for (const [method, path, query] of expected) {
    const route = applicationRoutes.routes.find(
      (entry) => entry.method === method && entry.path === path,
    );
    assert.ok(route, `missing ${method} ${path}`);
    assert.equal(route.auth, 'api-session');
    assert.deepEqual([...route.query_parameters], query);
    assert.equal(route.encoding, 'no-op');
    assert.ok(
      declaredApiRoutes.some(
        (entry) => entry.path === path && entry.method === method && entry.upstream === path,
      ),
      `missing KrakenD proxy for ${method} ${path}`,
    );
  }
  assert.ok(
    !applicationRoutes.routes.some(
      (route) => route.method === 'PUT' && route.path.endsWith('/role-grant'),
    ),
    'direct role-grant mutation must remain unavailable',
  );
  assert.match(
    template,
    /"endpoint":\s*"\/api\/admin\/role-requests\/\{requestId\}\/approve"[\s\S]*?"input_headers":\s*\[[^\]]*"Cookie"[^\]]*"X-Csrf-Token"/,
  );
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
    2 + applicationRoutes.routes.length,
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
  ]) {
    assert.match(inventory, new RegExp(`^  ${key}: TO_BE_PROVIDED$`, 'm'));
  }
  assert.match(inventory, /^  version: 3\.0\.0$/m);
});
