import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    include: [
      'platform/**/test/**/*.spec.ts',
      'modules/**/test/**/*.spec.ts',
      'packages/**/test/**/*.spec.ts',
      'apps/**/test/**/*.spec.ts',
      'apps/**/test/**/*.spec.tsx',
      'tests/architecture/**/*.spec.ts',
    ],
    exclude: ['**/*.integration.spec.ts'],
    passWithNoTests: false,
    fsModuleCache: true,
  },
});
