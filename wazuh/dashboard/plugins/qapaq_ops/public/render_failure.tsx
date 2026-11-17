/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */
import React from 'react';

/** A failed view must leave a visible recovery action, not an empty dashboard. */
export class ViewErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  public state = { failed: false };
  public static getDerivedStateFromError() {
    return { failed: true };
  }
  public componentDidCatch(error: Error) {
    console.error('QAPAQ view render failed', error);
  }
  public render() {
    return this.state.failed ? (
      <section className="qapaqRenderFailure" role="alert">
        <h2>No se pudo abrir esta vista</h2>
        <p>La interfaz no termino de cargar. Recarga la pagina para volver a intentarlo.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Recargar pagina
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}

/** Handles a rejected lazy bundle before React has mounted. */
export function renderMountFailure(element: HTMLElement, error: unknown): () => void {
  console.error('QAPAQ view load failed', error);
  const section = document.createElement('section');
  section.className = 'qapaqRenderFailure';
  section.setAttribute('role', 'alert');
  const title = document.createElement('h2');
  title.textContent = 'No se pudo abrir esta vista';
  const detail = document.createElement('p');
  detail.textContent =
    'La interfaz no termino de cargar. Recarga la pagina para volver a intentarlo.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Recargar pagina';
  retry.onclick = () => window.location.reload();
  section.append(title, detail, retry);
  element.textContent = '';
  element.appendChild(section);
  return () => section.remove();
}
