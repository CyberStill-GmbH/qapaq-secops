import { readFileSync } from 'node:fs';

const terraform = readFileSync('infra/azure/modules/runtime/main.tf', 'utf8');
const schema = readFileSync('platform/configuration/src/schema/environment.schema.ts', 'utf8');
const schemaStart = schema.indexOf('export const KNOWN_QAPAQ_VARIABLES = new Set([');
const schemaEnd = schema.indexOf(']);', schemaStart);
if (schemaStart < 0 || schemaEnd < 0) throw new Error('No se encontró KNOWN_QAPAQ_VARIABLES');
const known = new Set([...schema.slice(schemaStart, schemaEnd).matchAll(/'([^']+)'/gu)].map((m) => m[1]));

function envBlock(service) {
  const serviceStart = terraform.indexOf(`    ${service} = {`);
  if (serviceStart < 0) throw new Error(`No se encontró runtime ${service}`);
  const envStart = terraform.indexOf('      env = {', serviceStart);
  if (envStart < 0) throw new Error(`No se encontró env para runtime ${service}`);
  const open = terraform.indexOf('{', envStart);
  let depth = 0;
  for (let i = open; i < terraform.length; i += 1) {
    if (terraform[i] === '{') depth += 1;
    if (terraform[i] === '}') depth -= 1;
    if (depth === 0) return terraform.slice(open + 1, i);
  }
  throw new Error(`Bloque env sin cerrar para runtime ${service}`);
}

const failures = [];
for (const service of ['api', 'worker']) {
  const configured = [...envBlock(service).matchAll(/^\s*(QAPAQ_[A-Z0-9_]+)\s*=/gmu)].map((m) => m[1]);
  for (const name of configured) {
    if (!known.has(name)) failures.push(`${service}: ${name} no está en KNOWN_QAPAQ_VARIABLES`);
    if (name.startsWith('QAPAQ_QUEUE_')) failures.push(`${service}: ${name} no tiene implementación de runtime`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Azure API/worker no reciben variables QAPAQ desconocidas ni de cola sin implementar.');