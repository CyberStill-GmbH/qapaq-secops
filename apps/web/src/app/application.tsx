import type { PublicConfig } from '../bootstrap/public-config.js';
import { Console } from './console.js';

/**
 * Shell de la consola. El primer render no afirma nada sobre el backend: declara que la
 * interfaz está disponible y deja que `Console` resuelva el estado real de la sesión.
 * Esa separación es lo que permite que la interfaz siga siendo útil —y honesta— cuando
 * la API no responde.
 */
export default function Application({ config }: { config: PublicConfig }): React.JSX.Element {
  return (
    <main>
      <h1>{config.appName}</h1>
      <p>Centro de operaciones de seguridad</p>
      <p role="status">Interfaz disponible</p>
      <Console />
    </main>
  );
}
