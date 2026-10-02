# 06 · Patrones de interacción

Estado: **especificación de diseño**. Fecha: 2026-10-02.

Reglas de comportamiento que aplican a todas las pantallas. Cuando una
pantalla de [04](04-pantallas.md) no dice cómo tratar un caso, aplica lo que
dice aquí.

---

## 1. Niveles de disponibilidad

Cada pantalla o sección tiene un nivel ([01](01-inventario-backend.md)):

| Nivel | Adaptador | En desarrollo | En producción |
| --- | --- | --- | --- |
| API | `HttpAdapter` contra `/api/*` | Visible | Visible |
| DOMINIO | `MockAdapter` con el contrato del dominio | Visible con chip **Demostración** | **No se renderiza** (`DemoBoundary`) |
| DOC | ninguno | Ausente | Ausente |

Reglas:

1. **Un adaptador por recurso, no por aplicación.** La consola usa
   `HttpAdapter` para alertas aunque los eventos sigan en mock. Hoy
   [`application.tsx`](../../apps/web/src/app/application.tsx) instancia
   `MockAdminApi` para todo; esa decisión se sustituye por un registro de
   adaptadores por recurso.
2. Los tipos del frontend se derivan del **dominio real** (`AlertView`,
   `IncidentView`…), no de [`admin.ts`](../../apps/web/src/api/admin.ts). El
   mock implementa los tipos reales, no al revés.
3. Un dato de demostración nunca se mezcla con uno real en la misma tabla o
   tarjeta.

---

## 2. Autorización en la interfaz

| # | Regla |
| --- | --- |
| Z1 | La UI **no sustituye** la autorización del servidor. Ocultar un botón es experiencia de uso, no control. |
| Z2 | **Ausente, no deshabilitado.** Sin capability no se renderiza la acción, el ítem del riel ni la sección. Un botón gris con tooltip "sin permiso" enumera lo que existe. |
| Z3 | Se decide por **capability**, nunca por nombre de rol. |
| Z4 | Lo **deshabilitado** se reserva para condiciones que el usuario puede resolver: formulario incompleto, presupuesto de reintentos agotado, alertas sin veredicto antes del cierre. Siempre con el motivo escrito junto al control. |
| Z5 | **No enumeración.** 404 por falta de permiso y 404 por inexistencia se presentan igual ("No disponible"). |
| Z6 | Campos ausentes por permiso (`rawRef`, `raw`) no dejan hueco ni rótulo vacío. |
| Z7 | Las capabilities se releen de `/api/auth/session` al arrancar, al volver el foco a la pestaña tras > 5 min y tras cualquier 404 en una acción que la UI creía permitida. |

---

## 3. Estados de datos

Seis estados, todos distintos a la vista ([05 · §3](05-componentes.md#3-componentes-de-estado-de-datos)):

| Estado | Detectado por | Se muestra |
| --- | --- | --- |
| Cargando | petición en curso, sin datos previos | `Skeleton` tras 300 ms (antes, nada: evita parpadeo) |
| Vacío | 200 con `items: []` | `EmptyState` |
| Vacío por filtros | 200 con datos que el filtro deja en cero | `FilteredEmptyState` |
| Parcial | filtro en cliente, límite de servidor | `PartialResultBanner` |
| Degradado | salud del pipeline `degraded`/`failed`, o `DEPENDENCY_DEGRADED` | `DegradedBanner` **además** del contenido |
| Viejo | refresco fallido con datos previos | Se mantienen los datos + `StaleDataBanner` |
| Error | fallo sin datos previos | `ErrorState` |

**Regla de honestidad.** Ningún indicador afirma más de lo que mide. Mientras
no exista API de salud del pipeline, la UI no tiene forma de saber si la
ingesta está al día, y lo dice: "Ingesta: sin datos de salud". La peor falla
de un SOC es una pantalla vacía que parece "no pasó nada" cuando significa "no
estamos viendo nada".

Cada pantalla muestra "actualizado hace N s" en la cabecera, en
`RelativeTime`.

---

## 4. Errores

Cuerpo del BFF: `{ code, message, action, helpRef, retriable, correlationId,
fields? }`.

### 4.1 Presentación por código

| `code` | HTTP | Dónde | Texto | Acción |
| --- | --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Diálogo de sesión | "Inicie sesión para continuar." | Iniciar sesión |
| `SESSION_EXPIRED` | 401 | Diálogo de sesión | "Su sesión terminó. Vuelva a iniciar sesión." Si el usuario abrió otra sesión: "Iniciaste sesión en otro navegador." | Iniciar sesión |
| `AUTH_FAILED` | 401 | Pantalla de acceso | mensaje del catálogo | Intentar otra vez |
| `PASSKEY_REQUIRED` | 401 | Pantalla de acceso | mensaje del catálogo | Guía de passkey |
| `NETWORK_NOT_ALLOWED` | 403 | Pantalla completa | mensaje del catálogo | Red QAPAQ o VPN |
| `REQUEST_NOT_VERIFIED` | 403 | Banner en el elemento | "No fue posible verificar la solicitud. Recargue la página e intente de nuevo." | Releer `/api/auth/session` (nuevo `csrfToken`) y recargar el elemento. **No** se reenvía el comando solo: la persona decide |
| `RATE_LIMITED` | 429 | En línea | mensaje del catálogo | Espera de 60 s visible (el BFF no envía `Retry-After`) |
| `RESOURCE_UNAVAILABLE` | 404 | En una lectura: "No disponible". En un comando: banner en el drawer | "Esta acción no está disponible para ti o el elemento cambió." | Recargar el elemento |
| `STATE_CONFLICT` | 409 | Banner en el elemento | "Otra persona cambió este elemento. Revisa el estado nuevo." | Recarga automática; conserva el formulario |
| `VALIDATION_FAILED` | 422 | Con `fields`: junto a cada campo. Sin `fields`: encima del botón de envío | "Revise los datos ingresados." | Corregir |
| `DEPENDENCY_DEGRADED` | 503 | `ErrorState` de sección | mensaje del catálogo | Reintento con espera creciente (2, 4, 8 s; máx. 3) |
| `INTERNAL_ERROR` / fuera de catálogo | 500 | `ErrorState` | "No asumas que la operación se completó." | Recargar el elemento y revisar su estado |

Toda presentación de error incluye el `correlationId` en `MonoId` con copia y
el enlace "Qué significa" a `/errors/:code`. Nunca se muestra un stack, una
URL interna ni el cuerpo crudo.

### 4.2 Por qué la UI valida antes

El BFF devuelve `VALIDATION_FAILED` **sin `fields`** para todo error de
dominio (nota corta, veredicto ausente, alertas sin triar), y
`RESOURCE_UNAVAILABLE` para "no eres el asignado". El mensaje genérico no
permite al analista corregir. Por eso cada regla de
[01 · §4](01-inventario-backend.md#4-reglas-de-negocio-que-la-interfaz-debe-aplicar-antes-de-enviar)
se valida en el formulario y **el botón de envío explica qué falta**. Si el
servidor aún rechaza, se asume que el estado cambió: se recarga el elemento.

---

## 5. Concurrencia y revisión

- Todo comando envía `expectedRevision` (alertas, incidentes) o
  `expectedAlertRevision` (abrir incidente), con la revisión del elemento **tal
  como el usuario lo está viendo**.
- Tras un 201, la UI reemplaza el elemento con el devuelto (nueva revisión);
  no vuelve a pedir la lista.
- Ante 409: se recarga el elemento, se marca en el drawer qué cambió ("Estado:
  Nueva → Reconocida por 0191…"), se **conserva** lo escrito en el formulario
  y se vuelve a calcular qué comandos son válidos. El usuario decide si
  reenvía.
- **Sin actualizaciones optimistas** en comandos de estado. El chip cambia
  cuando el servidor confirma. En un SOC, mostrar "cerrada" algo que el
  servidor rechazó es peor que esperar 300 ms.

---

## 6. Acciones críticas y confirmación

Tres niveles. Se elige el menor que proteja la acción.

| Nivel | Patrón | Acciones |
| --- | --- | --- |
| Directo | Clic → envío; resultado en el propio control | Reconocer, marcar contenido/erradicado/resuelto, reabrir |
| Confirmación en línea | El botón pasa a "Confirmar …" 4 s | Acusar notificación |
| Diálogo con motivo | `ReasonRequiredDialog` / `CommandDialog` | Triar, cerrar alerta (con nota), cerrar incidente, reasignar, reprocesar, rotar y revocar credencial |

En todo diálogo:

- El título es la acción y el objeto: "Cerrar incidente 0193…".
- El cuerpo dice **la consecuencia**, no "¿Estás seguro?": "El incidente quedará
  cerrado. Se podrá reabrir; el cierre queda en auditoría."
- El botón repite el verbo: "Cerrar incidente", no "Aceptar".
- Cancelar es siempre la opción de foco inicial en acciones `danger`.

---

## 7. Actualización en vivo

| Pantalla | Intervalo | Condición |
| --- | --- | --- |
| Alertas, Resumen | 15 s | pestaña visible, sin formulario abierto |
| Notificaciones | 15 s | igual |
| Incidentes | 30 s | igual |
| Auditoría | manual | botón "Actualizar" |

- Las peticiones periódicas **renuevan la inactividad** de la sesión en el BFF
  actual (cada petición desliza `lastSeenAt`). El diseño de identidad pide lo
  contrario ([08 · B-07](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)):
  hasta resolverlo, el refresco se detiene tras 10 min sin interacción del
  usuario y la pantalla muestra "Actualización en pausa por inactividad ·
  Reanudar".
- Filas nuevas: si el usuario está arriba de la tabla, se insertan con el
  realce de 1.2 s; si no, aviso "3 alertas nuevas · Ver" sin mover la lista.
- Una fila que el usuario tiene abierta en el drawer nunca desaparece por un
  refresco: si cambió de estado y ya no corresponde a la pestaña, queda
  marcada "ya no está en Abiertas" hasta cerrar el drawer.

---

## 8. Reglas de código de estilos

Reglas de construcción, verificables en revisión. Vienen del análisis
anterior de esta carpeta (commit `cef5d9d`) y siguen vigentes.

### 8.1 El estilo vive en la capa de diseño

> Ningún archivo `.tsx` contiene utilidades de Tailwind ni estilos literales.

```tsx
// NO
<tr className="flex items-center gap-4 px-6 py-2 bg-slate-50 border-b">
<div style={{ padding: '12px 24px', color: '#0F2D4D' }}>

// SÍ: el componente nombra su intención
import styles from './AlertQueueRow.module.css';
<tr className={styles.row} data-priority={priority}>
```

```css
/* AlertQueueRow.module.css */
.row {
  height: var(--row-height);
  border-bottom: 1px solid var(--border-subtle);
}
.row[data-priority='P1'] { box-shadow: inset 3px 0 0 var(--sev-1); }
```

Única excepción: un valor derivado de datos se pasa como **variable CSS**
(`style={{ '--bar-width': `${pct}%` }}`).

El código actual incumple esta regla en
[`HeroArt.tsx`](../../apps/web/src/components/login/HeroArt.tsx) y en
[`application.tsx`](../../apps/web/src/app/application.tsx) (utilidades
Tailwind y `style` literales). Se corrige al migrar a `src/design/`.

### 8.2 Dónde vive cada cosa

| Capa | Contenido |
| --- | --- |
| `src/design/tokens.css` | Variables de [02](02-sistema-visual.md) |
| `src/design/primitives/` | Primitivas de [05 · §1](05-componentes.md#1-primitivas) con CSS colocalizado |
| `src/components/` | Compuestos de dominio, cada uno con su `.module.css` |
| `src/features/` | Pantallas: componen, no estilan |
| `src/lib/` | Adaptadores de API, hooks de datos, `CommandAvailability`, autorización. Sin JSX |
| `src/i18n/` | Catálogo de textos |

### 8.3 Reglas

1. Sin colores, espaciados, radios ni duraciones literales fuera de
   `tokens.css`.
2. Un componente, una responsabilidad.
3. Sin lógica de dominio en JSX: las transiciones viven en
   `CommandAvailability`.
4. Sin `any`, sin `as` para silenciar el compilador.
5. Props explícitas; sin `{...props}` sin declarar.
6. Sin estado derivado duplicado.
7. Textos desde el catálogo.
8. Nombres del dominio: `AlertQueueRow`, no `TableRowWrapper2`.

### 8.4 Verificación

| Control | Estado |
| --- | --- |
| Lint de `className` con utilidades en `.tsx` | por escribir |
| Lint de literales de color/longitud fuera de `tokens.css` (stylelint) | por escribir |
| `tsc` estricto | existente |
| Pruebas de accesibilidad de primitivas (axe en Playwright) | por escribir |
