import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Los paquetes del workspace se resuelven a su fuente, igual que en las specs unitarias.
  resolve: { conditions: ['development'] },
  test: {
    include: [
      'platform/testing/test/**/*.spec.ts',
      'modules/telemetry/test/**/*.integration.spec.ts',
      'modules/soc/test/**/*.integration.spec.ts',
      'modules/soar/test/**/*.integration.spec.ts',
      'modules/access/test/**/*.integration.spec.ts',
      'modules/queue/test/**/*.integration.spec.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
