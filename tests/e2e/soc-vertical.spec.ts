/**
 * C-21/C-22 — recorrido vertical contra backend real.
 *
 * No hay dobles de API: el BFF corre como proceso independiente, la consola se compila
 * y el navegador recorre el flujo completo —acceso, listado, detalle, triaje— sobre
 * HTTP. Lo que la prueba demuestra es la ruta crítica de la Review: un evento controlado
 * se promueve, se tria y queda auditado, y una denegación real se observa desde la UI.
 *
 * El origen del evento es la entrada controlada `/api/ingest/security-events`: Wazuh
 * real sigue siendo gate del MVP y está declarado BLOCKED en la matriz de C-22.
 */

import { expect, test, type Page } from '@playwright/test';

import { securityEvent, startStack, type Stack } from './support/stack.js';

let stack: Stack;
let tenantId = 'local-development';

async function ingest(recordId: string) {
  const response = await fetch(`http://127.0.0.1:${stack.apiPort}/api/ingest/security-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(securityEvent(recordId, tenantId)),
  });
  return (await response.json()) as { outcome: string };
}

async function signIn(page: Page, username: string) {
  // B-03: tras el emisor, el BFF devuelve el navegador a la consola, no a un JSON.
  await page.goto(
    `${stack.baseUrl}/api/auth/start?returnTo=${encodeURIComponent('/console.html')}`,
  );
  await page.locator(`#signin-${username.split('@')[0]}`).click();
  await expect(page).toHaveURL(/\/console\.html(\?|$)/u);
  await expect(
    page.getByRole('heading', { name: /Resumen de operación|Estado de la operación/u }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.close();
});

test('la consola exige sesión antes de mostrar alertas', async ({ page }) => {
  await page.goto(`${stack.baseUrl}/console.html`);

  await expect(page).toHaveURL(new RegExp(`${stack.baseUrl}/$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Inicia sesión en tu cuenta' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar con Microsoft Entra' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0);
});

test('recorrido completo: evento controlado, promoción, triaje y auditoría', async ({ page }) => {
  const ingested = await ingest('01890f47-7abc-7def-8abc-0000000000e1');
  expect(ingested.outcome).toBe('promoted');

  await signIn(page, 'analista@qapaq.pe');
  await page.getByRole('link', { name: 'Alertas' }).click();
  const alertRow = page
    .getByRole('row', { name: /Acceso sospechoso desde Microsoft 365/u })
    .first();
  await expect(alertRow).toBeVisible();
  await alertRow.getByRole('button', { name: /Acceso sospechoso desde Microsoft 365/u }).click();
  const drawer = page.getByRole('complementary', { name: /Detalle de alerta/u });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.soc-drawer__status')).toContainText('Nueva');

  await drawer.getByRole('button', { name: 'Reconocer y asignarme' }).click();
  await expect(drawer.locator('.soc-drawer__status')).toContainText('Reconocida');

  await drawer
    .getByLabel('Sustento del triaje')
    .fill('Confirmado con el usuario: no reconoce el acceso.');
  await page.getByRole('button', { name: 'Registrar triaje' }).click();
  await expect(drawer.locator('.soc-description-list')).toContainText('Verdadero positivo');

  // El analista no tiene audit.read: la API responde igual que ante algo inexistente.
  const audit = await page.request.get(
    `${stack.baseUrl}/api/audit/events?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z`,
  );
  expect(audit.status()).toBe(404);

  await page.screenshot({ path: 'test-results/c21-triage.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Tras el cambio de viewport el layout puede tardar un frame; si persiste el desborde, el
  // mensaje nombra los elementos que se salen para no depender de la captura.
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth
          ? 'ok'
          : [...document.querySelectorAll('body *')]
              .filter((element) => {
                const box = element.getBoundingClientRect();
                return box.right > window.innerWidth + 1 && !element.closest('[class*="table"]');
              })
              .slice(0, 8)
              .map((element) => `${element.tagName}.${element.className}`)
              .join(' | '),
      ),
    )
    .toBe('ok');
  await page.screenshot({ path: 'test-results/c21-triage-mobile.png', fullPage: true });
});

test('la repetición del mismo evento no duplica la alerta', async ({ page }) => {
  await ingest('01890f47-7abc-7def-8abc-0000000000e2');
  const repeated = await ingest('01890f47-7abc-7def-8abc-0000000000e2');

  expect(repeated.outcome).toBe('duplicate');

  await signIn(page, 'analista@qapaq.pe');
  await page.getByRole('link', { name: 'Alertas' }).click();
  await expect(
    page.getByRole('row', { name: /Acceso sospechoso desde Microsoft 365/u }).first(),
  ).toBeVisible();
});

test('el crudo se deniega por API, no por la interfaz', async ({ page }) => {
  await ingest('01890f47-7abc-7def-8abc-0000000000e3');
  await signIn(page, 'analista@qapaq.pe');
  await page.getByRole('link', { name: 'Alertas' }).click();
  await page
    .getByRole('row', { name: /Acceso sospechoso desde Microsoft 365/u })
    .first()
    .getByRole('button', { name: /Acceso sospechoso desde Microsoft 365/u })
    .click();
  const drawer = page.getByRole('complementary', { name: /Detalle de alerta/u });
  await expect(drawer.getByText('Evento original', { exact: true })).toHaveCount(0);

  const raw = await page.request.get(`${stack.baseUrl}/api/alerts?pageSize=50`);
  const body = (await raw.json()) as { items: { rawRef?: string }[] };

  expect(body.items.every((item) => item.rawRef === undefined)).toBe(true);
});

test('el líder ve el crudo y el auditor verifica la cadena', async ({ page }) => {
  await ingest('01890f47-7abc-7def-8abc-0000000000e4');
  await signIn(page, 'lider@qapaq.pe');
  await page.getByRole('link', { name: 'Alertas' }).click();
  await page
    .getByRole('row', { name: /Acceso sospechoso desde Microsoft 365/u })
    .first()
    .getByRole('button', { name: /Acceso sospechoso desde Microsoft 365/u })
    .click();

  await expect(page.getByRole('complementary', { name: /Detalle de alerta/u })).toContainText(
    'raw:',
  );

  await signIn(page, 'auditor@qapaq.pe');
  const verify = await page.request.get(`${stack.baseUrl}/api/audit/verify`);
  const verification = (await verify.json()) as { ok: boolean; checked: number };

  expect(verification.ok).toBe(true);
  expect(verification.checked).toBeGreaterThan(0);
});

test('la consola degrada con claridad cuando la API no responde', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.abort('failed'));
  await page.goto(`${stack.baseUrl}/console.html`);

  await expect(
    page.getByRole('heading', { name: 'No fue posible abrir la consola' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('servicio está degradado');
  await expect(page.getByRole('alert')).toContainText('Referencia:');
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await page.screenshot({ path: 'test-results/c21-degraded.png', fullPage: true });
});
