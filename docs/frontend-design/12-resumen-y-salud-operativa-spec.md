# 12 · Especificación intensiva — «Resumen SOC» y «Salud operativa»

**Estado:** especificación de diseño e implementación, calcable 1:1. Escrita contra el código
real del **2026-10-13** (`apps/web/src/components/soc/SocSummaryPage.tsx`,
`OperationsHealthPage.tsx`, `soc-data-ui.tsx`, `soc-ui.tsx`, y los CSS
`soc-data.css`, `soc-shell.css`, `soc-responsive.css`).
**Alcance:** detalla de punta a punta las dos vistas de apertura de la consola: `/` (Resumen) y
`/operations` (Salud operativa). No redefine el sistema: **toda medida, token, clase y
breakpoint es textual del código**.

> **Fuente de verdad.** Tokens, escala tipográfica, breakpoints y principios se heredan de
> [`11-mi-sesion-y-shell-spec.md`](11-mi-sesion-y-shell-spec.md) §0–§2 y §5, y de
> [`10-vistas-por-rol-y-referencias.md`](10-vistas-por-rol-y-referencias.md). Aquí **no** se
> vuelven a definir; se referencian y se aplican. Escala de espaciado `--space-1..12` =
> 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 px; radios literales 6 / 9 / 999 px; colores
> `--surface-*`, `--text-*`, `--border-*`, `--state-*`, `--sev-*`, `--brand-amber`.
> Donde el código usa un literal fuera de la escala del doc 11 (p. ej. `radius: 8px`,
> `gap: 14px`, `28px`), se marca como **(literal del código, no en la escala)** para que el
> calco sea exacto y la deuda quede registrada, no disimulada.

> **Nota de honestidad de implementación.** El doc 04 §1 describe un Resumen con secciones
> «Mi cola», «Críticas sin acuse», «Alertas por prioridad», etc. El componente **real** hoy
> no implementa esa composición: renderiza una franja de estado + una rejilla de hasta 5
> paneles (alertas, notificaciones, incidentes, integridad, actividad). Esta spec documenta
> **lo implementado**, y marca lo del doc 04 que sigue **pendiente/no implementado**.

---

## `/` «Resumen SOC»

**Propósito (1 línea):** que la persona de turno vea en cinco segundos si la información es
confiable (franja de estado) y cuáles son las prioridades abiertas, sin inventar salud ni
tendencias.

**Componente:** `SummaryPage` exportado desde
`apps/web/src/components/soc/SocSummaryPage.tsx` (re-export en `SocDataViews.tsx` →
`SocWorkspaceViews.tsx` para `pathname === '/'`). Ruta `/`.

**Capabilities y roles (doc 10).** La ruta `/` **no exige** ninguna capability para entrar
(siempre navegable por cualquier sesión autenticada). Cada panel se renderiza **solo** si su
capability está en `session.capabilities` (patrón «ausente, no deshabilitado», doc 06 Z2):

| Panel | Capability requerida | Roles que lo ven (doc 10) |
| --- | --- | --- |
| Título «Resumen de operación» (vs «Estado de la operación») | `alerts.read` presente ⇒ «Resumen de operación»; ausente ⇒ «Estado de la operación» | Analista, lead, admin |
| Alertas activas | `alerts.read` | Analista, lead, platform admin |
| Notificaciones pendientes | `notifications.read` | Analista, lead, admin |
| Incidentes activos | `incidents.read` | Analista, lead, auditor, admin |
| Integridad de auditoría | `audit.verify` | Auditor, admin (el lead **no** la tiene, doc 10) |
| Actividad de auditoría | `audit.read` | Lead, auditor, admin |
| Franja: chip de Integridad | `audit.verify` **y** `integrity` cargada | igual que panel Integridad |

La franja «Estado de la operación» (API + Ingesta) se muestra **siempre**, sin capability.

### Anatomía (clases reales `soc-*`)

```
┌─ div.soc-page ──────────────────────────────────────────────────────────────┐
│ ┌─ div.soc-page-heading (PageHeader) ──────────────────────────────────────┐ │
│ │ <div> h1 {título}                      ┌ div.soc-page-heading__meta ────┐ │ │
│ │       p  Prioridades del turno…        │ span "Actualizado <time>"      │ │ │
│ │                                        │ Button(soc-button) ⟳ Actualizar│ │ │
│ │                                        └────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ div.soc-operation-strip (franja de estado, ancho completo) ─────────────┐ │
│ │ <div> [StatusChip API]  <span> disponibilidad / referencia…              │ │
│ │ <div> [StatusChip neutral «Ingesta sin datos de salud»] <span> …         │ │
│ │ <div> [StatusChip Integridad]  <span> N eventos verificados   (opcional) │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ div.soc-summary-grid (2 columnas) ──────────────────────────────────────┐ │
│ │ ┌ section.soc-panel ─────────────┐  ┌ section.soc-panel ─────────────┐    │ │
│ │ │ header.soc-panel__header       │  │ header.soc-panel__header       │    │ │
│ │ │  h2 «Alertas activas · N»  [⟶] │  │  h2 «Notificaciones…»      [⟶] │    │ │
│ │ │ div.soc-compact-list           │  │ div.soc-compact-list           │    │ │
│ │ │  button(fila)× ≤6:             │  │   --notifications × ≤5:        │    │ │
│ │ │   [Severity][strong][State][t] │  │   [StatusChip][span][time]     │    │ │
│ │ └────────────────────────────────┘  └────────────────────────────────┘    │ │
│ │ ┌ Incidentes activos ────────────┐  ┌ Integridad de auditoría ───────┐    │ │
│ │ │ div.soc-compact-list × ≤5      │  │ div.soc-integrity-summary      │    │ │
│ │ └────────────────────────────────┘  └────────────────────────────────┘    │ │
│ │ ┌ Actividad de auditoría ────────┐                                         │ │
│ │ │ div.soc-activity-list          │   ← sin regla CSS dedicada (ver tabla)  │ │
│ │ └────────────────────────────────┘                                         │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Tabla elemento → clase CSS → medidas → token de color

| Elemento | Clase / selector | Medidas reales (código) | Color (token) |
| --- | --- | --- | --- |
| Contenedor de página | `.soc-page` | `position:relative; min-width:0`; animación `soc-view-enter 180ms var(--ease-out)` | — |
| Cabecera | `.soc-page-heading` | `display:flex; min-height:48px; align-items:flex-start; justify-content:space-between; gap:var(--space-6)=24px; margin:0 0 var(--space-6)` | — |
| H1 | `.soc-page-heading h1` | `font-size:20px; weight:480; letter-spacing:-0.025em; line-height:28px` | `--text-1` |
| Descripción | `.soc-page-heading p` | `margin:4px 0 0; font-size:13px` | `--text-2` |
| Meta + acción | `.soc-page-heading__meta` | `display:flex; align-items:center; gap:14px` (literal); `font-size:12px; white-space:nowrap` | `--text-3` |
| Botón «Actualizar» | `.soc-button.soc-button--secondary` | `min-height:40px; padding:0 14px; radius:999px; border:1px solid var(--border-control); font-size:13px/550; gap:8px` | `--text-1` sobre `transparent`; hover `--surface-2` + `--border-control-hover` |
| Icono ⟳ | `SocIcon name="refresh"` (default `size=18`) | `viewBox 0 0 24; strokeWidth 1.65` | `currentColor` |
| Franja de estado | `.soc-operation-strip` | `display:flex; flex-wrap:wrap; gap:10px 28px` (28px literal); `min-height:54px; margin-bottom:20px; padding:8px 12px; border:1px solid var(--border-default); radius:9px` | `background:--surface-1` |
| Ítem de franja | `.soc-operation-strip > div` | `display:flex; align-items:center; gap:9px` (literal) | — |
| Texto secundario de ítem | `.soc-operation-strip > div > span:last-child` | `font-size:12px` | `--text-3` |
| Chip de estado | `.soc-status` + `.soc-status--{ok\|warn\|fail\|info\|neutral}` | `min-height:22px; gap:6px; padding:1px 8px; border:1px solid var(--border-default); radius:999px; font-size:12px` | base `--text-2`; `--ok`=`--state-ok`, `--warn`=`--state-warn`, `--fail`=`--state-fail`, `--info`=`--state-info`, `--neutral`= hereda base (`--text-2`) |
| Glifo del chip | `.soc-status__mark` | `width/height:14px; border:1px solid currentColor; radius:50%; font-size:9px` | `currentColor`; símbolos `✓ ! × i –` por estado |
| Rejilla de paneles | `.soc-summary-grid` | `grid-template-columns:repeat(2, minmax(0,1fr)); gap:14px` (literal); `align-items:start` | — |
| Panel | `.soc-panel` | `min-width:0; border:1px solid var(--border-default); radius:9px` | `background:--surface-1` |
| Cabecera de panel | `.soc-panel__header` | `display:flex; min-height:44px; align-items:center; justify-content:space-between; gap:10px; padding:0 14px; border-bottom:1px solid var(--border-default)` | — |
| H2 de panel | `.soc-panel__header h2` | `font-size:15px; weight:550; letter-spacing:-0.01em` | `--text-1` |
| Contador en h2 | texto `· N` dentro del `title` del `Panel` | tabular-nums global | `--text-1` |
| Enlace de acción | `.soc-text-link` | `display:inline-flex; gap:5px; padding:0; border:0; background:transparent` | `--text-2`; hover `--text-1` |
| Icono flecha | `SocIcon name="arrow" size={14}` | `14px` | `currentColor` |
| Lista compacta | `.soc-compact-list` | `display:grid` (apila filas) | — |
| Fila compacta (alertas/incidentes) | `.soc-compact-list > button` | `display:grid; grid-template-columns:90px minmax(0,1fr) 136px 84px; min-height:40px; align-items:center; gap:10px; padding:5px 14px; border-bottom:1px solid var(--border-subtle)` | `--text-2`; hover `--surface-2`; último sin borde |
| Título de fila | `.soc-compact-list strong` | `overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:400` | `--text-1` |
| Hora de fila | `.soc-compact-list time` | `text-align:right; font-size:12px` | `--text-3` |
| Severidad | `.soc-severity` + `.soc-severity--{1..4}` | `gap:5px`; glifo `span` 10px; `strong` 12px/600; `small` 11px | `--sev-1..4`; `small`=`--text-3`; glifos `◆ ▲ ■ ●` |
| Estado (chip de fila) | `StateCell` → `.soc-status--…` | ver chip | según `statusState()` |
| Fila de notificaciones | `.soc-compact-list--notifications > div` | `grid-template-columns:1fr 1fr 80px` (resto igual a fila compacta) | `--text-2`; `span:nth-child(2)`=`--text-2` |
| Resumen de integridad | `.soc-integrity-summary` | `margin:14px` | — |
| Texto de integridad | `.soc-integrity-summary p` | `margin:10px 0 3px` | `--text-1` |
| Nota de integridad | `.soc-integrity-summary small` | — | `--text-3` |
| Lista de actividad | `.soc-activity-list` | **sin regla CSS dedicada** → flujo de bloque por defecto (pendiente: no hay grilla/separadores). Cada ítem es un `div` con `RelativeTime` + `strong` (acción) + `span` (outcome · actor). | hereda `--text-2` |
| Placeholder de carga | `.soc-table-placeholder` (dentro de `.soc-panel`) | `padding:20px; text-align:center`; margen `14px` por `.soc-panel > .soc-table-placeholder` | `--text-3` |
| Vacío | `.soc-empty` | `min-height:76px; place-items:center; padding:20px`; margen `14px` por `.soc-panel > .soc-empty` | `--text-2` |
| Error | `.soc-error` | `padding:14px; border:1px solid rgb(255 95 87 /45%); radius:8px; background:#120d0d`; margen `14px` | `--text-1`; marca `--state-fail` |

**Severidad por rótulo + forma + color** (doc 11 §0.3): `Severity` imprime glifo (`◆▲■●`) +
rótulo (`P1..P4`) + color `--sev-n`, nunca solo color.

### Interacciones

- **Refresco en vivo.** No hay `setInterval` en esta vista. Usa **`useChanges`** (long-poll de
  `GET /api/changes`, `apps/web/src/components/soc/use-changes.ts`) con
  `resourceTypes: ['alert','incident','notification']`; cualquier cambio dispara `refresh()`
  completo. El feed **se pausa** si la pestaña está oculta (`visibilitychange` aborta la
  petición) y **reintenta con backoff exponencial** `min(1000·2^n, 30 000) ms` tras fallo.
  > Discrepancia honesta con doc 06 §7 (que pide 15 s para Resumen): **no hay intervalo fijo
  > de 15 s**; el refresco es dirigido por eventos de `/api/changes`. Registrar, no simular.
- **Refresco manual.** `Button` «Actualizar» → `refresh()`. `refresh()` relee `health`, y por
  capability: `alertsByStatus('open')`, `incidents(undefined,'active')`, `notifications()`,
  `verifyAudit()`, `audit(últimas 24 h)` (toma `slice(-8).reverse()`). El sello
  «Actualizado hace N s» (`updated`) **solo** se fija si **todas** las tareas fueron exitosas
  (`complete === true`): honestidad de frescura.
- **Navegación a detalle.** Fila de alerta → `onNavigate('/alerts/:id')`; fila de incidente →
  `/incidents/:id`; enlaces de acción → `/alerts`, `/notifications`, `/incidents`,
  `/audit/integrity`, `/audit`.
- **Filtros:** no hay filtros en esta vista.
- **Confirmaciones (doc 06 §6):** esta vista **no** ejecuta comandos mutantes; «Acusar» en
  línea (nivel 2) descrito por doc 04 §1 está **pendiente/no implementado** aquí.

### Estados (render exacto por panel)

- **Cargando** (`loading && !errores`): `<div class="soc-table-placeholder">Cargando alertas…</div>`
  (o «…notificaciones…», «…incidentes…», «…actividad…»). Integridad no tiene placeholder:
  si aún no hay `integrity`, muestra `EmptyState` «Verificación pendiente.».
- **Vacío** (200, lista vacía): `.soc-empty` con texto literal por panel:
  - Alertas: «No hay alertas activas en la consulta completa.»
  - Notificaciones: «No hay notificaciones pendientes de acuse en las entregas consultadas.»
  - Incidentes: «No hay incidentes activos en la consulta completa.»
  - Actividad: «Sin actividad de auditoría en las últimas 24 horas.»
- **Vacío por filtros:** no aplica (sin filtros de cliente en esta vista).
- **Parcial:** el contador del título usa `totalCount ?? items.length`; las listas muestran
  `slice(0,6)` (alertas) / `slice(0,5)` (notificaciones, incidentes) / `slice(-8)` (actividad).
  **No existe** `.soc-partial-banner` en esta vista (está definido en `soc-data.css`:
  `margin-bottom:10px; padding:8px 11px; border:1px solid var(--border-default); radius:6px;
  color:var(--state-info)`), pero **no se renderiza aquí**: pendiente conectar el aviso
  «página consultada» a un banner real. El título de Notificaciones ya rotula
  «· página consultada» como mitigación textual.
- **Degradado:** la franja fija «Ingesta sin datos de salud» (chip `neutral`) declara que **no
  hay API de cobertura del pipeline**; nunca se pinta «OK» por ausencia de error (doc 06
  regla de honestidad). No hay `DegradedBanner` en esta vista.
- **Viejo / stale:** si un refresco falla, `updated` **no** se actualiza (queda el último sello
  válido); los datos previos permanecen en estado. No hay `StaleDataBanner` dedicado
  (pendiente): la señal de obsolescencia es que «Actualizado hace N s» deja de crecer tras un
  error y aparece `ErrorState` en el panel afectado.
- **Error** (fallo sin datos): `ErrorState` **dentro del panel afectado**
  (`errors.{alerts|notifications|incidents|integrity|activity}`), con **`correlationId`
  SIEMPRE** (`<code>{correlationId}</code>` + botón copiar `.soc-copy-reference`, feedback
  «Copiada» 1.5 s) y botón «Reintentar» → `refresh()`. Un panel que falla **no** tumba a los
  demás (aislamiento por `errors` por clave). La franja de API muestra
  `No se pudo consultar · referencia {correlationId}` cuando `errors.health` existe.
- **Sin capability:** el panel **no se renderiza** (condicional `session.capabilities.includes`).
  **Ausente, no deshabilitado** (doc 06 Z2); sin placeholders grises ni «sin permiso».

### Responsividad (3 breakpoints reales de `soc-responsive.css`)

- **≥1101px (escritorio):** riel 232px (según toggle, doc 11 §2.1). `.soc-summary-grid` en
  **2 columnas** (`repeat(2, minmax(0,1fr))`, gap 14px). Franja en fila. Filas compactas con
  rejilla `90px 1fr 136px 84px`.
- **≤1100px (tablet):** riel **forzado a 56px** (`--rail-width:56px`; se ocultan `__name`, `h2`,
  `span` de ítems y texto de «Contraer»). `.soc-summary-grid` → **1 columna**
  (`grid-template-columns:1fr`). La franja conserva su layout. Las filas compactas **no**
  cambian su rejilla en este umbral.
- **≤760px (móvil):** Topbar 50px, padding `0 12px`; perfil solo-avatar (`.soc-profile__name`
  y chevron ocultos); «Ir a» (`.soc-command-button`) → cuadrado **44×44** solo-icono;
  `.soc-status` máx 145px truncado. Workspace padding `17px 12px`.
  `.soc-operation-strip` → **columna** (`flex-direction:column; align-items:flex-start;
  gap:8px`) y cada `> div` con `flex-wrap:wrap`. Filas compactas de alertas/incidentes →
  `grid-template-columns:78px minmax(90px,1fr) 94px` y **se oculta la `time`**
  (`.soc-compact-list > button time {display:none}`). Notificaciones →
  `grid-template-columns:1fr 1fr` con `time` en `grid-column:2`. `.soc-page-heading` apila
  (`align-items:flex-start; gap:10px`) y `.soc-page-heading__meta` pasa a `grid; justify-items:end`.
  Controles táctiles `.soc-button` **≥44px**; inputs a 16px (no hay inputs en esta vista).

### Micro-detalles

- **tabular-nums** es global (`.soc-app`, doc 11 §1.5): contadores («· N»), scores y horas
  alinean cifras. No sobreescribir.
- **Ámbar solo en selección** (riel). El contenido del Resumen **no usa `--brand-amber`**.
- **Sin sombras de tarjeta, sin gradientes, sin glow** (doc 10/11): paneles separados por
  `--surface-1` + `--border-default`. Única sombra permitida: anillo de foco.
- **Severidad por rótulo + forma + color** (nunca solo color).
- **Baseline / alineación:** filas compactas `align-items:center`; título con elipsis a 1 línea
  (`white-space:nowrap`). Chips alinean su glifo circular a 14px.
- **Checks/íconos** siempre `SocIcon` propio (`strokeWidth 1.65`), nunca packs genéricos.

### Prohibido (recordatorio doc 10 «Lo que el diseño debe evitar»)

- KPIs/tarjetas vacías sin explicación; tendencias calculadas desde una página parcial
  (por eso **no hay gráficos** en Resumen).
- «online»/verde por **ausencia de error**; cero ≠ sano (la franja de ingesta lo dice).
- Controles sin acción conectada; errores sin instrucción o sin `correlationId`.
- Inglés suelto: «capabilities» ya se traduce «capacidades» en el resto del sistema; aquí usar
  español en todo rótulo.

### Checklist de aceptación — `/`

- [ ] El título cambia a «Estado de la operación» si la sesión **no** tiene `alerts.read`.
- [ ] La franja muestra SIEMPRE «Ingesta sin datos de salud» en chip `neutral`, nunca «OK».
- [ ] Cada panel aparece **solo** con su capability; sin botones grises «sin permiso».
- [ ] `updated` («Actualizado hace N s») solo avanza cuando **todas** las tareas fueron OK.
- [ ] Un panel con error muestra `ErrorState` con `correlationId` copiable + «Reintentar», y
      **no** derriba a los demás paneles.
- [ ] Rejilla 2 col ≥1101px → 1 col ≤1100px → filas sin `time` ≤760px, sin recortes de layout.
- [ ] Cero ámbar fuera del riel; cero sombras de tarjeta; cero texto en inglés.
- [ ] El refresco en vivo se pausa con la pestaña oculta y reintenta con backoff.

### Trazabilidad — `/`

- Componente: `apps/web/src/components/soc/SocSummaryPage.tsx` (`SummaryPage`).
- Soporte: `soc-data-ui.tsx` (`PageHeader`, `Panel`, `StateCell`, `statusLabel`),
  `soc-ui.tsx` (`StatusChip`, `Severity`, `SocIcon`, `ErrorState`, `EmptyState`, `RelativeTime`,
  `Button`), `use-changes.ts`.
- Clases: `.soc-page`, `.soc-page-heading(__meta)`, `.soc-operation-strip`, `.soc-summary-grid`,
  `.soc-panel(__header)`, `.soc-compact-list(--notifications)`, `.soc-severity`,
  `.soc-status(--*)`, `.soc-integrity-summary`, `.soc-activity-list`, `.soc-text-link`,
  `.soc-empty`, `.soc-error`, `.soc-table-placeholder` (en `soc-data.css` / `soc-shell.css`).
- Ruta/gating: `SocWorkspaceViews.tsx` (línea 58), nav `SocConsole.tsx`.
- Docs: 04 §1, 06 §2–§4 y §7, 10 (composición por rol), 11 (tokens/shell).

---

## `/operations` «Salud operativa»

**Propósito (1 línea):** mostrar la frescura de la señal de alertas y el estado de los
servicios que sostienen la operación (flujo SOC, plataforma), con secciones que el servidor
entrega según permiso.

**Componente:** `OperationsHealthPage`
(`apps/web/src/components/soc/OperationsHealthPage.tsx`), re-export en `SocDataViews.tsx` →
`SocWorkspaceViews.tsx` para `pathname === '/operations'`. Ruta `/operations`.

**Capabilities y roles (doc 10).** La **ruta** exige **`alerts.read`**
(`SocWorkspaceViews.tsx` línea 35; ítem de nav con `capability:'alerts.read'`). **El auditor
no la ve** (no tiene `alerts.read`). **Qué secciones llegan** lo decide el **servidor** según
`observability.read_soc` (sección «Flujo SOC») y `observability.read_platform` (sección
«Plataforma»): la `summary` llega a quien pasa el gate de ruta; `sections.soc` y
`sections.platform` solo si el token las incluye.

| Sección | Gate | Roles de referencia (doc 10) |
| --- | --- | --- |
| `summary` (Señal de alertas) | ruta `alerts.read` | Analista, lead, platform admin |
| `sections.soc` (Flujo SOC) | servidor: `observability.read_soc` | Lead, platform admin |
| `sections.platform` (Plataforma) | servidor: `observability.read_platform` | Platform admin |

> Nota: el componente **no** comprueba `observability.*` en cliente; renderiza cada `section`
> solo si viene en la respuesta (`result?.sections.soc ? … : null`). La autorización es
> server-side (doc 06 Z1).

### Anatomía (clases reales `soc-*`)

```
┌─ div.soc-page.soc-operations-health (grid, gap 14px) ──────────────────────────┐
│ ┌─ div.soc-page-heading (PageHeader) ───────────────────────────────────────┐ │
│ │ h1 «Salud operativa»  · p …          meta: "Actualizado <time>" + ⟳ Actual.│ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ (p.soc-page-note «Consultando estado operativo…»  ← solo carga inicial)        │
│ (div.soc-error  ← si error, con correlationId)                                 │
│ ┌─ section.soc-health-summary (grid 3 col) ─────────────────────────────────┐ │
│ │ <div> h2 «Señal de alertas» + p (última alerta / sin señal)               │ │
│ │ [HealthStatus chip]                                                        │ │
│ │ <dl> ⟨Antigüedad última alerta⟩ ⟨Cobertura de fuentes⟩                     │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ section.soc-health-section (Flujo SOC) ──────────────────────────────────┐ │
│ │ <header> div(h2+p) ───────────────── [HealthStatus chip]                  │ │
│ │ <dl.soc-health-facts> Persistencia · Despachador · Outbox pend. ·         │ │
│ │                        En procesamiento · Antigüedad pendiente más viejo  │ │
│ │ <ul.soc-health-reasons> (si degradedReasons)                              │ │
│ │ <div.soc-health-counts> h3 + <ul> (intentos por estado, si hay)           │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ section.soc-health-section (Plataforma) ─────────────────────────────────┐ │
│ │ <header> div(h2+p) ───────────────── [HealthStatus chip]                  │ │
│ │ <dl.soc-health-facts> Base de datos · Memoria · Tiempo activo · Runtime   │ │
│ │ <ul.soc-health-reasons> (si degradedReasons)                              │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ p.soc-health-footnote «Vista agregada. Los eventos y registros…»               │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Tabla elemento → clase CSS → medidas → token de color

| Elemento | Clase / selector | Medidas reales (código) | Color (token) |
| --- | --- | --- | --- |
| Contenedor | `.soc-page.soc-operations-health` | `display:grid; gap:14px` (literal) | — |
| Cabecera / H1 / meta | `.soc-page-heading` (ver tabla de `/`) | idéntico | `--text-1` / `--text-2` / `--text-3` |
| Botón «Actualizar/Actualizando» | `.soc-button--secondary` + `disabled` cuando `loading\|\|refreshing` | `min-height:40px`; `:disabled{opacity:0.55}`; icono `refresh size=15` | `--text-1`; disabled atenuado |
| Nota de carga | `.soc-page-note` | `font-size:12px; margin:0`; `role="status"` | `--text-3` |
| Error | `.soc-error` (ver `/`) | `padding:14px; border rgb(255 95 87 /45%); radius:8px; background:#120d0d` | `--text-1`; marca `--state-fail` |
| Tarjeta resumen | `.soc-health-summary` | `display:grid; grid-template-columns:minmax(180px,1fr) auto minmax(250px,0.8fr); align-items:center; gap:20px; padding:18px; border:1px solid var(--border-default); radius:8px` (8px literal) | `background:--surface-1` |
| H2 (resumen/sección) | `.soc-health-summary h2`, `.soc-health-section h2` | `font-size:14px; weight:560` | `--text-1` |
| Párrafo | `.soc-health-summary p`, `.soc-health-section header p` | `margin:5px 0 0; font-size:12px` | `--text-3` |
| Chip de salud | `HealthStatus` → `.soc-status--{tone}` | chip estándar (22px, radius 999px) | `OK`→`--state-ok`; `STALE`→`--state-warn`; `DEGRADED`→`--state-fail`; `NO_DATA`→neutral (`--text-2`); resumen OK usa tono `info`=`--state-info` con rótulo «Señal encontrada» |
| `dl` del resumen / hechos | `.soc-health-summary dl`, `.soc-health-facts` | `display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 20px; margin:0` (facts además `padding:14px 0 2px`) | — |
| `dt` | `.soc-health-summary dt`, `.soc-health-facts dt` | `font-size:11px` | `--text-3` |
| `dd` | `.soc-health-summary dd`, `.soc-health-facts dd` | `font-size:13px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; min-width:0; margin:0` | `--text-1` |
| Sección (SOC/Plataforma) | `.soc-health-section` | `padding:16px 18px; border:1px solid var(--border-default); radius:8px` | `background:--surface-1` |
| Header de sección | `.soc-health-section > header` | `display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding-bottom:14px; border-bottom:1px solid var(--border-subtle)` | — |
| Motivos degradados (lista) | `.soc-health-reasons` | `display:flex; flex-wrap:wrap; gap:6px; margin:14px 0 0; list-style:none` | — |
| Motivo (ítem) | `.soc-health-reasons li` | `padding:5px 8px; border-left:2px solid var(--status-warn,#c18a36); background:var(--surface-2); font-size:11px` | `--text-2`; borde `--status-warn` (fallback `#c18a36`) |
| Bloque de conteos | `.soc-health-counts` | `margin-top:16px; padding-top:14px; border-top:1px solid var(--border-subtle)` | — |
| H3 de conteos | `.soc-health-counts h3` | `margin:0 0 9px; font-size:12px; weight:550` | `--text-2` |
| Lista de conteos | `.soc-health-counts ul` | `display:flex; flex-wrap:wrap; gap:8px 18px; list-style:none` | — |
| Ítem de conteo | `.soc-health-counts li` | `display:flex; gap:8px; font-size:12px` | `--text-3`; `strong`→`--text-1` (tabular-nums) |
| Nota al pie | `.soc-health-footnote` | `margin:0; font-size:11px` | `--text-3` |

**Catálogos de texto (código, no inventar):**
`statusCopy`: `OK`→«Operativo»/ok · `NO_DATA`→«Sin datos»/neutral · `STALE`→«Atrasado»/warn ·
`DEGRADED`→«Degradado»/fail.
`reasonCopy`: `DISPATCHER_STOPPED`→«Despachador detenido» · `OUTBOX_BACKLOG`→«Cola pendiente por
más de 5 minutos» · `PERSISTENCE_EPHEMERAL`→«Persistencia en memoria; los datos no sobreviven un
reinicio» · `DATABASE_UNAVAILABLE`→«Base de datos sin respuesta» · `DATABASE_SLOW`→«Base de datos
sobre el umbral de latencia». Motivo desconocido → «Condición degradada».
`ageLabel(null)` → «Sin actividad registrada»; `<60s`→`N s`; `<1h`→`N min`; `<1d`→`N h`; resto `N d`.

### Interacciones

- **Refresco en vivo:** `window.setInterval(load, 60_000)` (**60 s**, intervalo real del código)
  + carga inicial `load(true)`. Guardia `inFlight` evita solapamientos; `active` evita setState
  tras desmontaje. (No se pausa por visibilidad en esta vista; diferencia honesta frente a `/`.)
- **Refresco manual:** `Button` «Actualizar» → `refresh()`; mientras tanto `disabled` y copia
  «Actualizando». El sello «Actualizado hace N s» usa `result.generatedAt`.
- **Navegación a detalle:** no hay enlaces a detalle; la nota al pie recuerda que eventos y
  auditoría conservan sus permisos propios.
- **Filtros / confirmaciones:** ninguno (vista de solo lectura; sin comandos, doc 06 §6 no aplica).

### Estados (render exacto)

- **Cargando (inicial):** `loading && !result` → `<p class="soc-page-note" role="status">
  Consultando estado operativo…</p>`. No hay `Skeleton`.
- **Vacío / sin datos:** honestidad por campo, no sección vacía:
  - Señal: si `!summary.lastAlertAt` → «No hay alertas para calcular frescura.» y
    `ageLabel(null)` → «Sin actividad registrada».
  - Cobertura `NO_DATA` → chip neutral «Sin datos» (doc 10: queda `NO_DATA` hasta C-5).
  - Plataforma: `databaseLatencyMs===null`→«Sin respuesta»; `memoryRssMb===null`→«Sin dato»;
    `nodeVersion ?? 'Sin dato'`.
  - Conteos: el bloque `.soc-health-counts` **solo** se renderiza si
    `Object.keys(byStatus).length > 0` (cero intentos ⇒ no se dibuja, no se finge actividad).
- **Vacío por filtros:** no aplica.
- **Parcial:** las métricas de proceso «pueden venir sin dato» (doc 10): se muestran «Sin dato»
  por campo, no se omite la fila. Intentos de notificación se agregan por estado en ventana
  `windowHours` (rótulo «Intentos por estado · últimas N h»).
- **Degradado:** la sección trae `status` (`DEGRADED`→chip fail / `STALE`→warn) y, si hay,
  `.soc-health-reasons` con los motivos traducidos (borde izquierdo `--status-warn`). El estado
  degradado se muestra **además** del contenido (no reemplaza los hechos).
- **Viejo / stale:** estado `STALE` → chip «Atrasado» `--state-warn`. Si un refresco de fondo
  falla, se conserva `result` previo (no se limpia) y se pinta `ErrorState` arriba; el sello
  `generatedAt` deja de avanzar (señal de obsolescencia).
- **Error (sin datos):** `ErrorState` con **`correlationId` SIEMPRE** (copiable) + «Reintentar»
  → `refresh()`. Si `result` ya existía, el error se muestra encima y se mantienen las secciones.
- **Sin capability:** sin `alerts.read`, `SocWorkspaceViews` devuelve `UnavailablePage`
  («No disponible», con acción «Ir al resumen»); el ítem de nav **no se renderiza**
  (ausente, no deshabilitado). Sin `observability.read_soc`/`read_platform`, esas secciones
  simplemente no llegan y **no se dibujan**.

### Responsividad (3 breakpoints reales)

- **≥1101px (escritorio):** riel 232px (según toggle). `.soc-health-summary` en **3 columnas**
  (`minmax(180px,1fr) auto minmax(250px,0.8fr)`, gap 20px, padding 18px). `dl` de resumen y
  `.soc-health-facts` en **2 columnas** (`repeat(2,minmax(0,1fr))`, gap 12px 20px).
- **≤1100px (tablet):** riel **forzado a 56px**. `.soc-health-summary` →
  `grid-template-columns:minmax(0,1fr) auto` (2 columnas: texto + chip) y su `dl` pasa a
  `grid-column:1 / -1` (ocupa todo el ancho, debajo). `.soc-health-facts` sigue 2 columnas.
- **≤760px (móvil):** Topbar 50px; workspace padding `17px 12px`. `.soc-health-summary` →
  **1 columna** (`minmax(0,1fr)`, `align-items:start; gap:12px; padding:14px`); su `dl` y
  `.soc-health-facts` → `grid-template-columns:1fr 1fr` (2 col fijas). `.soc-health-section`
  padding `14px`. `.soc-page-heading` apila y `__meta` a `grid; justify-items:end`. Controles
  táctiles `.soc-button` **≥44px**. No hay inputs (no aplica regla de 16px, aunque el shell la
  impone a inputs globales).

### Micro-detalles

- **tabular-nums** en `dd` de resumen/hechos y en `strong` de conteos: latencias, MB, segundos
  y conteos alinean cifras.
- **Severidad/estado por rótulo + forma + color:** `HealthStatus` imprime glifo (`✓ ! × i –`) +
  rótulo en español + color de estado; nunca color solo.
- **Ámbar solo en selección** (riel); el contenido de `/operations` no usa `--brand-amber`.
- **Sin sombras, sin gradientes, sin glow:** secciones separadas por `--surface-1` +
  `--border-default`; motivos por borde-izquierdo 2px, no por relleno de color.
- **`overflow-wrap:anywhere`** en `dd` evita que un `nodeVersion`/latencia larga rompa el grid.
- **Baseline:** `header` de sección `align-items:flex-start` (h2 y chip alineados arriba).

### Prohibido (recordatorio doc 10)

- «online»/verde por ausencia de error: aquí el estado viene del servidor (`OK/STALE/DEGRADED/
  NO_DATA`), nunca inferido de «no hubo error».
- Cero = sano: `byStatus` vacío **no** dibuja conteos; cobertura `NO_DATA` no se pinta OK.
- KPIs vacíos / tendencias desde página parcial: no hay series ni gráficos aquí.
- Controles sin acción; errores sin `correlationId`.
- Inglés suelto: todo rótulo y motivo traducido por `statusCopy`/`reasonCopy`.

### Checklist de aceptación — `/operations`

- [ ] Sin `alerts.read` la ruta responde `UnavailablePage` y el ítem de nav no aparece.
- [ ] `sections.soc`/`sections.platform` se dibujan **solo** si vienen en la respuesta.
- [ ] Refresco automático cada **60 s** + carga inicial; «Actualizar» deshabilita y muestra
      «Actualizando».
- [ ] Cobertura `NO_DATA` → chip neutral «Sin datos» (nunca OK).
- [ ] `byStatus` vacío ⇒ **no** se renderiza `.soc-health-counts`.
- [ ] `databaseLatencyMs`/`memoryRssMb`/`nodeVersion` nulos ⇒ «Sin respuesta»/«Sin dato», no
      se omite la fila.
- [ ] Error siempre con `correlationId` copiable + «Reintentar»; conserva `result` previo.
- [ ] Resumen: 3 col ≥1101px → 2 col (dl a ancho completo) ≤1100px → 1 col (dl/facts 2 col)
      ≤760px; botones ≥44px en móvil.
- [ ] Cero ámbar fuera del riel; cero sombras; cero texto en inglés; tabular-nums en cifras.

### Trazabilidad — `/operations`

- Componente: `apps/web/src/components/soc/OperationsHealthPage.tsx`
  (helpers `HealthStatus`, `ageLabel`, `reasonLabels`; catálogos `statusCopy`, `reasonCopy`).
- Soporte: `soc-data-ui.tsx` (`PageHeader`, `statusLabel`), `soc-ui.tsx` (`StatusChip`,
  `Button`, `ErrorState`, `RelativeTime`, `SocIcon`); `api.operationsHealth()`.
- Clases: `.soc-operations-health`, `.soc-health-summary`, `.soc-health-section`,
  `.soc-health-facts`, `.soc-health-reasons`, `.soc-health-counts`, `.soc-health-footnote`,
  `.soc-page-note`, `.soc-status(--*)`, `.soc-error` (en `soc-data.css` / `soc-shell.css`;
  breakpoints en `soc-responsive.css`).
- Ruta/gating: `SocWorkspaceViews.tsx` (líneas 35, 59), nav `SocConsole.tsx` (línea 25).
- Docs: 04 §7 (salud/plataforma), 06 §3–§4 y §7, 10 (`/operations` por rol), 11 (tokens/shell).

---

## Deuda y literales a normalizar (registrar, no inventar como hechos)

- Literales fuera de la escala `--space-*`/radios del doc 11 usados en el código real:
  `gap:14px` (`.soc-summary-grid`, `.soc-operations-health`, `.soc-source-grid`),
  `gap:10px 28px` y `gap:9px` (`.soc-operation-strip`), `radius:8px` (tarjetas de salud),
  `gap:20px`/`padding:18px` (`.soc-health-summary`). Reemplazables por tokens al migrar a
  `src/design/tokens.css` (doc 06 §8, aspiracional).
- `.soc-activity-list` **no tiene regla CSS dedicada**: pendiente darle grilla/separadores
  coherentes con `.soc-compact-list`.
- `.soc-partial-banner` existe en CSS pero **no se usa** en el Resumen pese a que el doc 04 §1
  pide avisar «página consultada»/parcial: pendiente conectarlo.
- `--status-warn` / `--status-fail` (con fallback `#c18a36` / `#c46b5e`) aparecen junto a
  `--state-*`: unificar nomenclatura de tokens de estado.
- Composición del Resumen del doc 04 §1 (Mi cola, Críticas sin acuse con «Acusar» en línea,
  Alertas por prioridad, Actividad sensible) sigue **pendiente/no implementada** en el
  componente actual.
