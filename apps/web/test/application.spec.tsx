import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import Application from '../src/app/application.js';
import { parsePublicConfig } from '../src/bootstrap/public-config.js';
import { StartupBoundary } from '../src/bootstrap/error-boundary.js';

it('renders only the lightweight QAPAQ splash before session resolution', () => {
  const config = parsePublicConfig({ appName: 'QAPAQ SecOps', basePath: '/' });
  const html = renderToStaticMarkup(createElement(Application, { config }));
  expect(html).toContain('class="auth-startup"');
  expect(html).toContain('aria-label="QAPAQ SecOps"');
  expect(html).toContain('class="auth-splash-mark"');
  expect(html).toContain('qapaq-q-mask.png');
  expect(html).not.toContain('Inicia sesión en tu cuenta');
  expect(html).not.toContain('Cargando interfaz');
  expect(html).not.toContain('iniciando sesión institucional');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('Interfaz disponible');
});

it('projects only finite public values', () => {
  expect(
    parsePublicConfig({ appName: 'QAPAQ SecOps', basePath: '/', token: 'synthetic-secret' }),
  ).toEqual({ appName: 'QAPAQ SecOps', basePath: '/' });
});

it.each([
  null,
  {},
  { appName: 'secret', basePath: '/' },
  { appName: 'QAPAQ SecOps', basePath: 'https://u:p@example.test' },
])('rejects invalid public config', (input) => {
  expect(() => parsePublicConfig(input)).toThrow('PUBLIC_CONFIG_INVALID');
});

it('renders a safe recovery action after an error', () => {
  const boundary = new StartupBoundary({ children: 'normal' });
  boundary.state = StartupBoundary.getDerivedStateFromError();
  const html = renderToStaticMarkup(boundary.render());
  expect(html).toContain('No se pudo iniciar');
  expect(html).toContain('Recargar página');
  expect(html).not.toContain('normal');
});
