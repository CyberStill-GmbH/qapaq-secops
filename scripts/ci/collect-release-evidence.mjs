/**
 * C-22 — recolector de evidencia del candidato.
 *
 * Ejecuta las comprobaciones reales, las combina con los gates bloqueados por accesos
 * externos y emite la matriz atada al commit y al ambiente. No interpreta resultados: un
 * comando que falla es FAIL, y la decisión se deriva de la matriz, no al revés.
 *
 * Uso:
 *   node --import tsx scripts/ci/collect-release-evidence.mjs [--skip-e2e] [--environment <nombre>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const { buildReleaseEvidence, renderMarkdown } = await import(
  pathToFileURL(resolve(root, 'platform/testing/src/evidence/release-evidence.ts')).href
);

const args = process.argv.slice(2);
const skipE2e = args.includes('--skip-e2e');
const environment =
  args[args.indexOf('--environment') + 1] && args.includes('--environment')
    ? args[args.indexOf('--environment') + 1]
    : `${process.platform}-${process.arch}`;

/** Cada comprobación declara qué requisito del Sprint 3 sostiene. */
const CHECKS = [
  {
    id: 'C-16-prioritization',
    component: 'C-16',
    priority: 'P0',
    requirement: 'Priorización con reason codes y promoción idempotente.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'modules/detection/test'],
  },
  {
    id: 'C-17-lifecycle',
    component: 'C-17',
    priority: 'P0',
    requirement: 'Lifecycle, concurrencia y atomicidad estado/auditoría/outbox.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'modules/soc/test'],
  },
  {
    id: 'C-18-C-25-access',
    component: 'C-18/C-25',
    priority: 'P0',
    requirement: 'OIDC, sesión única, red QAPAQ, passkey, Smart Lockout y rate limit.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'modules/access/test'],
  },
  {
    id: 'C-19-audit',
    component: 'C-19',
    priority: 'P0',
    requirement: 'Cadena de hash, tamper/gap, archivo y reconciliación.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'platform/audit/test'],
  },
  {
    id: 'C-20-notification',
    component: 'C-20',
    priority: 'P0',
    requirement: 'Outbox, reintento, timeout ambiguo, fallback y acuse.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'modules/soar/test'],
  },
  {
    id: 'C-18-bff-http',
    component: 'C-18/C-27',
    priority: 'P0',
    requirement: 'Autorización, denegación y catálogo de errores sobre HTTP real.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'apps/api/test'],
  },
  {
    id: 'C-27-error-catalog',
    component: 'C-27',
    priority: 'P1',
    requirement: 'Catálogo de errores con helpRef, acción y no enumeración.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'packages/contracts/test'],
  },
  {
    id: 'C-26-observability',
    component: 'C-26',
    priority: 'P1',
    requirement: 'Señales SOC, dashboards versionados, hardening y retención.',
    command: [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.config.ts',
      'platform/observability/test',
    ],
  },
  {
    id: 'C-23-coupling',
    component: 'C-23',
    priority: 'P1',
    requirement: 'Acoplamiento a proveedor acotado y conformidad del adapter real.',
    command: ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'tests/architecture'],
  },
  {
    id: 'C-22-evidence',
    component: 'C-22',
    priority: 'P0',
    requirement: 'Matriz de evidencia y decisión derivadas, no narradas.',
    command: [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.config.ts',
      'platform/testing/test/release-evidence.spec.ts',
    ],
  },
  {
    id: 'C-28-gateway',
    component: 'C-28',
    priority: 'P1',
    requirement: 'Cuota por réplica, failover configurado y dashboards por ruta.',
    command: null,
    node: [
      '--test',
      'platform/gateway/krakend/test/contract.test.mjs',
      'platform/gateway/krakend/test/ha.test.mjs',
    ],
  },
  {
    id: 'C-07-boundaries',
    component: 'C-07',
    priority: 'P0',
    requirement: 'Límites de arquitectura y entrypoints.',
    command: ['run', 'boundaries'],
  },
  {
    id: 'C-01-typecheck',
    component: 'C-01',
    priority: 'P0',
    requirement: 'Tipado estricto en todo el workspace.',
    command: ['run', 'typecheck'],
  },
  ...(skipE2e
    ? []
    : [
        {
          id: 'C-21-C-22-e2e',
          component: 'C-21/C-22',
          priority: 'P0',
          requirement: 'Recorrido vertical en navegador contra backend real.',
          command: ['exec', 'playwright', 'test'],
        },
      ]),
];

/** Resumen de una salida fallida: la última línea útil, sin volcar la suite entera. */
function failureSummary(result) {
  const output = [result.stdout ?? '', result.stderr ?? '']
    .join(String.fromCharCode(10))
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return output.at(-1)?.slice(0, 160) ?? 'sin salida';
}

function run(check) {
  const started = Date.now();
  const options = {
    cwd: root,
    encoding: 'utf8',
    // Un comando que no termina no es un fallo de la ruta crítica: es una medición que
    // no se pudo tomar, y conviene que se note en la evidencia.
    timeout: 10 * 60 * 1000,
  };
  const result = check.node
    ? spawnSync(process.execPath, check.node, options)
    : spawnSync('pnpm', check.command, { ...options, shell: process.platform === 'win32' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const command = check.node ? `node ${check.node.join(' ')}` : `pnpm ${check.command.join(' ')}`;
  process.stdout.write(`${result.status === 0 ? 'PASS' : 'FAIL'} ${check.id} (${seconds}s)\n`);
  return {
    id: check.id,
    component: check.component,
    requirement: check.requirement,
    priority: check.priority,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    evidence:
      result.status === 0
        ? `${command} · ${seconds}s`
        : `${command} · ${seconds}s · ${failureSummary(result)}`,
  };
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const blocked = JSON.parse(
  readFileSync(resolve(root, 'docs/reference/release-gates/blocked-gates.json'), 'utf8'),
).items;

const items = [...CHECKS.map(run), ...blocked];
const evidence = buildReleaseEvidence(
  {
    commit,
    environment,
    generatedAt: new Date().toISOString(),
    toolchain: {
      node: process.versions.node,
      pnpm: execFileSync('pnpm', ['--version'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }).trim(),
    },
  },
  items,
);

const directory = resolve(root, 'docs/reference/release-gates');
mkdirSync(directory, { recursive: true });
writeFileSync(
  resolve(directory, 'release-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8',
);
writeFileSync(resolve(directory, 'release-evidence.md'), renderMarkdown(evidence), 'utf8');

process.stdout.write(`\nDecisión: ${evidence.outcome.decision}\n${evidence.outcome.rationale}\n`);
if (evidence.problems.length > 0) {
  process.stdout.write(`Problemas de la matriz: ${evidence.problems.length}\n`);
  process.exitCode = 1;
}
if (evidence.outcome.decision === 'NOT_READY') process.exitCode = 1;
