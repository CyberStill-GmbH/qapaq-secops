import { Component, type ReactNode } from 'react';

export function StartupError(): React.JSX.Element {
  return (
    <main role="alert">
      <h1>No se pudo iniciar la interfaz</h1>
      <p>Recarga la página para volver a intentarlo.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Recargar página
      </button>
    </main>
  );
}

export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  public override state = { failed: false };
  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  public override render(): ReactNode {
    return this.state.failed ? <StartupError /> : this.props.children;
  }
}
