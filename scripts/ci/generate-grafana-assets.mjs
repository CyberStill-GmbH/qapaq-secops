/**
 * Genera el provisioning de Grafana a partir del catálogo de señales (C-26).
 *
 * Se ejecuta a mano tras cambiar una métrica; la spec `grafana-provisioning.spec.ts`
 * falla si lo versionado deja de coincidir con lo generado.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const { buildDashboards, serializeDashboard } = await import(
  pathToFileURL(resolve(root, 'platform/observability/src/grafana-provisioning.ts')).href
);

const directory = resolve(root, 'platform/observability/grafana/dashboards');
mkdirSync(directory, { recursive: true });
for (const dashboard of buildDashboards()) {
  writeFileSync(resolve(directory, `${dashboard.uid}.json`), serializeDashboard(dashboard), 'utf8');
  process.stdout.write(`${dashboard.uid}.json\n`);
}
