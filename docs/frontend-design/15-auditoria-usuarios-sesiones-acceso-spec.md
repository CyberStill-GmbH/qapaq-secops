# 15 · Especificación intensiva — Auditoría, Usuarios SOC, Sesiones de acceso y Acceso/Login

**Estado:** especificación de diseño e implementación, escrita contra el código real del
2026-10-13. Alcance: cuatro superficies de gobierno/identidad de la consola SOC —
**Auditoría** (`/audit`), **Integridad** (`/audit/integrity`), **Usuarios SOC**
(`/admin/users` + `/:oid`), **Sesiones de acceso** (`/admin/sessions`) y la **pantalla de
Acceso/Login** (`/login`, BFF OIDC) con sus **errores por código** (`/errors/:code`).

> **Fuente de verdad de tokens, escala y breakpoints:**
> [`11-mi-sesion-y-shell-spec.md`](11-mi-sesion-y-shell-spec.md) §1 y §5. Esta spec **no
> introduce** tokens, tamaños ni breakpoints nuevos: reutiliza los de `soc-shell.css`
> (`:root`), `soc-data.css`, `soc-overlays.css`, `soc-responsive.css` y, para el login, la
> cadena propia de `login.css` / `login-motion.css`. Donde un valor difiere del doc 11, se
> marca.
> **Honestidad de estado (doc 11 §0.4 / 06 §3):** un dato ausente se muestra *como ausente*;
> cero ≠ sano; vacío ≠ ok. **Autorización server-side (doc 11 §0.5 / 06 §2):** la UI oculta lo
> que la capability no permite; no enumera lo que no se tiene.

Archivos de referencia (clases y medidas **textuales**):
`apps/web/src/components/soc/AuditPage.tsx`, `IntegrityPage.tsx`,
`UserAdministrationPage.tsx`, `AdminSessionsPage.tsx`;
`apps/web/src/app/application.tsx`, `error-banner.tsx`, `login.css`, `login-motion.css`;
hojas `soc-data.css`, `soc-overlays.css`, `soc-shell.css`, `soc-responsive.css`. Las vistas
admin reusan estas mismas `soc-*`; **no** existen archivos `admin-data.css` /
`admin-shell.css` / `admin-overlays.css` / `admin-responsive.css` para estas superficies
(los `admin-*.css` pertenecen a la consola legacy `console.tsx`, fuera de alcance aquí) —
ver §«Trazabilidad» y las marcas *no implementado*.

---

## 0 · Principios heredados (no negociables)

Del doc 11 §0 y de [10](10-vistas-por-rol-y-referencias.md) §«Lo que evitar»:

1. **Para turno, no para demo.** Densidad alta, escaneo veloz. Auditoría es la más compacta
   del sistema: tabla de 7 columnas, filas de 40px, sin aire decorativo.
2. **Negro `#080808` + grises para jerarquía.** El ámbar `--brand-amber` (`#c49a5a`) es
   **solo** marca/selección (barra activa del riel). Ninguna de estas vistas usa ámbar en su
   contenido.
3. **Estado por rótulo + forma + color**, nunca solo color (`StatusChip` lleva glifo
   `✓ ! × i –`).
4. **Honestidad de estado.** Sync `stale` se dice; «sin acceso» se dice; `No informado` /
   `Sin dato` / `Sin rol` nunca se disfrazan de dato real.
5. **Autorización server-side.** `audit.read_sensitive` ausente ⇒ datos sensibles redactados
   por el BFF (`[REDACTED]`), la UI solo **informa** la redacción. `sessions.revoke` ausente
   ⇒ no se renderiza el botón «Revocar» (regla Z2).
6. **Cero ruido.** Sin glow/neón, sin gradientes de fondo, sin iconos de packs genéricos
   (solo `SocIcon`, `strokeWidth 1.65`), sin animación que no responda a una acción.
7. **Idioma: español** en toda cadena visible, contadores y unidades (`2.000`, `es-PE`,
   `America/Lima`).

---

## 1 · Vista «Auditoría» (`/audit`) — `AuditPage.tsx`

**Propósito.** Que el auditor/líder consulte acciones y resultados registrados en un intervalo,
con filtros aplicados **en el BFF**, cursor que continúa la misma consulta y densidad máxima.
Es lectura, no configuración.
**Capabilities (10 §Catálogo · `/audit`):** requiere `audit.read`. La columna de datos
sensibles depende de `audit.read_sensitive` (`const sensitive = session.capabilities.includes('audit.read_sensitive')`).
No hay escritura.

### 1.1 Anatomía ASCII (clases reales)

```
┌─ .soc-page ───────────────────────────────────────────────────────────────┐
│ .soc-page-heading                                                          │
│   h1  Auditoría            .soc-page-heading__meta → [Actualizar⟳] + hace Ns│
│   p   Acciones y resultados registrados para el intervalo consultado.      │
│                                                                           │
│ <form .soc-filter-bar>  (flex-wrap, align-items:end, gap --space-3)       │
│   [Desde ▾] [Hasta ▾] [Acción ▾] [Actor] [Tipo recurso] [Recurso] [Result]│
│                                                 … [Consultar] (primary)    │
│                                                                           │
│  p.soc-overdue role=alert  ← validationError (solo si inválido)           │
│  <ErrorState .soc-error>   ← error con correlationId (solo si error)      │
│  p.soc-page-note role=status  ← «Actualizando resultados…» (recarga)      │
│                                                                           │
│ ┌ .soc-table-panel ───────────────────────────────────────────────────┐ │
│ │ .soc-table-scroll > table.soc-table                                   │ │
│ │  Secuencia │ Instante │ Actor │ Acción │ Recurso │ Resultado │ Correl.│ │
│ │  <code>    │ <time>   │<code> │ <code> │ <code>  │<StatusChip>│<code>…│ │
│ │  …                                                                    │ │
│ │  <EmptyState .soc-empty> (si 0 y !error y !loading)                   │ │
│ │  .soc-table-footer → [Cargar más registros] + «N registros… hay más» │ │
│ └───────────────────────────────────────────────────────────────────────┘│
│ p.soc-page-note  «Los filtros se aplican en el BFF…»                      │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Tabla elemento → clase → medidas → token

| Elemento | Clase / etiqueta | Medidas (textuales) | Token/escala |
| --- | --- | --- | --- |
| Contenedor | `.soc-page` | `min-width:0`; entrada `soc-view-enter 180ms var(--ease-out)` | `--motion-base`/`--ease-out` |
| Encabezado | `.soc-page-heading` | `min-height:48px`; `gap:var(--space-6)`; `margin:0 0 var(--space-6)` | `--space-6` (24px) |
| H1 | `.soc-page-heading h1` | `20px/480`, `letter-spacing:-0.025em`, `line-height:28px`, `--text-1` | H1 página (doc 11 §1.5) |
| Subtítulo | `.soc-page-heading p` | `13px`, `margin-top:4px`, `--text-2` | Cuerpo |
| Meta/acción | `.soc-page-heading__meta` | `gap:14px`; `12px`; `white-space:nowrap`; `--text-3` | Secundario |
| Botón Actualizar | `.soc-button` (`<SocIcon name="refresh">`) | `min-height:40px`; `radius:999px`; `gap:8px`; `13px/550` | pill 999px |
| Barra de filtros | `form.soc-filter-bar` | `flex-wrap`; `align-items:end`; `gap:var(--space-3)`; `margin:var(--space-4) 0` | `--space-3`/`--space-4` |
| Label de filtro | `.soc-filter-bar > label` | `display:grid`; `gap:5px`; `12px`; `--text-2` | Secundario |
| Inputs/selects | `input`/`select` (globales) | heredan estilo base de controles | `--border-control` |
| Botón Consultar | `.soc-button--primary` (`type=submit`) | fondo `--text-1`, texto `--surface-0` | primary blanco |
| Error de validación | `p.soc-overdue` `role=alert` | color `--state-fail !important` | `--state-fail` |
| Panel de tabla | `.soc-table-panel` | `overflow:hidden`; borde sup/inf `--border-default`; `--surface-1` | `--border-default` |
| Scroll | `.soc-table-scroll` | `width:100%`; `overflow:auto` | — |
| Cabecera de tabla | `.soc-table thead` | `sticky top:0`; fondo `--surface-1` | — |
| `th` | `.soc-table th` | `height:32px`; `11px/600`; `+0.06em`; UPPERCASE; `--text-3`; `nowrap` | eyebrow 11px |
| `td` | `.soc-table td` | `height:40px`; `padding:6px 12px`; `--text-2`; borde `--border-subtle` | compacto 40px |
| Códigos de celda | `td > code` | `--font-mono` (hereda); IDs/acción/recurso/secuencia | Código 12px |
| Instante | `<time>` | `Intl.DateTimeFormat('es-PE', dateStyle:short, timeStyle:medium, TZ America/Lima)` | tabular-nums |
| Resultado | `StateCell` → `StatusChip` `.soc-status--{ok/warn/fail…}` | `.soc-table .soc-status` a `11px` | estado semántico |
| Correlación | `<code title={full}>{id.slice(0,8)}…</code>` | truncado a 8 + elipsis, completo en `title` | Código 12px |
| Pie de tabla | `.soc-table-footer` | `min-height:50px`; centrado; `gap:14px`; `--text-3` | — |
| Nota de pie | `p.soc-page-note` | `12px`; `--text-3` | Secundario |

### 1.3 Interacciones

- **Consulta.** `submit` valida en cliente antes de pedir al BFF: fechas válidas, `from ≤ to`,
  rango **≤ 365 días** (`'El BFF permite consultar hasta 365 días por búsqueda.'`). Al aplicar,
  limpia `items`/`nextCursor` y fija `applied` con ISO. Filtros: `action` (select cerrado:
  Todas / Inicio de sesión `access.sign_in` / Triaje de alerta `soc.alert.triage` / Cierre de
  incidente `soc.incident.close`), `actorId`, `resourceType`, `resourceId`, `outcome`
  (Todos/Permitido/Correcto/Denegado/Fallido). Intervalo por defecto: últimas 24 h.
- **Actualizar** (manual, 06 §7: Auditoría refresca **solo** por botón): relee la misma
  consulta aplicada; deshabilita durante `loading` («Consultando…»).
- **Cargar más registros.** Solo si `nextCursor`; hace `load(cursor, append=true)`; el pie
  muestra «{N} registros cargados · hay más resultados». El cursor **continúa la misma
  consulta** (no re-filtra).

### 1.4 Estados

| Estado | Render |
| --- | --- |
| Cargando (sin datos) | tabla vacía; al terminar, filas o EmptyState |
| Recargando (con datos) | `p.soc-page-note role=status` «Actualizando resultados…» encima de la tabla |
| Vacío | `EmptyState` «No hay eventos de auditoría que coincidan con esta consulta.» |
| Error | `ErrorState` (`.soc-error`) con mensaje + `correlationId` copiable + «Reintentar» |
| Validación local | `p.soc-overdue role=alert` con el texto exacto del caso |
| **Datos sensibles redactados** | sin `audit.read_sensitive`, si `actor.ip==='[REDACTED]'` o `actor.sessionId==='[REDACTED]'`, el `<small>` del actor añade ` · datos sensibles redactados`. Nunca se muestra el valor crudo ni se finge disponible (doc 10 §Auditor: «hash/metadata sensibles con política de redacción») |

### 1.5 Responsividad (3 breakpoints exactos)

- **≥1101px:** riel según toggle; `.soc-filter-bar` en línea; tabla a ancho completo del
  workspace (`padding 24px`).
- **≤1100px** (`soc-responsive.css`): riel **forzado a 56px** (`--rail-width:56px`); la vista
  no tiene regla propia en este umbral (la barra de filtros sigue haciendo wrap por
  `flex-wrap`).
- **≤760px:** `.soc-filter-bar{align-items:stretch}`; `.soc-filter-bar>label{flex:1 1 145px}`;
  `.soc-filter-bar input,select{min-height:44px; font-size:16px}` (táctil + anti-zoom iOS);
  `.soc-button{min-height:44px}`; `.soc-table th,td{padding-inline:9px}`; topbar 50px,
  workspace `padding:17px 12px`. La tabla conserva `overflow:auto` horizontal (no se recorta
  ninguna columna).

### 1.6 Micro-detalles

- **Densidad compacta:** filas 40px, `th` 32px, `padding 6px 12px`; es la tabla más densa; no
  agregar separadores ni zebra.
- **Redacción:** solo se rotula la ausencia; el `<code>` del actor muestra `actor.id`, el
  `<small>` el `actor.type` y, de corresponder, la nota de redacción. Prohibido mostrar IP o
  `sessionId` sin la capability.
- **No inventar:** si el BFF devuelve 0 filas, es «no coincide», no «sin actividad»; los
  contadores son `tabular-nums` global.
- **Correlación** siempre abreviada a 8 caracteres + `title` completo; patrón de ID consistente
  con el resto del sistema.

---

## 2 · Vista «Integridad de auditoría» (`/audit/integrity`) — `IntegrityPage.tsx`

**Propósito.** Verificar la **continuidad de la cadena** de eventos (hash encadenado) y
listar violaciones si las hay. Lectura + verificación; sin edición.
**Capabilities:** requiere `audit.verify` (gate de render del auto-arranque:
`if (session.capabilities.includes('audit.verify')) void verify()`). El líder SOC **no** la
tiene (10); el auditor y platform admin sí.

### 2.1 Anatomía ASCII

```
┌─ .soc-page ───────────────────────────────────────────────────────────────┐
│ .soc-page-heading                                                          │
│   h1 Integridad de auditoría     .soc-page-heading__meta → [Verificar cadena]│
│   p  Verifica la continuidad de la cadena de eventos.      (primary + shield)│
│                                                                           │
│ <ErrorState>  ← solo si error                                             │
│                                                                           │
│ <Panel .soc-panel «Resultado de verificación»>  (solo si result)         │
│   .soc-panel__header → h2 Resultado de verificación                       │
│   .soc-integrity-summary.soc-integrity-summary--large                     │
│     <StatusChip ok|fail> Cadena íntegra | Cadena con violaciones          │
│     p  {checked} eventos revisados · secuencia {headSequence}             │
│     small La verificación revisa los primeros 1 000 eventos.              │
│   [si violations] .soc-table-scroll > table.soc-table                     │
│     Código │ Secuencia │ Detalle                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Tabla elemento → clase → medidas → token

| Elemento | Clase / etiqueta | Medidas | Token |
| --- | --- | --- | --- |
| Botón Verificar | `.soc-button--primary` (`<SocIcon name="shield">`) | `min-height:40px`; primary blanco; «Verificando…» mientras `busy` | primary |
| Panel | `Panel` → `section.soc-panel` | borde `--border-default`; `radius:9px`; `--surface-1` | radio panel 9px |
| Cabecera panel | `.soc-panel__header` | `min-height:44px`; `padding:0 14px`; `border-bottom` | `--border-default` |
| H2 panel | `.soc-panel__header h2` | `15px/550`, `-0.01em`, `--text-1` | H2 panel |
| Resumen | `.soc-integrity-summary` + `--large` | `margin:14px`; `--large` ⇒ `padding:18px 0` | — |
| Chip estado | `StatusChip state=ok|fail` | `.soc-status` pill `min-height:22px`; glifo `✓`/`×` | estado semántico |
| Línea de recuento | `.soc-integrity-summary p` | `margin:10px 0 3px`; `--text-1`; `{checked.toLocaleString('es-PE')}` | tabular-nums |
| Nota de límite | `.soc-integrity-summary small` | `--text-3` | Micro |
| Tabla violaciones | `.soc-table` (Código/Secuencia/Detalle) | `code` en Código y Secuencia; Detalle texto plano | Código 12px |

### 2.3 Interacciones

- **Verificar cadena (read/verify).** Auto-ejecuta al montar **solo** con `audit.verify`;
  botón primario repite la acción. Durante `busy`: deshabilitado + «Verificando…». Al volver,
  fija `checkedAt` (mostrado como «Actualizado hace N s» en el meta por `PageHeader`).
- **Sin violaciones:** solo el resumen con chip `ok` «Cadena íntegra». **Con violaciones:**
  además la tabla; el chip pasa a `fail` «Cadena con violaciones». El límite declarado
  («primeros 1 000 eventos») se muestra **siempre** — no se afirma integridad total.

### 2.4 Estados

| Estado | Render |
| --- | --- |
| Sin capability `audit.verify` | no auto-verifica; el ítem no debería estar en el riel (Z2). La vista queda sin `result` (solo heading + botón, que el servidor rechazaría) |
| Verificando | botón «Verificando…»; sin `result` aún |
| OK íntegra | Panel + chip `ok`, sin tabla |
| Con violaciones | Panel + chip `fail` + tabla de violaciones |
| Error | `ErrorState` con `correlationId` + «Reintentar»; no se pinta Panel |

### 2.5 Responsividad

- **≥1101px:** panel a ancho de workspace.
- **≤1100px:** riel 56px; sin regla propia (el panel fluye).
- **≤760px:** heading apila (`.soc-page-heading{align-items:flex-start; gap:10px}`,
  `.soc-page-heading__meta{display:grid; justify-items:end}`); botón 44px; la tabla de
  violaciones usa `overflow:auto`.

### 2.6 Micro-detalles

- **Hash/cadena honestos:** el texto «revisa los primeros 1 000 eventos» es parte de la
  verdad del estado (cobertura parcial declarada); no eliminarlo aunque `violations` esté
  vacío.
- `checked` y `headSequence` con `tabular-nums`; `toLocaleString('es-PE')`.
- Ámbar ausente; separación por `--surface-1` + `--border-default`, sin sombra.

---

## 3 · Vista «Usuarios SOC» (`/admin/users` + `/:oid`) — `UserAdministrationPage.tsx`

**Propósito.** Padrón **de solo lectura** de los miembros y dueños del grupo de admisión
Entra `QAPAQ-SecOps-Users` (más identidades declaradas en el deploy). Muestra membresía, acceso
QAPAQ efectivo, **origen del rol**, sesiones activas y última actividad; y el **estado de
sincronización en la cabecera** (no por fila). «Activo ahora» deriva de **sesión QAPAQ
vigente**, nunca de presencia en Teams (10).
**Capabilities:** `users.read` (admin runtime). No concede cambiar app roles ni membresía
Entra: **no hay comandos** (10 §Catálogo).

### 3.1 Anatomía ASCII

```
┌─ .soc-page.soc-user-admin ────────────────────────────────────────────────┐
│ .soc-page-heading  h1 Usuarios SOC · p Miembros y dueños del grupo…        │
│                    .soc-page-heading__meta → [Actualizar⟳]                 │
│                                                                           │
│ .soc-operation-strip role=status   ← ESTADO DE SYNC (cabecera, no por fila)│
│   [<StatusChip tone>{label}]  p {detail}  │ Último intento <rel> │ Último éxito <rel>│
│                                                                           │
│ p.soc-live-announcement (si liveChanges) «Actividad de sesión actualizada»│
│ <ErrorState> (si error)                                                   │
│                                                                           │
│ .soc-user-admin__toolbar                                                  │
│   label.soc-user-admin__search [Buscar en el padrón ____]                 │
│   span.soc-user-admin__scope  «{visible} de {total} identidades»          │
│                                                                           │
│ .soc-user-admin__layout  (grid 1fr | minmax(310px,0.42fr))               │
│ ┌ section.soc-table-panel ──────────────┐ ┌ aside.soc-panel .__detail ──┐│
│ │ table.soc-table                        │ │ header: h2 nombre · span upn ││
│ │ Persona│Membresía│Acceso QAPAQ│Origen  │ │ .__detail-body              ││
│ │        │         │del rol│Ses.act│Últ.  │ │  dl.__facts (grid 1fr 1fr) ││
│ │ [button.__person strong+span] …        │ │  Membresía/Dueño/Acceso/    ││
│ │ fila is-selected = abierta             │ │  Origen/Cuenta Entra/Última…││
│ │ EmptyState / placeholder según estado  │ │  section.__sessions h3      ││
│ └────────────────────────────────────────┘ │   ul li: estado+amr+revoc.  ││
│                                             └──────────────────────────────┘│
│ p.soc-page-note «La lista se limita al grupo configurado… no cambia roles»│
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Tabla elemento → clase → medidas → token

| Elemento | Clase / etiqueta | Medidas (textuales) | Token |
| --- | --- | --- | --- |
| Franja de sync | `.soc-operation-strip` `role=status` | `flex-wrap`; `gap:10px 28px`; `min-height:54px`; `margin-bottom:20px`; `padding:8px 12px`; borde `--border-default`; `radius:9px`; `--surface-1` | radio panel 9px |
| Pares de la franja | `.soc-operation-strip > div` | `flex`; `gap:9px`; `span:last-child` a `12px`/`--text-3` | Secundario |
| Chip de sync | `StatusChip state={tone}` | tono `ok/warn/fail/neutral` según `syncStatus()` | estado semántico |
| Marcas de tiempo | `RelativeTime` | «hace N s/min/h/d»; `title` fecha `es-PE`/Lima | tabular-nums |
| Aviso en vivo | `p.soc-live-announcement` `aria-live=polite` | `11px`; `--text-2` | Micro |
| Toolbar | `.soc-user-admin__toolbar` | `flex`; `align-items:end`; `gap:12px`; `margin:16px 0` | — |
| Label búsqueda | `.soc-user-admin__search` | `flex:1`; `min-width:180px`; label `11px`/`--text-3` | Label 11px |
| Input búsqueda | `.soc-user-admin__toolbar input` | `min-height:38px`; `padding:8px 10px`; borde `--border-control`; `radius:7px`; `--surface-1` | `--border-control` |
| Alcance | `.soc-user-admin__scope` | `margin-left:auto`; `padding-bottom:10px`; `12px`; `--text-3` | Secundario |
| Layout maestro-detalle | `.soc-user-admin__layout` | `grid-template-columns: minmax(0,1fr) minmax(310px,0.42fr)`; `gap:14px`; `align-items:start` | — |
| Panel tabla | `section.soc-table-panel` | ver §1.2 | — |
| Botón persona | `.soc-user-admin__person` | `grid`; `gap:3px`; `strong` `550`; `span` `11px`/`--text-3`; `text-align:left` | — |
| Numérica | `td.is-numeric` | `text-align:right` (sesiones activas) | tabular-nums |
| Detalle | `aside.soc-panel.soc-user-admin__detail` | panel estándar; `aria-label` con nombre/oid | radio 9px |
| Cabecera detalle | `.soc-panel__header` | `h2` nombre (o «Identidad del deploy»), `span` upn/oid | H2 panel |
| Cuerpo detalle | `.soc-user-admin__detail-body` | `grid`; `gap:18px`; `padding:14px` | — |
| Hechos | `dl.soc-user-admin__facts` | `gap:10px`; cada `div` `grid 1fr 1fr gap:8px`; `dt` `11px`/`--text-3`; `dd` `12px`/`--text-1` `overflow-wrap:anywhere` | Label/Cuerpo |
| Sesiones | `.soc-user-admin__sessions` | `h3` `13px/550`; `ul` `gap:8px`; `li` `flex` `justify-between`, `border-top --border-subtle`, `11px`/`--text-2` | — |

### 3.3 Semántica de datos (etiquetas reales)

- **Origen del rol** (`originLabels`, columna «Origen del rol» y en el detalle):
  `group_owner`→«Dueño del grupo» · `admin_group`→«Miembro del grupo admin» ·
  `deploy_binding`→«Asignado en el deploy» · `entra_app_role`→«App role de Entra» ·
  `none`→«Sin acceso».
- **Membresía** (`membershipLabel`): `member`→«Miembro del grupo» · `removed`→«Fuera del
  grupo» · otro→«Identidad del deploy». Si `isOwner`, `<small>Dueño del grupo</small>`.
- **Acceso QAPAQ:** `roles` mapeadas por `roleLabels` (Analista SOC / Líder SOC / Auditor /
  Administrador de plataforma); si vacío → **«Sin acceso asignado»** (fila «sin acceso», no se
  oculta la persona).
- **Estado de sync** (`syncStatus()`, solo en cabecera): `disabled`→«Sincronización
  deshabilitada» (neutral) · `DIRECTORY_FORBIDDEN`→«Pendiente de consentimiento» (warn) ·
  `stale`→«Directorio desactualizado» (warn) · `ok`→«Directorio sincronizado» (ok) ·
  `failed`→«Sincronización fallida» (fail) · si no → «Pendiente de primera sincronización»
  (neutral). **Nunca** un badge de sync por fila.
- **Sesiones del detalle:** `entry.current`→«Sesión actual», si no `sessionStateLabels`
  (Activa/Expirada/Revocada/Reemplazada); `amr.join(' · ')` o «Método MFA no informado»; y
  **motivo de revocación** (`revocationReasonLabel`): `membership_removed`→«Salió del grupo» ·
  `ownership_removed`→«Dejó de ser dueño del grupo».
- **Cuenta Entra:** `null`→«Sin dato» · `true`→«Habilitada» · `false`→«Deshabilitada».

### 3.4 Interacciones

- **Solo lectura.** Clic en `.soc-user-admin__person` ⇒ `openUser(oid)` carga el detalle
  (`api.adminUser`), con guarda `detailRequest.current` contra respuestas fuera de orden.
  **No** hay acción de cambiar rol/membresía (la nota de pie lo declara).
- **Buscar en el padrón.** Filtro **en cliente** sobre `displayName`, `upn`, `oid` y etiquetas
  de rol; `toLocaleLowerCase('es')`. El contador «{visible} de {total} identidades» refleja el
  subconjunto.
- **Actualizar.** `api.adminUsers()` recarga lista + `sync` + `totalCount`.
- **En vivo.** `useChanges({resourceTypes:['session']})`: ante cambios recarga lista y, si hay
  detalle abierto, lo reabre; muestra el aviso polite. «Activo ahora/Sesiones activas» proviene
  de sesión vigente (`activeSessions`, `lastSeenAt`), no de presencia.

### 3.5 Estados

| Estado | Render |
| --- | --- |
| Cargando (sin datos) | `p.soc-table-placeholder role=status` «Consultando el padrón autorizado…» |
| Vacío por búsqueda | `EmptyState` «No hay identidades que coincidan con la búsqueda.» |
| Padrón no disponible (Graph) | Si `mode==='graph'` y (`status==='never'` o `DIRECTORY_FORBIDDEN`): «El padrón no está disponible hasta que Graph complete una sincronización autorizada.» — **no se muestra un padrón incompleto** |
| Sin miembros ni deploy | «No hay miembros visibles ni identidades declaradas en el deploy.» |
| Filas «sin acceso» | la persona aparece con «Sin acceso asignado» + origen «Sin acceso»; se **incluye** (miembro del grupo sin grant QAPAQ) |
| Sync stale/failed | chip warn/fail en la **cabecera**; la lista puede quedar limitada a identidades del deploy (detalle lo explica) |
| Error | `ErrorState` con `correlationId` + «Reintentar» |
| Detalle cargando | `p role=status` «Consultando actividad…» |
| Detalle sin sesiones | `p.soc-muted` «No hay sesiones asociadas a esta identidad.» |

### 3.6 Responsividad (3 breakpoints exactos)

- **≥1101px:** `.soc-user-admin__layout` a **2 columnas** (`minmax(0,1fr)` + `minmax(310px,0.42fr)`):
  tabla a la izquierda, detalle a la derecha.
- **≤1100px** (`soc-responsive.css`): `.soc-user-admin__layout{grid-template-columns:minmax(0,1fr)}`
  → **1 columna** (detalle baja bajo la tabla). Riel forzado a 56px.
- **≤760px:** `.soc-user-admin__toolbar{flex-wrap:wrap; align-items:stretch}`;
  `.soc-user-admin__search{flex:1 1 145px; width:auto}`;
  `.soc-user-admin__toolbar input,select{min-height:44px; font-size:16px}` (táctil 44px +
  16px anti-zoom); `.soc-user-admin__scope{width:100%; margin-left:0; padding-bottom:0}`;
  `.soc-operation-strip{flex-direction:column; align-items:flex-start; gap:8px}`; heading
  apila; `th,td{padding-inline:9px}`.

### 3.7 Micro-detalles

- **No inventar usuarios/datos:** si el nombre falta → «Nombre no disponible»/«Identidad del
  deploy»; `upn ?? oid`. Nunca generar un nombre plausible. Cuando `mode==='disabled'`, el
  detalle añade la nota: «La identidad proviene de la configuración del deploy; el nombre y la
  pertenencia al grupo no se consultan.»
- **Sync solo en cabecera** (confirmado por 10: «sync global en cabecera, no por fila»).
- **«Activo ahora» = sesión vigente**, no presencia; etiqueta de columna «Sesiones activas» +
  «Última actividad» (`RelativeTime`).
- `overflow-wrap:anywhere` en `dd` para UPN/OID largos.
- Fila abierta: `.is-selected` con fondo `--surface-2` (`.soc-user-admin .soc-table tr.is-selected`).

---

## 4 · Vista «Sesiones de acceso» (`/admin/sessions`) — `AdminSessionsPage.tsx`

**Propósito.** Listar las sesiones QAPAQ observadas en los **últimos 7 días (máx. 2.000)** y
permitir **revocación auditable** de sesiones ajenas con **CSRF + motivo (10–500) +
`expectedRevision`**. La actividad es la última solicitud autenticada, **no presencia**.
**Capabilities:** `sessions.read` (listado) y `sessions.revoke` (revocación). Sin
`sessions.revoke`, el botón «Revocar» no se renderiza (Z2).

### 4.1 Anatomía ASCII

```
┌─ .soc-page.soc-admin-sessions ────────────────────────────────────────────┐
│ .soc-page-heading h1 Sesiones de acceso · p «…última solicitud autenticada»│
│                   .soc-page-heading__meta → [Actualizar⟳]                  │
│                                                                           │
│ .soc-admin-sessions__scope role=status  (border-left 2px var(--accent))   │
│   «{countLabel} · últimos {windowDays} días · máximo 2.000»               │
│   «La sesión actual no se puede revocar desde esta vista.»                │
│                                                                           │
│ p.soc-admin-sessions__notice (si notice) «Sesión revocada · {correlationId}»│
│ p.soc-live-announcement (si liveChanges) «Cambió el estado de acceso…»     │
│ <ErrorState> (si error) · p.soc-page-note (si cargando) «Consultando…»     │
│ <EmptyState> (si 0) «No hay sesiones observadas en esta ventana.»         │
│                                                                           │
│ .soc-table-panel.soc-admin-sessions__table                               │
│   table.soc-table                                                         │
│   Persona│Rol│Estado│Método│Última act.│Inicio│Vencimiento│ (Acciones sr) │
│   <tr [is-selected si current][soc-live-change]>                          │
│     strong nombre + small email + small «Esta sesión»                     │
│     StatusChip estado + small motivo revocación                          │
│     … [Revocar|Cancelar] (si state=active && !current)                    │
│   <tr.soc-admin-sessions__confirm-row> (si isConfirming)                  │
│     form: label «Motivo… 10–500» + textarea + [Confirmar revocación]      │
│   footer.soc-table-footer «{countLabel} · ventana de N días» [Cargar sig.]│
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Tabla elemento → clase → medidas → token

| Elemento | Clase / etiqueta | Medidas (textuales) | Token |
| --- | --- | --- | --- |
| Franja de alcance | `.soc-admin-sessions__scope` `role=status` | `flex-wrap`; `justify-between`; `gap:8px 20px`; `margin:0 0 14px`; `padding:10px 12px`; **`border-left:2px solid var(--accent)`**; `--surface-1`; `12px`/`--text-2` | ⚠ `--accent` no definido (ver §4.7) |
| Aviso de revocación | `.soc-admin-sessions__notice` | `margin:0 0 12px`; `12px`/`--text-2` | Secundario |
| Panel tabla | `.soc-table-panel.soc-admin-sessions__table` | ver §1.2 | — |
| Filas no clicables | `.soc-admin-sessions .soc-table tbody tr` | `cursor:default` (no abre detalle) | — |
| Celda persona | `td` `strong`+`small` | `strong` nombre (`'Usuario sin nombre'` si falta), `small` email, `small` «Esta sesión» si `current` | — |
| Estado | `StatusChip` por `sessionState()` | active→ok «Activa» · expired→warn «Vencida» · superseded→neutral «Reemplazada» · revoked→neutral «Revocada» | estado semántico |
| Motivo revocación | `small` | `membership_removed`→«Salió del grupo de admisión.» · `ownership_removed`→«Dejó de ser dueño del grupo.» | Micro |
| Método | `td title=…` | `amr.join(', ')` o «No informado»; `title` «Métodos informados por el proveedor de identidad» | — |
| Instantes | `<time>` + `RelativeTime` | Última act.=`RelativeTime`; Inicio/Vencimiento=`dateTime()` `es-PE` medium/short Lima | tabular-nums |
| Celda acción | `td.soc-admin-sessions__action` | `width:1%`; `white-space:nowrap` | — |
| Botón revocar | `Button variant="danger"` | borde `rgb(255 95 87 / 60%)`; texto `--state-fail`; al confirmar pasa a `ghost` «Cancelar» | `--state-fail` |
| Fila de confirmación | `tr.soc-admin-sessions__confirm-row > td colSpan=8` | fondo `--surface-2` | `--surface-2` |
| Form de confirmación | `.soc-admin-sessions__confirm-row form` | `flex-wrap`; `align-items:end`; `gap:10px`; `max-width:900px` | — |
| Label motivo | `.soc-admin-sessions__confirm-row label` | `width:100%`; `12px`/`--text-2`; «Motivo de revocación · 10–500 caracteres» | Secundario |
| Textarea motivo | `.soc-admin-sessions__confirm-row textarea` | `flex:1 1 300px`; `min-height:72px`; `padding:9px 10px`; borde `--border-control`; `radius:6px`; `--surface-1`; `resize:vertical`; `minLength=10`, `maxLength=500` | `--border-control` |
| Foco textarea | `:focus-visible` | `outline:2px solid var(--accent); outline-offset:2px` | ⚠ `--accent` no definido |
| Pie | `footer.soc-table-footer` | `min-height:50px`; centrado; `{countLabel} · ventana de N días` + [Cargar siguientes] | — |

### 4.3 Interacciones — revocación nivel 3 (06 §6 «Diálogo con motivo»)

- **No autoaprobación / no sesión propia.** La revocación solo aparece si
  `entry.state==='active' && !entry.current`. La franja declara: «La sesión actual no se puede
  revocar desde esta vista.»
- **Confirmación con motivo.** Al pulsar «Revocar», la fila despliega
  `.soc-admin-sessions__confirm-row` con `textarea` y «Confirmar revocación». Guardas de
  `revoke()` (todas deben cumplirse): `confirmRef===entry.ref`, `!entry.current`,
  `entry.state==='active'`, `reason.trim().length` **≥10 y ≤500**. El botón de confirmar está
  deshabilitado mientras `reason.trim().length < 10`.
- **CSRF + revisión.** `api.revokeSession(entry.ref, cleanReason, entry.revision)` envía el
  motivo, el token **CSRF** (gestionado por el cliente/BFF) y `expectedRevision=entry.revision`
  (concurrencia, 06 §5). Tras éxito, reemplaza la fila con `result.data.session`, fija el aviso
  «Sesión revocada · {correlationId}», limpia `reason` y `confirmRef`. **Sin optimistic
  update:** el chip cambia solo cuando el servidor confirma.
- **Cancelar.** Vuelve a pulsar «Cancelar» (botón `ghost`) cierra la fila y limpia motivo/error.
- **Paginación/actualización.** `Cargar siguientes` usa `nextCursor` (append); `Actualizar`
  recarga; guarda `inFlight` evita solapamiento. `useChanges(['session'])` dispara recarga y el
  aviso «Cambió el estado de acceso de una persona»; las filas con `change.resource.id ===
  subjectId` reciben `.soc-live-change` (realce 200ms).

### 4.4 Estados

| Estado | Render |
| --- | --- |
| Cargando (sin datos) | `p.soc-page-note role=status` «Consultando sesiones…» |
| Vacío | `EmptyState` «No hay sesiones observadas en esta ventana.» |
| Error | `ErrorState` con `correlationId` + «Reintentar» |
| Revocación OK | `p.soc-admin-sessions__notice` con `correlationId`; fila actualizada al nuevo estado |
| Revocación rechazada | `setError(result.error)` → `ErrorState`; el formulario de motivo se conserva hasta reabrir (no se reenvía solo) |
| Límite de ventana | `countLabel` = `totalCount >= 2000 ? '2.000 o más registros' : '{N} registros'`; se repite «últimos {windowDays} días · máximo 2.000» |
| Motivo de revocación por baja/propiedad | `small` bajo el chip con el texto de `revocationReasonLabel` |
| Sin capability `sessions.revoke` | columna de acción vacía (botón ausente, no deshabilitado) |

### 4.5 Responsividad (3 breakpoints exactos)

- **≥1101px:** tabla completa de 8 columnas; franja en una línea.
- **≤1100px:** riel 56px; sin regla propia (la tabla hace scroll horizontal por
  `.soc-table-scroll`).
- **≤760px** (`soc-responsive.css`): `.soc-admin-sessions__scope{flex-direction:column}`
  (la franja pasa a **columna**); `.soc-admin-sessions__confirm-row form{align-items:stretch}`;
  `.soc-admin-sessions__confirm-row .soc-button{min-height:44px}` (táctil);
  `th,td{padding-inline:9px}`; topbar 50px; heading apila. El textarea de motivo hereda
  `font-size:16px` de controles táctiles cuando la regla global de inputs aplica.

### 4.6 Micro-detalles

- **Auditable por diseño:** el `correlationId` de la revocación se muestra al operador (prueba
  de registro); el motivo queda en auditoría (consultable en `/audit`).
- **Nombres honestos:** `displayName || 'Usuario sin nombre'`; email solo si existe.
- **Vencimiento siempre visible** (`absoluteExpiresAt`) — corrige la brecha de expiración
  invisible del doc 11 §9 (B-07).
- `tabular-nums` global alinea fechas y contadores.

### 4.7 Defectos marcados (no implementado)

- **⚠ `var(--accent)` sin definir.** `.soc-admin-sessions__scope` (border-left) y el
  `:focus-visible` del textarea usan `--accent`, que **no está declarado** en
  `soc-shell.css:root` ni en ninguna hoja (`--brand-amber` sí existe). Hoy el borde y el anillo
  de foco caen al valor inicial (`currentColor`). **Corrección propuesta:** usar
  `--brand-amber` o definir `--accent` en `:root`. No inventar que funciona.
- **⚠ `.soc-sr-only` sin definir.** El `<span className="soc-sr-only">Acciones</span>` del `th`
  de acciones no tiene CSS de ocultamiento accesible en estas hojas; el texto podría ser
  visible. **Corrección:** añadir la utilidad `.soc-sr-only` estándar.

---

## 5 · Vista «Acceso / Login» (`/login`, BFF OIDC) y errores (`/errors/:code`)

**Propósito.** Pantalla de acceso con **Microsoft Entra** (OIDC vía BFF): un único botón que
navega a `/api/auth/start`. Al volver con error, muestra el **mensaje del catálogo** para el
código, con `correlationId`. No hay formulario de credenciales propio.
**Capabilities:** sin sesión / inicio autorizado (10 §Catálogo · `/login`).
**Componentes:** `application.tsx` (pantalla + splash), `login.css` (layout + cadena
responsiva propia), `login-motion.css` (animación + reduced-motion), `error-banner.tsx`
(`ErrorBanner` para el catálogo de 12 códigos, con `correlationId`).

### 5.1 Anatomía ASCII (clases reales)

```
┌─ main.auth-screen (superficie continua, min-height:100svh, #080808) ─────┐
│ header.auth-topbar (arriba a la izquierda, margen 6.1vw)                  │
│   .login-brand-name «QAPAQ SecOps»                                        │
│                                                                           │
│ section.login-core (capa izquierda, width min(100%-56px,460px))          │
│   h1#login-title «Inicia sesión en tu cuenta» (clamp 25–32px/480)         │
│   p.login-description «Usa tu cuenta corporativa para continuar.»         │
│   div.login-action-group (width min(100%,460px), margin-top:38px)         │
│     button.entra-button.entra-button-enabled                              │
│        <MicrosoftMark/> «Continuar con Microsoft Entra»                   │
│          (o «Conectando con Microsoft Entra…» si redirecting)             │
│     p.login-security-note «Autenticación protegida por Microsoft Entra ID»│
│     p.auth-message solo con error o durante redirección                  │
│                                                                           │
│ footer.auth-footer (absolute, abajo a la izquierda)                       │
│   «© QAPAQ SecOps»                                                       │
│ <HeroArt/> → .brand-panel (fondo completo, sombra, sin divisor)           │
│   retrato a la derecha, disuelto hacia el negro a la izquierda            │
│ <CookieNotice/>                                                           │
└───────────────────────────────────────────────────────────────────────────┘

Splash (antes de la consola):  .auth-splash / .auth-splash-mark (Q blanca)
ErrorBanner (catálogo):  section.qapaq-error[data-error-code]
   p.qapaq-error__message · p.qapaq-error__meta (a «Ver ayuda» + «· Referencia: {id}»)
   button → ACTION_LABELS[action]
```

### 5.2 Tabla elemento → clase → medidas → token (valores **textuales** de `login.css`)

| Elemento | Clase | Medidas | Color |
| --- | --- | --- | --- |
| Lienzo | `.auth-screen` | `display:grid`; una columna; `min-height:100svh`; `overflow:hidden`; stacking context aislado | `#080808` |
| Topbar | `.auth-topbar` | margen superior `clamp(34px,6.6vh,64px)` e izquierdo `clamp(28px,6.1vw,88px)` | — |
| Marca | `.login-brand-name` dentro de `.auth-topbar` | «QAPAQ SecOps», alineado a la izquierda, `font-size:clamp(24px,2.25vw,32px)` | `#f4f4f5` |
| Descripción | `.login-description` | «Usa tu cuenta corporativa para continuar.»; 14 px, interlineado 1.6 | `#9d9da2` |
| Núcleo | `.login-core` | `width:min(100% - 56px,460px)`; `min-height:100svh`; margen izquierdo `clamp(28px,6.1vw,88px)`; centrado vertical, alineado a la izquierda | — |
| H1 | `.login-core h1` | `font-size:clamp(25px,2.1vw,32px)`; `font-weight:480`; `letter-spacing:-0.035em`; `line-height:1.3`; `text-wrap:balance` | `#f5f5f5` |
| Grupo de acción | `.login-action-group` | `width:min(100%,460px)`; `margin-top:38px` | — |
| Botón Entra | `.entra-button` | `width:100%`; `min-height:52px`; `gap:12px`; `padding:12px 20px`; borde `1px #3b3b3f`; `border-radius:999px`; `font:14px/550` | `bg rgb(10 10 10 / 84%)`, `color #f3f3f4` |
| Botón habilitado | `.entra-button-enabled` | `cursor:pointer`; `transition 160ms`; hover `border #929297`, `bg #131315`, `translateY(-1px)`; focus `outline:2px #f5f5f5 offset 3px`; disabled `cursor:progress; opacity:0.75` | `color #f3f3f4` |
| Marca Microsoft | `.microsoft-mark` | `18×18`; cuatro cuadros `#f25022/#7fba00/#00a4ef/#ffb900` | — |
| Mensaje | `.auth-message` | `margin-top:13px`; `font-size:13px`; `line-height:1.5`; solo durante redirección o con error | `#9d9da2` |
| Mensaje error | `.auth-message-error` | (modificador) | `#f4a6a6` |
| Confianza Entra | `.login-security-note` | Bajo el botón; candado de 16 px y texto de 12 px | texto `#8e8e93`, candado `#c49a5a` |
| Pie | `.auth-footer` | `position:absolute`; abajo a la izquierda; `font-size:12px`; alineación izquierda | `#89898e`; «© QAPAQ SecOps» |
| Arte | `.brand-panel` + `.login-art-shade` | Capa absoluta a pantalla completa; retrato a la derecha; degradado oscuro continuo entre texto e imagen; sin borde ni divisor | `#080808`; halo ámbar tenue |
| Splash | `.auth-splash` / `--waiting` | `fixed inset:0`; `place-items:center`; `auth-splash-out 1050ms`; `--waiting` detiene la animación | `#080808` |
| Marca splash | `.auth-splash-mark` | `width:clamp(64px,7vw,96px)`; `aspect-ratio:1`; `opacity:0.76`; `drop-shadow 0 0 16px rgb(255 255 255 /12%)` | `#fff` |

### 5.3 Error banner (catálogo) — `error-banner.tsx`

| Elemento | Clase | Contenido |
| --- | --- | --- |
| Contenedor | `section.qapaq-error[data-error-code]` `role=alert` | — |
| Mensaje | `p.qapaq-error__message` | `error.message` **del catálogo** (no se inventa texto por código) |
| Meta | `p.qapaq-error__meta` | `<a href={helpRef} target=_blank>Ver ayuda</a>` + `span[data-testid=correlation-id]` « · Referencia: {correlationId}» |
| Acción | `button` | `ACTION_LABELS[error.action]` (ver abajo) o «Continuar» |

`ACTION_LABELS`: `sign_in_again`→«Iniciar sesión» · `register_passkey`→«Registrar passkey» ·
`use_qapaq_network`→«Conectarse a la red QAPAQ» · `retry_later`→«Reintentar» ·
`reload_resource`→«Recargar el elemento» · `correct_input`→«Corregir los datos» ·
`contact_support`→«Contactar a soporte».

### 5.4 Estados de error por código (06 §4 · 12 códigos del catálogo)

En la **pantalla de acceso** (`application.tsx`), el error llega por
`?authError=<código>&correlationId=`; solo se acepta si el código está en `API_ERROR_CODES`
(`apiError(code, correlationId)`), de lo contrario se **ignora**. El mensaje se pinta en
`p.auth-message` con `role=alert`; la descripción institucional fija está en
`p.login-description`, y el mensaje de estado solo aparece durante la redirección.

| `code` | HTTP | Dónde (06 §4.1) | Acción sugerida |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Diálogo de sesión | Iniciar sesión |
| `SESSION_EXPIRED` | 401 | Diálogo de sesión / acceso | Iniciar sesión |
| `AUTH_FAILED` | 401 | **Pantalla de acceso** | Intentar otra vez |
| `PASSKEY_REQUIRED` | 401 | **Pantalla de acceso** | Guía de passkey |
| `NETWORK_NOT_ALLOWED` | 403 | Pantalla completa | Red QAPAQ / VPN |
| `REQUEST_NOT_VERIFIED` | 403 | Banner en el elemento | Releer sesión (nuevo CSRF) + recargar; no reenvía el comando solo |
| `RATE_LIMITED` | 429 | En línea | Espera de 60 s visible |
| `RESOURCE_UNAVAILABLE` | 404 | Lectura «No disponible» / comando banner | Recargar el elemento |
| `STATE_CONFLICT` | 409 | Banner en el elemento | Recarga; conserva formulario |
| `VALIDATION_FAILED` | 422 | Junto al campo (con `fields`) o sobre el botón | Corregir |
| `DEPENDENCY_DEGRADED` | 503 | `ErrorState` de sección | Reintento con espera creciente (2/4/8s, máx 3) |
| `INTERNAL_ERROR` / fuera de catálogo | 500 | `ErrorState` | «No asumas que la operación se completó» |

Regla transversal: **todo error lleva `correlationId`** y enlace «Ver ayuda»/«Qué significa»
(`/errors/:code`); nunca stack, URL interna ni cuerpo crudo.

### 5.5 Interacciones

- **Iniciar sesión.** `signIn()` ⇒ `window.location.assign('/api/auth/start?returnTo=<console.html>')`
  (navegación 303 del BFF, **no** `fetch`). Durante la redirección: botón `disabled`, copia
  «Conectando con Microsoft Entra…» y `p.auth-message` «Conectando de forma segura…».
- **Arranque de sesión.** Al montar, `api.session()` decide: si autenticado →
  `<SocConsole>`; si no → pantalla de acceso. Antes, `QapaqSplash` (1.050ms, o `waiting`).
- **Splash respeta reduced-motion:** `showSplash` se inicia `false` si
  `prefers-reduced-motion: reduce`.

### 5.6 Responsividad — **cadena propia del login** (`login.css`, textual)

Independiente de los breakpoints SOC (1100/760). Umbrales propios: **800px**, **620px** y
**max-height 680px**; más un refuerzo `min-width:1440px and min-height:800px`.

- **`@media (min-width:1440px) and (min-height:800px)`** (holgura en pantallas grandes):
  `.login-action-group{margin-top:44px}`; `.api-check-row{margin-top:48px}`.
- **`@media (max-width:800px)`:** la superficie sigue continua; el retrato reduce escala y
  opacidad, mientras el degradado protege el contraste. Marca, contenido y pie usan 28 px de
  margen izquierdo; el núcleo mide `min(100% - 56px,430px)`.
- **`@media (max-width:620px)`:** una columna; el retrato permanece tenue en la parte inferior
  con máscara vertical. El margen izquierdo pasa a 18 px;
  `.login-brand-name{font-size:clamp(25px,7vw,30px)}`;
  `.login-core{position:relative; min-height:100svh; width:min(100% - 36px,460px); margin-left:18px; padding:126px 0 120px}`;
  `.login-core h1{max-width:360px; font-size:clamp(25px,7vw,31px)}`;
  `.login-action-group{margin-top:32px}`; `.api-check-row{flex-direction:column; gap:8px; margin-top:34px}`;
  `.auth-footer{z-index:2; bottom:calc(178px + env(safe-area-inset-bottom)); left:18px; font-size:11px}`
  para mantener visible el copyright sobre el aviso fijo de cookies.
- **`@media (max-height:680px) and (min-width:621px)`** (pantallas bajas, no móvil estrecho):
  `.login-core{padding-block:118px 76px}`; `.login-action-group{margin-top:24px}`;
  `.login-description{margin-top:14px}`;
  `.api-check-row{margin-top:25px}`; `.auth-footer{bottom:10px}`.

> Nota: `.api-check-row` / `.api-check-button` / `.api-explanation` están **estilados** en
> `login.css` pero **no se renderizan** en `application.tsx` actual (es un bloque de
> comprobación de API latente). Se documenta como *no implementado en la vista actual*.

### 5.7 Movimiento (`login-motion.css`) y reduced-motion

- Entrada escalonada con `cubic-bezier(0.16,1,0.3,1)`: `.auth-topbar` `auth-content-enter 780ms
  120ms`; `.login-core` `900ms 180ms`; `.auth-footer` `720ms 280ms`. Splash:
  `auth-splash-out`/`auth-mark-out` 1050ms. El retrato aparece suavemente; la luz ámbar
  permanece tenue y se funde con la sombra continua.
- El retrato de `HeroArt` (`qapaq-secops-analyst.webp`) entra con `login-analyst-arrival` en
  1700ms. La jerarquía permanece estática: marca arriba a la izquierda, título, descripción,
  botón y confirmación visual de Entra.
- **`prefers-reduced-motion: reduce`:** todas las animaciones a `0.01ms !important`;
  `.auth-splash{display:none}` salvo dentro de `.auth-startup`; `auth-topbar/login-core/
  auth-footer/…::after` con `animation:none; opacity:1`; el retrato queda fijo y el degradado
  conserva el contraste. La pantalla es legible sin animación.

### 5.8 Micro-detalles

- **Mensaje de error del catálogo, nunca inventado** (C-27). Código fuera de catálogo ⇒
  ignorado, no se improvisa texto.
- **`correlationId` siempre presente** en el error (banner `data-testid=correlation-id`).
- **Marca Microsoft** con sus cuatro colores oficiales; es la única excepción cromática
  (identidad del proveedor), no decorativa.
- **`.qapaq-error` sin CSS dedicado** en `login.css`/`styles.css` ⇒ el banner del catálogo se
  ve sin estilo propio en estas hojas (hoy `ErrorBanner` solo se usa en `console.tsx` legacy).
  Marcar como *no implementado* para `/login`/`/errors/:code`.

---

## 6 · Prohibido (doc 10 §«Lo que el diseño debe evitar»)

- **Enumerar lo no permitido:** nada de botones grises con tooltip «sin permiso». Sin
  `audit.read_sensitive` no se muestra IP/sessionId; sin `sessions.revoke` no hay botón
  «Revocar»; sin `users.read` la ruta no aparece (Z2/Z5).
- **Inventar usuarios/datos:** no generar nombres, no simular un padrón cuando Graph no ha
  sincronizado; «Nombre no disponible» / «Sin dato» / «Sin acceso asignado» son los únicos
  placeholders.
- **Verde/estado inventado:** sync `ok` solo con `status==='ok'`; cadena «íntegra» solo con
  `result.ok`; vacío ≠ ok.
- **Confirmaciones sin impacto:** la revocación resume la consecuencia y exige motivo; nada de
  «¿Estás seguro?». Sin autoaprobación (no revocar la propia sesión).
- **Errores sin instrucción ni `correlationId`.** Nunca stack, URL interna ni cuerpo crudo.
- **Ruido visual:** sin glow/neón, gradientes de fondo, grids de tarjetas idénticas, iconos de
  packs genéricos (solo `SocIcon`); severidad/estado nunca solo por color.
- **Copiar píxel a píxel** Splunk/Sentinel/Elastic/Wazuh; implementar el concepto propio de
  QAPAQ.
- **Respuesta automática con privilegio implícito:** no aplica aquí (vistas de lectura), y no
  introducir acciones de escritura fuera de la revocación auditada.

---

## 7 · Checklist de aceptación

**Auditoría / Integridad**
- [ ] Tabla densa (filas 40px, `th` 32px); 7 columnas; `correlationId` a 8 + `title`.
- [ ] Rango ≤365 días validado en cliente; filtros aplicados en el BFF; cursor continúa la
  consulta.
- [ ] Datos sensibles: solo nota «datos sensibles redactados» sin `audit.read_sensitive`;
  nunca el valor crudo.
- [ ] Integridad: auto-verifica solo con `audit.verify`; chip ok/fail; límite «primeros 1 000»
  siempre visible; tabla de violaciones solo si existen.
- [ ] Errores con `ErrorState` + `correlationId` + «Reintentar».

**Usuarios SOC**
- [ ] Solo lectura: sin acción de cambiar rol/membresía; nota de pie presente.
- [ ] Origen del rol con las 5 etiquetas; filas «Sin acceso asignado» incluidas.
- [ ] Estado de sync **en cabecera** (`.soc-operation-strip`), nunca por fila; `stale`/`failed`
  explicados.
- [ ] «Sesiones activas» / «Última actividad» = sesión vigente, no presencia.
- [ ] `≤1100px`: `.soc-user-admin__layout` a 1 columna. `≤760px`: inputs 44px/16px, toolbar
  apila.
- [ ] No inventa nombres; `upn ?? oid`.

**Sesiones de acceso**
- [ ] Listado 7 días, máx 2.000 (`countLabel`); vencimiento visible.
- [ ] Revocación solo en `active && !current`; motivo 10–500; CSRF + `expectedRevision`; sin
  optimistic update; `correlationId` en el aviso.
- [ ] Motivo de revocación por baja de grupo / pérdida de propiedad mostrado.
- [ ] `≤760px`: `.soc-admin-sessions__scope` en columna; confirmar 44px.
- [ ] ⚠ `--accent` y `.soc-sr-only` marcados como pendientes.

**Acceso / Login / Errores**
- [ ] Botón único → `/api/auth/start` (navegación, no fetch); mensajes del catálogo por código;
  `correlationId` siempre.
- [ ] Cadena responsiva propia: 800 / 620 (oculta `.brand-panel`) / max-height 680; 1440×800
  de holgura.
- [ ] `prefers-reduced-motion`: legible sin animación; splash off.
- [ ] ⚠ `.qapaq-error` sin estilo y bloque `api-check-*` no renderizado: marcados.

---

## 8 · Trazabilidad

- **Tokens/escala/breakpoints:** [`11-mi-sesion-y-shell-spec.md`](11-mi-sesion-y-shell-spec.md)
  §1 (tokens), §5 (1100/760) — fuente de verdad.
- **Pantallas:** [`04-pantallas.md`](04-pantallas.md) §0 (Acceso), §5 (Auditoría), §7
  (Plataforma).
- **Interacción:** [`06-patrones-de-interaccion.md`](06-patrones-de-interaccion.md) §2
  (autorización Z1–Z7), §3 (estados de datos), §4 (12 códigos de error + `correlationId`), §5
  (revisión/concurrencia), §6 (confirmación nivel 3 con motivo).
- **Rol/ruta/prohibiciones:** [`10-vistas-por-rol-y-referencias.md`](10-vistas-por-rol-y-referencias.md)
  (catálogo `/audit`,`/admin/users`,`/admin/sessions`,`/login`; sync en cabecera; «Activo
  ahora» = sesión; §«Lo que evitar»).
- **Brechas:** [`08-brechas-y-decisiones.md`](08-brechas-y-decisiones.md) (B-07 expiración
  visible, resuelta en Sesiones).
- **Código:**
  `apps/web/src/components/soc/AuditPage.tsx`, `IntegrityPage.tsx`,
  `UserAdministrationPage.tsx`, `AdminSessionsPage.tsx`;
  `apps/web/src/app/application.tsx`, `error-banner.tsx`;
  `apps/web/src/app/soc-data.css` (`.soc-filter-bar`, `.soc-table*`, `.soc-user-admin*`,
  `.soc-admin-sessions*`, `.soc-operation-strip`, `.soc-integrity-summary`, `.soc-panel*`),
  `soc-shell.css` (tokens `:root`, `.soc-status*`), `soc-responsive.css` (1100/760),
  `login.css` + `login-motion.css` (cadena 800/620/680 + movimiento + reduced-motion).
- **Defectos a corregir (no implementado):** `--accent` sin declarar (usado en
  `.soc-admin-sessions__scope` y foco de textarea), `.soc-sr-only` sin CSS, `.qapaq-error` sin
  estilo para `/login`, bloque `api-check-*` estilado pero no renderizado. No existen
  `admin-*.css` para estas superficies SOC.
</content>
</invoke>
