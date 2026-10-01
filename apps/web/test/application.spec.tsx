import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import Application from '../src/app/application.js';
import { parsePublicConfig } from '../src/bootstrap/public-config.js';
import { StartupBoundary } from '../src/bootstrap/error-boundary.js';

it('renders a QAPAQ sign-in gate with the real brand, Entra identity, and right-side brand panel', () => {
  const config = parsePublicConfig({ appName: 'QAPAQ SecOps', basePath: '/' });
  const html = renderToStaticMarkup(createElement(Application, { config }));
  expect(html).toContain('Inicia sesión en tu cuenta');
  expect(html).toContain('Continuar con Microsoft Entra');
  expect(html).toContain('Demo de interfaz · no inicia una sesión corporativa real');
  expect(html).toContain('OIDC · Authorization Code + PKCE · sesión BFF');
  expect(html).toContain('Identidad visual QAPAQ');
  expect(html).toContain('src="/qapaq-mark-source.png"');
  expect(html).toContain('Emblema Q de QAPAQ');
  expect(html).toContain('radial-gradient(ellipse 60% 75% at 100% 45%');
  expect(html).toContain('Verificar estado del API');
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
