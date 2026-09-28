import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkEntrypoints } from '../../scripts/check-entrypoints.mjs';

it('the repository respects entrypoint boundaries', () => {
  expect(checkEntrypoints()).toEqual([]);
});

it.each([
  ['api', 'worker'],
  ['api', 'web'],
  ['worker', 'api'],
  ['worker', 'web'],
  ['web', 'api'],
  ['web', 'worker'],
])('rejects relative, dynamic, reexport, deep and alias imports: %s → %s', (from, to) => {
  const root = mkdtempSync(join(tmpdir(), 'qapaq-c02-boundaries-'));
  const write = (path: string, source: string) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, source);
  };
  try {
    for (const app of [from, to]) {
      write(
        `apps/${app}/package.json`,
        JSON.stringify({ name: `@qapaq/${app}`, exports: './src/index.ts' }),
      );
      write(`apps/${app}/src/index.ts`, 'export const value = 1;');
    }
    write(
      `apps/${from}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          moduleResolution: 'NodeNext',
          paths: { '@other/*': [`../${to}/src/*`] },
        },
      }),
    );
    for (const source of [
      `import { value } from '../../${to}/src/index.js';`,
      `export { value } from '../../${to}/src/index.js';`,
      `void import('../../${to}/src/index.js');`,
      `import { value } from '@other/index';`,
      `import { value } from '@qapaq/${to}/src/index';`,
      `const other = require('@qapaq/${to}');`,
      `type Other = typeof import('../../${to}/src/index.js');`,
      `import other = require('@qapaq/${to}');`,
    ]) {
      write(`apps/${from}/src/violation.ts`, source);
      expect(
        checkEntrypoints(root).some((error) => error.includes('no-cross-app-imports')),
        source,
      ).toBe(true);
    }
    write(`apps/${from}/src/violation.ts`, 'export const safe = 1;');
    expect(checkEntrypoints(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects raw environment, package internals, client construction and opaque imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'qapaq-c02-root-'));
  const app = join(root, 'apps/api');
  const configuration = join(root, 'platform/configuration');
  mkdirSync(join(app, 'src'), { recursive: true });
  mkdirSync(join(configuration, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@qapaq/api' }));
  writeFileSync(
    join(configuration, 'package.json'),
    JSON.stringify({ name: '@qapaq/configuration', exports: './src/index.ts' }),
  );
  try {
    writeFileSync(
      join(app, 'src/bootstrap.ts'),
      `
      import { value } from '@qapaq/configuration/src/index';
      import { Redis } from 'ioredis';
      const { env } = process;
      void import(env.DYNAMIC);
    `,
    );
    const errors = checkEntrypoints(root).join('\n');
    for (const rule of [
      'public-package-exports-only',
      'environment-at-process-boundary',
      'clients-in-composition-root',
      'statically-resolvable-imports-only',
    ])
      expect(errors).toContain(rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
