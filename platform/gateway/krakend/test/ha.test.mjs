/**
 * C-28 — specs del perfil de alta disponibilidad.
 *
 * Verifican lo que distingue "dos contenedores" de "alta disponibilidad": que el
 * balanceador expulse a la réplica caída, que la cuota siga cumpliéndose con una sola
 * réplica sirviendo, que el cierre sea ordenado y que ninguna ruta de la allowlist se
 * quede sin observabilidad.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BURST_FACTOR,
  CapacityError,
  MINIMUM_REPLICAS_FOR_HA,
  planReplicaQuota,
  TARGET_PROFILE,
  verifyConfiguredQuota,
} from '../capacity.mjs';

const root = new URL('../', import.meta.url);
const ha = await readFile(new URL('compose.ha.yaml', root), 'utf8');
const nginx = await readFile(new URL('lb/nginx.conf', root), 'utf8');
const envExample = await readFile(new URL('.env.example', root), 'utf8');
const routes = JSON.parse(await readFile(new URL('routes.json', root), 'utf8'));
const routeDashboard = JSON.parse(
  await readFile(
    new URL('../../../observability/grafana/dashboards/qapaq-krakend-routes.json', import.meta.url),
    'utf8',
  ),
);

function envValue(name) {
  return Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(envExample)?.[1]);
}

test('la cuota por réplica se calcula con holgura N-1', () => {
  const plan = planReplicaQuota({ aggregateRatePerSecond: 20, replicas: 2 });

  assert.equal(plan.servingReplicas, 1);
  assert.equal(plan.perReplicaRate, 20);
  assert.equal(plan.perReplicaBurst, 20 * BURST_FACTOR);
  assert.equal(plan.aggregateWhenDegraded, 20);
  assert.equal(plan.aggregateWhenHealthy, 40);
});

test('con más réplicas la cuota por réplica baja y el objetivo degradado se conserva', () => {
  const plan = planReplicaQuota({ aggregateRatePerSecond: 90, replicas: 4 });

  assert.equal(plan.servingReplicas, 3);
  assert.equal(plan.perReplicaRate, 30);
  assert.ok(plan.aggregateWhenDegraded >= 90);
});

test('el cálculo rechaza entradas que no describen alta disponibilidad', () => {
  assert.throws(
    () => planReplicaQuota({ aggregateRatePerSecond: 20, replicas: 1 }),
    (error) => error instanceof CapacityError && error.code === 'REPLICAS_INSUFFICIENT',
  );
  assert.throws(
    () => planReplicaQuota({ aggregateRatePerSecond: 0, replicas: 2 }),
    (error) => error.code === 'RATE_INVALID',
  );
  assert.throws(
    () => planReplicaQuota({ aggregateRatePerSecond: 20, replicas: 2, toleratedFailures: 2 }),
    (error) => error.code === 'TOLERANCE_INVALID',
  );
  assert.equal(MINIMUM_REPLICAS_FOR_HA, 2);
});

test('el perfil configurado corresponde al objetivo agregado declarado', () => {
  const verification = verifyConfiguredQuota({
    ...TARGET_PROFILE,
    configuredRate: envValue('GATEWAY_RATE_PER_SECOND'),
    configuredBurst: envValue('GATEWAY_RATE_BURST'),
  });

  assert.deepEqual(verification.problems, []);
  assert.ok(verification.ok);
});

test('una cuota dimensionada sobre el total de réplicas se detecta como insuficiente', () => {
  // Error clásico: repartir 20 rps entre 2 réplicas deja 10 por réplica y el conjunto
  // cae a la mitad del objetivo en cuanto una réplica se pierde.
  const verification = verifyConfiguredQuota({
    ...TARGET_PROFILE,
    configuredRate: 10,
    configuredBurst: 20,
  });

  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((problem) => problem.includes('10')));
});

test('el perfil HA declara dos réplicas detrás del balanceador', () => {
  assert.match(ha, /^ {2}gateway-a:/m);
  assert.match(ha, /^ {2}gateway-b:/m);
  assert.match(nginx, /server gateway-a:8080/);
  assert.match(nginx, /server gateway-b:8080/);
});

test('el balanceador expulsa la réplica caída y limita el reintento', () => {
  assert.match(nginx, /max_fails=2 fail_timeout=5s/);
  assert.match(nginx, /proxy_next_upstream error timeout http_502 http_503/);
  assert.match(nginx, /proxy_next_upstream_tries 2/);
});

test('el rolling update cierra de forma ordenada y se verifica por health check', () => {
  assert.match(ha, /stop_grace_period: 20s/);
  assert.match(ha, /condition: service_healthy/);
  assert.match(ha, /healthcheck:/);
});

test('el perfil HA conserva el endurecimiento del contenedor', () => {
  assert.match(ha, /read_only: true/);
  assert.match(ha, /cap_drop: \[ALL\]/);
  assert.match(ha, /no-new-privileges:true/);
  assert.match(ha, /'127\.0\.0\.1:18080:8080'/);
});

test('el perfil HA no versiona secretos ni valores reales', () => {
  assert.doesNotMatch(ha, /Bearer\s+[A-Za-z0-9._-]{16,}/i);
  assert.doesNotMatch(ha, /password\s*[:=]/i);
  // Todo valor sensible llega por variable requerida, nunca con un valor por defecto.
  for (const variable of ['WAZUH_BASIC_AUTH_B64', 'OIDC_JWKS_URL', 'WAZUH_INDEXER_URL']) {
    assert.match(ha, new RegExp(`${variable}: \\$\\{${variable}:\\?required\\}`));
  }
});

test('el balanceador no decide autorización ni reescribe la ruta', () => {
  assert.doesNotMatch(nginx, /auth_|rewrite\s+/);
  assert.match(nginx, /proxy_pass http:\/\/krakend;/);
  assert.match(nginx, /server_tokens off/);
});

test('cada ruta de la allowlist tiene paneles de tasa y latencia', () => {
  for (const route of routes.routes) {
    const panels = routeDashboard.panels.filter((panel) =>
      panel.targets.some((target) => target.expr.includes(`endpoint="${route.path}"`)),
    );

    assert.equal(panels.length, 2, `ruta sin observabilidad completa: ${route.path}`);
    assert.ok(panels.some((panel) => panel.targets[0].expr.includes('requests_total')));
    assert.ok(panels.some((panel) => panel.targets[0].expr.includes('histogram_quantile')));
  }
  assert.equal(routeDashboard.panels.length, routes.routes.length * 2);
});
