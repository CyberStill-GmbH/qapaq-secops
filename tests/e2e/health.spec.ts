import { expect, test } from '@playwright/test';

test('la aplicación muestra el health real de la API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'QAPAQ SecOps' })).toBeVisible();
  await expect(page.getByText('operational', { exact: true })).toBeVisible();
});
