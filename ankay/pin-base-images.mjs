#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lock = JSON.parse(
  readFileSync(new URL('./azure-components.lock.json', import.meta.url), 'utf8'),
);
const [component, dockerfile] = process.argv.slice(2);
const replacements = {
  frontend: [
    [/^FROM node:23 AS builder$/m, `FROM ${lock.buildBases.node23} AS builder`],
    [/^FROM nginx:1\.29\.3$/m, `FROM ${lock.buildBases.nginx1293}`],
  ],
};

if (!component || !dockerfile || !replacements[component]) {
  process.stderr.write('uso: pin-base-images.mjs frontend <Dockerfile>\n');
  process.exit(2);
}

let source = readFileSync(dockerfile, 'utf8');
for (const [pattern, replacement] of replacements[component]) {
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1)
    throw new Error(`Se esperaba una sola base ${pattern}; se encontraron ${matches.length}`);
  source = source.replace(pattern, replacement);
}
if (/^FROM (?!.*@sha256:).+$/m.test(source))
  throw new Error('El Dockerfile conserva una imagen FROM sin digest');
writeFileSync(dockerfile, source);

if (fileURLToPath(import.meta.url) === process.argv[1])
  process.stdout.write(`Bases ${component} fijadas por digest\n`);
