#!/usr/bin/env node
/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Typecheck aislado de qapaq_ops sin `yarn osd bootstrap`.
 *
 * Monta un árbol temporal con la misma forma que OSD (`plugins/qapaq_ops` + `src/core/{public,
 * server}`), donde el core son las firmas de 2.19.6 de tools/shims, y compila con TypeScript
 * 4.0.2 (la versión de OSD 2.19.6: así también se detecta sintaxis que el build no admite)
 * contra los tipos reales de OUI 1.19.0 y React 16.14.
 *
 * Uso:
 *   QAPAQ_TOOLS_DIR=/ruta/con/node_modules node tools/typecheck.mjs
 * donde node_modules contiene: typescript@4.0.2 @opensearch-project/oui@1.19.0
 *   @types/react@16.14 @types/react-dom@16.9 @types/node@18 @types/jest@27 rxjs@6.6.7
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = process.env.QAPAQ_TOOLS_DIR;
if (!tools || !existsSync(join(tools, 'node_modules', 'typescript'))) {
  console.error('QAPAQ_TOOLS_DIR debe apuntar a un directorio con node_modules (ver cabecera).');
  process.exit(2);
}
const modules = join(tools, 'node_modules').replace(/\\/g, '/');

const stage = mkdtempSync(join(tmpdir(), 'qapaq-ops-typecheck-'));
try {
  const target = join(stage, 'plugins', 'qapaq_ops');
  cpSync(pluginDir, target, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|target|build)([\\/]|$)/.test(source),
  });
  for (const [side, shim] of [
    ['public', 'core-public.d.ts'],
    ['server', 'core-server.d.ts'],
  ]) {
    const dir = join(stage, 'src', 'core', side);
    mkdirSync(dir, { recursive: true });
    cpSync(join(pluginDir, 'tools', 'shims', shim), join(dir, 'index.d.ts'));
  }
  const tsconfig = {
    compilerOptions: {
      target: 'es2019',
      module: 'esnext',
      moduleResolution: 'node',
      jsx: 'react',
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      isolatedModules: true,
      lib: ['es2019', 'es2020.string', 'es2020.intl', 'dom', 'dom.iterable'],
      baseUrl: '.',
      typeRoots: [`${modules}/@types`],
      types: ['node', 'jest', 'react'],
      paths: { '*': [`${modules}/*`, `${modules}/@types/*`] },
    },
    files: [
      'plugins/qapaq_ops/tools/shims/osd-modules.d.ts',
      `${modules}/@opensearch-project/oui/oui.d.ts`,
    ],
    include: ['plugins/qapaq_ops/**/*.ts', 'plugins/qapaq_ops/**/*.tsx'],
    exclude: ['plugins/qapaq_ops/tools/**'],
  };
  writeFileSync(join(stage, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  const tsc = join(tools, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(stage, 'tsconfig.json')], {
    stdio: 'inherit',
  });
  if (result.status === 0)
    console.log('typecheck qapaq_ops: OK (TypeScript 4.0.2, OUI 1.19.0, React 16.14)');
  process.exitCode = result.status ?? 1;
} finally {
  if (!process.env.QAPAQ_KEEP_STAGE) rmSync(stage, { recursive: true, force: true });
  else console.log(`stage: ${stage}`);
}
