# 13 · Especificación intensiva — Alertas e Incidentes

**Estado:** especificación de diseño e implementación, escrita contra el código real del
2026-10-13 (`apps/web/src/components/soc/*` y `apps/web/src/app/soc-*.css`). Los valores de
tokens, clases, medidas y breakpoints son **textuales del código**, no aspiracionales.
**Alcance:** las dos vistas operativas centrales del analista de turno:

1. **Cola de alertas + detalle/investigación** — ruta `/alerts`, `/alerts/:id` —
   `AlertQueuePage.tsx` + `AlertDetailDrawer.tsx`.
2. **Incidentes e investigación** — ruta `/incidents`, `/incidents/:id` —
   `IncidentPage.tsx` + `IncidentWorkTabs.tsx`.

> **Fuente de verdad de tokens, escala, breakpoints y principios:**
> [`11-mi-sesion-y-shell-spec.md`](11-mi-sesion-y-shell-spec.md). Este documento **no
> redefine** tokens: los referencia (`--space-*`, `--sev-*`, `--surface-*`, `--text-*`,
> radios 6/9/999, familias/escala tipográfica del doc 11 §1). Los patrones de estado, error,
> concurrencia y confirmación vienen de
> [`06-patrones-de-interaccion.md`](06-patrones-de-interaccion.md); el alcance por rol y las
> prohibiciones de [`10-vistas-por-rol-y-referencias.md`](10-vistas-por-rol-y-referencias.md);
> el contrato de pantalla de [`04-pantallas.md`](04-pantallas.md) §3 (Alertas) y §4
> (Incidentes).

> **Honestidad de implementación (leer antes de calcar).** Donde el código actual difiere de
> `04-pantallas.md`, esta spec documenta **lo que el código hace hoy** y marca lo no
> implementado como tal. Diferencias verificadas el 2026-10-13:
> - **La franja de prioridad de 3 px NO está implementada.** No existe regla CSS para
>   `.soc-alert-row`, `data-priority` ni `box-shadow: inset 3px 0 0 var(--sev-*)` en ningún
>   `soc-*.css`. La clase `soc-alert-row` se aplica en el TSX pero **no tiene estilo**. Hoy el
>   color de prioridad vive **solo** en el glifo + rótulo del componente `Severity` dentro de
>   la columna «Prioridad». La franja de 3 px queda como **mejora pendiente** (§7).
> - **No hay columna de selección ni acciones masivas** (`04 §3.3`/`§3.6`): la tabla no tiene
>   checkbox ni barra de selección. No implementado.
> - **Las pestañas de estado no llevan contador** (`04 §3.2`): solo el rótulo. No implementado.
> - **El indicador de pestaña activa es blanco `--text-1`, no ámbar** (`.soc-tabs
>   button.is-active::after`, 2 px). Difiere de la convención «ámbar = selección» del doc 11
>   §0.2; se documenta el estado real.
> - **La fase de respuesta es una fila de píldoras** (`.soc-lifecycle`), **no** un
>   `LifecycleStepper` con conectores ni paso «omitido» punteado (`04 §4.2`). No implementado
>   como stepper.
> - **No existe `CommandDialog`/`ReasonRequiredDialog` para alertas/incidentes:** todos los
>   comandos con formulario se renderizan **en línea** dentro del bloque `.soc-actions` del
>   drawer (`04 §3.5` pedía diálogo sobre el drawer). Se documenta el formulario en línea real.

---

## 0 · Principios aplicados (heredados del doc 11 §0 y doc 10)

1. **Para turno, no para demo.** Densidad alta, escaneo veloz. Tabla `.soc-table` a 40 px de
   fila; drawer de investigación a la derecha sin tapar la cola.
2. **Severidad SIEMPRE por glifo + rótulo + color**, nunca solo color: `◆ P1` (`--sev-1`),
   `▲ P2` (`--sev-2`), `■ P3` (`--sev-3`), `● P4` (`--sev-4`). Lo entrega el componente
   `Severity` (`soc-ui.tsx`).
3. **Autorización server-side; «ausente, no deshabilitado»** (doc 06 Z2). Un comando sin
   capability **no se renderiza**; `deshabilitado` se reserva a condiciones que la persona
   puede resolver (nota corta, guardas de cierre — doc 06 Z4).
4. **Sin actualizaciones optimistas en comandos de estado** (doc 06 §5): el chip cambia cuando
   el servidor confirma.
5. **Honestidad de estado:** cola vacía ≠ fuente sana; `—`/«Sin asignar» se muestran atenuados
   (`.soc-muted`, `--text-3`), nunca como dato real.
6. **Cero ruido:** sin glow/gradiente/sombra de tarjeta; única sombra permitida, el anillo de
   foco. Iconos solo de `SocIcon` (SVG propio, `strokeWidth 1.65`).
7. **Español** en toda cadena visible, incluidos contadores y unidades.

---

# Vista 1 — `/alerts` «Alertas»

**Componentes:** `AlertQueuePage` (`AlertQueuePage.tsx`) + `AlertDetailDrawer`
(`AlertDetailDrawer.tsx`). **Rutas:** `/alerts`, `/alerts/:id`. Parámetros de URL:
`?status=`, `?q=` (saneado, ver §1.6), `?priority=`, `?entity=ent_…`.

**Propósito.** Cola principal del analista: filtrar por estado/prioridad/texto, abrir el
detalle de una alerta e investigar/triar/asignar/escalar/abrir incidente conforme a las
transiciones autorizadas.

**Capabilities / roles (doc 10).**

| Capability | Habilita | Si ausente |
| --- | --- | --- |
| `alerts.read` | Ver la cola y el detalle (ruta navegable) | La ruta no aparece en el riel; 404 «No disponible» |
| `alerts.triage` | `Reconocer y asignarme`, `triage`, `escalate`, `close`, `reopen` | La acción **no se renderiza** |
| `alerts.assign` | Formulario `Asignar a` | No se renderiza |
| `incidents.write` | Formulario `Abrir incidente` en estado `escalated` | No se renderiza |

Reglas de rol: el **analista** opera triaje/asignación por estado; el **auditor** ve lectura
sin comandos (bloque `.soc-actions` ausente); `events.read_raw` y cierre de incidente no
pertenecen a esta vista. La comprobación server-side se mantiene aunque la acción no esté en
el cliente.

## 1.1 · Anatomía (clases reales)

```
.soc-page
┌──────────────────────────────────────────────────────────────────────────────┐
│ .soc-page-heading                                                              │
│  ┌ div ───────────────────────────┐   ┌ .soc-page-heading__meta ───────────┐  │
│  │ h1 Alertas                      │   │ «Actualizado hace 4 s» (RelativeT.)│  │
│  │ p  Filtra alertas por estado…   │   │ [⟳ Actualizar]  (.soc-button)      │  │
│  └─────────────────────────────────┘   └────────────────────────────────────┘  │
│                                                                                │
│ (.soc-live-announcement · role=status)  «Dato nuevo entrando»   ← si useChanges│
│                                                                                │
│ .soc-tabs  (role=group «Filtrar alertas por estado»)                           │
│  Abiertas │ Nuevas │ Reconocidas │ Triadas │ Escaladas │ Cerradas             │
│  └ botón .is-active → subrayado ::after 2px --text-1                            │
│                                                                                │
│ form.soc-filter-bar                                                             │
│  [⌕ .soc-search-field  «Buscar alertas por título, ID o responsable»  <kbd>/</kbd>]│
│  [label.soc-priority-filter  Prioridad  <select>]                               │
│  [Buscar (primary)]  [Limpiar filtros (ghost, si hay filtro)]                   │
│  [.soc-active-entity  «Entidad: <code>ent_…</code>»  (si ?entity=)]             │
│  span.soc-page-note «Busca en toda la cola autorizada · j / k para recorrer.»   │
│                                                                                │
│ (ErrorState .soc-error  ← solo si error && !selected)                           │
│                                                                                │
│ .soc-table-panel [ .soc-table-panel--with-drawer si hay selección ]            │
│  .soc-table-scroll                                                              │
│   table.soc-table                                                               │
│    thead: PRIORIDAD · TÍTULO · ESTADO · ASIGNADO · INCIDENTE · OCURRIDA         │
│    tbody: tr.soc-alert-row [.is-selected][.soc-live-change]                     │
│  (.soc-table-placeholder «Cargando alertas…»  |  .soc-empty  |  footer)         │
│  .soc-table-footer: [Cargar más (si cursor)]  «Mostrando N de T alertas.»       │
└──────────────────────────────────────────────────────────────────────────────┘

aside.soc-drawer  (fixed, derecha)  ← si hay alerta seleccionada  (ver §1.4)
```

> Nota: `.soc-table-panel--with-drawer` se aplica cuando hay selección, pero **no tiene regla
> CSS propia hoy** (no reduce ancho de tabla). El drawer se superpone `fixed` sobre la derecha.

## 1.2 · Pestañas de estado (`.soc-tabs`)

Cada pestaña fija `status` y recarga con `?status=`. Valores reales
(`AlertQueuePage.statuses`):

| Pestaña | `value` → filtro servidor | Por defecto |
| --- | --- | --- |
| Abiertas | `open` (cliente excluye `closed` del resultado) | **sí** |
| Nuevas | `new` | |
| Reconocidas | `acknowledged` | |
| Triadas | `triaged` | |
| Escaladas | `escalated` | |
| Cerradas | `closed` | |

- `.soc-tabs`: `display:flex; gap:22px; overflow-x:auto; border-bottom:1px solid
  var(--border-default)`. Botón: `min-height:44px; padding:0 2px; color:var(--text-3)`;
  hover/`.is-active` → `--text-1`; `.is-active::after` barra inferior de **2 px**
  `background:var(--text-1)` (no ámbar). `aria-pressed` refleja la pestaña activa.
- **Contador por pestaña: no implementado** (solo rótulo). Pendiente del endpoint de agregados
  (04 §3.2 / B-08).
- Al cambiar de pestaña se limpia la selección (`setSelected(null)`) y se navega a
  `listPath(value)`.

## 1.3 · Tabla (`.soc-table`) — columnas reales

| # | Columna (thead) | Campo | Celda / clase | Alineación |
| --- | --- | --- | --- | --- |
| 1 | PRIORIDAD | `priority` + `score` | `<Severity value score>` → `.soc-severity.soc-severity--{1..4}` | I |
| 2 | TÍTULO | `title` | `button.soc-row-link` + `<small>` con `id.slice(0,8)…` | I |
| 3 | ESTADO | `status` | `<StatusChip state={stateTone}>` (`.soc-status`) | I |
| 4 | ASIGNADO | `assigneeId` | `<code>{id.slice(0,8)}…</code>` o `.soc-muted «Sin asignar»` | I · mono |
| 5 | INCIDENTE | `incidentId` | `button.soc-inline-link` con `<code>` o `.soc-muted «—»` | I · mono |
| 6 | OCURRIDA | `occurredAt` | `<RelativeTime>` («hace N s/min/h/d», `title` absoluto es-PE) | I |

- `thead` *sticky*: `.soc-table thead { position:sticky; top:0 }`; `th` 32 px de alto, 11 px,
  600, `letter-spacing:0.06em`, **UPPERCASE**, `--text-3`.
- `td` 40 px de alto, `padding:6px 12px`, `border-bottom:1px solid var(--border-subtle)`,
  `--text-2`. Fila hover → `background:var(--surface-2)`; `tr.is-selected` →
  `background:var(--surface-selected)` (`#17140f`, cálido tenue).
- `stateTone(status)`: `triaged→ok`, `escalated→warn`, `acknowledged→info`, resto `neutral`.
- `alertStatus`: `new`→Nueva, `acknowledged`→Reconocida, `triaged`→Triada,
  `escalated`→Escalada, `closed`→Cerrada.
- **Franja de prioridad 3 px: pendiente** (§7). Hoy la prioridad se comunica íntegramente por
  el componente `Severity` (glifo + P# + color `--sev-*`) de la columna 1 — cumple la regla de
  «nunca solo color» por el glifo, pero falta el refuerzo de la franja izquierda.

## 1.4 · Drawer de detalle (`aside.soc-drawer`) — `AlertDetailDrawer`

**Contenedor.** `.soc-drawer`: `position:fixed; z-index:8; inset:52px 0 0 auto;
width:min(480px, calc(100vw - var(--rail-width))); border-left:1px solid
var(--border-default); background:var(--surface-1)`; entrada `soc-drawer-in` (`--motion-panel`
220 ms, desliza 16 px). `aria-label="Detalle de alerta: {title}"`.

```
header (min-height 64px, border-bottom)
  ├ .soc-drawer__eyebrow  «Alerta · <code>{id8}…</code>»  (11px --text-3)
  ├ h2  {title}  (16px/550/-0.02em --text-1)
  └ [× Button ghost]  aria-label «Cerrar detalle»
.soc-drawer__body (grid, gap 18px, overflow auto, padding 16px)
  ├ .soc-drawer__status : <Severity> + <StatusChip>
  ├ p.soc-signal-label  «Táctica inferida · {signalLabels[signal]}»      (si signal)
  ├ section «Entidades relacionadas» : .soc-entity-list de .soc-entity-chip  (si entities)
  │    chip con ref → botón pivote (onEntityPivot);  sin ref → span.is-static
  │    p.soc-entity-unavailable si alguna entidad no tiene ref
  ├ (ErrorState .soc-error  ← si error)
  ├ dl.soc-description-list : Ocurrida · Asignada a · Veredicto
  │    [· Incidente (link) si incidentId]  [· Evento original <code>{rawRef}</code> si rawRef]
  ├ section «Por qué esta prioridad» : ul.soc-reasons (strong {reasonLabel} + span detalle)
  ├ section «Alertas relacionadas» : ul.soc-related-alerts (si relatedAlertIds)
  └ section.soc-actions  «Acciones»   ← CALCULADO por capability + estado (ver §1.5)
```

- `dl.soc-description-list`: `grid-template-columns:120px minmax(0,1fr); gap:8px 12px;
  padding:13px 0; border-top/border-bottom:1px solid var(--border-default)`. `dt` 12 px
  `--text-3`; `dd` `--text-1`, `overflow-wrap:anywhere`.
- Campo **Evento original (`rawRef`)**: se dibuja **solo si** `selected.rawRef` existe (doc 06
  Z6: campo ausente no deja hueco). No hay botón «ver raw» en esta vista.
- `.soc-reasons`: `strong` 12 px/550 `text-transform:capitalize` `--text-2`; `span` `--text-3`.
  Etiquetas conocidas en `reasonLabels` (`BREAK_GLASS_IDENTITY`→«Identidad de emergencia»,
  `CORRELATED_ENTITY`→«Entidad vinculada», `ATTACK_CHAIN`→«Cadena de ataque»).

## 1.5 · Bloque de acciones (`section.soc-actions`) — CÁLCULO real

La sección existe **solo si** `canTriage || canAssign || canOpenIncident`. Dentro, cada
control aparece según estado + capability + «¿soy el asignado?» (`isMine = assigneeId ===
session.subjectId`). `canTake = status==='new' && canTriage`.

| Estado origen | Condición | Control renderizado (verbo real) | `name` de comando |
| --- | --- | --- | --- |
| `new` | `canTake` | **`Reconocer y asignarme`** (primary) | `acknowledge` |
| `new` | `canAssign && !canTake` | form `Asignar a` + `Asignar alerta` | `assign {assigneeId}` |
| `acknowledged` | `!isMine && canAssign` | form `Asignar a` + `Asignar alerta` | `assign {assigneeId}` |
| `acknowledged` | `isMine && canTriage` | form triaje (ver abajo) | `triage {verdict, note}` |
| `triaged` | `canTriage && verdict==='true_positive'` | **`Escalar alerta`** (primary) | `escalate` |
| `escalated` | `canOpenIncident && !incidentId` | form `Abrir incidente` | `createIncident` |
| `acknowledged`/`triaged`/`escalated` | `canTriage` | form cierre (danger) | `close {note}` |
| `closed` | `canTriage` | `Reabrir alerta` | `reopen` |

**Formulario de triaje** (en línea, `.soc-actions form`, aparece con `acknowledged && isMine &&
canTriage`):
- `select#alert-verdict`: `true_positive`→«Verdadero positivo», `false_positive`→«Falso
  positivo», `benign`→«Benigno», `duplicate`→«Duplicado». Valor inicial `true_positive`.
- `textarea#alert-note` «Sustento del triaje», `minLength=10 maxLength=2000`; `<small>{len} /
  2000 caracteres · mínimo 10»`.
- Botón primary `Registrar triaje`, `disabled = busy || note.trim().length < 10`.

**Formulario Abrir incidente** (aparece con `escalated && canOpenIncident && !incidentId`):
- `h4 «Abrir incidente»`; `input#incident-title` (`minLength=4 maxLength=160`, valor inicial
  `title` de la alerta); `textarea#incident-summary` (`minLength=10 maxLength=2000`,
  obligatorio); `<small>La severidad se deriva de la prioridad {priority}.»`.
- Severidad derivada: P1→`critical`, P2→`high`, P3→`medium`, P4→`low` (`incidentSeverity`).
- Botón primary `Abrir incidente`, `disabled = busy || summary.trim().length < 10`. Se envía
  con `expectedAlertRevision`; tras éxito navega a `/incidents/{nuevo}`.

**Formulario de cierre** (aparece con `acknowledged|triaged|escalated && canTriage`):
- `label`: «Nota de cierre (opcional)» si `triaged`; si no, «Motivo de cierre».
- `textarea#alert-close-note` `maxLength=2000`; `minLength=10` salvo cuando `triaged` (opcional).
- Botón **danger** `Cerrar alerta`, `disabled = busy || (status!=='triaged' &&
  closeNote.trim().length < 10)`.

**Formulario Asignar** (`assign`): `input` de `subjectId` en texto (valor inicial
`session.subjectId`, atajo implícito «asignarme»); no hay directorio de personas. Botón
`Asignar alerta`, `disabled = busy || !assignee.trim()`.

Si no se cumple ninguna condición, el bloque `.soc-actions` **no se dibuja** (no hay franja
vacía) — doc 04 §3.4, doc 06 Z2.

## 1.6 · Interacciones

- **Concurrencia / `expectedRevision` (doc 06 §5).** `execute(name, extra)` envía
  `{ name, ...extra, expectedRevision: selected.revision }`. Tras éxito: `setSelected(data.alert)`
  + se reemplaza la fila en `items` (**no** se repide la lista). **Sin optimistic update**: el
  chip de estado cambia solo al confirmar el servidor. Ante `STATE_CONFLICT` (409): se llama a
  `load()` para recargar y el `ErrorState` queda visible en el drawer; lo escrito en el
  formulario **se conserva** (estado local del drawer). `createIncident` usa
  `expectedAlertRevision`.
- **Niveles de confirmación (doc 06 §6).**
  - Nivel 1 **directo**: `Reconocer y asignarme`, `Escalar alerta`, `Reabrir alerta`
    (clic → envío; resultado en el propio control).
  - Nivel 3 **con motivo/nota en formulario en línea**: triaje (veredicto+nota), cierre
    (nota), asignar, abrir incidente. (No hay diálogo modal; el `CommandDialog` del doc 04
    §3.5 **no está implementado** para alertas.)
- **Teclado.** `/` enfoca la búsqueda (si el foco no está en campo); `Escape` cierra el drawer
  y vuelve a `listPath(status)`; `j`/`k` recorren filas (`.soc-row-link`). Atajos ignorados si
  el foco está en `INPUT/TEXTAREA/SELECT` o editable.
- **Búsqueda.** `form.soc-filter-bar` aplica `q` + `priority` al enviar; el input de búsqueda
  es `.soc-search-field` (`width:min(380px,100%)`, radio 999, `<kbd>/</kbd>`). El valor `q` y un
  `entity` no válido se **eliminan de la URL** (`history.replaceState`) para no retener
  UPN/IP/texto libre en el historial; `entity` solo persiste si cumple `^ent_[A-Za-z0-9_-]{22}$`.
- **Paginación por cursor.** `Cargar más` (`.soc-table-footer`) mientras `nextCursor`; pie
  «Mostrando {items.length} de {totalCount} alertas.» (tabular-nums, global). Sin números de
  página ni total opaco salvo `totalCount` del servidor.
- **En vivo (doc 06 §7).** `useChanges({resourceTypes:['alert']})` → recarga y banner
  `.soc-live-announcement` «Dato nuevo entrando»; la fila cambiada recibe `.soc-live-change`
  (animación `soc-live-arrival` 200 ms, anulada por `prefers-reduced-motion`).
- **Pivote por entidad.** Chip `.soc-entity-chip` con `ref` → `onEntityPivot` arma
  `?entity=ent_…` y recarga la cola filtrada. Foco visible del chip: `outline:2px solid
  var(--brand-amber)` (único ámbar de la vista, en foco).

## 1.7 · Estados

| Estado | Detección | Render | Clase |
| --- | --- | --- | --- |
| Cargando | `loading` sin datos | `.soc-table-placeholder` «Cargando alertas…» (`role=status`) | `.soc-table-placeholder` |
| Vacío | 200 sin filtro, 0 filas | `EmptyState` «No hay alertas para este estado.» | `.soc-empty` |
| Vacío por filtros | `appliedQuery` y 0 filas | `EmptyState` «No hay alertas que coincidan con la búsqueda. Revisa el término o limpia el filtro.» | `.soc-empty` |
| Parcial | (cola grande por cursor) | pie «Mostrando N de T» + `Cargar más` | `.soc-table-footer` |
| Degradado | salud pipeline (no en esta vista hoy) | — | — |
| Viejo | refresco fallido con datos | se mantienen datos (no hay banner stale dedicado aquí) | — |
| Error (sin selección) | `error && !selected` | `ErrorState` con `message` + **`correlationId`** copiable + `Reintentar` | `.soc-error` |
| Error (con drawer) | `error` en comando | `ErrorState` dentro de `.soc-drawer__body` (conserva formulario) | `.soc-error` |
| Sin capability de comando | capability ausente | el control **no se renderiza** (bloque puede desaparecer) | — |

- `ErrorState` siempre muestra `Referencia: <code>{correlationId}</code>` + botón copiar
  (`copy`→`check`, feedback «Copiada» 1.5 s) + `Reintentar` (doc 06 §4.1).

## 1.8 · Responsividad — 3 breakpoints EXACTOS

Breakpoints autoritativos (`soc-responsive.css`): **1100 px** y **760 px**.

**≥ 1101 px (escritorio).**
- Riel 232 px (o 56 si el usuario colapsó con `[`). Drawer
  `width:min(480px, calc(100vw - var(--rail-width)))`, anclado `inset:52px 0 0 auto`.
- Tabla completa a 6 columnas; `.soc-table-scroll` da scroll horizontal si no cabe.

**≤ 1100 px (tablet).**
- Riel **forzado a 56 px** (`.soc-app{--rail-width:56px}`): solo iconos. El drawer recalcula
  su ancho porque depende de `--rail-width` (queda `min(480px, calc(100vw-56px))`).
- `.soc-summary-grid`→1 col (afecta Resumen, no esta tabla). La tabla de alertas conserva 6
  columnas con scroll horizontal dentro de `.soc-table-scroll`.

**≤ 760 px (móvil).**
- Topbar 50 px; `.soc-workspace` padding `17px 12px`. Perfil solo-avatar; «Ir a» →
  `.soc-command-button` cuadrado **44×44**; `.soc-status` máx 145 px truncado.
- **Drawer a pantalla completa:** `.soc-drawer{ inset:50px 0 0; width:100%; border-left:0 }`.
- `.soc-page-heading__meta` → `display:grid; justify-items:end` (la acción baja bajo el título).
- `.soc-table th, .soc-table td { padding-inline:9px }`.
- `.soc-filter-bar` → `align-items:stretch`; sus `label` `flex:1 1 145px`; **inputs/selects a
  `min-height:44px; font-size:16px`** (anti-zoom iOS). Lo mismo para `.soc-actions
  input/select/textarea`.
- **Áreas táctiles 44 px:** `.soc-button, .soc-tabs button, .soc-row-link, .soc-profile
  summary { min-height:44px }`.
- **`.soc-compact-list` (patrón de listas compactas del Resumen, no de esta tabla):** a 3
  columnas `grid-template-columns:78px minmax(90px,1fr) 94px` ocultando `time`
  (`.soc-compact-list > button time { display:none }`). Las vistas Alertas/Incidentes usan
  `.soc-table` con scroll horizontal, no `.soc-compact-list`.
- `prefers-reduced-motion: reduce`: todas las animaciones/transiciones del `.soc-app` a
  0.01 ms; `.soc-live-change` sin animación.

## 1.9 · Tabla elemento → clase → medidas → token (Alertas)

| Elemento | Clase | Medidas reales | Token/color |
| --- | --- | --- | --- |
| Contenedor | `.soc-page` | entrada `soc-view-enter` 180 ms | — |
| Encabezado | `.soc-page-heading` | `min-height:48px; gap:var(--space-6); margin:0 0 var(--space-6)` | — |
| H1 | `.soc-page-heading h1` | 20px/480/−0.025em, line 28px | `--text-1` |
| Descripción | `.soc-page-heading p` | 13px, `margin-top:4px` | `--text-2` |
| Meta | `.soc-page-heading__meta` | `gap:14px`, 12px, `white-space:nowrap` | `--text-3` |
| Pestañas | `.soc-tabs` | `gap:22px; border-bottom 1px` | `--border-default` |
| Pestaña botón | `.soc-tabs button` | `min-height:44px; padding:0 2px` | `--text-3`→`--text-1` |
| Activa | `.soc-tabs button.is-active::after` | barra **2px** | `--text-1` (no ámbar) |
| Barra filtros | `.soc-filter-bar` | `gap:var(--space-3); margin:var(--space-4) 0` | — |
| Campo búsqueda | `.soc-search-field` | `width:min(380px,100%); min-height:40px; radius 999` | `--surface-2` |
| Select prioridad | `.soc-priority-filter select` | `min-width:160px; min-height:40px; radius 7px` | `--border-control` |
| Botón | `.soc-button` | `min-height:40px; padding:0 14px; radius 999; 13px/550` | `--border-control` |
| Botón primario | `.soc-button--primary` | fondo blanco | `--text-1` / `--surface-0` |
| Botón peligro | `.soc-button--danger` | borde `rgb(255 95 87/60%)` | `--state-fail` |
| Panel tabla | `.soc-table-panel` | `border-top/bottom 1px; overflow:hidden` | `--surface-1` |
| `th` | `.soc-table th` | `height:32px; 11px/600; 0.06em; UPPERCASE` | `--text-3` |
| `td` | `.soc-table td` | `height:40px; padding:6px 12px` | `--text-2` / `--border-subtle` |
| Fila seleccionada | `.soc-table tbody tr.is-selected` | — | `--surface-selected` `#17140f` |
| Severidad | `.soc-severity--{1..4}` | glifo 10px + `strong` 12px/600 + `small` 11px | `--sev-1..4` |
| Chip estado | `.soc-status` | `min-height:22px; padding:1px 8px; radius 999` | por `--state-*` |
| Código inline | `td code` / `.soc-inline-link code` | 12px mono | `--text-1`/`--text-3` |
| Drawer | `.soc-drawer` | `width:min(480px,calc(100vw - rail)); inset:52px 0 0 auto` | `--surface-1` |
| Título drawer | `.soc-drawer > header h2` | 16px/550/−0.02em | `--text-1` |
| Lista detalle | `.soc-description-list` | `cols 120px 1fr; gap:8px 12px; padding:13px 0` | `--border-default` |
| Razones | `.soc-reasons` | `gap:9px`; `strong` 12px/550 capitalize | `--text-2`/`--text-3` |
| Acciones | `.soc-actions` | `gap:10px; padding-top:14px; border-top 1px` | `--border-default` |
| Input acción | `.soc-actions input/select/textarea` | `min-height:40px; radius 7px`; textarea `min-height:88px` | `--surface-2` |

Severidad (glifo + P# + color) obligatoria, siempre: `◆ P1 --sev-1` · `▲ P2 --sev-2` ·
`■ P3 --sev-3` · `● P4 --sev-4`.

---

# Vista 2 — `/incidents` «Incidentes»

**Componentes:** `IncidentPage` (`IncidentPage.tsx`) + `IncidentWorkTabs`
(`IncidentWorkTabs.tsx`: `TasksTab`, `NotesTab`, `TimelineTab`). **Rutas:** `/incidents`,
`/incidents/:id`. Parámetros: `?status=active|resolved|closed`, `?tab=tasks|notes|timeline`,
`?q=`, `?open=`.

**Propósito.** Investigar incidentes: lista/búsqueda, detalle con fase de respuesta, alertas
vinculadas, reasignación, tareas, bitácora append-only, timeline, y cierre con guardas.

**Capabilities / roles (doc 10).**

| Capability | Habilita | Si ausente |
| --- | --- | --- |
| `incidents.read` | Ver lista y detalle | Ruta no navegable |
| `incidents.write` | Reasignar, `contain`/`eradicate`/`resolve`/`reopen`, crear/operar tareas base | No se renderiza |
| `incidents.close` | Cierre del incidente (`close`) | El form de cierre no aparece; la fase `resolved` se ve igual, sin explicación (04 §4.3) |
| `incidents.tasks.write` | Crear/operar tareas (pestaña Tareas) | Solo lectura de tareas |
| `incidents.notes.write` | Agregar/corregir notas (Bitácora) | Solo lectura de bitácora |
| `alerts.read` | Ver alertas vinculadas y sus veredictos | «No tienes permiso para consultar las alertas vinculadas.» |
| `audit.read` | «Actividad auditada» del incidente + transiciones del timeline | Bloque ausente; timeline avisa «Transiciones visibles solo con permiso de auditoría» |

El **auditor** ve lista y detalle **sin ningún botón** de acción. `incidents.close` ausente →
no hay botón de cierre para el analista.

## 2.1 · Anatomía — lista (`.soc-page`)

```
.soc-page
 PageHeader: h1 «Incidentes» · p «Investiga alertas vinculadas, cambios auditados y fase…»
            · meta «Actualizado …» + [⟳ Actualizar]
 (.soc-live-announcement «Dato nuevo entrando»  ← useChanges)
 .soc-tabs (role=group): Activos │ Resueltos │ Cerrados
 form.soc-filter-bar: [⌕ «Buscar por incidente, identificador o responsable»]
                      [Buscar (primary)] [Limpiar búsqueda (ghost)]
                      span.soc-page-note «Resultados en toda la cola autorizada.»
 (ErrorState  ← si error)
 .soc-table-panel › .soc-table-scroll › table.soc-table
   thead: SEVERIDAD · INCIDENTE · FASE · RESPONSABLE · ALERTAS · ABIERTO
   tbody: tr[.is-selected][.soc-live-change]
 (.soc-empty  |  .soc-table-footer: [Cargar más] «Mostrando N de T incidentes.»)
 aside.soc-drawer  ← si hay incidente seleccionado  (ver §2.3)
```

**Columnas (reales).**

| # | Columna | Campo | Celda | Alin. |
| --- | --- | --- | --- | --- |
| 1 | SEVERIDAD | `severity` | `<Severity value>` (sin score) → `◆/▲/■/●` + P# | I |
| 2 | INCIDENTE | `title` + `summary` | `button.soc-row-link` (`data-incident-id`) + `<small>{summary}</small>` | I |
| 3 | FASE | `status` | `<StateCell>` → `<StatusChip>` traducido | I |
| 4 | RESPONSABLE | `ownerId` | `<code>{id.slice(0,8)}…</code>` | I · mono |
| 5 | ALERTAS | `alertIds.length` | `td.is-numeric` (tabular, derecha) | D |
| 6 | ABIERTO | `openedAt` | `<RelativeTime>` | I |

Orden del servidor: severidad y luego `openedAt` ascendente (04 §4.1).
`StateCell`/`statusLabel` (`soc-data-ui.tsx`): `open`→Abierto, `contained`→Contenido,
`eradicated`→Erradicado, `resolved`→Resuelto, `closed`→Cerrada. Tono (`statusState`):
`resolved/eradicated/closed/acknowledged/triaged`→ok, `escalated`→warn, `contained`→info.

## 2.2 · Búsqueda y en vivo

- `form.soc-filter-bar` aplica `q` (navega a `listPath(status, q)`); `Limpiar búsqueda` si hay
  `appliedSearch`.
- `useChanges({resourceTypes:['incident','alert','incident_task','incident_note']})`: recarga
  la lista ante cambios de `incident`; si hay incidente abierto, recarga el incidente, sus
  tareas (`openRequiredCount`) y sus alertas vinculadas según el tipo que cambió. Refresco
  objetivo cada 30 s (doc 06 §7), pausado con formulario abierto.

## 2.3 · Anatomía — drawer de detalle (`aside.soc-drawer`)

```
header: .soc-drawer__eyebrow «Incidente · {id8}…» · h2 {title} · [× ghost, autofoco]
.soc-drawer__body
 .soc-tabs (role=tablist «Secciones de investigación»): Resumen │ Tareas │ Bitácora │ Timeline
 ├─ [tab Resumen] (div hidden si tab≠summary)
 │   <Severity> <StateCell>
 │   dl.soc-description-list: Responsable <code> · Abierto <RelativeTime> · Alertas vinculadas N
 │   section «Resumen» : p {summary}
 │   section «Alertas vinculadas (N)»  (ver §2.5)
 │   section «Fase de respuesta» : .soc-lifecycle (5 píldoras) + nota QAPAQ
 │   section.soc-actions «Responsable» : form reasignar  (si canWrite && !closed)
 │   section «Actividad auditada» : ol.soc-reasons  (si canReadAudit)  (ver §2.6)
 │   section.soc-actions «Acciones» : comandos por fase  (si canWrite || canClose) (ver §2.4)
 └─ [tab Tareas|Bitácora|Timeline] → <IncidentWorkTabs> (ver §2.7)
```

- **Fase de respuesta (`.soc-lifecycle`).** `display:flex; flex-wrap:wrap; gap:4px`. Cinco
  `span` en orden fijo `['open','contained','eradicated','resolved','closed']`, rotulados por
  `statusLabel`. Píldora: `padding:4px 7px; border:1px solid var(--border-default); radius 999;
  color:var(--text-3); 11px`. La actual (`status===selected.status`) → `.is-current`
  (`border-color:var(--text-2); color:var(--text-1)`). **No hay conectores ni paso «omitido»
  punteado** (el `LifecycleStepper` del doc 04 §4.2 no está implementado). Nota debajo
  (`.soc-page-note`): «La fase registra el estado del caso en QAPAQ; no confirma que Wazuh,
  Entra o un endpoint hayan ejecutado contención o erradicación.»

## 2.4 · Acciones por fase (`section.soc-actions «Acciones»`)

Sección presente solo si `canWrite || canClose`.

| Fase | Condición | Control (verbo real) | `name` |
| --- | --- | --- | --- |
| `open` | `canWrite` | `Marcar contenido` | `contain` |
| `contained` | `canWrite` | `Marcar erradicado` + `Marcar resuelto` | `eradicate` / `resolve` |
| `eradicated` | `canWrite` | `Marcar resuelto` | `resolve` |
| `resolved` | `canClose` | **form de cierre** (danger) | `close {closureReason}` |
| `closed` | `canWrite` | `Reabrir` | `reopen` |

- **Reasignar** (`section.soc-actions «Responsable»`, con `canWrite && status!=='closed'`):
  `input#incident-owner` (`maxLength=200`), `<small>No hay directorio de personas disponible
  para validar este ID.»`, botón `Guardar responsable` `disabled = busy || !ownerId.trim() ||
  ownerId.trim()===selected.ownerId`. Envía `reassign {ownerId}`.

## 2.5 · Alertas vinculadas (guarda de cierre) — `section «Alertas vinculadas (N)»`

Consulta `api.incidentAlerts(id, cursor)` (límite 200 por respuesta). Estados del render:
- `!canReadAlerts` → `p` «No tienes permiso para consultar las alertas vinculadas.» (la UI no
  revela IDs ni campos — doc 04 §4.2).
- `linkedAlertsError` → `ErrorState` con reintento.
- `linkedAlertsLoading` → `p role=status` «Consultando alertas vinculadas…».
- Con datos → `ul.soc-related-alerts`: por fila `button.soc-row-link {title}` + `span`
  «{priority} · {statusLabel(status)}[ · {statusLabel(verdict)}]».
- Sin datos → `p` «No hay alertas vinculadas disponibles.» o «No fue posible cargar N
  alerta(s) vinculada(s).» si `linkedAlertFailures`.
- `linkedAlertsNextCursor` → `Cargar siguientes alertas` (ghost).
- `linkedAlertFailures > 0` → `.soc-page-note` «N vínculo(s) no están disponibles para esta
  sesión; la investigación no puede cerrarse desde esta vista.»
- `linkedAlertsTruncated` → `.soc-page-note` «El servicio limita esta respuesta a 200
  vínculos; hay vínculos adicionales. La lista está incompleta y el cierre requiere revisión
  manual.»

**`linkedAlertsComplete`** (bandera que habilita el cierre) es verdadera solo si: hay selección
+ `canReadAlerts` + no cargando + `linkedAlertFailures===0` + `!truncated` + `nextCursor===null`
+ `linkedAlerts.length === totalCount === selected.alertIds.length`.

## 2.6 · Actividad auditada (`section «Actividad auditada»`, con `canReadAudit`)

Consulta `api.audit(from,to, …, {resourceType:'incident', resourceId})` con ventana desde
`openedAt` (o retención 365 d) hasta ahora. Render en `ol.soc-reasons`: `strong {action}` +
`span` «{fecha es-PE} · {outcome} · {actor.type}» + `span {reason}` + `<code>Ref.
{correlationId}</code>`. Vacío → «No hay cambios auditados en el período consultable (máximo
365 días).» Cursor → `Cargar actividad siguiente` (ghost). Errores → `ErrorState`.

## 2.7 · Formulario de cierre y GUARDAS (`resolved && canClose`)

`form` con `textarea#incident-closure` (`minLength=10 maxLength=2000`), `<small>Describe la
resolución (mínimo 10 caracteres).»`. Mensajes `small role=status` según guarda:
- Alertas aún no completas: «Carga las siguientes alertas para revisar todos sus veredictos
  antes del cierre.» (si `linkedAlertsNextCursor`) o «El cierre espera que la UI confirme el
  veredicto de todas las alertas vinculadas.».
- `linkedAlertsWithoutVerdict.length`: «Faltan veredictos en N alerta(s). Ábrelas y registra
  su triaje antes de cerrar.»
- Tareas: «Consultando tareas obligatorias para validar el cierre…» o «Cierre bloqueado · N
  tarea(s) obligatoria(s) abierta(s).».

Botón **danger** `Cerrar incidente`, `disabled` si **cualquiera**:
`busy || closureReason.trim().length < 10 || !requiredTasksLoaded || openRequiredTaskCount > 0
|| !linkedAlertsComplete || linkedAlertsWithoutVerdict.length > 0`. El backend mantiene la
guarda autoritativa; esto es validación previa (doc 06 §4.2). Es la aplicación real de
`04 §4.2` (cierre requiere veredictos + ninguna tarea obligatoria abierta).

## 2.8 · Pestañas de trabajo (`IncidentWorkTabs`)

Se montan cuando `?tab=tasks|notes|timeline`. Contenedor común `section.soc-investigation-tab`
(`display:grid; gap:12px; padding-top:14px`), cabecera `.soc-investigation-heading`.

**Tareas (`TasksTab`, `incidents.tasks.write`).**
- Si `openRequiredCount > 0`: banner `p.soc-closure-blocked` (`role=status`) «Cierre bloqueado
  · N tarea(s) obligatoria(s) abierta(s)». Clase: `border-left:2px solid var(--state-warn);
  background:var(--surface-2); color:var(--text-1); padding:10px 12px; 12px`.
- Crear (si `canWrite && status!=='closed'`): `form.soc-task-create` — Título (`min3 max200`),
  Descripción (`max4000`), bloque `.soc-task-create__details` con Responsable (opcional,
  `max200`), Vencimiento (`datetime-local`), checkbox `.soc-task-required` «Obligatoria para el
  cierre». Botón `Crear tarea` `disabled = busy || title.trim().length < 3`.
- Lista `.soc-work-list` de `article.soc-work-item` (`data-task-id`): título `h3`, badge
  `.soc-work-required` «Obligatoria» (borde `--state-warn`), badge
  `.soc-work-status--{status}` (`done`→`--state-ok`, `in_progress`→`--state-info`,
  `cancelled`→`--text-3`); `taskStatusLabel`: open→Abierta, in_progress→En curso,
  done→Completada, cancelled→Cancelada. `dl` (Responsable `<code>` / Vencimiento es-PE o «Sin
  vencimiento» / Actualizada `RelativeTime`); `p.soc-work-cancel-reason` si hay
  `cancellationReason`.
- Acciones `.soc-work-actions` (ghost, si `canWrite && !closed`): `Iniciar` (open→`start`),
  `Completar` (`complete`, si open/in_progress), `Reabrir` (`reopen`, si done/cancelled),
  `Asignar` (toggla `form.soc-work-inline-form`, `assign {assigneeId}`), `Cancelar tarea`
  (toggla form; motivo `max500`, **`minLength=10` obligatorio si la tarea es `required`**;
  botón danger `Confirmar cancelación`). Cada comando envía `expectedRevision: task.revision`.
- Vacío → `EmptyState` «Aún no hay tareas para este incidente.»; cursor → `Cargar más tareas`.

**Bitácora (`NotesTab`, `incidents.notes.write`).** Append-only.
- `form.soc-note-form` (si `canWrite && !closed`): `textarea#incident-note-body` (`max10000`,
  obligatorio), `<small>La nota no se puede editar ni borrar después de guardarla.»`, botón
  `Guardar nota`. Corrección: `Corregir` arma `correctsNoteId` → banner «Corrige nota {id8}…
  [Cancelar corrección]». Una corrección **añade** una nota nueva que referencia la anterior
  (no edita).
- Lista `ol.soc-note-list`: `li` con `header` (autor vía `shortId` → «Tú» si propio, si no
  `{id8}…` + `RelativeTime`), `.soc-page-note` «Corrige nota {id8}…» si aplica,
  `p.soc-note-body` (`white-space:pre-wrap; overflow-wrap:anywhere`), botón `Corregir`.
- Vacío → `EmptyState` «La bitácora está vacía.»; cursor → `Cargar notas anteriores`.

**Timeline (`TimelineTab`).**
- Aviso `p.soc-partial-banner` (`color:var(--state-info)`): «Transiciones visibles solo con
  permiso de auditoría» (`transitions==='requires_audit_read'`) o «Historial parcial»
  (`'partial'`).
- `ol.soc-timeline` (`.soc-timeline > li` grid `14px minmax(0,1fr)`, `min-height:72px`):
  `.soc-timeline__marker` (punto 7×7, borde `--accent`) con conector vertical de **64 px** vía
  `::after` salvo el último; `.soc-timeline__content` con `header` (`strong`
  `timelineLabels[kind]` + `RelativeTime`), `p` resumen, `.soc-timeline__meta` («Hora de la
  fuente»/«Hora registrada», «Registrado en QAPAQ …» si `provider`, «Autor {id8}…»), y
  `small` «Transición auditada» para `incident.transition` auditada. `timelineLabels` cubre
  `incident.opened/transition/closed`, `alert.linked`, `task.created/completed/cancelled`,
  `note.added`.
- Vacío → `EmptyState` «Sin actividad registrada para este incidente.»; cursor → `Cargar
  actividad anterior`.

## 2.9 · Interacciones (Incidentes)

- **`expectedRevision` (doc 06 §5).** `command(name)` envía `{ name, expectedRevision:
  selected.revision }` (+ `closureReason` en `close`, + `ownerId` en `reassign`). Tras éxito:
  `setSelected(data.incident)` + `load()`; **sin optimistic update**. Ante `STATE_CONFLICT` →
  `load()` y `ErrorState` visible; el texto escrito se conserva. Las tareas envían
  `expectedRevision: task.revision`.
- **Confirmación (doc 06 §6).** Nivel 1 directo: `Marcar contenido/erradicado/resuelto`,
  `Reabrir`. Nivel 3 con motivo: `Cerrar incidente` (danger, motivo ≥10 + guardas),
  `Cancelar tarea` de tarea obligatoria, `Reasignar`. (No hay `ReasonRequiredDialog` modal; el
  motivo va en formulario en línea.)
- **Teclado.** Al abrir el drawer, autofoco en el botón cerrar; `Escape` cierra y devuelve el
  foco a la fila (`[data-incident-id]`).
- **Navegación por pestañas del drawer** vía URL `?tab=` (no estado efímero): recargable y
  enlazable.

## 2.10 · Estados (Incidentes)

| Estado | Render | Clase |
| --- | --- | --- |
| Cargando lista | (sin placeholder dedicado; `busy`) la tabla no muestra `EmptyState` hasta terminar | — |
| Vacío | `EmptyState` «No hay incidentes para este estado.» | `.soc-empty` |
| Vacío por filtros | `EmptyState` «No hay incidentes que coincidan con la búsqueda…» | `.soc-empty` |
| Parcial (alertas vinculadas) | `.soc-page-note` truncado a 200 / vínculos no disponibles | `.soc-page-note` |
| Timeline parcial | `.soc-partial-banner` | `.soc-partial-banner` |
| Viejo | datos previos se mantienen; refresco por `useChanges` | — |
| Error | `ErrorState` con **`correlationId`** + `Reintentar` | `.soc-error` |
| Cierre bloqueado | `p.soc-closure-blocked` + botón `Cerrar incidente` deshabilitado con motivo | `.soc-closure-blocked` |
| Sin capability | el bloque/acción no se renderiza (auditor sin botones) | — |

## 2.11 · Responsividad (Incidentes) — 3 breakpoints

**≥ 1101 px.** Riel 232 px; drawer `min(480px, calc(100vw - rail))`; tabla 6 columnas.

**≤ 1100 px.** Riel **56 px** (`--rail-width:56px`); el drawer se reajusta; la tabla conserva
columnas con scroll horizontal (`.soc-table-scroll`).

**≤ 760 px.**
- Topbar 50 px; workspace `17px 12px`. **Drawer a pantalla completa:** `.soc-drawer{
  inset:50px 0 0; width:100%; border-left:0 }` → las pestañas internas y el timeline ocupan
  todo el ancho.
- `.soc-table th/td { padding-inline:9px }`.
- **Inputs a 44 px / 16 px:** `.soc-filter-bar input/select`, `.soc-actions
  input/select/textarea`, y en el segundo bloque `@media (max-width:760px)`:
  `.soc-task-create input/textarea`, `.soc-note-form textarea`, `.soc-work-inline-form
  input/textarea` → `min-height:44px; font-size:16px`.
- `.soc-work-actions { align-items:stretch }`; `.soc-work-inline-form { flex-direction:column;
  align-items:stretch }`; `.soc-note-form > div { flex-direction:column; align-items:flex-start }`.
- **Táctiles 44 px:** `.soc-button, .soc-tabs button, .soc-row-link, .soc-profile summary`.
- `.soc-compact-list` (Resumen) a 3 col `78px minmax(90px,1fr) 94px` ocultando `time`
  — patrón compartido del shell; las tablas de esta vista usan `.soc-table`.
- `prefers-reduced-motion: reduce`: animaciones a 0.01 ms; `.soc-live-change` sin animación.

## 2.12 · Tabla elemento → clase → medidas → token (Incidentes)

| Elemento | Clase | Medidas | Token |
| --- | --- | --- | --- |
| Pestaña trabajo | `.soc-investigation-tab` | `gap:12px; padding-top:14px` | — |
| Cabecera trabajo | `.soc-investigation-heading h3` | 15px/560 | `--text-1` |
| Cierre bloqueado | `.soc-closure-blocked` | `padding:10px 12px; border-left 2px` | `--state-warn` / `--surface-2` / `--text-1` |
| Fase | `.soc-lifecycle span` | `padding:4px 7px; radius 999; 11px` | `--border-default` / `--text-3` |
| Fase actual | `.soc-lifecycle span.is-current` | — | `--text-2` / `--text-1` |
| Tarjeta tarea | `.soc-work-item` | `gap:10px; padding:12px; border 1px` | `--border-default` / `--surface-1` |
| Badge obligatoria | `.soc-work-required` | `padding:3px 6px; 10px` | `--state-warn` |
| Badge estado | `.soc-work-status--{s}` | 10px | ok/info/`--text-3` |
| Acciones tarea | `.soc-work-actions` | `gap:5px; padding-top:8px; border-top 1px` | `--border-subtle` |
| Form en línea | `.soc-work-inline-form` | `gap:8px; width:100%` | — |
| Crear tarea / nota | `.soc-task-create` / `.soc-note-form` | `gap:10px; padding:12px` | `--surface-1` |
| Nota | `.soc-note-list > li` | `padding:12px; border-left 1px` | `--border-default` / `--surface-1` |
| Cuerpo nota | `.soc-note-body` | `white-space:pre-wrap; overflow-wrap:anywhere` | `--text-1` |
| Timeline | `.soc-timeline > li` | grid `14px 1fr; min-height:72px` | — |
| Marcador | `.soc-timeline__marker` | punto 7×7 + conector 64px | `--accent` / `--border-default` |
| Meta timeline | `.soc-timeline__meta` | 10px; `gap:5px 14px` | `--text-3` |
| Aviso parcial | `.soc-partial-banner` | `padding:8px 11px; radius 6px` | `--state-info` |

Severidad obligatoria (glifo + P#): `◆ P1`/`▲ P2`/`■ P3`/`● P4` en `--sev-1..4`.

---

## 3 · Micro-detalles (ambas vistas)

1. **`tabular-nums` global** (`.soc-app`): contadores («Mostrando N de T»), scores y
   `alertIds.length` alinean cifras. No sobreescribir.
2. **Glifo + color + rótulo** en severidad siempre; nunca severidad solo por color (doc 10).
   El `StatusChip` añade su propia marca (`✓ ! × i –`), independiente del glifo de severidad.
3. **Ausencias atenuadas:** `Sin asignar` y `—` en `.soc-muted` (`--text-3`); campo `rawRef`
   ausente no dibuja la fila (doc 06 Z6).
4. **Ámbar solo en foco/selección:** el único ámbar en estas vistas es el anillo de foco del
   chip de entidad (`outline:2px solid var(--brand-amber)`). La fila seleccionada usa
   `--surface-selected` (cálido tenue), no ámbar pleno. El subrayado de pestaña activa es
   blanco `--text-1` (estado real del código).
5. **Mono para IDs:** `subjectId`/`ownerId`/`incidentId`/`correlationId` en `<code>` 12 px
   `--font-mono`; en tabla truncados a 8 caracteres + `…`, completos en el drawer.
6. **Foco visible** en todo control (anillo de foco, única sombra permitida). Orden de
   tabulación: heading → acción → pestañas → filtros → tabla → drawer.
7. **Copiar `correlationId`:** patrón `ErrorState` (`copy`→`check`, «Copiada» 1.5 s).
8. **Sin sombras de tarjeta, sin gradientes, sin glow**: separación por `--surface-1` +
   `--border-default`/`--border-subtle`. Iconos solo `SocIcon`.
9. **Espaciados solo de la escala** `--space-*` donde el código los usa (`.soc-page-heading`,
   `.soc-filter-bar`); el resto son literales ya presentes (no introducir tamaños nuevos).

## 4 · Prohibido (doc 10 «Lo que el diseño debe evitar»)

- Acciones visibles **sin capability** (todo comando se calcula por capability + estado).
- Severidad comunicada **solo por color** (siempre glifo + P# + rótulo).
- **KPI vacíos, tendencias** calculadas desde una página parcial, totales que mientan al crecer
  (por eso cursor opaco + «Mostrando N de T», sin gráficas de tendencia).
- **Verdes inventados / «ok» por ausencia de error**: cola vacía ≠ fuente sana; incidente
  «cerrado» solo cuando el servidor confirma y las guardas pasan.
- **Optimistic update** en comandos de estado (doc 06 §5).
- **Confirmaciones que no resumen el impacto** o **errores sin `correlationId`/instrucción**.
- Packs de iconos genéricos (`react-icons`); copiar píxel a píxel Splunk/Sentinel/Elastic/Wazuh.
- Glow/neón, gradientes de fondo, grid de tarjetas idénticas, animación sin respuesta a acción,
  texto en inglés en la UI.
- Presentar como activo lo no implementado (franja 3 px, selección masiva, contadores de
  pestaña, stepper de fase, diálogos modales): marcarlo como pendiente.

## 5 · Checklist de aceptación

**Alertas.**
- [ ] Pestañas Abiertas/Nuevas/Reconocidas/Triadas/Escaladas/Cerradas con `aria-pressed` y
  subrayado activo de 2 px.
- [ ] Columnas: Prioridad(`Severity`)/Título/Estado/Asignado/Incidente/Ocurrida; `th` sticky.
- [ ] Severidad con glifo + P# + score + color `--sev-*`; «Sin asignar»/«—» atenuados.
- [ ] Drawer `min(480px, calc(100vw - rail))`; pantalla completa en ≤760 px.
- [ ] Bloque `.soc-actions` solo con comandos válidos por capability+estado; triaje solo si
  `acknowledged && isMine && canTriage`; nunca «Triar» en alerta ajena.
- [ ] Comandos con `expectedRevision`; 409 recarga y conserva el formulario; sin optimistic.
- [ ] `/` enfoca búsqueda; `j`/`k` recorren; `Escape` cierra drawer.
- [ ] `q`/`entity` inválido saneados de la URL; `entity` solo si cumple `^ent_…{22}$`.
- [ ] Error con `correlationId` copiable + Reintentar; `rawRef` ausente sin hueco.

**Incidentes.**
- [ ] Pestañas Activos/Resueltos/Cerrados; columnas Severidad/Incidente/Fase/Responsable/
  Alertas/Abierto; Alertas en `td.is-numeric`.
- [ ] Drawer con sub-pestañas Resumen/Tareas/Bitácora/Timeline por URL `?tab=`.
- [ ] Fase `.soc-lifecycle` 5 píldoras con `.is-current`; nota «no confirma contención real».
- [ ] Alertas vinculadas respetan `alerts.read`; avisos de truncado 200 / vínculos no
  disponibles; `linkedAlertsComplete` gobierna el cierre.
- [ ] Cierre `resolved && incidents.close`: motivo ≥10 + ninguna tarea obligatoria abierta +
  todos los veredictos → botón danger habilitado; banner `.soc-closure-blocked` si falta algo.
- [ ] Bitácora append-only (corregir añade nota); tareas con `expectedRevision`; cancelar
  tarea obligatoria exige motivo ≥10.
- [ ] Timeline distingue hora de fuente vs. registrada; aviso parcial / requiere auditoría.
- [ ] Auditor: lista y detalle sin ningún botón de acción.

**Responsividad (ambas).**
- [ ] ≥1101: riel 232; ≤1100: riel 56; ≤760: topbar 50, workspace `17px 12px`, drawer
  `inset:50px 0 0; width:100%`.
- [ ] ≤760: inputs 44 px / 16 px; táctiles 44 px; `.soc-compact-list` a 3 col ocultando `time`.
- [ ] `prefers-reduced-motion`: vistas legibles sin animación.

## 6 · Trazabilidad

- Contrato de pantalla: `04-pantallas.md` §3 (Alertas), §4 (Incidentes).
- Estados/errores/concurrencia/confirmación: `06-patrones-de-interaccion.md` §3/§4/§5/§6/§7.
- Alcance por rol y prohibiciones: `10-vistas-por-rol-y-referencias.md`.
- Tokens/escala/breakpoints/principios: `11-mi-sesion-y-shell-spec.md` §0/§1/§2/§5.
- Código:
  `apps/web/src/components/soc/AlertQueuePage.tsx`,
  `apps/web/src/components/soc/AlertDetailDrawer.tsx`,
  `apps/web/src/components/soc/IncidentPage.tsx`,
  `apps/web/src/components/soc/IncidentWorkTabs.tsx`,
  `apps/web/src/components/soc/soc-ui.tsx` (`Severity`, `StatusChip`, `Button`, `ErrorState`,
  `EmptyState`, `RelativeTime`, `SocIcon`),
  `apps/web/src/components/soc/soc-data-ui.tsx` (`PageHeader`, `StateCell`, `statusLabel`).
- CSS: `apps/web/src/app/soc-data.css` (`.soc-table`, `.soc-tabs`, `.soc-filter-bar`,
  `.soc-severity--{1..4}`, `.soc-work-item`, `.soc-closure-blocked`, `.soc-timeline`),
  `apps/web/src/app/soc-overlays.css` (`.soc-drawer`, `.soc-description-list`, `.soc-reasons`,
  `.soc-actions`, `.soc-lifecycle`), `apps/web/src/app/soc-shell.css` (tokens, `.soc-status`),
  `apps/web/src/app/soc-responsive.css` (1100/760 px, reduced-motion).

## 7 · Mejoras pendientes (registrar, no presentar como hechas)

1. **Franja de prioridad de 3 px** (`04 §3.3`, `06 §8.1`): añadir regla CSS para
   `.soc-alert-row[data-priority]` con `box-shadow: inset 3px 0 0 var(--sev-N)`. Hoy la clase
   `soc-alert-row` existe en el TSX **sin estilo**; la prioridad vive solo en el glifo de
   `Severity`.
2. **Selección y acciones masivas** (`04 §3.3/§3.6`): columna de checkbox + barra «N
   seleccionadas · Reconocer · Asignar a… · Limpiar». No implementado.
3. **Contadores por pestaña de estado** (`04 §3.2`): requiere endpoint de agregados (B-08).
4. **`LifecycleStepper` real** con conectores y paso «omitido» punteado (`04 §4.2`): hoy es una
   fila de píldoras `.soc-lifecycle`.
5. **`CommandDialog`/`ReasonRequiredDialog` modales** (`04 §3.5`, `06 §6`): hoy todos los
   comandos con formulario van en línea en `.soc-actions`. Existe `.soc-command-dialog` en CSS
   pero no se usa para comandos de alerta/incidente.
6. **Historial de alerta por recurso** en el drawer (`04 §3.4`): no cableado; la actividad
   auditada solo está en el detalle de incidente.
7. **Indicador de pestaña activa en ámbar** si se quisiera alinear con el doc 11 §0.2 (hoy
   `--text-1`).
