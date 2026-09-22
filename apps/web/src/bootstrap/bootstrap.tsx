import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { StartupBoundary } from './error-boundary.js';
import { parsePublicConfig } from './public-config.js';

const Application = lazy(() => import('../app/application.js'));

function ConfiguredApplication({ input }: { input: unknown }) {
  const config = parsePublicConfig(input);
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
        <Suspense fallback={<main role="status">Cargando interfaz…</main>}>
          <ConfiguredApplication input={publicInput} />
        </Suspense>
      </StartupBoundary>
    </StrictMode>,
  );
  return () => root.unmount();
}
