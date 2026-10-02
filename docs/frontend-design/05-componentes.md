# 05 · Componentes

Estado: **especificación de diseño**. Fecha: 2026-10-02.

Inventario cerrado de componentes. Cada uno indica anatomía, medidas en
tokens ([02](02-sistema-visual.md)), estados y requisitos de accesibilidad.
Un componente que no está aquí no se crea sin agregarlo antes a este
documento.

Ubicación en código ([06 · §8](06-patrones-de-interaccion.md#8-reglas-de-código-de-estilos)):
primitivas en `src/design/primitives/`, compuestos de dominio en
`src/components/`.

---

## 1. Primitivas

### 1.1 Button

| Variante | Fondo | Texto | Borde | Uso |
| --- | --- | --- | --- | --- |
| `primary` | `--text-1` | `--text-inverse` | ninguno | **Una** por vista: la acción siguiente del flujo |
| `secondary` | transparente | `--text-1` | 1 px `--border-control` | Resto de acciones |
| `ghost` | transparente | `--text-2` | ninguno | Acciones de herramienta (copiar, expandir) |
| `danger` | transparente | `--state-fail` | 1 px `--state-fail` al 60 % | Cerrar incidente, revocar credencial. Nunca rojo relleno |

- Forma: `--radius-pill`. Alto `sm` 28 px / `md` 36 px. Relleno horizontal
  `--space-3` / `--space-4`. Texto `--type-body` peso 550.
- Hover: `secondary` → borde `--border-control-hover`, fondo `--surface-2`;
  `primary` → fondo `#ffffff`. Sin `translateY` (el login lo usa; la consola
  no, porque las filas se mueven bajo el cursor).
- `loading`: el rótulo cambia a gerundio ("Reconociendo…") y aparece un
  `Spinner` de 12 px a la izquierda. El ancho no cambia.
- Solo icono: `aria-label` obligatorio y `Tooltip`.

### 1.2 Campos

| Componente | Especificación |
| --- | --- |
| `TextField` | Alto 36 px, `--radius-control`, fondo `--surface-2`, borde `--border-control`. Rótulo **encima** (nunca solo placeholder), 12 px `--text-2`. Ayuda y error debajo, ligados por `aria-describedby`. Error: borde `--state-fail` + texto con glifo × |
| `Textarea` | Igual; contador `n / máx` alineado a la derecha en mono tabular, pasa a `--state-warn` al 90 % |
| `SearchField` | Píldora, icono lupa, botón limpiar, atajo `/` visible |
| `Select` / `Combobox` | Lista en capa `--surface-3`; búsqueda en el combobox; estados carga, vacío ("Sin coincidencias"), error |
| `RadioGroup` | Vertical para opciones con explicación (veredicto). Cada opción: rótulo 13 px + ayuda 12 px `--text-3` |
| `Checkbox` | 16 px, estado indeterminado para "seleccionar todo" |
| `TimeRangePicker` | Presets 1 h · 24 h · 7 d · 30 d · personalizada. Recibe `maxRange` (90 d eventos, 365 d auditoría) y **no permite** superarlo. Muestra la zona horaria |

### 1.3 Indicadores

| Componente | Especificación |
| --- | --- |
| `SeverityIndicator` | Glifo (◆ ▲ ■ ●) 10 px + rótulo ("P1") 12 px peso 600 + `score` opcional en `--text-3` tabular. Color de `--sev-n` en glifo y rótulo. Acepta `priority` o `severity` |
| `StatusChip` | Píldora 20 px de alto, borde 1 px `--border-default`, texto 12 px. Punto de 6 px a la izquierda en el color del estado (neutro para estados de flujo, estado para resultados). Rótulo del catálogo de [01 · §3](01-inventario-backend.md#3-enumeraciones-exactas) |
| `HealthMark` | La del login: círculo 15 px, borde 1 px, glifo ✓ ! × – centrado. Variante `checking` con el giro de 700 ms ya existente |
| `NotificationStatusChip` | `StatusChip` especializado: `sent` se rinde como "Entregada · sin acuse" con "sin acuse" en `--state-warn`; `acknowledged` como "Acusada por [persona]" |
| `RelativeTime` | "hace 4 min"; `title` y `aria-label` con absoluto `2026-10-02 14:02:11 America/Lima`. Se actualiza cada 30 s, sin anunciar el cambio |
| `MonoId` | Identificador abreviado (8 caracteres + "…"), completo en `title`, con `CopyButton` al hover y al foco |
| `CopyButton` | `ghost` 24 px; tras copiar, icono ✓ 1.5 s y anuncio "Copiado" en región viva |
| `RedactedValue` | `[redactado]` en `--text-3` con icono de candado de trazo. Sin estado "revelar". Tooltip: "No visible con tus permisos" **solo** en auditoría (donde la redacción es esperada); en secretos: "El valor nunca se muestra" |
| `Spinner` | 12/16/20 px, trazo 1.65, `role="status"` con texto oculto |
| `Skeleton` | Bloque `--surface-2` con la forma final (fila, línea, bloque); opacidad 0.6↔1 en 1.4 s; sin gradiente |

### 1.4 Contenedores

| Componente | Especificación |
| --- | --- |
| `Panel` | `--surface-1`, borde `--border-default`, `--radius-panel`. Cabecera 44 px con título `--type-heading` y acciones `ghost` a la derecha. Sin sombra |
| `Drawer` | Derecha, 480 px (400–720 redimensionable con asa de 4 px). Cabecera fija con cierre, cuerpo con scroll propio. Atrapa foco solo en modo modal (< 1280 px); en ≥ 1280 px **no** es modal: la lista sigue operable con `j`/`k` y el drawer sigue a la fila |
| `Dialog` | Ancho 480 / 640 px, `--surface-3`, velo 64 %. Título, cuerpo, pie con acciones a la derecha (cancelar a la izquierda de la primaria). `Esc` cierra salvo con envío en curso |
| `Tabs` | Rótulo + contador mono. Activa: `--text-1` y subrayado de 2 px `--text-1` (no ámbar: el ámbar es del riel). Flechas izquierda/derecha |
| `Toast` | Abajo a la derecha, 360 px, `--surface-3`. Éxito 4 s; error **no se cierra solo** si trae `correlationId` |
| `Tooltip` | 12 px, `--surface-3`, retardo 400 ms, accesible por foco. Nunca porta información única |

### 1.5 Datos

| Componente | Especificación |
| --- | --- |
| `DataTable` | Cabecera fija 32 px con `--type-label`; filas según densidad; separador `--border-subtle`; hover `--surface-2`; seleccionada `--surface-selected`; activa (abierta en drawer) con borde izquierdo 2 px `--text-1`. Columnas redimensionables y ocultables (preferencia por navegador). Orden por cabecera con `aria-sort`. Teclado `j`/`k`/`Enter`/`x` |
| `CursorPagination` | "Anterior" · "Siguiente" y "50 por página ▾". **Sin números de página ni total** |
| `DescriptionList` | Dos columnas: clave 12 px `--text-3` de 160 px, valor 13 px `--text-1`. Valores técnicos en mono |
| `JsonViewer` | Mono 12 px, plegable por nivel, búsqueda, copiar ruta y valor. Valores `[REDACTED]` como `RedactedValue` |
| `Timeline` | Vertical. Por evento: hora absoluta (mono) · actor · acción en lenguaje natural · resultado. Línea de 1 px `--border-default`. Sin edición |
| `LifecycleStepper` | Pasos con círculo 10 px y rótulo. Completado: lleno `--text-2`. Actual: lleno `--text-1` + rótulo peso 550. Omitido: conector punteado y la palabra "omitido" bajo el rótulo en `--text-3`. Pendiente: vacío `--border-control`. Variante compacta para celda (solo círculos + rótulo del actual) |
| `MetricTile` | Rótulo 12 px · valor 20 px tabular · contexto obligatorio ("de 23 abiertas", "en las últimas 24 h"). Todo el tile es enlace a la lista filtrada que compone el número. **Sin flecha de tendencia** si no hay periodo de comparación real |

---

## 2. Componentes de control y seguridad

Son los que garantizan las reglas de [06](06-patrones-de-interaccion.md). Son
los más importantes del inventario.

| Componente | Responsabilidad | Regla |
| --- | --- | --- |
| `CapabilityGate` | Renderiza hijos solo si la sesión tiene la capability | Por omisión **no** renderiza. Sin modo "deshabilitado para mostrar que existe" |
| `CommandAvailability` | Calcula los comandos válidos de una alerta o incidente: estado × capability × asignación | Único lugar donde vive la tabla de transiciones en el cliente. Las pantallas no repiten la lógica |
| `CommandDialog` | Formulario de comando con validación previa (§4 de [01](01-inventario-backend.md#4-reglas-de-negocio-que-la-interfaz-debe-aplicar-antes-de-enviar)), envío con `expectedRevision`, manejo de 409 | Conserva lo escrito ante error o 409 |
| `ReasonRequiredDialog` | Confirmación con motivo escrito obligatorio | Sin motivo válido el botón de envío está deshabilitado **y** el motivo del bloqueo está escrito encima del botón |
| `PrecheckList` | Lista de condiciones que bloquean una acción (alertas sin veredicto antes de cerrar) | Cada ítem enlaza a donde se resuelve |
| `SessionGuard` | Intercepta `AUTH_REQUIRED` / `SESSION_EXPIRED` en cualquier petición | Abre el diálogo de sesión terminada; reintenta la navegación tras reingreso |
| `DemoBoundary` | Envuelve una pantalla o sección servida por `MockAdapter` | Muestra el chip "Demostración" en la cabecera de la pantalla; en build de producción **no renderiza** la pantalla |
| `RedactedValue` | Ver §1.3 | — |

---

## 3. Componentes de estado de datos

| Componente | Cuándo | Qué comunica | Aspecto |
| --- | --- | --- | --- |
| `LoadingState` | Primera carga > 300 ms | Que se está consultando | `Skeleton` con la forma final |
| `EmptyState` | Consulta válida, cero resultados | **La consulta funcionó** y no hay datos; qué ampliar | Una línea `--text-2` + una acción. Sin ilustración |
| `FilteredEmptyState` | Cero resultados por filtros del usuario | Que los filtros lo explican | "Ninguna alerta coincide con P1 + Sin asignar. Quitar filtros" |
| `PartialResultBanner` | Resultado incompleto (filtro en cliente, límite de `verify`) | Qué falta y por qué | Franja `--state-info` sobre la tabla |
| `DegradedBanner` | Fuente o pipeline degradado | **Sin datos no confirma ausencia de actividad** | Franja `--state-warn`/`--state-fail` persistente; no se cierra |
| `StaleDataBanner` | Último refresco fallido, datos anteriores visibles | Antigüedad exacta del dato mostrado | "Mostrando datos de hace 3 min. El último refresco falló · Reintentar" |
| `ErrorState` | Fallo de la sección | Mensaje del catálogo, acción, `correlationId` | Glifo × + mensaje + acción + `MonoId` del `correlationId` |
| `SectionBoundary` | Envuelve cada sección | Aísla el fallo | — |

`EmptyState` y `DegradedBanner` **no se parecen en nada**: uno es una línea
gris centrada en la tabla; el otro, una franja de color arriba con glifo. Si
ambos aplican, se muestran ambos.

---

## 4. Compuestos de dominio

| Componente | Contenido | Pantalla |
| --- | --- | --- |
| `AlertQueueTable` | Columnas de [04 · §3.3](04-pantallas.md#33-columnas); pestañas de estado; selección masiva | Alertas |
| `AlertDrawer` | Cabecera, acciones (`CommandAvailability`), `PriorityBreakdown`, detalle, historial | Alertas |
| `PriorityBreakdown` | `reasons[]` como lista de código traducido → `delta` alineado a la derecha, y la puntuación final | Alerta |
| `TriageForm` | Veredicto + nota con contador | Alerta |
| `OpenIncidentForm` | Título, severidad precalculada desde prioridad, resumen | Alerta |
| `IncidentTable` | Columnas de [04 · §4.1](04-pantallas.md#41-lista) con `LifecycleStepper` compacto | Incidentes |
| `IncidentHeader` | Severidad, título, propietario, `LifecycleStepper` completo, menú de acciones | Incidente |
| `LinkedAlertsPanel` | Alertas de `alertIds` con estado y veredicto; marca las que bloquean el cierre | Incidente |
| `AuditTable` / `AuditDetail` | [04 · §5](04-pantallas.md#5-auditoría) | Auditoría |
| `ChainIntegrityPanel` | Resultado de `verify` | Integridad, Resumen |
| `NotificationTable` | [04 · §6](04-pantallas.md#6-notificaciones) | Notificaciones |
| `PipelineStatusPill` | `HealthMark` + texto corto en la barra superior | Global |
| `SourceHealthCard` | Estado, razones con valor y umbral, último éxito | Plataforma |
| `QuarantineTable` / `LineageChain` | Causa, estado, intentos; cadena de cinco identificadores | Cuarentena |
| `CredentialTable` / `WriteOnlySecretField` | Metadatos; campo de una sola escritura sin "mostrar" | Credenciales |
| `EventTable` / `EventDetail` | [04 · §2](04-pantallas.md#2-eventos) | Eventos |

---

## 5. Catálogo de textos

Los textos visibles **no se escriben en JSX**: salen de
`src/i18n/es.ts`. Claves por dominio (`alert.status.new`,
`error.STATE_CONFLICT.action`). Si una clave falta se muestra el texto base en
español del catálogo de errores (`packages/contracts`), **nunca la clave**.

Traducciones obligatorias desde el primer día: todos los valores de
[01 · §3](01-inventario-backend.md#3-enumeraciones-exactas) y los 12 códigos de
error del catálogo.
