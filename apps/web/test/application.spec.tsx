import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import Application from '../src/app/application.js';
import { parsePublicConfig } from '../src/bootstrap/public-config.js';
import { StartupBoundary } from '../src/bootstrap/error-boundary.js';

it('renders the institution and interface availability without claiming backend health', () => {
  const config = parsePublicConfig({ appName: 'QAPAQ SecOps', basePath: '/' });
  const html = renderToStaticMarkup(createElement(Application, { config }));
  expect(html).toContain('QAPAQ SecOps');
  expect(html).toContain('Interfaz disponible');
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
