import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type HealthState = 'checking' | 'operational' | 'unavailable';

function Application(): React.JSX.Element {
  const [health, setHealth] = useState<HealthState>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Health returned ${response.status}`);
        await response.json();
        setHealth('operational');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHealth('unavailable');
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>QAPAQ SecOps</h1>
      <p>
        Estado de la API: <strong>{health}</strong>
      </p>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Missing #root element');
createRoot(rootElement).render(
  <StrictMode>
    <Application />
  </StrictMode>,
);
