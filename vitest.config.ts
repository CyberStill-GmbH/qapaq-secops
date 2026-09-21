import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['platform/**/test/**/*.spec.ts', 'packages/**/test/**/*.spec.ts'],
    exclude: ['**/*.integration.spec.ts'],
    passWithNoTests: false,
  },
});
