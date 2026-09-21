import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['platform/testing/test/**/*.integration.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
