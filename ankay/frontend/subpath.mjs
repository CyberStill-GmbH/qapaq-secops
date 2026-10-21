#!/usr/bin/env node
/*
 * QAPAQ overlay for the upstream Shuffle v2.3.0 `enable_subpathing.sh.tpl` contract.
 * The upstream script rewrites React route literals so the frontend can be hosted at /ankay/.
 * This equivalent is deterministic, idempotent, and deliberately limited to App.jsx, views and
 * components. The QAPAQ edge strips /ankay/ before forwarding static/API requests upstream.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUBPATH = '/ankay';

const REPLACEMENTS = [
  [/startsWith\("\/(?!ankay\/)/gu, 'startsWith("/ankay/'],
  [/path="\/(?!ankay\/)/gu, 'path="/ankay/'],
  [/location = "\/(?!ankay\/)/gu, 'location = "/ankay/'],
  [/window\.location\.origin;/gu, '"/ankay";'],
  [/pathname = "\/(?!ankay\/)/gu, 'pathname = "/ankay/'],
  [/navigate\("\/(?!ankay\/)/gu, 'navigate("/ankay/'],
  [/navigate\(`\/(?!ankay\/)/gu, 'navigate(`/ankay/'],
  [/href="\/(?!ankay\/)/gu, 'href="/ankay/'],
  [/path = "\/(?!ankay\/)/gu, 'path = "/ankay/'],
  [/link=\{"\/(?!ankay\/)/gu, 'link={"/ankay/'],
  [/to="\/(?!ankay\/)/gu, 'to="/ankay/'],
  [/to=\{"\/(?!ankay\/)/gu, 'to={"/ankay/'],
  [/\$\{window\.location\.origin\}/gu, SUBPATH],
];

export function prefixSource(source) {
  return REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    source,
  );
}

function prefixFiles(directory) {
  let changed = 0;
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith('.jsx'))
    .sort()) {
    const path = join(directory, name);
    const original = readFileSync(path, 'utf8');
    const prefixed = prefixSource(original);
    if (prefixed !== original) {
      writeFileSync(path, prefixed);
      changed += 1;
    }
  }
  return changed;
}

export function enableSubpath(frontendDirectory) {
  const appPath = join(frontendDirectory, 'src', 'App.jsx');
  const original = readFileSync(appPath, 'utf8');
  const prefixed = prefixSource(original);
  if (prefixed === original && !original.includes('"/ankay"')) {
    throw new Error('UPSTREAM_SUBPATH_CONTRACT_MISMATCH: App.jsx');
  }
  writeFileSync(appPath, prefixed);
  const views = prefixFiles(join(frontendDirectory, 'src', 'views'));
  const components = prefixFiles(join(frontendDirectory, 'src', 'components'));
  return { app: prefixed === original ? 0 : 1, views, components };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const frontendDirectory = process.argv[2];
  if (!frontendDirectory) {
    process.stderr.write('uso: node subpath.mjs <shuffle-frontend-dir>\n');
    process.exit(2);
  }
  const result = enableSubpath(frontendDirectory);
  process.stdout.write(
    `subruta /ankay aplicada: App.jsx=${result.app}, views=${result.views}, components=${result.components}\n`,
  );
}
