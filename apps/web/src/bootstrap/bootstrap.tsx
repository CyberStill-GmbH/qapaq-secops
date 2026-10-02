import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { StartupBoundary } from './error-boundary.js';
import { parsePublicConfig } from './public-config.js';
import { QapaqSplash } from '../components/login/QapaqSplash.js';

const Application = lazy(() => import('../app/application.js'));
const SocConsole = lazy(() =>
  import('../components/soc/SocConsole.js').then((module) => ({ default: module.SocConsole })),
);

function ConfiguredApplication({ input }: { input: unknown }) {
  const config = parsePublicConfig(input);
  const prefix = config.basePath === '/' ? '' : config.basePath.slice(0, -1);
  const pathname = window.location.pathname;
  const isLogin = pathname === config.basePath || pathname === `${prefix}/`;
  if (!isLogin) return <SocConsole basePath={config.basePath} />;
  return <Application config={config} />;
}

export function bootstrap(element: HTMLElement, publicInput: unknown) {
  const root = createRoot(element, {
    // React no debe imprimir el objeto capturado, la configuración ni el error del proveedor.
    onCaughtError: () => {},
  });
  root.render(
    <StrictMode>
      <StartupBoundary>
        <Suspense fallback={<QapaqSplash waiting />}>
          <ConfiguredApplication input={publicInput} />
        </Suspense>
      </StartupBoundary>
    </StrictMode>,
  );
  return () => root.unmount();
}
