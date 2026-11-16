import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(pluginRoot, '../../../..');
const pnpmStore = join(repositoryRoot, 'node_modules/.pnpm');

function pnpmPackageDirectory(name: string): string {
  const entry = readdirSync(pnpmStore)
    .filter((candidate) => candidate.startsWith(`${name}@`))
    .sort()
    .find((candidate) => existsSync(join(pnpmStore, candidate, 'node_modules', name)));
  if (!entry) {
    throw new Error(
      `No se encontró ${name} en node_modules/.pnpm; ejecuta pnpm install antes de probar qapaq_ops.`,
    );
  }
  return join(pnpmStore, entry, 'node_modules', name);
}

const reactDirectory = pnpmPackageDirectory('react');
const reactDomDirectory = pnpmPackageDirectory('react-dom');

export default defineConfig({
  root: pluginRoot,
  resolve: {
    conditions: ['development'],
    alias: [
      { find: /^react$/, replacement: join(reactDirectory, 'index.js') },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: join(reactDirectory, 'jsx-dev-runtime.js'),
      },
      { find: /^react\/jsx-runtime$/, replacement: join(reactDirectory, 'jsx-runtime.js') },
      {
        find: /^react-dom\/server$/,
        replacement: join(reactDomDirectory, 'server.node.js'),
      },
      {
        find: /^@elastic\/eui$/,
        replacement: join(pluginRoot, 'tools/testing/oui-adapter.tsx'),
      },
    ],
  },
  test: {
    include: [
      'common/**/*.test.ts',
      'server/**/*.test.ts',
      'public/**/*.test.ts',
      'public/**/*.test.tsx',
    ],
    exclude: ['**/node_modules/**', '**/build/**', '**/target/**'],
    environment: 'node',
    globals: true,
    pool: 'threads',
    maxWorkers: 1,
    setupFiles: ['./tools/testing/vitest.setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    passWithNoTests: false,
  },
});
