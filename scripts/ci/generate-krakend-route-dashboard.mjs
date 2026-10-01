/**
 * C-28 — dashboard por ruta del gateway, generado desde `routes.json`.
 *
 * Generarlo evita el modo de fallo habitual: añadir una ruta a la allowlist y dejarla
 * sin observabilidad, que es justo la ruta sobre la que nadie mira cuando falla.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const routes = JSON.parse(
  readFileSync(resolve(root, 'platform/gateway/krakend/routes.json'), 'utf8'),
);

const datasource = { type: 'prometheus', uid: 'qapaq-prometheus' };
const panels = routes.routes.flatMap((route, index) => {
  const selector = `{endpoint="${route.path}",method="${route.method}"}`;
  return [
    {
      id: index * 2 + 1,
      title: `${route.method} ${route.path} · tasa por código`,
      type: 'timeseries',
      datasource,
      targets: [
        {
          expr: `sum(rate(krakend_http_requests_total${selector}[5m])) by (status_code)`,
          legendFormat: '{{status_code}}',
        },
      ],
    },
    {
      id: index * 2 + 2,
      title: `${route.method} ${route.path} · latencia p95`,
      type: 'timeseries',
      datasource,
      targets: [
        {
          expr: `histogram_quantile(0.95, sum(rate(krakend_http_request_duration_seconds_bucket${selector}[5m])) by (le))`,
          legendFormat: 'p95',
        },
      ],
    },
  ];
});

const dashboard = {
  uid: 'qapaq-krakend-routes',
  title: 'QAPAQ SecOps · KrakenD por ruta',
  tags: ['qapaq', 'gateway'],
  timezone: 'utc',
  refresh: '1m',
  panels,
};

const target = resolve(root, 'platform/observability/grafana/dashboards/qapaq-krakend-routes.json');
writeFileSync(target, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
process.stdout.write(`${dashboard.uid}: ${panels.length} paneles\n`);
