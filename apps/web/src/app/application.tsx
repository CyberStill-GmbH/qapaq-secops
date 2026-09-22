import type { PublicConfig } from '../bootstrap/public-config.js';

export default function Application({ config }: { config: PublicConfig }): React.JSX.Element {
  return (
    <main>
      <h1>{config.appName}</h1>
      <p>Centro de operaciones de seguridad</p>
      <p role="status">Interfaz disponible</p>
    </main>
  );
}
