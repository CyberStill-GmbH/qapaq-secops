import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'pnpm --filter @qapaq/api dev',
      env: { QAPAQ_PROFILE: 'test' },
      url: 'http://127.0.0.1:3100/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @qapaq/web dev --host 127.0.0.1 --mode test',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
