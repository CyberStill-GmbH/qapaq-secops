/**
 * Entrada de la consola operativa de C-21.
 *
 * Vive en una página propia y no en la pantalla principal: la interfaz de producto y
 * esta consola evolucionan por separado, una sobre datos de demostración y la otra
 * contra el BFF real. Separarlas evita que un cambio de maquetación rompa la evidencia
 * del recorrido, y que la consola imponga su estética al producto.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { StartupBoundary } from './bootstrap/error-boundary.js';
import { Console } from './app/console.js';
import './app/styles.css';

const element = document.getElementById('root');
if (element) {
  createRoot(element, { onCaughtError: () => {} }).render(
    <StrictMode>
      <StartupBoundary>
        <main>
          <h1>QAPAQ SecOps</h1>
          <p>Centro de operaciones de seguridad</p>
          <p role="status">Interfaz disponible</p>
          <Console />
        </main>
      </StartupBoundary>
    </StrictMode>,
  );
} else {
  const fallback = document.createElement('main');
  fallback.setAttribute('role', 'alert');
  fallback.textContent = 'No se pudo iniciar la interfaz. Recarga la página.';
  document.body.append(fallback);
}
