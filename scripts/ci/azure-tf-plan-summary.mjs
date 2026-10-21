#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

export function summarizePlan(plan) {
  const changes = (plan.resource_changes ?? []).map((resource) => ({
    address: resource.address,
    actions: resource.change?.actions ?? [],
  }));
  const destructive = changes.filter(
    ({ actions }) => actions.includes('delete') || actions.includes('forget'),
  );
  return {
    changes: changes.filter(({ actions }) => !actions.includes('no-op')),
    destructive,
  };
}

function main() {
  const [planJsonPath] = process.argv.slice(2);
  if (!planJsonPath) {
    console.error('Usage: node scripts/ci/azure-tf-plan-summary.mjs <plan.json>');
    process.exit(2);
  }

  const { changes, destructive } = summarizePlan(JSON.parse(readFileSync(planJsonPath, 'utf8')));
  if (destructive.length > 0) {
    console.error('El plan contiene acciones destructivas y no puede aplicarse:');
    for (const resource of destructive)
      console.error(`- ${resource.address}: ${resource.actions.join(',')}`);
    process.exit(1);
  }

  console.log(
    `Plan protegido: ${changes.length} recurso(s) con cambios; no contiene delete, forget ni reemplazos.`,
  );
  for (const resource of changes)
    console.log(`- ${resource.address}: ${resource.actions.join(',')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const markdown = [
      '### Terraform Azure: resumen del plan',
      '',
      `Cambios: **${changes.length}**. No se permiten acciones delete/forget ni reemplazos.`,
      '',
      ...changes.map(({ address, actions }) => `- ${address}: ${actions.join(', ')}`),
      '',
      'Los valores de atributos y secretos no se muestran en este resumen.',
    ].join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

if (process.argv[1]?.endsWith('azure-tf-plan-summary.mjs')) main();
