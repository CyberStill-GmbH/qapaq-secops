/**
 * Marcas de integración/fuente propias de QAPAQ.
 *
 * Son SVG monoline originales (no los logos de marca), coherentes con `SocIcon`:
 * viewBox 24×24, `fill: none`, `stroke: currentColor`, `stroke-width: 1.65`, uniones
 * redondeadas. Heredan el color del contexto (`--text-2`/`--text-3`), así que funcionan en
 * cualquier superficie del tema sin introducir color de marca. Formato óptimo para iconos de
 * UI: pesan <1 KB, escalan sin pérdida y respetan `prefers-reduced-motion` (no animan).
 *
 * No usan los logotipos registrados de Microsoft, Google, Cloudflare, Vercel ni Railway: son
 * representaciones abstractas que evocan cada integración por su forma, conforme a la regla de
 * `10-vistas-por-rol-y-referencias.md` («SVG propio revisado», sin packs de iconos).
 *
 * Uso: <SocBrandMark name="m365" size={18} title="Microsoft 365" />
 * El `title` da nombre accesible; sin él, el icono es decorativo (`aria-hidden`).
 */

export type BrandMarkName =
  | 'microsoft'
  | 'm365'
  | 'entra'
  | 'exchange'
  | 'sharepoint'
  | 'teams'
  | 'graph'
  | 'wazuh'
  | 'browser'
  | 'cloudflare'
  | 'vercel'
  | 'railway'
  | 'window'
  | 'source';

const PATHS: Record<BrandMarkName, React.ReactNode> = {
  // Suite: cuatro paneles redondeados con separación (evoca un conjunto de apps).
  microsoft: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  // M365: nube de servicio con tres puntos de la suite.
  m365: (
    <>
      <path d="M7 16.5a3.2 3.2 0 0 1 .4-6.37 4.3 4.3 0 0 1 8.26-1.1A3.5 3.5 0 0 1 16.8 16.5Z" />
      <circle cx="9.2" cy="13" r="0.6" />
      <circle cx="12" cy="13" r="0.6" />
      <circle cx="14.8" cy="13" r="0.6" />
    </>
  ),
  // Entra / identidad: escudo con figura de persona (admisión).
  entra: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7-7 9-4.1-2-7-4.8-7-9V6Z" />
      <circle cx="12" cy="10" r="2" />
      <path d="M8.6 15.4a3.6 3.6 0 0 1 6.8 0" />
    </>
  ),
  // Exchange / correo: sobre con marca de sincronización.
  exchange: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </>
  ),
  // SharePoint: nodos enlazados (compartir documentos).
  sharepoint: (
    <>
      <circle cx="7" cy="7" r="2.3" />
      <circle cx="17" cy="9" r="2.3" />
      <circle cx="10" cy="17" r="2.3" />
      <path d="M9 8.1 15 8.9M8.5 9 9.2 14.8M12 16.2 15.2 11" />
    </>
  ),
  // Teams: persona + burbuja de conversación.
  teams: (
    <>
      <circle cx="9" cy="8.5" r="2.4" />
      <path d="M4.5 18a4.5 4.5 0 0 1 9 0" />
      <path d="M14.5 6.5h4a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H18l-2 2v-2h-1.5" />
    </>
  ),
  // Graph: nodos y aristas (grafo de directorio).
  graph: (
    <>
      <circle cx="6" cy="8" r="1.8" />
      <circle cx="18" cy="6.5" r="1.8" />
      <circle cx="16.5" cy="18" r="1.8" />
      <circle cx="7.5" cy="17" r="1.8" />
      <path d="M7.6 8.9 16.4 7M7.2 9.6l.1 5.6M9 16.6l5.8.7M17.7 8.2l-.9 8M7.6 8.9l8.3 7.6" />
    </>
  ),
  // Wazuh: escudo SIEM con pulso de telemetría.
  wazuh: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7-7 9-4.1-2-7-4.8-7-9V6Z" />
      <path d="M7.5 12h2l1.2-3 1.8 6 1.3-3h2.7" />
    </>
  ),
  // Navegador (Chrome): círculo con ventana y centro.
  browser: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.8v5.2M14.6 13.5l4.5 2.6M9.4 13.5 4.9 16.1" />
    </>
  ),
  // Cloudflare: nube (borde/entrega).
  cloudflare: (
    <>
      <path d="M8 17h9a3 3 0 0 0 .3-6 4.6 4.6 0 0 0-8.7-1.3A3.4 3.4 0 0 0 8 17Z" />
      <path d="M8 17H6.2a2.7 2.7 0 0 1-.2-5.4" />
    </>
  ),
  // Vercel: triángulo (despliegue frontend).
  vercel: <path d="M12 5 20 19H4Z" />,
  // Railway: vías con durmientes (plataforma de despliegue).
  railway: (
    <>
      <path d="M9 4v16M15 4v16" />
      <path d="M6 8h12M6 12h12M6 16h12" />
    </>
  ),
  // Ventana / app genérica.
  window: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9h16" />
      <circle cx="6.8" cy="7" r="0.5" />
      <circle cx="8.8" cy="7" r="0.5" />
    </>
  ),
  // Fuente / feed de eventos.
  source: (
    <>
      <path d="M5.5 12a6.5 6.5 0 0 1 6.5 6.5M5.5 7.5A11 11 0 0 1 16.5 18.5" />
      <circle cx="6" cy="18" r="1.1" />
    </>
  ),
};

export function SocBrandMark({
  name,
  size = 18,
  title,
}: {
  readonly name: BrandMarkName;
  readonly size?: number;
  readonly title?: string;
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
