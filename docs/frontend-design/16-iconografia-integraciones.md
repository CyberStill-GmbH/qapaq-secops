# 16 · Iconografía de integraciones y fuentes

**Estado:** especificación + implementación inicial (2026-10-13).
**Implementación:** `apps/web/src/components/soc/SocBrandMark.tsx` (`<SocBrandMark>`).

Complementa a `SocIcon` (glifos de UI). `SocBrandMark` cubre **marcas de integración / fuente**
(Microsoft, M365, Wazuh, navegador, etc.) para dar identidad visual a las fuentes sin usar los
logotipos registrados ajenos.

## Por qué SVG propio y no raster/IA

| Criterio | SVG monoline propio (elegido) | Raster/WebP/PNG o IA |
| --- | --- | --- |
| Peso | <1 KB por icono | 5–200 KB; pipeline de optimización |
| Escala | Nítido a cualquier tamaño/DPR | Pixela; requiere @1x/@2x/@3x |
| Tema | Hereda `currentColor` (claro/oscuro) | Color fijo; hay que duplicar assets |
| Consistencia | Mismo trazo (1.65) que `SocIcon` | Estilos dispares |
| Marca/legal | Abstracto, no copia logos registrados | Riesgo de usar el logo oficial |
| Regla del repo (doc 10) | ✅ «SVG propio revisado, sin packs» | ❌ packs/genéricos prohibidos |

Conclusión: para **iconos de UI**, SVG propio es el formato óptimo. El arte raster/ilustración
(si alguna vez se quiere para onboarding/marketing) es otro pipeline y otra superficie, no la
consola operativa.

## Sistema

- `viewBox 0 0 24 24`, `fill: none`, `stroke: currentColor`, `stroke-width: 1.65`,
  `linecap/linejoin: round` — idéntico a `SocIcon`.
- Tamaño por defecto 18px (`size` configurable). Hereda color del contexto: usar `--text-2`
  cuando la fuente está activa, `--text-3` en reposo/listas, `--text-4` si deshabilitada.
- **Color de marca: no.** La identidad la da la **forma**, no el color (coherente con el
  sistema: el color se gana). Nada de azules/naranjas de marca en la consola.
- Accesibilidad: con `title` → `role="img"` + `<title>`; sin `title` → `aria-hidden` (decorativo,
  acompañado de texto).

## Catálogo (`BrandMarkName`)

| name | Representa | Motivo visual | Dónde se usa |
| --- | --- | --- | --- |
| `microsoft` | Microsoft (suite) | 4 paneles redondeados | Encabezado de identidad / tenant |
| `m365` | Microsoft 365 | Nube + 3 puntos de suite | `/sources` fuente M365, `/settings` |
| `entra` | Entra ID / admisión | Escudo + persona | `/admin/users`, `/me` autenticación |
| `exchange` | Audit.Exchange | Sobre | `/sources` stream Exchange |
| `sharepoint` | Audit.SharePoint | Nodos enlazados | `/sources` stream SharePoint |
| `teams` | Teams / avisos | Persona + burbuja | Notificaciones, `/sources` |
| `graph` | Microsoft Graph | Grafo de nodos | Diagnóstico de padrón |
| `wazuh` | Wazuh Indexer | Escudo + pulso | `/sources` fuente Wazuh, `/events` |
| `browser` | Navegador (Chrome) | Círculo + ventana | Sesiones / origen de inicio |
| `cloudflare` | Cloudflare | Nube de borde | Pie/estado de plataforma (si se expone) |
| `vercel` | Vercel | Triángulo | Pie/estado de plataforma |
| `railway` | Railway | Vías | Pie/estado de plataforma |
| `window` | App genérica | Ventana | Fuente/integración sin marca propia |
| `source` | Feed de eventos | Ondas + punto | Encabezado de salud de fuentes |

> `Audit.AzureActiveDirectory` (stream M365) usa `entra`; `Audit.General` usa `source`.

## Uso en «Salud de fuentes» (`/sources`)

Cada fuente/suscripción lleva su marca a la izquierda del nombre, a `--text-3` (o `--state-*`
solo en el **chip de estado**, nunca en el icono). Ejemplo de fila:

```
[wazuh]  Wazuh Indexer · alertas            [× Fallida]
[m365 ]  Office 365 · Audit.Exchange        [– Sin eventos (24 h)]
```

El icono identifica la fuente; el **estado** sigue comunicándose por chip (rótulo + forma +
color `--state-*`), nunca por el color del icono. Cero eventos = chip neutral, no rojo.

## Reglas

1. No sustituir una etiqueta textual por el icono solo: icono **acompaña** al nombre.
2. No colorear los iconos con colores de marca. Si una fuente está degradada, el color va en
   el chip de estado adyacente, no en la marca.
3. No animar los iconos (respeta `prefers-reduced-motion`).
4. Revisar cada nuevo mark contra este sistema (trazo 1.65, 24×24, abstracto) antes de añadirlo.
5. No importar `react-icons` ni packs: todo mark vive en `SocBrandMark`.

## Pendiente / a revisar

- Alinear ópticamente cada glifo (peso visual uniforme) con los `SocIcon` existentes en una
  lámina de contacto antes de usarlos en producción.
- Si se expone un pie «infraestructura» con Cloudflare/Vercel/Railway, confirmar que es
  informativo y no sugiere relación comercial/endoso.
