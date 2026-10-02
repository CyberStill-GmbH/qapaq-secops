import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let baseURL: string;
let close: () => Promise<void>;

test.beforeAll(async () => {
  const require = createRequire(resolve('apps/web/package.json'));
  const { preview } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await preview({
    configFile: false,
    root: resolve('apps/web'),
    preview: { port: 0, host: '127.0.0.1' },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('PREVIEW_NOT_LISTENING');
  baseURL = `http://127.0.0.1:${address.port}`;
  close = () => server.close();
});
test.afterAll(async () => {
  await close?.();
});

test('la interfaz compilada está disponible sin API', async ({ page }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'Inicia sesión en tu cuenta' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continuar con Microsoft Entra/u })).toBeVisible();
  await expect(page.getByText('Usa tu cuenta institucional para continuar.')).toBeVisible();
  expect(requests.filter((url) => url.includes('/api/'))).toEqual([
    expect.stringContaining('/api/auth/session'),
  ]);
  await expect(page.getByText(/mock|demo de interfaz|verificar estado del api/i)).toHaveCount(0);
  await expect(page.getByText('Cargando interfaz…')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/c02-web-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/c02-web-mobile.png', fullPage: true });
});

test('el boundary captura fallos reales de carga y permite recuperarse', async ({ page }) => {
  await page.route('**/assets/application-*.js', (route) => route.abort('failed'));
  await page.goto(baseURL);
  await expect(page.getByRole('alert')).toContainText('No se pudo iniciar la interfaz');
  await expect(page.getByRole('button', { name: 'Recargar página' })).toBeVisible();
  await page.unroute('**/assets/application-*.js');
  await page.getByRole('button', { name: 'Recargar página' }).click();
  await expect(page.getByRole('heading', { name: 'Inicia sesión en tu cuenta' })).toBeVisible();
});
