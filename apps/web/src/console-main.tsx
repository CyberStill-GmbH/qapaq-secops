import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StartupBoundary } from './bootstrap/error-boundary.js';
import { parsePublicConfig } from './bootstrap/public-config.js';
import { SocConsole } from './components/soc/SocConsole.js';
import './app/styles.css';
import './app/soc-shell.css';
import './app/soc-data.css';
import './app/soc-overlays.css';
import './app/soc-responsive.css';

const element = document.getElementById('root');
const config = parsePublicConfig(__QAPAQ_PUBLIC_CONFIG__);
if (element) {
  createRoot(element, { onCaughtError: () => {} }).render(
    <StrictMode>
      <StartupBoundary>
        <SocConsole basePath={config.basePath} />
      </StartupBoundary>
    </StrictMode>,
  );
} else {
  const fallback = document.createElement('main');
  fallback.setAttribute('role', 'alert');
  fallback.textContent = 'No se pudo iniciar la interfaz. Recarga la página.';
  document.body.append(fallback);
}
