# 14 · Especificación intensiva — Eventos, Salud de fuentes, Notificaciones y Avisos push

**Estado:** especificación de diseño e implementación, escrita contra el código real del
2026-10-13 (`apps/web/src/components/soc/*` y `apps/web/src/app/*.css`). Los valores de
tokens, clases, medidas y breakpoints son **textuales del código**, no aspiracionales.
**Alcance:** las cuatro vistas de investigación y entrega del SOC —`/events`, `/sources`,
`/notifications`, `/settings/notifications`— de punta a punta, para calcarlas tal cual.

> Fuente de verdad de tokens, escala tipográfica, espaciado y breakpoints:
> [`11-mi-sesion-y-shell-spec.md`](11-mi-sesion-y-shell-spec.md). Esta spec no redefine el
> shell (riel + topbar + workspace); hereda sus reglas y detalla solo el contenido de cada
> página. Los archivos CSS reales son `soc-data.css` (todo el contenido de estas vistas),
> `soc-overlays.css` (drawer), `soc-shell.css` (`.soc-status`, tokens) y `soc-responsive.css`
> (breakpoints). Los TSX son `EventsPage.tsx`, `SourcesHealthPage.tsx`, `NotificationPage.tsx`
> y `PushNotificationSettingsPage.tsx`.

---

## 0 · Principios heredados (no negociables)

De [doc 11 §0](11-mi-sesion-y-shell-spec.md) y [doc 10 «Lo que el diseño debe evitar»](10-vistas-por-rol-y-referencias.md):

1. **Para turno, no para demo.** Densidad alta, escaneo veloz, foco en la tarea.
2. **Negro `#080808` + grises para jerarquía.** El ámbar `--brand-amber` (`#c49a5a`) es **solo**
   marca / selección / indicador activo; nunca decorativo. En estas cuatro vistas no hay ámbar
   de contenido (la única selección ámbar es el ítem activo del riel).
3. **Estado por rótulo + forma + color**, nunca solo color. El glifo del `StatusChip`
   (`✓ ! × i –`) acompaña siempre al tono.
4. **Honestidad de estado (crítico aquí).** Cero ≠ sano; vacío ≠ ok; «sin dato» se muestra
   *como ausente*. Una cola vacía de eventos o notificaciones **no** implica salud de la fuente.
5. **Autorización server-side.** La UI oculta lo que la capability no permite («ausente, no
   deshabilitado»): pestaña Crudo, «Despachar ahora», `/sources` completo.
6. **Cero ruido:** sin glow/neón, sin gradientes, sin sombras de tarjeta (separación por
   `--surface-1` + borde). Única sombra permitida: anillo de foco.
7. **Idioma: español.** Toda cadena visible, contadores y unidades en español.

### 0.1 Componentes compartidos usados por las cuatro vistas

| Componente | Origen | Render |
| --- | --- | --- |
| `PageHeader` | `soc-data-ui.tsx` | `div.soc-page-heading` → `div`(h1+p) + `div.soc-page-heading__meta`(«Actualizado …» + `action`) |
| `StatusChip` | `soc-ui.tsx` | `span.soc-status.soc-status--{ok\|warn\|fail\|info\|neutral}` con `span.soc-status__mark` (glifo `✓ ! × i –`) |
| `Button` | `soc-ui.tsx` | `button.soc-button` (+ `--primary` / `--ghost` / `--danger`) |
| `ErrorState` | `soc-ui.tsx` | `.soc-error` con `correlationId` y «Reintentar» |
| `EmptyState` | `soc-ui.tsx` | `.soc-empty` (min-height 76px, grid place-items center) |
| `RelativeTime` | `soc-ui.tsx` | tiempo relativo con detalle absoluto |
| `SocIcon` | `soc-ui.tsx` | SVG propio (`refresh`, `arrow`, `check`…); **no** packs genéricos |

Glifos de `StatusChip` por estado (de `soc-ui.tsx`): `ok → ✓`, `warn → !`, `fail → ×`,
`info → i`, `neutral → –`. Colores (`soc-shell.css`): `ok #5fb98a`, `warn #d8c35c`,
`fail #ff5f57`, `info #8fb3d9`, `neutral` = `--text-2` (sin color de estado).

---

## 1 · `/events` «Eventos de seguridad»

Componente `EventsPage` (`EventsPage.tsx`). **Nivel:** API · `GET /api/events` (read-through
del Indexer Wazuh) · capability `events.read`; pestaña Crudo solo con `events.read_raw`.
**Roles:** líder SOC, auditor, administrador ([doc 10](10-vistas-por-rol-y-referencias.md)); no
aparece al analista. **Propósito:** buscar telemetría normalizada en una ventana acotada
(máx. 31 días) para contextualizar una alerta. La telemetría permanece en su fuente: la consola
no guarda copia ni acepta DSL del proveedor.

### 1.1 Anatomía ASCII (clases reales)

```
div.soc-page
├─ PageHeader → div.soc-page-heading
│   ├─ div                h1 «Eventos de seguridad»
│   │                     p  «Actividad normalizada de Wazuh. La telemetría permanece en su fuente.»
│   └─ div.soc-page-heading__meta   (sin «Actualizado»: esta vista no pasa `updated`)
│
├─ form.soc-events-filters                         (flex wrap, align end, gap 12px)
│   ├─ label  «Rango de tiempo» + select(24h/7d/31d) + small «Máximo 31 días»
│   ├─ fieldset.soc-events-mode   legend «Modo de búsqueda»  (○ Filtros  ○ Consulta)
│   │
│   ├─ [modo Filtros] div.soc-events-filter-groups
│   │     ├─ fieldset.soc-events-checkgroup  legend «Severidad»  (☐ Crítica … ☐ Informativa)
│   │     ├─ fieldset.soc-events-checkgroup  legend «Categoría»  (☐ Autenticación … ☐ Base de datos)
│   │     └─ label «Resultado» + select (Todos / Exitoso / Fallido)
│   │
│   ├─ [modo Consulta] div.soc-events-query
│   │     ├─ label «Consulta de eventos»
│   │     ├─ textarea#events-query  (mono, maxLength 512, placeholder gramática)
│   │     ├─ small#events-query-help  «Gramática qapaq-events-v1. Campos: severity, category, outcome…»
│   │     └─ p#events-query-error  (role=alert si inválida · aria-live=polite si válida)
│   │
│   └─ Button.soc-button--primary «Buscar»   (disabled si cargando o q inválida)
│
├─ p.soc-page-note  «Consulta activa: <code>…</code>»        (solo en modo Consulta aplicado)
├─ p.soc-page-note  «Período consultado: <desde> – <hasta>»  (es-PE)
├─ ErrorState (.soc-error)                                    (si error)
│
├─ [status=disabled] EmptyState.soc-empty
│     «Fuente de eventos no configurada. No se puede consultar la telemetría en este entorno.»
│
└─ [status=ok] div.soc-table-panel
      ├─ p.soc-partial-banner  «N documento(s) de esta página no se pudieron normalizar.»
      ├─ div.soc-table-scroll → table.soc-table
      │     thead: Hora · Severidad · Tipo · Resultado · Regla · Identidad · Fuente · Detalle
      │     tbody: fila por evento; col Detalle = Button.soc-button--ghost «Ver evento»
      ├─ EmptyState  «Sin eventos para estos filtros en el período consultado.»  (si 0 filas)
      └─ div.soc-table-footer.soc-events-pagination
            [Anterior]   «Consultando Wazuh…» / «Resultados ordenados del más reciente al más antiguo»   [Siguiente]

aside.soc-drawer  (EventDetail, si hay evento seleccionado)   → §1.6
```

### 1.2 Tabla elemento → clase → medidas → token (escala real)

| Elemento | Clase | Medidas | Token |
| --- | --- | --- | --- |
| Contenedor | `.soc-page` | `position:relative; min-width:0`; entrada `soc-view-enter 180ms` | `--ease-out` |
| Encabezado | `.soc-page-heading` | `min-height:48px`; flex, align-items flex-start, `gap:var(--space-6)`; `margin:0 0 var(--space-6)` | `--space-6` (24px) |
| H1 | `.soc-page-heading h1` | `font-size:20px; font-weight:480; letter-spacing:-0.025em; line-height:28px` | `--text-1` |
| Descripción | `.soc-page-heading p` | `font-size:13px; margin:4px 0 0` | `--text-2` |
| Barra de filtros | `.soc-events-filters` | `display:flex; flex-wrap:wrap; align-items:end; gap:12px; margin:16px 0 8px` | — |
| Label de rango | `.soc-events-filters > label` | `display:grid; min-width:150px; gap:6px; font-size:11px` | `--text-3` |
| Select de rango | `.soc-events-filters select` | `min-height:38px; padding:8px 10px; border:1px solid var(--border-control); border-radius:7px` | `--surface-1`, `--text-1` |
| Nota «Máximo 31 días» | `.soc-events-filters small` | `font-size:10px` | `--text-3` |
| Selector de modo | `.soc-events-mode` | flex, `gap:12px`; `padding:8px 10px`; `border:1px solid var(--border-control); border-radius:7px` | — |
| Legend de modo | `.soc-events-mode legend` | `font-size:11px; padding:0 4px` | `--text-3` |
| Radios/labels de modo | `.soc-events-mode label` | inline-flex, `gap:6px; font-size:12px`; `input{accent-color:var(--text-1)}` | `--text-2` |
| Grupo de filtros | `.soc-events-filter-groups` | flex wrap, align-items end, `gap:12px; flex:1 1 100%` | — |
| Check-group | `.soc-events-checkgroup` | `min-width:190px; padding:8px 10px; border:1px solid var(--border-control); border-radius:7px` | — |
| Check-group `legend` | `.soc-events-checkgroup legend` | `font-size:11px; padding:0 4px` | `--text-3` |
| Casillas | `.soc-events-checkgroup > div` | flex wrap, `gap:8px 12px`; labels inline-flex `gap:6px; 12px` | `--text-2` |
| Editor de consulta | `.soc-events-query` | `display:grid; flex:1 1 100%; gap:6px` | — |
| `textarea` de consulta | `.soc-events-query textarea` | `min-height:82px; resize:vertical; padding:10px 12px; border:1px solid var(--border-control); border-radius:7px; font:13px/1.5 ui-monospace…` | `--surface-1`, `--text-1` |
| Error de consulta | `.soc-events-query p[role='alert']` | `font-size:11px; color:var(--status-fail,#e18776)` | `--status-fail` |
| Ayuda de consulta | `.soc-events-query small`, `p` | `font-size:11px; margin:0` | `--text-3` |
| Notas de estado | `.soc-page-note` | `font-size:12px; margin:0` | `--text-3` |
| Panel de tabla | `.soc-table-panel` | `overflow:hidden; border-top/bottom:1px solid var(--border-default)` | `--surface-1` |
| Aviso parcial | `.soc-partial-banner` | `margin-bottom:10px; padding:8px 11px; border:1px solid var(--border-default); border-radius:6px` | `--state-info` |
| Tabla | `.soc-table` | `width:100%; border-collapse:collapse`; `th{height:32px; font-size:11px; 600; +0.06em; uppercase}`; `td{height:40px; padding:6px 12px}` | `th→--text-3`, `td→--text-2` |
| Pie/paginación | `.soc-table-footer.soc-events-pagination` | `min-height:50px`; `.soc-events-pagination{justify-content:space-between}` | `--text-3` |
| Botón de fila | `Button variant="ghost"` «Ver evento» | `.soc-button.soc-button--ghost`, `min-height:40px; border-radius:999px` | `--text-2` |

### 1.3 Interacciones — editor `q` seguro, modos y cursor

- **Dos modos (`FilterMode`)**: `filters` (por defecto) y `query`. Se alternan con los radios
  `name="events-mode"`. `changeMode('query')` hace `setQueryDraft(formatEventsQuery(draftFilters))`
  (serializa los filtros al texto `q`); `changeMode('filters')` parsea el texto actual con
  `parseEventsQuery`; **si el texto no parsea, no cambia de modo** (`if (!parsed.ok) return`). Al
  cambiar de modo se reinicia la paginación (`resetPaging`).
- **Editor `q` seguro (gramática `qapaq-events-v1`)**: `textarea` mono, `maxLength={512}`,
  `spellCheck=false`, `autoComplete="off"`, `autoCapitalize="off"`. Validación **en vivo** con
  `parseEventsQuery(queryDraft)` (memoizada). Campos admitidos: `severity`, `category`, `outcome`.
  Solo `AND`; un predicado por campo; listas con coma. **No es SQL ni DSL de proveedor.**
  - `aria-invalid` = `!parsedDraft.ok`; borde `--status-fail` cuando inválida.
  - Mensaje bajo el editor: inválida → `p[role="alert"]` con texto + posición de
    `queryErrorText(code, position)` → *«… Posición N.»* (posición `position + 1`). Válida →
    `p[aria-live="polite"]`: «Consulta válida: {canónica}» o «Sin filtros adicionales.».
  - Atajo **Ctrl/Cmd + Enter**: envía el formulario (`requestSubmit`) solo si `parsedDraft.ok`.
  - Catálogo de errores (todos en español, con «Posición N.» al final): `TOO_LONG`,
    `INVALID_CHARACTER`, `UNEXPECTED_TOKEN`, `UNSUPPORTED_OPERATOR`, `UNKNOWN_FIELD`,
    `UNKNOWN_VALUE`, `DUPLICATE_FIELD`, `DUPLICATE_VALUE`, `SINGLE_VALUE_FIELD`,
    `TOO_MANY_PREDICATES`, `TOO_MANY_VALUES`, `TOO_MANY_TOKENS`, `INCOMPLETE`.
- **Rango**: `select` con `rangeLabels` = `24 → «Últimas 24 horas»`, `168 → «Últimos 7 días»`,
  `744 → «Últimos 31 días»` (744 h = 31 días, **máximo contractual**). Cambiarlo fija
  `windowEnd = ahora` y reinicia la paginación. El backend recibe `from`/`to` en ISO/UTC.
- **Enviar (`applySearch`)**: fija `windowEnd = ahora`. En modo `query` envía
  `q = parsedDraft.canonical` (canónica) y guarda `applied = parsedDraft.filters`. En modo
  `filters` limpia `q`, aplica `draftFilters` y sincroniza el texto con `formatEventsQuery`.
  El backend aplica el mismo cursor y rango a ambos modos y **rechaza mezclar `q` con filtros**.
- **Outcomes**: `outcomeLabels` = `success → «Exitoso»`, `failure → «Fallido»`,
  `unknown → «Desconocido»`. En tabla y detalle se usa `outcomeLabels[outcome] ?? 'Desconocido'`.
  El filtro «Resultado» ofrece solo `Todos / Exitoso / Fallido` (selección simple); `unknown`
  aparece en resultados pero no se envía como filtro.
- **Severidad** (`severityLabels`): crítica/alta/media/baja/informativa; `unknown → «Desconocida»`
  se muestra pero no se filtra. Categorías: `filterableCategories` (las que compila el adapter
  Wazuh), traducidas por `categoryLabels`.
- **Cursor (paginación opaca, solo en memoria)**: `cursorStack`/`cursorIndex`; «Anterior»
  retrocede, «Siguiente» usa `nextCursor`. Sin números ni total. `resetPaging()` al cambiar
  rango, modo o aplicar filtros. No hay refresco automático en `/events`.

### 1.4 Estados

| Estado | Detección | Render |
| --- | --- | --- |
| Cargando | `loading` tras enviar | Botón «Buscar» deshabilitado; pie dice **«Consultando Wazuh…»**; se conservan filas previas |
| OK con datos | `status==='ok'` | `.soc-table-panel` con filas |
| Vacío por filtros | `status==='ok'` y `items.length===0` sin cargar/errores | EmptyState «Sin eventos para estos filtros en el período consultado.» |
| Parcial | `unparsedCount > 0` | `.soc-partial-banner` «N documento(s) de esta página no se pudieron normalizar.» |
| No configurada | `status==='disabled'` | EmptyState «Fuente de eventos no configurada. No se puede consultar la telemetría en este entorno.» (no es cola vacía) |
| Error / degradado | `result.ok===false` | `ErrorState` con `correlationId` + «Reintentar» (un 503/`DEPENDENCY_DEGRADED` del catálogo) |

- **`disabled` no es «vacío»** ([doc 04 §2](04-pantallas.md)): identifica una fuente no
  configurada; jamás se dibuja como cola vacía ni como «sin eventos».
- Todo error lleva `correlationId` ([doc 06 §4](06-patrones-de-interaccion.md)).

### 1.5 Responsividad (breakpoints exactos)

- **≥1101px (escritorio):** `.soc-events-filters` en una fila con wrap; label de rango
  `min-width:150px`; check-groups `min-width:190px` lado a lado; `.soc-events-query` ocupa
  el 100% (`flex:1 1 100%`).
- **≤1100px (tablet):** el riel se fuerza a 56px (shell, doc 11 §5.2). La barra de filtros
  mantiene su maquetación flex (sin regla propia a 1100): rara vez cambia salvo por el reflujo
  natural del wrap.
- **≤760px (móvil):**
  - `.soc-events-filters{align-items:stretch}`; `.soc-events-filters > label{flex:1 1 135px}`;
    `.soc-events-filters select{min-height:44px; font-size:16px}` (táctil 44px, anti-zoom iOS 16px).
  - `.soc-events-filter-groups{align-items:stretch; flex-direction:column}` (una columna);
    `.soc-events-checkgroup{width:100%}`.
  - `.soc-events-query textarea{min-height:104px; font-size:16px}`.
  - `.soc-events-mode{width:fit-content; min-height:44px}`.
  - Tabla: `.soc-table th,.soc-table td{padding-inline:9px}`.
  - Drawer: `.soc-drawer{inset:50px 0 0; width:100%; border-left:0}`.
  - Táctiles: `.soc-button,.soc-tabs button,.soc-row-link,.soc-profile summary{min-height:44px}`.
- **`prefers-reduced-motion: reduce`:** `.soc-app *` → animaciones/transiciones a 0.01ms;
  `soc-view-enter` y `soc-drawer-in` dejan de ser requisito para leer.

### 1.6 Detalle del evento (drawer)

`EventDetail` → `aside.soc-drawer` (`soc-overlays.css`): `position:fixed; inset:52px 0 0 auto;
width:min(480px, calc(100vw - var(--rail-width)))`; entrada `soc-drawer-in var(--motion-panel)`.

- `header` (`min-height:64px`): `span.soc-drawer__eyebrow` «Evento · {recordId.slice(0,8)}…»
  (11px `--text-3`), `h2` (16px/550/−0.02em) con `eventSummary` (title ‖ action ‖ kind), y
  `Button variant="ghost"` «Cerrar».
- `div.soc-drawer__body` (grid, gap 18px, padding 16px): `div.soc-tabs role="tablist"` con
  **Resumen** y **Crudo** (esta última **solo si `events.read_raw`**, nunca deshabilitada).
  - **Resumen**: `dl.soc-description-list` con Ocurrido, Recibido (RelativeTime), Severidad,
    Tipo, Resultado (`outcomeLabels`), Regla (`id · grupos` ‖ «Sin grupo» ‖ `—`), Identidades,
    Recursos (`display()`), Fuente (`sourceLabel` = vendor · product · dataset), Identificador
    (`<code>{eventUid}</code>`).
  - **Crudo**: `pre.soc-event-raw` con `JSON.stringify(raw, null, 2)` (`max-height:min(65vh,720px)`,
    mono 11px, `white-space:pre-wrap`).

### 1.7 Micro-detalles (/events)

1. Selector de rango muestra **siempre** el máximo contractual («Últimos 31 días»); nunca un
   rango mayor.
2. El editor `q` nunca ejecuta: solo envía al pulsar «Buscar» o Ctrl/Cmd+Enter con `q` válida.
3. «Resultado» como `select` simple; severidad y categoría como casillas multiselección.
4. `tabular-nums` global alinea cifras del aviso parcial y de horas.
5. Botón «Ver evento» es `ghost` (no primario): abrir detalle no es una acción destructiva.
6. `display()` resuelve objetos a un preferido (displayName/name/UPN/address/ip/id/kind) o `—`.

---

## 2 · `/sources` «Salud de fuentes»

Componente `SourcesHealthPage` (`SourcesHealthPage.tsx`). **Nivel:** API ·
`GET /api/sources/health` · capability `sources.health.read` (líder, auditor, admin; **no**
analista). **Propósito:** mostrar la evaluación del servidor sobre la ingesta real. **Modelo
de una sola fuente (Wazuh)** ([doc 10 v4/v5](10-vistas-por-rol-y-referencias.md); referencia
`salud-fuentes-v4/v5.png`). Las suscripciones de Office 365 (`Audit.*`) son **medición anidada
de contexto**.

> **Regla central de honestidad (dílo explícito en la UI):** la medición de suscripciones M365
> es **contexto de investigación y NO determina la salud de la fuente**. **Cero eventos es
> NEUTRAL**, no malo: no implica fallo ni confirma que la fuente esté saludable. Los estados
> `unknown` y `disabled` también son **neutrales**.

### 2.1 Anatomía ASCII (clases reales)

```
div.soc-page
├─ PageHeader → div.soc-page-heading
│   ├─ div  h1 «Salud de fuentes» · p «Estado de ingesta y observaciones reales por fuente.»
│   └─ div.soc-page-heading__meta  «Actualizado <RelativeTime>» + Button(SocIcon refresh) «Actualizar»
│
├─ p.soc-page-note       «Evaluado por el servidor <RelativeTime checkedAt>.»
├─ p.soc-live-announcement (role=status, aria-live=polite)  «Estado de fuente actualizado»  (si /api/changes source)
├─ ErrorState (.soc-error)   (si error)
│
├─ div.soc-source-grid                               (grid 2 col ≥761px)
│   └─ article.soc-source-card   (una tarjeta por fuente/dataset; modelo = 1 fuente Wazuh)
│       ├─ header
│       │    ├─ div  h2 {displayName}  ·  p «{dataset} · {sourceId}»
│       │    └─ StatusChip (tono por estado)   {label}
│       ├─ p.soc-source-reason   {reasonLabels[reason]}
│       ├─ dl.soc-health-facts   (8 pares: intento/éxito/evento/fallos/error/intervalo/degrad./caída)
│       │
│       ├─ [subscriptions === null]  p.soc-page-note
│       │     «Actividad de suscripción: no medido · no confirma salud.»
│       ├─ [subscriptions != null]  details.soc-source-subscriptions
│       │     summary «Actividad de suscripción · últimas {windowHours} h»
│       │     p.soc-page-note «Medida <RelativeTime>. Es contexto de investigación; no determina la salud de la fuente.»
│       │     table.soc-table  (Stream · Último evento · Eventos en ventana)  ‖  p.soc-page-note «Sin streams reportados en esta medición.»
│       │
│       └─ [transitions.length]  details.soc-source-history
│             summary «Transiciones recientes ({N})»  → ol (toState · reason · RelativeTime)
│
├─ EmptyState   «No hay fuentes configuradas para este entorno.»   (si 0 fuentes, sin cargar/error)
└─ p.soc-table-placeholder (role=status)  «Consultando fuentes…»   (si cargando sin datos)
```

### 2.2 Tabla elemento → clase → medidas → token (escala real)

| Elemento | Clase | Medidas | Token |
| --- | --- | --- | --- |
| Rejilla | `.soc-source-grid` | `display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:14px; margin-top:14px` | — |
| Tarjeta | `.soc-source-card` | `min-width:0; padding:16px; border:1px solid var(--border-default)` (**sin radius**) | `--surface-1` |
| Cabecera | `.soc-source-card > header` | flex, space-between, align flex-start, `gap:12px; padding-bottom:12px; border-bottom:1px solid var(--border-subtle)` | — |
| Nombre | `.soc-source-card h2` | `font-size:15px; font-weight:560` | `--text-1` |
| Dataset/ID | `.soc-source-card header p` | `font-size:11px; margin:5px 0 0` | `--text-3` |
| Motivo | `.soc-source-reason` | `font-size:12px; margin:12px 0 0` | `--text-2` |
| Hechos de salud | `.soc-health-facts` | `display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:12px 20px; padding:14px 0 2px` | — |
| `dt` | `.soc-health-facts dt` | `font-size:11px` | `--text-3` |
| `dd` | `.soc-health-facts dd` | `font-size:13px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere` | `--text-1` |
| Suscripciones | `.soc-source-subscriptions` | `margin-top:12px; font-size:12px`; `summary{cursor:pointer}`; tabla con `margin-top:8px` | `--text-2` |
| Historial | `.soc-source-history` | `margin-top:12px; font-size:12px`; `ol{display:grid; gap:8px; padding-left:18px}` | `--text-2` |
| Fila de transición | `.soc-source-history li` | `display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px`; `strong→--text-1` | `--text-3` |
| Chip de estado | `.soc-status.soc-status--{tono}` | `min-height:22px; padding:1px 8px; border-radius:999px` | según tono |
| Nota evaluación / no medido | `.soc-page-note` | `font-size:12px` | `--text-3` |
| Placeholder carga | `.soc-table-placeholder` | `padding:20px; text-align:center` | `--text-3` |
| Vacío | `.soc-empty` | `min-height:76px; grid place-items center; padding:20px` | `--text-2` |

**Los 8 hechos (`dl.soc-health-facts`), en orden:** Último intento, Último éxito, Último evento
recibido (`RelativeTime`), Fallos consecutivos (número), **Último error** (`lastErrorClass ??
«Sin dato»`), Intervalo configurado (`policy.intervalMs/1000` → «N s»), Umbral de degradación
(`degradeAfterMs/1000`), Umbral de caída (`failAfterMs/1000`).

### 2.3 Estados y mapeo de tono (crítico para honestidad)

**Estado de la fuente (`sourceState`):**

| `state` | `label` | `tone` → chip | Glifo | Color |
| --- | --- | --- | --- | --- |
| `healthy` | Saludable | `ok` | ✓ | `--state-ok` |
| `degraded` | Degradada | `warn` | ! | `--state-warn` |
| `failed` | **Fallida** | `fail` | × | **`--state-fail` (`#ff5f57`)** |
| `disabled` | Deshabilitada | `neutral` | – | `--text-2` (neutral) |
| `unknown` | Desconocida | `neutral` | – | `--text-2` (neutral) |

Solo **«Fallida»** usa `--state-fail`. `unknown` y `disabled` son **neutrales**, nunca rojos ni
verdes.

**Motivos (`reasonLabels`):** `DISABLED` «La ingesta está deshabilitada.» · `NO_OBSERVATIONS`
«Sin pasadas registradas.» · `PERMANENT_ERROR` «La última ejecución encontró un error
permanente.» · `NO_RECENT_SUCCESS` «No se registró un éxito dentro del umbral.» ·
`CONSECUTIVE_FAILURES` «Se alcanzó el umbral de fallos consecutivos.» · `NEVER_SUCCEEDED` «La
fuente todavía no registra una ejecución exitosa.» · `RECENT_SUCCESS` «La última ejecución
terminó correctamente.»

**Estados de la vista:**

| Estado | Render |
| --- | --- |
| Cargando (sin datos) | `p.soc-table-placeholder` role=status «Consultando fuentes…» |
| OK | `.soc-source-grid` con tarjeta(s) |
| Vacío | `EmptyState` «No hay fuentes configuradas para este entorno.» (solo si `!loading && !error`) |
| Error / degradado | `ErrorState` con `correlationId` + «Reintentar» |
| Actualización en vivo | `p.soc-live-announcement` «Estado de fuente actualizado» (de `useChanges({resourceTypes:['source']})`) |
| **Suscripción no medida** | `p.soc-page-note` «Actividad de suscripción: no medido · no confirma salud.» |
| **Suscripción con cero eventos** | columna «Eventos en ventana» muestra `0` (neutral); jamás rojo ni «sin datos de salud» |
| **Sin streams** | `p.soc-page-note` «Sin streams reportados en esta medición.» |

### 2.4 Interacciones

- **Actualizar**: `Button` con `SocIcon name="refresh"`; llama `load()` (`api.sourcesHealth()`),
  deshabilitado mientras `loading`. Fija `updatedAt = ahora` y `checkedAt` del servidor.
- **Evaluado por el servidor**: `p.soc-page-note` con `RelativeTime` de `checkedAt`
  (separado de «Actualizado», que es el último refresco del cliente). [Doc 10 v5](10-vistas-por-rol-y-referencias.md)
  exige conservar **ambas marcas con semántica propia**: último intento del servidor ≠ momento
  de medición de suscripciones.
- **Suscripciones (`details`)**: colapsable; su `summary` incluye `windowHours` (ventana de
  **24 h**). El texto fijo aclara que es contexto y **no determina salud**. La tabla anidada usa
  `.soc-table` (Stream, Último evento, Eventos en ventana).
- **Transiciones (`details`)**: auditables; se refrescan vía `/api/changes`
  (`resource.type=source`). Cada ítem traduce `toState` por `sourceState[...]?.label ?? toState`
  y `reason` por `reasonLabels[...] ?? reason` (defensa ante valores nuevos).

### 2.5 Responsividad (breakpoints exactos)

- **≥1101px:** `.soc-source-grid` a **2 columnas** (`repeat(2, minmax(0,1fr))`, gap 14px).
- **≤1100px:** riel forzado a 56px (shell). **La rejilla de fuentes NO cambia a 1100**:
  permanece a 2 columnas (solo colapsa en ≤760). Con el modelo de una sola fuente, la tarjeta
  ocupa una celda y la segunda queda libre.
- **≤760px:**
  - `.soc-source-grid{grid-template-columns:minmax(0,1fr)}` → **una columna**.
  - `.soc-source-history li{grid-template-columns:1fr}` (la transición apila toState/reason/tiempo).
  - Tablas anidadas: `.soc-table th,td{padding-inline:9px}`; scroll horizontal por `.soc-table-scroll`.
  - Táctiles 44px e inputs 16px por las reglas globales del shell.
- **`prefers-reduced-motion`:** entrada de página sin animación.

### 2.6 Prohibido (de [doc 10](10-vistas-por-rol-y-referencias.md))

- Mostrar **cero eventos como fallo** o como confirmación de salud («fuente sana por consulta
  vacía» está vetado).
- Pintar `unknown`/`disabled` como `ok` o como `fail`.
- Inventar «online» por ausencia de error.
- Usar la medición de suscripciones M365 para derivar la salud de la fuente.
- Presentar una segunda «fuente M365» separada (el modelo es **una sola** fuente Wazuh con
  suscripciones anidadas; la lámina v3 que lo afirmaba quedó reemplazada).

### 2.7 Micro-detalles (/sources)

1. La tarjeta **no** tiene `border-radius` (a diferencia de `.soc-panel`/`.soc-push-card`):
   es un rectángulo con borde `--border-default`. No añadir radio.
2. «Último error» cae a «Sin dato» (no `—`, no vacío) cuando `lastErrorClass` es nulo.
3. Intervalos/umbrales se muestran en segundos redondeados (`Math.round(ms/1000) s`).
4. `tabular-nums` en los `dd` alinea fallos consecutivos y segundos.
5. `key` de la tarjeta = `${sourceId}:${dataset}` (soporta varios datasets de la misma fuente).

---

## 3 · `/notifications` «Notificaciones»

Componente `NotificationPage` (`NotificationPage.tsx`). **Nivel:** API · `GET /api/notifications`
· capability `notifications.read`; «Despachar ahora» solo con `notifications.dispatch`.
**Propósito:** patrón PagerDuty **«entregada ≠ acusada»**: el worker despacha solo; la persona
revisa la entrega y registra el **acuse humano**.

### 3.1 Anatomía ASCII (clases reales)

```
div.soc-page
├─ PageHeader → div.soc-page-heading
│   ├─ div  h1 «Notificaciones»
│   │       p «El servicio despacha automáticamente. Revisa la entrega y registra el acuse humano.»
│   └─ div.soc-page-heading__meta  «Actualizado <RelativeTime>»
│        + [notifications.dispatch] Button(SocIcon arrow) «Despachar ahora» / «Despachando…»
│        + Button(SocIcon refresh) «Actualizar»
│
├─ p.soc-live-announcement (role=status)  «Dato nuevo entrando»   (si /api/changes notification)
│
├─ div.soc-tabs role="tablist"   Sin acuse · En curso · Fallidas · Acusadas
│
├─ ErrorState (.soc-error)                         (si error)
├─ p.soc-page-note role=status  «Actualizando notificaciones…»  (si loading con items)
├─ p.soc-page-note role=status  {dispatchResult}                (si pasada manual)
│
├─ div.soc-table-panel
│   ├─ div.soc-table-scroll → table.soc-table
│   │     thead: Estado · Canal · Intentos · Entregada · Acuse · Último fallo · Acción
│   │     tbody: fila por notificación (class soc-live-change si cambió en vivo)
│   ├─ EmptyState   (según nextCursor: «…entre las páginas cargadas.» / «…en la consulta.»)
│   └─ div.soc-table-footer (si nextCursor)  [Cargar más notificaciones] + «N cargadas · …»
│
└─ p.soc-page-note  «Una notificación entregada requiere el acuse de una persona. El servicio no expone reintento manual.»
```

### 3.2 Tabla elemento → clase → medidas → token (escala real)

| Elemento | Clase | Medidas | Token |
| --- | --- | --- | --- |
| Pestañas | `.soc-tabs` | flex, `gap:22px; overflow-x:auto; border-bottom:1px solid var(--border-default)` | — |
| Botón de pestaña | `.soc-tabs button` | `min-height:44px; padding:0 2px`; activa → `color:--text-1` + barra inferior 2px `::after` | `--text-3` / activa `--text-1` |
| Panel de tabla | `.soc-table-panel` | `overflow:hidden; border-top/bottom:1px solid var(--border-default)` | `--surface-1` |
| Tabla | `.soc-table` | `th{height:32px; 11px; 600; uppercase}`; `td{height:40px; padding:6px 12px}` | `td→--text-2` |
| Celda estado | `NotificationStateCell` → `.soc-status` | `.soc-table .soc-status{font-size:11px}` | según tono |
| Vencida | `small.soc-overdue` | `color:var(--state-fail) !important` | `--state-fail` |
| Intentos | `td.is-numeric` | `text-align:right`; «N de 5» | `--text-2` |
| Acuse ausente | `span.soc-muted` | — | `--text-3` |
| Botón acuse | `Button` (default) | `.soc-button`, `min-height:40px; border-radius:999px` | `--text-1` |
| Fila en vivo | `tr.soc-live-change` | `animation:soc-live-arrival 200ms ease-out` | `--surface-selected` (transición) |
| Pie «Cargar más» | `.soc-table-footer` | `min-height:50px`, centrado, `gap:14px` | `--text-3` |
| Nota de cierre | `.soc-page-note` | `font-size:12px` | `--text-3` |

### 3.3 Pestañas y agrupación (`notificationGroups`)

| Pestaña (`value`) | Label | Estados que agrupa |
| --- | --- | --- |
| `unacknowledged` (por defecto) | Sin acuse | `sent`, `indeterminate`, `fallback` |
| `progress` | En curso | `pending`, `sending` |
| `failed` | Fallidas | `failed` |
| `acknowledged` | Acusadas | `acknowledged` |

El filtrado es **en cliente** sobre lo cargado (`items.filter(... notificationGroups[tab])`).

### 3.4 Estados de `statusLabel` y tono (`statusState`) — de `soc-data-ui.tsx`

| `status` | `statusLabel` | `statusState` → tono | Glifo |
| --- | --- | --- | --- |
| `pending` | En cola | `neutral` | – |
| `sending` | Enviando | `info` | i |
| `sent` | **Entregada · sin acuse** | `neutral` | – |
| `indeterminate` | Entrega no confirmada | `warn` | ! |
| `fallback` | Canal alterno | `warn` | ! |
| `failed` | Fallida | `fail` | × |
| `acknowledged` | **Acusada por una persona** (`NotificationStateCell` sobrescribe el label) | `ok` | ✓ |

> **Desviación honesta respecto de [doc 04 §6.1](04-pantallas.md):** el documento pedía el texto
> «sin acuse» en `--state-warn`; la implementación renderiza `sent` como chip **neutral**
> (`statusState('sent') → neutral`), con el aviso de urgencia delegado al indicador de vencimiento
> (`.soc-overdue`, rojo) a los 15 min. Marcar como ajuste de implementación, no inventar el color.

### 3.5 Interacciones

- **Acuse (confirmación en línea, 2 fases — [doc 06 §6](06-patrones-de-interaccion.md)):** primer
  clic → el botón pasa a **«Confirmar acuse»** durante **4 000 ms** (`setConfirmId` + timeout);
  segundo clic dentro de la ventana → `api.acknowledgeNotification(id)`, botón «Acusando…»
  (`busyId`), y al confirmar recarga la lista. El botón de acuse solo aparece para
  `status ∈ {sent, indeterminate, fallback}`.
- **Vencimiento**: `overdue` cuando `sentAt` existe, `status==='sent'` y han pasado **> 15 min**
  (`15 * 60_000`). Render: `small.soc-overdue` «! 15 min sin acuse humano» en rojo.
- **Despachar ahora (excepcional)**: solo si `session.capabilities.includes('notifications.dispatch')`.
  `api.dispatchNotifications()`; resultado en `p.soc-page-note`: «Pasada inmediata: N elementos
  procesados.» o «No hay elementos pendientes de despacho.». No sustituye al worker ni cambia el
  acuse humano. **No hay botón «Reintentar»** (no existe en el backend).
- **Actualizar / cargar más**: `Actualizar` recarga; `Cargar más notificaciones` usa `nextCursor`
  con `append=true` (acumula). Pie: «N cargadas · la consulta tiene más resultados».
- **En vivo**: `useChanges({resourceTypes:['notification']})` → aviso «Dato nuevo entrando» y
  clase `soc-live-change` en las filas afectadas; recarga vía `onChange`.
- **Canal (`channel`)**: `teams → «Microsoft Teams»`, `fallback_email → «Correo alterno»`, resto
  → «Consola».

### 3.6 Estados de la vista

| Estado | Render |
| --- | --- |
| Cargando con datos | `p.soc-page-note` role=status «Actualizando notificaciones…» (no borra la tabla) |
| Vacío por pestaña (hay más páginas) | `EmptyState` «No hay notificaciones de este estado entre las páginas cargadas.» |
| Vacío por pestaña (sin más páginas) | `EmptyState` «No hay notificaciones de este estado en la consulta.» |
| Error | `ErrorState` con `correlationId` + «Reintentar»; un fallo de red cae a `DEPENDENCY_DEGRADED` con `correlationId` generado (`crypto.randomUUID`) |
| Acuse en conflicto | un 409 recarga la fila (patrón doc 06 §5) |

> **Nota sobre `.soc-compact-list`:** la variante `.soc-compact-list--notifications` del CSS
> pertenece al **Resumen** («Críticas sin acuse», [doc 04 §1](04-pantallas.md)), no a esta vista.
> `/notifications` renderiza con `.soc-table`, no con `.soc-compact-list`. El reflujo de
> `.soc-compact-list--notifications` en ≤760px (`grid-template-columns:1fr 1fr`, `time`→
> `grid-column:2`) aplica al Resumen; se documenta aquí solo para evitar confundir ambas.

### 3.7 Responsividad (breakpoints exactos)

- **≥1101px:** tabla completa en 7 columnas.
- **≤1100px:** riel a 56px (shell); la tabla conserva columnas con scroll horizontal
  (`.soc-table-scroll`).
- **≤760px:** `.soc-table th,td{padding-inline:9px}`; `.soc-tabs button`, `.soc-button` a
  `min-height:44px`; el encabezado apila (`.soc-page-heading{align-items:flex-start; gap:10px}`,
  `.soc-page-heading__meta{display:grid; justify-items:end; gap:5px}`). La tabla sigue siendo
  tabla (no se convierte en lista) y usa scroll lateral.
- **`prefers-reduced-motion`:** `.soc-live-change{animation:none}` (regla explícita del CSS).

### 3.8 Prohibido (/notifications)

- Tratar «entregada» como «atendida»: el acuse humano es obligatorio y explícito.
- Mostrar un botón «Reintentar» (no existe) ni optimistic update del acuse (el chip cambia solo
  al confirmar el servidor).
- Exponer «Despachar ahora» sin `notifications.dispatch` (ausente, no deshabilitado).
- Inventar prioridad/color verde por ausencia de fallo.

---

## 4 · `/settings/notifications` «Avisos en tus dispositivos» (push)

Componente `PushNotificationSettingsPage` (`PushNotificationSettingsPage.tsx`). **Nivel:** API ·
`GET /api/me/push/*` · capability `notifications.read` (la ruta de API revalida sesión y
capability). **Propósito:** opt-in personal de Web Push (VAPID) para P1 e incidentes críticos.
**No solicita permiso al cargar la ruta**: solo al activar. El push transporta una señal vacía;
QAPAQ entrega el detalle tras validar la sesión.

### 4.1 Anatomía ASCII (clases reales)

```
section.soc-page.soc-push-settings
├─ header.soc-page-heading
│   ├─ div  h1#push-settings-title «Avisos en tus dispositivos»
│   │       p «Activa avisos push para alertas P1 e incidentes críticos que puedes consultar.»
│   └─ span.soc-page-heading__meta  «Preferencia personal»
│
├─ [error]  div.soc-push-feedback.soc-push-feedback--error (role=alert)  WarningIcon + msg·Ref. + Button ghost «Reintentar»
├─ [notice] p.soc-push-feedback (role=status)  {notice}
├─ [!config.enabled]  div.soc-push-unavailable (role=status)  InfoIcon + «Avisos al dispositivo no disponibles en este ambiente.»
│
└─ div.soc-push-grid                      (grid 1.15fr / 0.85fr ≥761px)
    ├─ section.soc-push-card «Este dispositivo»
    │    ├─ div.soc-push-card__header  (mark BellSimple) h2 «Este dispositivo» · p + StatusChip(permiso)
    │    ├─ label.soc-push-label «Nombre del dispositivo» + input(maxLength 80)
    │    └─ div.soc-push-actions
    │         Button--primary (BellSimple) «Activar en este dispositivo» / «Actualizar nombre…» / «Guardando…»
    │         + span.soc-push-help (denegado / límite N / iOS)
    │
    ├─ section.soc-push-card.soc-push-preview «Vista previa»
    │    ├─ div.soc-push-card__header  (mark--severity WarningIcon) h2 «Vista previa» · p
    │    ├─ article.soc-push-preview__notice  span.glyph «◆» + «Aviso crítico del SOC» / «P1 o incidente crítico · Abrir QAPAQ para investigar»
    │    └─ p.soc-push-privacy  ShieldCheck + «El servicio de push recibe una señal vacía. …»
    │
    ├─ section.soc-push-card.soc-push-card--wide «Mis dispositivos»
    │    ├─ div.soc-push-card__section-heading  h2 «Mis dispositivos» · p + Button(PaperPlaneTilt) «Enviar aviso de prueba»
    │    ├─ p.soc-push-empty  «Cargando tus dispositivos…» / «Aún no has activado avisos en ningún dispositivo.»
    │    └─ ul.soc-push-devices  li( icon · main{label/service} · date{lastSuccessAt} · Button--danger(Trash) «Quitar» )
    │
    └─ section.soc-push-card.soc-push-card--wide «Política de avisos del SOC»
         ├─ div.soc-push-card__section-heading  h2 · p
         ├─ div.soc-push-policy  (head Evento/Roles/Entrega + 3 filas con .soc-push-channels)
         ├─ p.soc-push-policy-note  (Teams por rol; correo de respaldo; push opcional)
         └─ div.soc-push-legend  (Teams · Correo de respaldo · Dispositivo activado)
```

### 4.2 Tabla elemento → clase → medidas → token (escala real)

| Elemento | Clase | Medidas | Token |
| --- | --- | --- | --- |
| Sección raíz | `.soc-push-settings` | `display:grid; gap:14px` | — |
| Rejilla | `.soc-push-grid` | `grid-template-columns:minmax(0,1.15fr) minmax(280px,0.85fr); gap:12px; align-items:start` | — |
| Tarjeta | `.soc-push-card` | `min-width:0; padding:15px; border:1px solid var(--border-default); border-radius:9px` | `--surface-1` |
| Tarjeta ancha | `.soc-push-card--wide` | `grid-column:1 / -1` | — |
| Cabecera tarjeta | `.soc-push-card__header` | flex, `gap:12px; min-height:40px; margin-bottom:14px` | — |
| Marca (icono) | `.soc-push-card__mark` | `36×36; border:1px solid var(--border-control); border-radius:9px`; svg 20px | `--text-1` |
| Marca severidad | `.soc-push-card__mark--severity` | `border-color:var(--sev-1); color:var(--sev-1)` | `--sev-1` |
| H2 de tarjeta | `.soc-push-card__header h2` | `font-size:15px; font-weight:550` | `--text-1` |
| Subtítulo | `.soc-push-card__header p` | `font-size:12px; margin:4px 0 0` | `--text-3` |
| Chip de permiso | `.soc-status` (en header) | `margin-left:auto` | tono ok/fail/neutral |
| Label de nombre | `.soc-push-label` | `display:grid; gap:6px; font-size:12px` | `--text-3` |
| Input de nombre | `.soc-push-label input` | `width:100%; min-height:38px; padding:8px 10px; border:1px solid var(--border-control); border-radius:7px` | `--surface-2`, `--text-1` |
| Acciones | `.soc-push-actions` | flex wrap, `gap:10px; margin-top:13px`; svg 17px | — |
| Ayuda | `.soc-push-help` | `font-size:12px` | `--text-3` |
| Aviso previa | `.soc-push-preview__notice` | flex, `gap:11px; padding:13px; border:1px solid var(--border-default); border-left:2px solid var(--sev-1); border-radius:7px` | `--surface-2` |
| Glifo ◆ | `.soc-push-preview__glyph` | `32×32; border:1px solid var(--sev-1); border-radius:50%` | `--sev-1` |
| Privacidad | `.soc-push-privacy` | flex, `gap:7px; font-size:11px`; svg 15px | `--text-3` |
| Encabezado de sección | `.soc-push-card__section-heading` | flex, space-between, `gap:12px; margin-bottom:12px` | — |
| Lista dispositivos | `.soc-push-devices li` | `display:grid; min-height:58px; grid-template-columns:36px minmax(130px,1fr) minmax(170px,0.9fr) auto; gap:10px; border-top:1px solid var(--border-subtle)` | — |
| Icono dispositivo | `.soc-push-device-icon` | `32×32; border:1px solid var(--border-default); border-radius:8px`; svg 18px | `--text-2` |
| Nombre dispositivo | `.soc-push-device-main strong` | `font-size:13px; font-weight:500; text-overflow:ellipsis` | `--text-1` |
| Servicio / fecha | `.soc-push-device-main small`, `.soc-push-device-date time` | `font-size:11px; ellipsis` | `--text-3` |
| Etiqueta fecha | `.soc-push-device-date strong` | `font-size:10px; font-weight:500` | `--text-3` |
| Botón quitar | `Button variant="danger"` | `.soc-button--danger`, borde `rgb(255 95 87 / 60%)` | `--state-fail` |
| Vacío dispositivos | `.soc-push-empty` | `padding:15px 0 3px; border-top:1px solid var(--border-subtle); font-size:12px` | `--text-3` |
| Política (tabla) | `.soc-push-policy` | `overflow-x:auto; border:1px solid var(--border-default); border-radius:7px`; filas `min-width:600px` grid 3 col | `--text-2` |
| Cabecera política | `.soc-push-policy__head` | `min-height:32px; font-size:10px; 600; +0.04em; uppercase` | `--surface-2`, `--text-3` |
| Canales | `.soc-push-channels` | inline-flex, `gap:11px`; svg 17px | `--text-2` |
| Nota política | `.soc-push-policy-note` | flex wrap, `gap:6px; font-size:11px`; svg 15px | `--text-3` |
| Leyenda | `.soc-push-legend` | flex wrap, `gap:12px; font-size:11px` | `--text-3` |
| Feedback | `.soc-push-feedback` | flex, `gap:8px; padding:10px 12px; border:1px solid var(--border-default); border-radius:7px` | `--surface-1`, `--text-2` |
| Feedback error | `.soc-push-feedback--error` | `border-color:var(--sev-1); color:var(--text-1)`; botón `margin-left:auto` | `--sev-1` |
| No disponible | `.soc-push-unavailable` | igual que feedback | `--text-2` |

### 4.3 Interacciones (VAPID, prueba, baja, confirmaciones)

- **Estado de permiso (`BrowserPermission`)**: `granted` «Permiso concedido» (chip `ok`) ·
  `denied` «Permiso bloqueado en el navegador» (chip `fail`) · `default` «Aún no solicitado»
  (chip `neutral`) · `unsupported` «Este navegador no admite avisos push» (chip `neutral`). Se
  lee `window.Notification.permission` al montar; **no se pide permiso al cargar**.
- **Activar (`activate`, VAPID)**: valida ambiente (`config.enabled` + `vapidPublicKey`),
  contexto seguro y soporte (`serviceWorker`/`PushManager`), y nombre 1–80 caracteres. Pide
  permiso **solo si** `default`; si no queda `granted`, aborta. Registra el service worker
  (`${basePath}sw.js`, scope `basePath`), obtiene/crea la suscripción
  (`subscribe({userVisibleOnly:true, applicationServerKey: applicationKey(vapidPublicKey)})`),
  y envía `endpoint` + claves `p256dh`/`auth` (base64url) a `api.registerPushDevice`. Guarda el
  id en `localStorage['qapaq.push.device-id.v1']`. Éxito → notice «Este dispositivo ya puede
  recibir avisos importantes del SOC.». El botón muestra «Guardando…» mientras `busy==='activate'`
  y su rótulo es «Actualizar nombre del dispositivo» si ya hay registro local, si no «Activar en
  este dispositivo».
- **`canActivate`**: `config.enabled && vapidPublicKey` **y** soporte **y** `permission!=='denied'`
  **y** (por debajo del límite de dispositivos **o** editando el propio). Deshabilita el botón si
  no se cumple.
- **Enviar aviso de prueba (`sendTest`)**: `api.sendPushTest()`; notice según `delivered`: «El
  servicio push aceptó el aviso de prueba para N dispositivo(s).» o «No se confirmó la entrega.
  Revisa el permiso del navegador y el estado del dispositivo.». Deshabilitado si no hay
  dispositivos.
- **Baja de dispositivo (`removeDevice`)**: `api.revokePushDevice(id)`; si es el dispositivo
  local, hace `subscription.unsubscribe()` y limpia `localStorage`. Si el navegador no confirma
  la baja local → notice «QAPAQ dejó de enviar avisos a este dispositivo; el navegador no
  confirmó la baja local.». Botón `danger` con `aria-label="Quitar {label}"`.
- **Errores**: todo error compone `«{message} · Ref. {correlationId}»` en
  `.soc-push-feedback--error` (role=alert) con «Reintentar» (`load`).
- **Marcas de navegador/servicio (`deviceIcon`)**: Phosphor seleccionadas por hostname —
  Apple (`AppleLogo`), Google/FCM (`GoogleChromeLogo`), Windows/Mozilla (`Laptop`), resto
  (`DeviceMobile`). El `service` (hostname) se mantiene como texto verificable en `small`.
- **Fechas (`formatDate`)**: `Intl.DateTimeFormat('es-PE', America/Lima)`; nulo → «Sin entrega
  confirmada»; inválida → «Fecha no disponible».

### 4.4 Estados

| Estado | Render |
| --- | --- |
| Cargando | `p.soc-push-empty` role=status «Cargando tus dispositivos…»; acciones deshabilitadas |
| Ambiente sin push | `.soc-push-unavailable` «Avisos al dispositivo no disponibles en este ambiente.» (cuando `!config.enabled && !loading`) |
| Lista vacía | `.soc-push-empty` «Aún no has activado avisos en ningún dispositivo.» |
| Permiso denegado | `.soc-push-help` «Cambia el permiso de avisos desde la configuración del navegador.» |
| Límite de dispositivos | `.soc-push-help` «Alcanzaste el límite de {maximumDevices} dispositivos.» |
| iOS | `.soc-push-help` «En iOS, la recepción puede requerir añadir QAPAQ a la pantalla de inicio.» |
| Error (carga/registro/prueba/baja) | `.soc-push-feedback--error` con `message · Ref. correlationId` + «Reintentar» |
| Éxito | `.soc-push-feedback` role=status con el notice correspondiente |

### 4.5 Responsividad (breakpoints exactos)

- **≥1101px:** `.soc-push-grid` a **2 columnas** (`1.15fr` / `minmax(280px, 0.85fr)`); «Este
  dispositivo» y «Vista previa» lado a lado; «Mis dispositivos» y «Política» a ancho completo
  (`--wide`).
- **≤1100px:** riel a 56px (shell). La `.soc-push-grid` **no** cambia a 1100 (solo en ≤760).
- **≤760px:**
  - `.soc-push-grid{grid-template-columns:minmax(0,1fr)}` → **una columna**; `.soc-push-card--wide{grid-column:auto}`.
  - `.soc-push-card__header{align-items:flex-start; flex-wrap:wrap}`; el chip baja con
    `.soc-push-card__header .soc-status{margin-left:48px}`.
  - `.soc-push-card__section-heading{align-items:stretch; flex-direction:column}` y su
    `> .soc-button{width:100%}`.
  - `.soc-push-devices li{grid-template-columns:34px minmax(0,1fr) auto; gap:8px}`;
    `.soc-push-device-date{grid-column:2; grid-row:2}`; `li > .soc-button{grid-column:3; grid-row:1 / span 2}`.
  - `.soc-push-card{padding:13px}`; `.soc-push-actions > .soc-button{width:100%}`.
  - `.soc-push-policy > div{min-width:550px}` (scroll horizontal se mantiene).
  - `.soc-push-feedback{flex-wrap:wrap}`; `.soc-push-feedback .soc-button{margin-left:0}`.
  - Táctiles 44px (`.soc-button` global); el input de nombre hereda `font:inherit` (revisar 16px:
    **no hay** regla 16px específica para `.soc-push-label input` — ver §4.7).
- **`prefers-reduced-motion`:** sin animación de entrada.

### 4.6 Prohibido (/push)

- Pedir permiso de notificaciones al abrir la ruta (solo al activar).
- Prometer que Teams fue leído: el acuse ocurre en QAPAQ; el push es opt-in y recupera solo
  elementos recientes autorizados.
- Mostrar endpoints o claves de la suscripción (solo label, service/hostname y última aceptación).
- Dejar que otra persona quite dispositivos ajenos (solo el propio usuario).
- Usar packs de iconos genéricos fuera de las marcas Phosphor seleccionadas por hostname.

### 4.7 Micro-detalles y marcados (/push)

1. El `textarea`/`input` de las demás vistas sube a 16px en móvil; `.soc-push-label input`
   **no** tiene regla de 16px en `soc-responsive.css`. **Marcado como pendiente** (riesgo de
   zoom iOS al enfocar el nombre). No inventar la regla; registrarla como mejora.
2. `applicationKey` convierte la clave VAPID base64url → `Uint8Array` (reemplaza `-`/`_`,
   rellena `=`). Las claves `p256dh`/`auth` se reenvían en base64url (sin `=` final).
3. La «Vista previa» usa el glifo `◆` (P1) dentro del círculo `--sev-1`; es ilustrativa, no un
   dato real.
4. La tabla de política tiene `min-width:600px` (`550px` en móvil) y scroll propio; nunca
   deforma la tarjeta.
5. `maximumDevices` viene de `config`; el límite por diseño es 10 ([doc 04 §6.4](04-pantallas.md)).

---

## 5 · Responsividad — los tres breakpoints, consolidados

Breakpoints autoritativos de `soc-responsive.css`: **1100px** y **760px** (más la media
`prefers-reduced-motion`). No se introducen breakpoints nuevos.

| Reflow | ≥1101px | ≤1100px | ≤760px |
| --- | --- | --- | --- |
| Riel (shell) | 232px (según toggle) | **forzado 56px** | 56px |
| Topbar (shell) | 52px | 52px | 50px, padding 12px |
| `.soc-source-grid` | 2 col | **2 col** (sin cambio) | **1 col** |
| `.soc-push-grid` | 2 col | **2 col** (sin cambio) | **1 col** |
| `.soc-events-filters` | fila (flex wrap) | fila | `align-items:stretch`; labels `flex:1 1 135px` |
| `.soc-events-filter-groups` | fila | fila | **columna** (`flex-direction:column`) |
| `.soc-events-checkgroup` | `min-width:190px` | id. | `width:100%` |
| `.soc-events-query textarea` | `min-height:82px` | id. | `min-height:104px; font-size:16px` |
| `.soc-events-mode` | inline | inline | `width:fit-content; min-height:44px` |
| `.soc-source-history li` | `auto 1fr auto` | id. | `1fr` (apilado) |
| `.soc-push-devices li` | `36px 1fr 0.9fr auto` | id. | `34px 1fr auto` (fecha y botón reubicados) |
| `.soc-push-policy` filas | `min-width:600px` | id. | `min-width:550px` |
| Tablas `.soc-table` | `padding:6px 12px` | id. | `padding-inline:9px` |
| Drawer | `width:min(480px, 100vw−riel)` | id. | `inset:50px 0 0; width:100%` |

**Táctiles (≤760px):** `.soc-button`, `.soc-tabs button`, `.soc-row-link`, `.soc-profile summary`
→ `min-height:44px`; `.soc-command-button` → 44×44. **Inputs 16px (anti-zoom iOS, ≤760px):**
`.soc-events-filters select`, `.soc-events-query textarea`, y los inputs de filtros/tareas/sesiones
suben a `font-size:16px`. **Excepción marcada:** `.soc-push-label input` (nombre de dispositivo)
no tiene regla de 16px (§4.7).

---

## 6 · Checklist de aceptación

### /events
- [ ] Modos Filtros/Consulta con radios; `changeMode` no cambia si la consulta no parsea.
- [ ] Editor `q` seguro: `maxLength 512`, mono, sin SQL/DSL; validación en vivo con posición.
- [ ] Ctrl/Cmd+Enter envía solo si `q` es válida; «Buscar» deshabilitado con `q` inválida.
- [ ] Rango 24h / 7d / 31d (744h máx.); cambiarlo reinicia la paginación.
- [ ] Outcomes como Exitoso / Fallido / Desconocido.
- [ ] `status=disabled` → «Fuente de eventos no configurada», no cola vacía.
- [ ] `unparsedCount>0` → `.soc-partial-banner`; vacío por filtros con mensaje propio.
- [ ] Pestaña «Crudo» solo con `events.read_raw`.
- [ ] Paginación opaca (Anterior/Siguiente) en memoria; sin total.

### /sources
- [ ] Una sola fuente Wazuh; suscripciones M365 anidadas en `details`.
- [ ] «No medido · no confirma salud» cuando `subscriptions===null`.
- [ ] Texto explícito: la medición de suscripciones no determina la salud de la fuente.
- [ ] **Cero eventos = neutral**; `unknown`/`disabled` = neutral; solo «Fallida» usa `--state-fail`.
- [ ] Ventana de 24 h visible en el `summary` de suscripciones.
- [ ] Dos marcas de tiempo distintas: «Evaluado por el servidor» (checkedAt) y «Actualizado» (cliente).
- [ ] Transiciones auditables con `RelativeTime`; refresco por `/api/changes`.

### /notifications
- [ ] Pestañas Sin acuse / En curso / Fallidas / Acusadas con agrupación correcta.
- [ ] `statusLabel`: sent «Entregada · sin acuse», acknowledged «Acusada por una persona», etc.
- [ ] Acuse en dos fases (4 s «Confirmar acuse»); sin optimistic update.
- [ ] Vencida a 15 min → `.soc-overdue` rojo «! 15 min sin acuse humano».
- [ ] «Despachar ahora» solo con `notifications.dispatch`; sin botón «Reintentar».
- [ ] Nota de cierre: «entregada requiere el acuse de una persona».

### /settings/notifications (push)
- [ ] No pide permiso al cargar; solo al activar (VAPID).
- [ ] Nombre 1–80; `canActivate` respeta ambiente, soporte, permiso y límite.
- [ ] Prueba, baja (solo propios) y actualización de nombre funcionan con `correlationId` en errores.
- [ ] Vista previa con señal vacía; política de solo lectura (Teams/Correo/Push).
- [ ] Reflujos 760: grid 1 col, dispositivos reubicados, política con scroll.
- [ ] **Pendiente marcado:** input de nombre sin `font-size:16px` en móvil.

### Transversal
- [ ] Todo error con `correlationId` + «Reintentar».
- [ ] Cero ámbar de contenido; cero sombras de tarjeta; cero texto en inglés.
- [ ] Táctiles 44px e inputs 16px en ≤760px (salvo la excepción del nombre de dispositivo).
- [ ] `prefers-reduced-motion`: todas las vistas legibles sin animación.

---

## 7 · Trazabilidad

- Dirección, prohibiciones y modelo de una sola fuente: [`10-vistas-por-rol-y-referencias.md`](10-vistas-por-rol-y-referencias.md)
  (Salud de fuentes v4/v5; «Lo que el diseño debe evitar»).
- Pantallas: [`04-pantallas.md`](04-pantallas.md) §2 (Eventos), §6 y §6.4 (Notificaciones y push),
  §7.4 (Salud de fuentes).
- Estados, errores (`correlationId`), confirmación en línea y actualización en vivo:
  [`06-patrones-de-interaccion.md`](06-patrones-de-interaccion.md) §3/§4/§5/§6/§7.
- Tokens, escala, breakpoints y shell: [`11-mi-sesion-y-shell-spec.md`](11-mi-sesion-y-shell-spec.md).
- Código:
  - `apps/web/src/components/soc/EventsPage.tsx`,
  - `apps/web/src/components/soc/SourcesHealthPage.tsx`,
  - `apps/web/src/components/soc/NotificationPage.tsx`,
  - `apps/web/src/components/soc/PushNotificationSettingsPage.tsx`,
  - `apps/web/src/components/soc/soc-data-ui.tsx` (`PageHeader`, `statusLabel`, `statusState`,
    `NotificationStateCell`), `soc-ui.tsx` (`StatusChip`, `Button`, `SocIcon`).
  - CSS: `apps/web/src/app/soc-data.css` (contenido de las cuatro vistas),
    `soc-overlays.css` (`.soc-drawer`), `soc-shell.css` (`.soc-status`, tokens),
    `soc-responsive.css` (breakpoints 1100/760 y `prefers-reduced-motion`).

> **Notas de honestidad (lo no implementado o desviado, marcado):**
> 1. `/notifications`: `sent` se renderiza como chip **neutral**, no con «sin acuse» en
>    `--state-warn` como pedía el doc 04 §6.1; la urgencia se comunica con `.soc-overdue` a los
>    15 min. (Desviación de implementación.)
> 2. `/push`: `.soc-push-label input` carece de `font-size:16px` en ≤760px (posible zoom iOS).
>    (Pendiente.)
> 3. `.soc-compact-list--notifications` del CSS pertenece al **Resumen**, no a `/notifications`,
>    que usa `.soc-table`. (Aclaración para no confundir clases.)
