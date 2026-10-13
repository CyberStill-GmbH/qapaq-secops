# 11 · Especificación intensiva — Shell SOC y vista «Mi sesión»

**Estado:** especificación de diseño e implementación, escrita contra el código real del
2026-10-13 (`apps/web/src/app/*.css` y `apps/web/src/components/soc/*`). Los valores de
tokens, breakpoints y clases son **textuales del código**, no aspiracionales.
**Alcance:** fija el rumbo visual y de responsividad del *shell* (riel + topbar + workspace)
que comparten todas las vistas, y detalla la vista `/me` («Mi sesión») de punta a punta,
incluyendo los defectos observados y su corrección.

> Fuente de verdad: los archivos CSS (`soc-shell.css`, `soc-overlays.css`,
> `soc-responsive.css`, `soc-data.css`) definen el estado actual. Donde el doc 06 §8 pide
> CSS Modules + `src/design/tokens.css`, eso es **aspiracional**: hoy el shell usa variables
> globales en `:root` de `soc-shell.css` y clases globales `soc-*`. Esta spec trabaja sobre
> el sistema real.

---

## 0 · Principios (no negociables)

Heredados de `10-vistas-por-rol-y-referencias.md` §«Dirección visual» y §«Lo que evitar»:

1. **Para turno, no para demo.** Densidad alta, escaneo veloz, foco en la tarea. Una vista de
   consulta (como `/me`) es densa y alineada, **no** un formulario aireado.
2. **Negro `#080808` + grises para jerarquía.** El color se gana: el ámbar `--brand-amber`
   (`#c49a5a`) es **solo** marca / selección / indicador activo. Nunca decorativo.
3. **Severidad y estado por rótulo + forma + color**, nunca solo color.
4. **Honestidad de estado.** Un valor ausente se muestra *como ausente* (atenuado / «sin
   dato»), jamás disfrazado de dato real. Cero ≠ sano; vacío ≠ ok.
5. **Autorización server-side.** La UI oculta lo que la capability no permite («ausente, no
   deshabilitado»); no enumera lo que no se tiene.
6. **Cero ruido:** sin glow/neón, sin gradientes de fondo, sin iconos de packs genéricos
   (solo los SVG propios de `SocIcon`), sin animación que no responda a una acción.
7. **Idioma: español.** Toda cadena visible en español, incluidos contadores y unidades.

---

## 1 · Tokens (valores reales, usar estos)

### 1.1 Superficies (fondo, de más oscuro a más claro)
| Token | Valor | Uso |
| --- | --- | --- |
| `--surface-rail` | `#050505` | Riel (el fondo más oscuro, ancla la izquierda) |
| `--surface-0` | `#080808` | Fondo de la app / workspace |
| `--surface-1` | `#0d0d0f` | Paneles / tarjetas |
| `--surface-2` | `#131315` | Ítem de nav activo, hovers de fila |
| `--surface-3` | `#1a1a1c` | Controles elevados, chips |
| `--surface-selected` | `#17140f` | Selección cálida (ámbar tenue) |

### 1.2 Texto (4 niveles de jerarquía)
`--text-1 #f4f4f5` (primario) · `--text-2 #b0b0b5` (secundario) · `--text-3 #8f8f95`
(terciario / códigos) · `--text-4 #6e6e74` (micro / deshabilitado).
**Regla de contraste:** etiquetas y metadatos nunca por debajo de `--text-3` sobre
`--surface-1`. El `--text-4` se reserva a micro-labels no esenciales.

### 1.3 Bordes
`--border-subtle #1f1f22` · `--border-default #29292d` (tarjetas) · `--border-control #49494e`
(botones/inputs) · `--border-control-hover #85858b`.

### 1.4 Estado semántico y severidad
Estado: `--state-ok #5fb98a` · `--state-warn #d8c35c` · `--state-fail #ff5f57` ·
`--state-info #8fb3d9`.
Severidad: `--sev-1 #ff5f57` (P1) · `--sev-2 #f0904a` (P2) · `--sev-3 #d8c35c` (P3) ·
`--sev-4 #7f95aa` (P4). Glifos obligatorios junto al color: `◆ P1`, `▲ P2`, `■ P3`, `● P4`.

### 1.5 Tipografía
- Familia: `--font-sans` = `'Segoe UI', Inter, ui-sans-serif, system-ui`. Mono: `--font-mono`
  = `'Cascadia Mono','JetBrains Mono', ui-monospace, Consolas, monospace`.
- Base app (`.soc-app`): **13px / line-height 1.5 / `font-variant-numeric: tabular-nums`**.
- Escala real (respetarla, no introducir tamaños nuevos):

| Rol | Tamaño | Peso | Tracking | Uso |
| --- | --- | --- | --- | --- |
| H1 página | 20px | 480 | −0.025em | `.soc-page-heading h1` |
| H1 auth | 24px | 480 | −0.03em | pantalla de acceso |
| H2 panel | 15px | 550–560 | — | cabecera de tarjeta |
| Título drawer | 16px | 550 | −0.02em | overlays |
| Cuerpo | 13px | 400–450 | — | datos |
| Secundario | 12px | 400 | — | descripciones |
| Label / terciario | 11px | 400–600 | — | `dt`, nav-group |
| Micro | 10–11px | 400 | — | meta, legend |
| Eyebrow / nav-group | 11px | 600 | +0.06em, UPPERCASE | encabezados de grupo |
| Código | 12px | — | — | `--font-mono`, capabilities, IDs |

### 1.6 Espaciado, radios, movimiento, layout
- Escala: `--space-1..12` = 4/8/12/16/20/24/32/48 px. **Usar solo estos múltiplos.**
- Radios (literales por componente; no hay token): 6px (ítems/controles), 9px (paneles),
  999px (pills: botones, chips). No introducir otros.
- Elevación: el sistema **no usa sombras** para jerarquía; separa con fondo + borde. Única
  sombra permitida: anillo de foco. No añadir `box-shadow` decorativo.
- Movimiento: `--motion-fast 120ms` / `--motion-base 160ms` / `--motion-panel 220ms`, easing
  `--ease-out cubic-bezier(0.16,1,0.3,1)`. Toda animación responde a una acción.
- Riel: `--rail-width 232px` expandido · `56px` colapsado.

---

## 2 · Anatomía del shell (compartida por todas las vistas)

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│  RIEL 232px  │  TOPBAR  (sticky, 52px, blur)                             │
│  #050505     │  QAPAQ SecOps / {título}        [estado] [Ir a] [perfil]  │
│              ├──────────────────────────────────────────────────────────┤
│ OPERACIÓN    │  WORKSPACE  (padding 24px)                                │
│  ▸ Resumen   │  ┌────────────────────────────────────────────────────┐  │
│  ▸ …         │  │  CONTENEDOR DE PÁGINA  (max-width, ver §3.1)        │  │
│ CONFIGURAC.  │  │  ...                                                │  │
│ ANÁLISIS     │  │                                                     │  │
│ GOBIERNO     │  └────────────────────────────────────────────────────┘  │
│ ─────────    │                                                          │
│  Mi sesión   │                                                          │
│  Contraer [  │                                                          │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### 2.1 Riel (`.soc-rail`, `<aside>`)
- `position: fixed; width: var(--rail-width); background: --surface-rail; border-right:
  1px solid --border-default; padding: 12px 12px 10px; z-index: 5`.
- Marca arriba (`.soc-brand`, min-height 48px) → grupos `.soc-nav` (grid, gap 25px, margin-top
  26px) con eyebrow `<h2>` uppercase 11px/600/+0.06em → ítems `.soc-nav__item`
  (min-height 36px, gap 11px, radius 6px, `--text-2`).
- **Activo** (`.is-active`): fondo `--surface-2` + barra ámbar de 2px vía `::before`
  (`--brand-amber`). El ícono activo sube a `--text-1`; inactivo `--text-3`.
- Pie (`.soc-rail__footer`, `margin-top:auto`, borde superior): «Mi sesión» (ítem a `/me`) y
  «Contraer» con `<kbd>[</kbd>`.
- **Colapso** (estado `collapsed`, persistido en `localStorage['qapaq.rail.collapsed']`,
  toggle con `[`): ancho 56px; se ocultan `__name`, los `h2`, los `span` de ítems y el texto
  del botón; todo se centra. **Forzado** por media `≤1100px` sin importar el toggle.

### 2.2 Topbar (`.soc-topbar`, `<header>`)
- `sticky; top:0; height:52px; padding:0 24px; border-bottom; background: rgb(8 8 8 /96%);
  backdrop-filter: blur(12px); z-index:4`.
- Izquierda: breadcrumb `QAPAQ SecOps / {pageTitle}` (el título en `--text-1`, el prefijo en
  `--text-3`). Derecha (`gap 14px`): `StatusChip` de API, botón «Ir a» + `<kbd>Ctrl K</kbd>`
  (min-width 104px), y `.soc-profile` (`<details>`: avatar inicial 28px + nombre/rol +
  dropdown con tenant, roles, «Cerrar sesión»).

### 2.3 Workspace (`.soc-workspace`, `<main id="soc-main">`)
- `min-height: calc(100svh - 52px); padding: 24px`. `tabIndex=-1` (destino del skip-link).

---

## 3 · Vista «Mi sesión» (`/me`) — especificación detallada

Componente `SessionPage` (`SocUtilityViews.tsx`). Propósito: que la persona de turno vea,
de un vistazo, **quién es, cómo se autenticó y exactamente qué puede hacer**. Es consulta,
no configuración.

### 3.1 Defectos actuales (lo que se ve en la captura) → corrección

| # | Defecto observado | Corrección (esta spec) |
| --- | --- | --- |
| D1 | **Sin ancho máximo:** el contenido se estira a toda la pantalla; etiqueta y valor quedan separados por un hueco enorme. | Contenedor `.soc-page` con `max-width: 1120px`; en `/me`, la lista de identidad es un `dl` de columna de etiqueta fija (ver §3.3). |
| D2 | **Grid de permisos desalineado:** el `<code>` flota a la derecha (`margin-left:auto`) con separación variable; queda ragged. | Cada capability es una fila de 2 columnas fijas `[check + label] [code]` con el código alineado en una columna tabular común (ver §3.4). |
| D3 | **Valor ausente como dato real:** «Autenticación: No informado» se ve igual que un dato. | Tratamiento de «sin dato»: `--text-4`, cursiva, texto corto «Sin dato». Nunca con el peso/estilo de un valor real (ver §3.3). |
| D4 | **IDs largos sin manejo:** `Identificador` y `Tenant` monoespaciados sin truncar ni copiar. | `<code>` con `overflow` controlado + botón copiar; en angosto, `word-break` controlado (ver §3.3 y §5). |
| D5 | **Mezcla de idioma:** «21 capabilities». | «21 capacidades». |
| D6 | **Aire excesivo y corte inferior** sin señal de que hay más. | Densidad: `gap` de paneles `--space-5` (20px) máx; padding de panel 16px; el workspace ya scrollea, pero los grupos de capacidades no deben exceder el panel sin estructura. |
| D7 | **Bordes de panel casi invisibles.** | `border: 1px solid --border-default` (#29292d) sobre `--surface-1`; cabecera de panel con `border-bottom` del mismo borde. |

### 3.2 Composición general
```
┌─ .soc-page (max-width 1120px, margin-inline auto) ─────────────────────┐
│  H1  Mi sesión                              [ Actualizar permisos ]     │
│  p   Identidad, autenticación y permisos vigentes.                       │
│                                                                         │
│  ┌─ Panel: Identidad institucional ─────────────────────────────────┐  │
│  │  dl de dos columnas: etiqueta fija 160px · valor flexible         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Panel: Permisos vigentes            [ 21 capacidades ] ──────────┐  │
│  │  grid de 2 columnas de GRUPOS; cada grupo = eyebrow + lista       │  │
│  │  de filas [✓ etiqueta ........... code]                           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```
- `.soc-page-heading`: H1 20px/480, `p` 12px `--text-2`. La acción «Actualizar permisos»
  (`Button` secondary, icono `refresh`) va alineada a la derecha del heading
  (`.soc-page-heading__meta`), **no** suelta en una esquina. En `≤760px` baja bajo el texto.
- Separación vertical entre paneles: `--space-5` (20px).

### 3.3 Panel «Identidad institucional» (`<dl class="soc-description-list">`)
- Cada par = `dt` (etiqueta) + `dd` (valor). Layout en rejilla:
  `grid-template-columns: 160px minmax(0, 1fr); row-gap: var(--space-3); column-gap:
  var(--space-4)`. En la implementación actual el `dt`/`dd` quedan sueltos → **fijar la
  columna de etiqueta a 160px** elimina el hueco gigante (D1).
- `dt`: 11px, `--text-3`, alineado arriba. `dd`: 13px, `--text-1`.
- Campos: **Nombre**, **Correo**, **Identificador** (`<code>`), **Tenant** (`<code>`),
  **Autenticación**, **Sesión** (texto fijo de política).
- **Valores `<code>` (Identificador, Tenant):** `font-mono` 12px, `--text-2`, fondo
  `--surface-2`, radius 6px, padding `2px 6px`. A la derecha un botón copiar (icono
  `copy`→`check`, patrón de `ErrorState`). `min-width:0` + `overflow-wrap:anywhere` para
  que no desborden (D4).
- **Valor ausente (D3):** cuando el dato no viene, `dd` renderiza
  `<span class="soc-dd-empty">Sin dato</span>` → `--text-4`, `font-style: italic`. Prohibido
  mostrar un placeholder con aspecto de dato real. La cadena larga actual «No informado por
  la identidad institucional» se reduce a «Sin dato» (la explicación va en `title`).
- **Autenticación:** `authMethod(amr)` → «Passkey (FIDO2)» / «Autenticación multifactor» /
  (si no hay amr) `soc-dd-empty` «Sin dato». Nunca «No informado» en texto plano.

### 3.4 Panel «Permisos vigentes»
- Cabecera (`.soc-panel__header`): `<h2>Permisos vigentes</h2>` + contador a la derecha
  `<span>{N} capacidades</span>` (11px, `--text-3`). **«capacidades», no «capabilities»** (D5).
- Cuerpo `.soc-capability-groups`: `grid-template-columns: repeat(2, minmax(0,1fr));
  gap: var(--space-4); padding: var(--space-4)`.
- Cada grupo (6 fijos, solo se renderiza si tiene ≥1): eyebrow `<h3>` 11px/600/+0.06em
  UPPERCASE `--text-3` + `<ul>` de filas.
- **Fila de capability (corrige D2):** en vez de `check + label + <code margin-left:auto>`,
  usar rejilla de la fila:
  `display: grid; grid-template-columns: 16px minmax(0,1fr) auto; align-items: baseline;
  column-gap: var(--space-2); min-height: 24px`.
  - Col 1: `SocIcon name="check"` 14px `--state-ok` (✓).
  - Col 2: etiqueta legible (`capabilityLabel`), 13px `--text-1`, puede envolver a 2 líneas.
  - Col 3: `<code>` del id técnico, 12px `--font-mono` `--text-3`, `white-space: nowrap`,
    `text-align: right`. Al envolver la etiqueta, el code se mantiene arriba (`baseline`).
- **No listar lo que no se tiene** (coherente con 04 §8): sin filas «✗», sin grises de
  «no disponible».
- Las categorías y su orden (de `capabilityGroups`): Alertas y telemetría · Incidentes y
  notificaciones · Observabilidad · Acceso y sesiones · Auditoría · Plataforma.

### 3.5 Acción «Actualizar permisos»
- `Button` secondary con icono `refresh`; dispara `onRefresh` (relee la sesión). Mientras
  carga: deshabilitado + copia «Actualizando…». No hace optimistic update; al volver, el
  contador y los grupos reflejan la sesión real.

---

## 4 · Estados (qué renderiza `/me` en cada caso)

| Estado | Render | Clase/patrón |
| --- | --- | --- |
| Cargando sesión / arranque | Splash Q (`QapaqSplash waiting`) a nivel de shell | `login-motion.css` |
| Sin sesión | El shell nunca se pinta: `loadSession()` redirige al login con `?authError`/`?correlationId` | — |
| Datos OK | Los dos paneles | §3 |
| Dato de identidad ausente | `soc-dd-empty` «Sin dato» por campo | §3.3 |
| Error al releer permisos | `ErrorState` dentro del panel de permisos, con `correlationId` copiable + «Reintentar»; el panel de identidad se mantiene | `.soc-error` |
| Sin ninguna capability (teórico) | Panel de permisos con `EmptyState` honesto: «Tu sesión no tiene capacidades asignadas.» | `.soc-empty` |

Regla transversal (06 §3/§4): **todo error lleva `correlationId`**; ningún estado inventa
salud ni «ok» por ausencia de error.

---

## 5 · Responsividad (al detalle, breakpoints reales)

Breakpoints autoritativos en `soc-responsive.css`: **1100px** (tablet / colapso) y **760px**
(móvil). No introducir breakpoints nuevos para `/me`.

### 5.1 ≥1101px (escritorio)
- Riel 232px (según toggle). `.soc-page` **centrado con `max-width: 1120px`** (corrige el
  estiramiento D1). Identidad: columna de etiqueta 160px. Permisos: grid de 2 columnas.

### 5.2 ≤1100px (tablet)
- Riel **forzado a 56px** (solo iconos; tooltips `title` en hover/focus). `.soc-main-column`
  recalcula `margin-left/width` a 56px.
- `.soc-page` sigue con su `max-width` pero rara vez lo alcanza.
- Permisos: **mantener 2 columnas mientras el ancho útil ≥ ~720px**; si el panel se estrecha,
  pasa a 1 (se hereda del comportamiento ≤760, pero conviene un `@container`/segundo umbral
  si el panel queda < 640px — ver §7, mejora opcional).

### 5.3 ≤760px (móvil)
- Topbar 50px, padding 12px; en el perfil se oculta nombre+chevron (queda el avatar); «Ir a»
  colapsa a botón cuadrado 44×44 solo-icono; `StatusChip` máx 145px truncado.
- Workspace padding `17px 12px`.
- **Identidad:** el `dl` pasa a **una columna** (`grid-template-columns: 1fr`): `dt` encima de
  `dd`, `row-gap --space-1`, separación entre pares `--space-3`. Los `<code>` de ID usan
  `overflow-wrap: anywhere` para no desbordar; el botón copiar baja a la misma fila del valor.
- **Permisos:** `.soc-capability-groups` → **1 columna**. La fila de capability conserva su
  rejilla `16px 1fr auto`; si la etiqueta + code no caben, el code envuelve a la línea
  siguiente alineado a la izquierda bajo la etiqueta (no se recorta ni se oculta el id).
- **Áreas táctiles:** cualquier control (`Button`, botón copiar, `summary` del perfil) a
  `min-height: 44px`; inputs a `font-size: 16px` (anti-zoom iOS). El botón «Actualizar
  permisos» ocupa el ancho disponible del heading apilado.
- `.soc-page-heading__meta` reflui­do a la derecha / bajo el título.

### 5.4 `prefers-reduced-motion: reduce`
- Se anulan transiciones del shell (`.soc-app *` a 0.01ms) y realces de fila. La entrada de
  página `soc-view-enter` no debe ser requisito para leer `/me`.

### 5.5 Límites y truncado
- IDs (`subjectId`, `tenantId`): nunca romper el layout. Escritorio: una línea con
  `overflow-wrap:anywhere`; si se decide truncar, SIEMPRE con copiar accesible y `title`
  completo. Móvil: envuelven.
- Etiquetas de capability: máximo 2 líneas; a partir de ahí, `title` con el texto completo.

---

## 6 · Micro-detalles (los que se aprecian «hasta lo mínimo»)

1. **Tabular-nums ya global**: contadores («21 capacidades»), fechas y scores alinean cifras.
   No sobreescribir.
2. **Checks verdes consistentes:** todos `SocIcon name="check"` a 14px `--state-ok`, mismo
   grosor (`strokeWidth 1.65`). Nada de `✓` tipográfico suelto.
3. **Códigos (`<code>`) uniformes:** 12px `--font-mono`, color `--text-3`, mismo tratamiento
   en identidad y en capabilities (hoy difieren). Un solo estilo `.soc-code`.
4. **Alineación baseline** en la fila de capability: el id y la etiqueta comparten baseline;
   al envolver la etiqueta, el id queda arrintegrado arriba, no centrado.
5. **Eyebrows de grupo** (Permisos) con el **mismo** estilo que los eyebrows del riel
   (11px/600/+0.06em/uppercase/`--text-3`): coherencia de sistema.
6. **Foco visible:** anillo de foco en todo control (botones, copiar, enlaces). Es la única
   sombra permitida. Verificar orden de tabulación: heading → acción → identidad → permisos.
7. **Copiar:** feedback «Copiada» 1.5s (patrón `ErrorState`), con `aria-live="polite"`.
8. **Ámbar solo en selección:** en `/me`, el único ámbar es la barra activa de «Mi sesión»
   en el riel. El contenido de la vista no usa ámbar.
9. **Sin sombras de tarjeta, sin gradientes, sin glow.** Separación por `--surface-1` +
   `--border-default`.
10. **Espaciados solo de la escala** (`--space-*`). Prohibido `13px`, `18px`, `22px` sueltos.

---

## 7 · Mejoras opcionales (registrar, no inventar como hechas)

- **Consultas de contenedor** (`@container`) en `.soc-panel` para que el grid de permisos
  decida 1↔2 columnas por el ancho del *panel*, no de la ventana — más robusto que el
  breakpoint global de ventana. Hoy no implementado.
- **Token de radio y de `max-width` de página** en `:root` (`--radius-panel: 9px`,
  `--radius-control: 6px`, `--page-max: 1120px`) para no repetir literales.
- **Clase compartida `.soc-code`** y `.soc-dd-empty` en `soc-overlays.css` para reutilizar en
  todas las vistas de detalle.

---

## 8 · Checklist de aceptación (vista «Mi sesión»)

- [ ] El contenido no se estira a todo el ancho: `max-width 1120px`, centrado.
- [ ] Identidad: columna de etiqueta de 160px; sin hueco gigante etiqueta→valor.
- [ ] Capabilities: id técnico en columna tabular alineada; nada ragged.
- [ ] Valores ausentes como «Sin dato» atenuado/cursiva, nunca como dato real.
- [ ] «21 capacidades» (español), tabular-nums.
- [ ] IDs largos no rompen el layout en 320px; copiar accesible con feedback.
- [ ] 2 columnas de grupos en escritorio; 1 en ≤760px; filas sin recorte del id.
- [ ] Riel colapsa a 56px en ≤1100px; topbar a 50px y perfil solo-avatar en ≤760px.
- [ ] Controles ≥44px e inputs 16px en móvil.
- [ ] Cero ámbar fuera de la selección; cero sombras de tarjeta; cero texto en inglés.
- [ ] `prefers-reduced-motion`: la vista es legible sin animación.
- [ ] Error al actualizar: `ErrorState` con `correlationId` + reintentar, sin tumbar identidad.

---

## 9 · Trazabilidad

- Dirección y prohibiciones: `10-vistas-por-rol-y-referencias.md`.
- Pantalla 8 (Mi sesión) y grid de capabilities: `04-pantallas.md` §8.
- Estados, errores y confirmación: `06-patrones-de-interaccion.md` §3/§4/§6.
- Brechas de identidad (B-04 sin displayName/correo, B-07 sin expiración visible):
  `08-brechas-y-decisiones.md`.
- Código: `apps/web/src/components/soc/SocUtilityViews.tsx` (`SessionPage`),
  `apps/web/src/app/soc-overlays.css` (`.soc-capability-groups`, `.soc-session-panel`,
  `.soc-description-list`), `soc-shell.css` (tokens), `soc-responsive.css` (breakpoints).
