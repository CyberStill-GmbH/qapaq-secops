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
  await page.goto(`${stack.baseUrl}/api/auth/start`);
  await page.locator(`#signin-${username.split('@')[0]}`).click();
  await page.goto(`${stack.baseUrl}/console.html`);
  await expect(page.getByTestId('console-state')).toHaveText('Sesión activa');
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

  await expect(page.getByTestId('console-state')).toHaveText('Sesión no iniciada');
  await expect(page.getByRole('link', { name: /Iniciar sesión/u })).toBeVisible();
  await expect(page.getByTestId('alert-list')).toHaveCount(0);
});

test('recorrido completo: evento controlado, promoción, triaje y auditoría', async ({ page }) => {
  const ingested = await ingest('01890f47-7abc-7def-8abc-0000000000e1');
  expect(ingested.outcome).toBe('promoted');

  await signIn(page, 'analista@qapaq.pe');
  await expect(page.getByTestId('alert-list')).toBeVisible();
  await page
    .getByTestId('alert-list')
    .getByRole('button', { name: /Acceso sospechoso/u })
    .first()
    .click();
  await expect(page.getByTestId('alert-detail')).toBeVisible();
  await expect(page.getByTestId('alert-status')).toHaveText('new');

  await page.getByRole('button', { name: 'Tomar la alerta' }).click();
  await expect(page.getByTestId('alert-status')).toHaveText('acknowledged');

  await page.getByLabel('Sustento').fill('Confirmado con el usuario: no reconoce el acceso.');
  await page.getByRole('button', { name: 'Registrar triaje' }).click();
  await expect(page.getByTestId('alert-verdict')).toHaveText('true_positive');

  // El analista no tiene audit.read: la API responde igual que ante algo inexistente.
  const audit = await page.request.get(
    `${stack.baseUrl}/api/audit/events?from=2026-10-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z`,
  );
  expect(audit.status()).toBe(404);

  await page.screenshot({ path: 'test-results/c21-triage.png', fullPage: true });
});

test('la repetición del mismo evento no duplica la alerta', async ({ page }) => {
  await ingest('01890f47-7abc-7def-8abc-0000000000e2');
  const repeated = await ingest('01890f47-7abc-7def-8abc-0000000000e2');

  expect(repeated.outcome).toBe('duplicate');

  await signIn(page, 'analista@qapaq.pe');
  const titles = await page.getByTestId('alert-list').getByRole('button').allInnerTexts();

  expect(new Set(titles).size).toBe(titles.length);
});

test('el crudo se deniega por API, no por la interfaz', async ({ page }) => {
  await ingest('01890f47-7abc-7def-8abc-0000000000e3');
  await signIn(page, 'analista@qapaq.pe');
  await page.getByTestId('alert-list').getByRole('button').first().click();

  await expect(page.getByTestId('alert-raw')).toHaveText('no disponible para su rol');

  const raw = await page.request.get(`${stack.baseUrl}/api/alerts`);
  const body = (await raw.json()) as { items: { rawRef?: string }[] };

  expect(body.items.every((item) => item.rawRef === undefined)).toBe(true);
});

test('el líder ve el crudo y el auditor verifica la cadena', async ({ page }) => {
  await ingest('01890f47-7abc-7def-8abc-0000000000e4');
  await signIn(page, 'lider@qapaq.pe');
  await page.getByTestId('alert-list').getByRole('button').first().click();

  await expect(page.getByTestId('alert-raw')).toContainText('raw:');

  await signIn(page, 'auditor@qapaq.pe');
  const verify = await page.request.get(`${stack.baseUrl}/api/audit/verify`);
  const verification = (await verify.json()) as { ok: boolean; checked: number };

  expect(verification.ok).toBe(true);
  expect(verification.checked).toBeGreaterThan(0);
});

test('la consola degrada con claridad cuando la API no responde', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.abort('failed'));
  await page.goto(`${stack.baseUrl}/console.html`);

  await expect(page.getByTestId('console-state')).toHaveText('Servicio degradado');
  await expect(page.getByRole('alert')).toContainText('degradado');
  await expect(page.getByTestId('correlation-id')).toContainText('Referencia:');
  await page.screenshot({ path: 'test-results/c21-degraded.png', fullPage: true });
});
