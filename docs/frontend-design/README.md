# Diseño de frontend — dashboard, secciones por rol e inventario de componentes

Estado: **PROPUESTA DE DISEÑO**, no decisión aceptada. Fecha: 2026-10-01.

Este documento analiza qué necesita la interfaz de QAPAQ SecOps: qué ve cada tipo
de usuario, qué secciones compone su dashboard y qué componentes hacen falta,
hasta el detalle de estado y comportamiento.

**No cambia el plan de entrega.** La interfaz es **C-21** (`apps/web`, PBI-017,
prioridad P1, forecast Sprint 3) y depende de **C-14** (consulta), **C-17** (SOC)
y **C-18** (acceso). Hoy C-14 tiene dominio sin adaptador, y C-17 y C-18 no
existen. Este documento se escribe por adelantado para que, cuando esas
dependencias estén, la construcción no empiece desde una página en blanco.

---

## 1. Restricciones heredadas (no negociables)

Todo lo que sigue está decidido en ADR o en el catálogo de errores. La interfaz
las aplica; no las reinterpreta.

| # | Restricción | Origen |
| --- | --- | --- |
| R1 | **La UI no sustituye autorización backend.** Ocultar un botón no es un control de seguridad; el servidor vuelve a autorizar siempre. | C-18, plan de componentes |
| R2 | **Deny por defecto.** Sin capability no se renderiza la acción ni se insinúa su existencia. | ADR-009, ADR-017 |
| R3 | **`raw` oculto por defecto.** `raw_event.read` no es implícito para roles SOC. La vista ordinaria usa eventos normalizados. | ADR-018, ADR-017 |
| R4 | **No enumeración.** 403 y 404 comparten presentación: la interfaz no permite deducir que un recurso existe. | ERR-AUTHZ-001, PBI-028 |
| R5 | **Paginación por cursor**, 50 por defecto y 200 máximo. Un tamaño mayor se rechaza, no se recorta. | ADR-016, C-14 |
| R6 | **Ventana temporal obligatoria**, máximo 90 días por consulta. | C-14 |
| R7 | **Estados explícitos**: carga, vacío, parcial, degradado y error son distintos entre sí y visualmente inequívocos. | PBI-017, PBI-027 |
| R8 | **Ningún stack, secreto ni topología llega a la UI.** Todo error se presenta por código + `helpRef` + `correlationId`. | PBI-028 |
| R9 | **Sesión humana única.** Una sesión concurrente por usuario, política `REJECT_NEW`. | ADR-025, identidad §sesión |
| R10 | **Color nunca comunica solo.** Severidad, estado y resultado llevan texto además de color. | ADR-025, accesibilidad |
| R11 | **`SENT` no significa acuse humano.** Una notificación entregada no es una notificación atendida. | C-20 |
| R12 | **Cookie opaca de sesión server-side.** React no recibe tokens; no hay almacenamiento de credenciales en el navegador. | ADR-017 |

---

## 2. Los ocho tipos de usuario

Bundles aceptados en [identidad y autorización](../architecture/identity-and-authorization.md).
`USER` no es un rol operativo: representa identidad autenticada y no concede nada.

| Rol | Pregunta que responde al abrir el sistema |
| --- | --- |
| `VIEWER` | ¿Está sano el sistema y qué está pasando, en agregado? |
| `SOC_L1` | ¿Qué me toca atender ahora y en qué orden? |
| `SOC_L2` | ¿Qué está pasando realmente en esta investigación? |
| `SOC_MANAGER` | ¿Cómo va el equipo y qué está atascado? |
| `DETECTION_ENGINEER` | ¿Mis reglas detectan lo que deben y no generan ruido? |
| `PLATFORM_ADMIN` | ¿Están sanas las integraciones y la ingesta? |
| `AUDITOR` | ¿Puedo reconstruir qué pasó y quién lo hizo? |
| `ACCESS_ADMIN` | ¿Quién tiene acceso a qué y desde cuándo? |

**El dashboard no es uno solo.** Es una composición de secciones donde cada rol
recibe las que su capability permite. Un usuario con dos bundles ve la unión, sin
duplicar secciones.

---

## 3. Secciones del dashboard por rol

### 3.1 Catálogo de secciones

Cada sección es una unidad independiente, con su propia carga, su propio estado de
error y su propia capability. **Una sección que falla no tumba el dashboard**: se
degrada sola.

| ID | Sección | Capability requerida |
| --- | --- | --- |
| `S-HEALTH` | Salud del pipeline | `dashboard.read` |
| `S-COVERAGE` | Cobertura y lag por fuente | `dashboard.read` |
| `S-QUEUE` | Mi cola de trabajo | `alert.read` + asignación |
| `S-TRIAGE` | Alertas por triar en mi scope | `alert.read` |
| `S-INCIDENTS` | Incidentes activos | `incident.read` |
| `S-SLA` | Tiempos de atención y vencimientos | `incident.read` |
| `S-TEAM` | Carga y desempeño del equipo | `team.metrics.read` |
| `S-RULES` | Rendimiento de reglas | `detection.read` |
| `S-NOISE` | Top reglas ruidosas y falsos positivos | `detection.read` |
| `S-SOURCES` | Estado de integraciones y collectors | `integration.read` |
| `S-SECRETS` | Vencimiento y rotación de credenciales | `integration.read` |
| `S-QUARANTINE` | Cuarentena y reproceso | `quarantine.read` |
| `S-AUDIT` | Actividad sensible reciente | `audit.read` |
| `S-ACCESS` | Grants activos, vencimientos y revisiones | `access.read` |
| `S-SESSIONS` | Sesiones activas y anomalías | `session.read` |
| `S-SOAR` | Ejecuciones de playbook y acuses | `playbook.read` |

### 3.2 Composición por rol

| Sección | VIEWER | SOC_L1 | SOC_L2 | SOC_MGR | DET_ENG | PLAT_ADM | AUDITOR | ACC_ADM |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `S-HEALTH` | ● | ● | ● | ● | ● | ● | ○ | ○ |
| `S-COVERAGE` | ● | ● | ● | ● | ● | ● | ○ | — |
| `S-QUEUE` | — | ● | ● | ○ | — | — | — | — |
| `S-TRIAGE` | — | ● | ● | ● | ○ | — | — | — |
| `S-INCIDENTS` | ○ | ● | ● | ● | ○ | — | ○ | — |
| `S-SLA` | — | ○ | ● | ● | — | — | ○ | — |
| `S-TEAM` | — | — | ○ | ● | — | — | — | — |
| `S-RULES` | — | ○ | ● | ● | ● | — | — | — |
| `S-NOISE` | — | — | ● | ● | ● | — | — | — |
| `S-SOURCES` | ○ | ○ | ● | ● | ● | ● | ○ | — |
| `S-SECRETS` | — | — | — | ○ | — | ● | ○ | — |
| `S-QUARANTINE` | — | ○ | ● | ● | ● | ● | ○ | — |
| `S-AUDIT` | — | — | ○ | ● | — | ○ | ● | ● |
| `S-ACCESS` | — | — | — | ○ | — | — | ● | ● |
| `S-SESSIONS` | — | — | — | ○ | — | ○ | ● | ● |
| `S-SOAR` | — | ○ | ● | ● | — | ○ | ○ | — |

● sección primaria · ○ versión reducida, solo lectura agregada · — no se renderiza
ni se insinúa (R2).

### 3.3 Detalle por rol

#### `VIEWER` — panorama sin detalle

Solo agregados. **Nunca** un identificador de evento, un principal ni un host
individual: ese nivel exige `alert.read` en scope.

Orden: `S-HEALTH` (ancho completo) → `S-COVERAGE` → tarjetas agregadas de
incidentes abiertos por severidad, sin enlace al detalle.

Vacío esperable: un VIEWER recién creado sin scope asignado ve un estado vacío que
dice *"no tienes recursos asignados"*, **no** un dashboard en ceros que parezca
que el sistema no funciona. La distinción importa: "sin permiso" y "sin datos" se
confunden y producen escalamientos falsos.

#### `SOC_L1` — cola de trabajo

La pantalla responde una sola pregunta: **qué atiendo ahora**.

Orden: `S-QUEUE` arriba y ancho completo → `S-TRIAGE` → `S-HEALTH` reducido.

- `S-QUEUE` ordena por severidad y antigüedad, con el vencimiento visible.
- Acciones en línea permitidas: autoasignar, escalar, marcar falso positivo, nota.
- Acciones **ausentes** (no deshabilitadas): cierre crítico, publicar regla,
  exportar raw, acciones destructivas.
- Un badge de *degradado de fuente* debe ser imposible de ignorar: para un L1,
  "no hay alertas" y "la fuente está caída" se ven igual si nadie los distingue, y
  ésa es la falla más cara de un SOC.

#### `SOC_L2` — investigación

Orden: `S-INCIDENTS` → `S-QUEUE` → `S-NOISE` → `S-QUARANTINE` → `S-RULES`.

- Acceso a línea de tiempo completa del incidente y eventos correlacionados.
- Puede solicitar acciones críticas; **no aprobarlas** (separación de funciones).
- `raw` solo si tiene `raw_event.read` concedido de forma temporal: la interfaz lo
  presenta como una acción con justificación obligatoria, no como una pestaña más.

#### `SOC_MANAGER` — supervisión

Orden: `S-SLA` → `S-TEAM` → `S-INCIDENTS` → `S-TRIAGE` agregado → `S-AUDIT`
reducido.

- Reasignación masiva y aprobación de cierres permitidos.
- **No** recibe identidad, secretos ni infraestructura automáticamente: si aparece
  `S-SECRETS`, es en versión reducida y solo de vencimientos, sin acciones.

#### `DETECTION_ENGINEER` — calidad de detección

Orden: `S-RULES` → `S-NOISE` → `S-COVERAGE` → `S-QUARANTINE`.

- Por regla: disparos, tasa de falso positivo, tiempo medio a triaje, tendencia.
- Flujo de publicación con estado de revisión. **La autopublicación crítica está
  impedida**, y la interfaz lo explica en el punto de la acción, no en una ayuda.

#### `PLATFORM_ADMIN` — operación técnica

Orden: `S-SOURCES` → `S-HEALTH` → `S-SECRETS` → `S-QUARANTINE`.

- Por fuente: último evento, lag, cursor, generación, errores recientes.
- `S-SECRETS` muestra **referencia, huella y vencimiento**. Nunca valor, nunca un
  campo que pueda revelarlo, nunca una acción "ver". La rotación es write-only
  (C-24): el formulario escribe y no lee de vuelta.
- Sin aprobación propia, cierres, alteración de evidencia ni export raw.

#### `AUDITOR` — reconstrucción

Orden: `S-AUDIT` → `S-ACCESS` → `S-SESSIONS` → `S-SOURCES` reducido.

- Todo en modo lectura. La interfaz **no muestra ninguna acción mutante**, ni
  deshabilitada.
- Reportes sanitizados. Un reporte sanitizado **no concede** exportación raw, y la
  interfaz no debe sugerir que sí.

#### `ACCESS_ADMIN` — gobierno de accesos

Orden: `S-ACCESS` → `S-SESSIONS` → `S-AUDIT` reducido.

- Grants con solicitante, aprobador, justificación, ticket, scope, vigencia.
- La interfaz **impide autoasignación y autoaprobación** en el propio formulario, y
  explica por qué en el momento del rechazo.

---

## 4. Inventario de pantallas

| Ruta | Pantalla | Capability mínima |
| --- | --- | --- |
| `/` | Dashboard compuesto por rol | sesión activa |
| `/events` | Búsqueda de eventos | `events.read` |
| `/events/:recordId` | Detalle de evento | `events.read` |
| `/alerts` | Lista de alertas | `alert.read` |
| `/alerts/:id` | Detalle y triaje | `alert.read` |
| `/incidents` | Lista de incidentes | `incident.read` |
| `/incidents/:id` | Detalle, línea de tiempo y acciones | `incident.read` |
| `/quarantine` | Cuarentena y reproceso | `quarantine.read` |
| `/sources` | Integraciones y collectors | `integration.read` |
| `/sources/:id` | Detalle, cursor y credenciales | `integration.read` |
| `/rules` | Reglas de detección | `detection.read` |
| `/audit` | Consulta de auditoría | `audit.read` |
| `/access` | Grants y revisiones | `access.read` |
| `/sessions` | Sesiones activas | `session.read` |
| `/me` | Perfil, capabilities vigentes y sesión | sesión activa |
| `/errors/:helpRef` | Explicación de un error del catálogo | pública autenticada |

Una ruta sin capability devuelve **la misma pantalla** que una ruta inexistente
(R4): "no disponible", sin confirmar ni negar existencia.

---

## 5. Inventario de componentes

### 5.1 Primitivas

| Componente | Variantes y estados obligatorios |
| --- | --- |
| `Button` | `primary`, `secondary`, `ghost`, `danger`; tamaños `sm`/`md`; `loading`, `disabled`; icon-only exige `aria-label` |
| `Link` | interno, externo (marca destino), deshabilitado |
| `TextField` | normal, con error, con ayuda, requerido, solo lectura; `aria-describedby` al mensaje |
| `SearchField` | con limpiar, con sugerencia, con estado de carga |
| `Select` / `Combobox` | búsqueda, multiselección, vacío, carga, error |
| `DateRangeField` | presets (1h, 24h, 7d, 30d), **tope de 90 días** (R6), zona horaria explícita |
| `Checkbox`, `Radio`, `Switch` | indeterminado donde aplique |
| `Textarea` | contador cuando hay límite |
| `Badge` | neutro, informativo, éxito, advertencia, peligro — **siempre con texto** (R10) |
| `SeverityIndicator` | `informational`…`critical`; color + etiqueta + valor numérico |
| `StatusChip` | estados de alerta e incidente (§6) |
| `Icon` | decorativo (`aria-hidden`) o significativo (con etiqueta) |
| `Spinner` | tamaños; `role="status"` |
| `Skeleton` | línea, bloque, fila de tabla, tarjeta |
| `Tooltip` | accesible por teclado; nunca único portador de información |
| `Popover`, `Dropdown` | cierre por `Esc`, foco atrapado |
| `Dialog` | `Esc`, foco atrapado, retorno de foco al disparador |
| `Drawer` | lateral, para detalle sin perder contexto de lista |
| `Toast` | éxito, error, informativo; no desaparece si contiene un `correlationId` |
| `Tabs` | navegables con flechas |
| `Table` | ordenable, densidad, cabecera fija, selección, columnas configurables |
| `CursorPagination` | **solo anterior/siguiente** (R5): sin números de página ni total |
| `Breadcrumb` | con ruta actual no enlazada |
| `DescriptionList` | pares clave-valor para detalle |
| `Timeline` | eventos con actor, acción, instante y razón |
| `JsonViewer` | plegable, con búsqueda; **solo dentro de `CapabilityGate`** |
| `CopyButton` | con confirmación accesible; usado para `correlationId` |
| `RelativeTime` | relativo con absoluto en `title` y zona horaria |
| `MetricTile` | valor, etiqueta, tendencia, estado |
| `Sparkline`, `BarChart`, `LineChart`, `StackedBar`, `Gauge` | con tabla equivalente accesible |
| `ProgressMeter` | determinado e indeterminado |

### 5.2 Componentes de control y seguridad

Son los que hacen que la interfaz respete las restricciones del §1. **Son los más
importantes del inventario.**

| Componente | Responsabilidad |
| --- | --- |
| `CapabilityGate` | Renderiza o no según capability vigente. **Por omisión no renderiza** (R2). Nunca renderiza deshabilitado "para que se vea que existe". |
| `ScopeGate` | Igual, por scope (`ORGANIZATION`, `BUSINESS_UNIT`, `BRANCH`, `TEAM`, `ASSIGNED_RESOURCES`). |
| `StepUpGuard` | Intercepta una acción crítica y exige reautenticación vigente antes de permitir el formulario. |
| `ReasonRequiredDialog` | Confirmación que **exige razón escrita** y ticket/incidente para acciones auditadas. Sin razón no hay envío. |
| `DualApprovalNotice` | Explica que la acción requiere un aprobador distinto, y por qué el usuario actual no puede aprobarla. |
| `RawAccessRequest` | Flujo de acceso a `raw`: justificación, incidente, vigencia. No es una pestaña; es una solicitud (R3). |
| `SensitiveExportFlow` | Export como **job**: manifiesto, clasificación, expiración, límite de descargas. Nunca un enlace permanente. |
| `SessionConflictNotice` | Presenta `ERR-AUTH-004` con la acción segura: cerrar la anterior o pedir revocación (R9). |
| `AuthorizationVersionWatcher` | Detecta cambio de `authorizationVersion` y fuerza recarga de capabilities: un rol revocado no sigue operando con la UI anterior. |
| `RedactedValue` | Muestra referencia y huella de un secreto. No tiene estado "revelado" (C-24). |

### 5.3 Componentes de estado de datos

Un requisito explícito de PBI-017: **cinco estados distintos, no tres** (R7).

| Componente | Cuándo | Qué debe comunicar |
| --- | --- | --- |
| `LoadingState` | Primera carga | Que se está consultando; con `Skeleton` de la forma final |
| `EmptyState` | Consulta válida, cero resultados | Que **la consulta funcionó**; sugerir ampliar ventana o filtros |
| `NoScopeState` | Sin recursos asignados | Que falta asignación, **no** que no hay datos |
| `PartialResultBanner` | Resultados incompletos | Qué falta y por qué; el resultado mostrado **no es el total** |
| `DegradedBanner` | Fuente degradada (`ERR-INGEST-001`) | **"Sin eventos" no confirma cobertura**; enlace a cobertura y runbook |
| `StaleDataBanner` | Datos vigentes pero viejos | Antigüedad exacta del último dato |
| `ErrorState` | Fallo de la sección | Código, mensaje del catálogo, `correlationId` copiable, acción segura, reintento si aplica |
| `SectionBoundary` | Envuelve cada sección | Aísla el fallo: una sección caída no tumba el dashboard |

> La distinción entre `EmptyState` y `DegradedBanner` es el punto más importante de
> esta sección. Si se confunden, un analista concluye "no pasó nada" cuando la
> realidad es "no estamos viendo nada". Es la falla silenciosa más cara de un SOC,
> y la única defensa es que sean visualmente inconfundibles.

### 5.4 Compuestos de dominio

| Componente | Notas |
| --- | --- |
| `EventTable` | Columnas: instante, severidad, categoría, origen, regla, equipo, principal. **Sin columna `raw`** |
| `EventDetailPanel` | `DescriptionList` + procedencia + versión de mapping; `raw` tras `CapabilityGate` |
| `AlertQueueList` | Agrupable por severidad; vencimiento visible; acciones en línea por capability |
| `AlertTriagePanel` | Transición + razón + notas; estados inválidos no se ofrecen |
| `IncidentTimeline` | Actor, acción, instante, razón; append-only, sin edición |
| `LifecycleStepper` | Estados del §6; el actual destacado, los imposibles ausentes |
| `CoverageBySourceTable` | Último evento, lag, cursor, generación, estado |
| `QuarantineList` | Causa traducida, linaje al crudo, acción de reproceso con presupuesto visible |
| `RulePerformanceTable` | Disparos, falso positivo, tiempo a triaje, tendencia |
| `GrantTable` | Solicitante, aprobador, justificación, ticket, scope, vigencia |
| `AuditTrailTable` | Actor, capability, recurso, scope, resultado, instante; solo lectura |
| `SourceHealthCard` | Estado `healthy`/`degraded`/`failed` **con sus razones** (C-15) |
| `NotificationStatusChip` | `SENT` se presenta como *entregado*, nunca como *atendido* (R11) |

---

## 6. Estados del dominio que la interfaz debe representar

Valores exactos del modelo de datos aceptado. La interfaz **no inventa estados
intermedios ni agrupa dos en uno**.

**Alerta:** `NEW` · `ENRICHING` · `TRIAGE` · `INVESTIGATING` · `CONFIRMED` ·
`FALSE_POSITIVE` · `CLOSED`

**Incidente:** `OPEN` · `INVESTIGATING` · `CONTAINMENT` · `ERADICATION` ·
`RECOVERY` · `RESOLVED` · `CLOSED`

**Salud de etapa (C-15):** `healthy` · `degraded` · `failed`, cada una con sus
razones: `DEPENDENCY_DOWN`, `NO_RECENT_SUCCESS`, `INGESTION_LAG`,
`QUARANTINE_RATE`, `ERROR_RATE`.

Regla de interacción: **una transición no permitida no se ofrece**. No se muestra
deshabilitada con tooltip, porque eso enumera el flujo a quien no debe conocerlo.
Si el servidor la rechaza igual (`ERR-STATE-001`), la interfaz recarga y muestra
el estado real.

---

## 7. Presentación de errores

Toda respuesta de error trae `code`, `message`, `correlationId` y `helpRef`. La
interfaz presenta **los cuatro**, siempre.

| Código | Presentación | Acción ofrecida |
| --- | --- | --- |
| `AUTH_REQUIRED` | Pantalla completa | Reingresar desde red QAPAQ |
| `AUTH_NETWORK_NOT_ALLOWED` | Pantalla completa | Conectar a oficina o VPN aprobada |
| `AUTH_SESSION_ALREADY_ACTIVE` | Diálogo | Cerrar sesión anterior o pedir revocación |
| `AUTH_TEMPORARILY_THROTTLED` | En línea | Cuenta regresiva con `Retry-After` |
| `ACCESS_DENIED` | Igual que recurso inexistente (R4) | Verificar asignación con el responsable |
| `REQUEST_INVALID` | Junto a cada campo | Corregir **solo** los campos marcados |
| `RESOURCE_STATE_CONFLICT` | Banner en el recurso | Recargar y revisar estado |
| `RATE_LIMITED` | En línea | Esperar o reducir rango |
| `DEPENDENCY_UNAVAILABLE` | `ErrorState` de sección | Reintento con backoff; conservar `correlationId` |
| `SOURCE_DEGRADED` | `DegradedBanner` persistente | Consultar cobertura y runbook |
| `INTEGRATION_CREDENTIAL_REJECTED` | En el formulario | Rotar por flujo write-only; **nunca pegar la credencial en un ticket** |
| `AUDIT_WRITE_REQUIRED` | Bloqueante | Escalar con `correlationId`; la operación **no** ocurrió |
| `UNEXPECTED_ERROR` | `ErrorState` | **No asumir éxito**; consultar estado |

`/errors/:helpRef` explica cada código sin exponer detalle interno, y soporte
correlaciona por `correlationId` en Loki **sin ampliar el acceso del usuario**.

---

## 8. Accesibilidad

Requisito de PBI-028, con pruebas.

- Contraste mínimo 4.5:1 en texto normal, 3:1 en texto grande y en los límites de
  los controles.
- Toda la operación es alcanzable por teclado; el orden de foco sigue el orden
  visual; el foco es visible siempre.
- `Dialog` y `Drawer` atrapan foco y lo devuelven al cerrarse.
- Cambios asíncronos se anuncian por región viva: resultados cargados, error,
  transición aplicada.
- Las tablas llevan cabeceras asociadas; los gráficos llevan tabla equivalente.
- Color nunca comunica solo (R10). Severidad y estado llevan etiqueta de texto.
- Objetivos táctiles de 44×44 px mínimo.
- Fallback de localización: si falta una traducción, se muestra el español base,
  **nunca la clave cruda**.

---

## 9. Tokens de diseño

Se definen como variables CSS en `:root`, con redefinición para modo oscuro. No se
usan valores literales en los componentes.

**Familias:** color de superficie, color de texto, color de borde, color de estado
(informativo, éxito, advertencia, peligro), escala de severidad (cinco pasos),
espaciado (escala de 4 px), radio, sombra, tipografía (cuatro o cinco tamaños),
duración de animación, z-index por capa.

**Regla de severidad:** los cinco niveles se distinguen además por **luminosidad**,
no solo por tono, para que sigan siendo legibles en daltonismo y en proyección.

Dónde se declaran y cómo se consumen: §10.

---

## 10. Código limpio y arquitectura de estilos

Reglas de construcción, no de estética. Son verificables y se revisan en cada PR.

### 10.1 La regla de estilos

> **Ningún archivo de componente contiene utilidades de Tailwind ni estilos
> embebidos. El estilo vive en la capa de diseño.**

Un componente describe **qué** es y **qué** hace. Cómo se ve lo decide la capa de
diseño. Mezclarlos produce tres problemas concretos, y ninguno es de gusto:

1. **El componente deja de ser legible.** Una fila de tabla con treinta utilidades
   en el `className` esconde la lógica entre ruido visual, y el defecto se cuela
   justo ahí.
2. **El cambio de diseño se vuelve un `find-and-replace` por todo el repositorio.**
   Cambiar un espaciado o un color obliga a tocar decenas de archivos de
   componente en lugar de un token.
3. **La consistencia deja de ser verificable.** Si cada componente redefine su
   espaciado en el sitio, nada impide que dos tablas tengan densidades distintas, y
   nadie lo detecta hasta verlo en pantalla.

**Prohibido en un archivo de componente:**

```tsx
// NO
<tr className="flex items-center gap-4 px-6 py-2 text-sm bg-slate-50 hover:bg-slate-100 border-b border-slate-200">
<div style={{ display: 'flex', padding: '12px 24px', color: '#0F2D4D' }}>
```

**Correcto:**

```tsx
// SÍ — el componente nombra su intención, no su apariencia
import styles from './AlertQueueRow.module.css';

<tr className={styles.row} data-severity={severity}>
```

```css
/* AlertQueueRow.module.css — aquí, y solo aquí, vive la apariencia */
.row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-6);
  background: var(--surface-subtle);
  border-bottom: 1px solid var(--border-subtle);
}
.row[data-severity='critical'] { border-left: 3px solid var(--severity-critical); }
```

**Si se adopta Tailwind**, se compone en la capa de diseño con `@apply`, nunca en
el `className` del componente:

```css
.row { @apply flex items-center gap-4 px-6 py-2; }
```

De ese modo el equipo conserva la velocidad de Tailwind sin trasladar el problema
al archivo que hay que leer para entender la lógica.

**Única excepción permitida:** un valor genuinamente dinámico que no puede ser un
token —el ancho calculado de una barra, una posición derivada de datos—. Se pasa
como **variable CSS**, no como estilo literal:

```tsx
<div className={styles.bar} style={{ '--bar-width': `${percentage}%` } as CSSProperties} />
```

### 10.2 Dónde vive cada cosa

| Capa | Contenido | No contiene |
| --- | --- | --- |
| `src/design/tokens.css` | Variables en `:root` y su redefinición para modo oscuro | Reglas de componente |
| `src/design/primitives/` | Primitivas del §5.1 con su CSS colocalizado | Lógica de dominio |
| `src/design/patterns.css` | Patrones repetidos: densidad de tabla, tarjeta, panel | Casos de un solo uso |
| `src/components/` | Compuestos de dominio del §5.4, cada uno con su `.module.css` | Utilidades sueltas, colores literales |
| `src/features/` | Pantallas y composición | Estilo propio: componen primitivas |
| `src/lib/` | Cliente de API, hooks de datos, autorización | JSX |

### 10.3 Reglas de código

1. **Sin valores mágicos.** Ningún color, espaciado, radio, duración ni tamaño
   literal fuera de `tokens.css`. Un `#0F2D4D` o un `12px` en un componente es un
   defecto, no una preferencia.
2. **Un componente, una responsabilidad.** Si necesita la conjunción «y» para
   describirse, son dos componentes.
3. **Sin lógica de dominio en el JSX.** Transformaciones, cálculos y decisiones
   viven en hooks o en `lib/`; el componente recibe datos ya listos para pintar.
4. **Sin `any`, sin `as` para silenciar el compilador.** Si el tipo no encaja, el
   contrato está mal.
5. **Props explícitas.** Nada de un objeto `config` que acepte cualquier cosa, ni
   de propagar `{...props}` sin declarar qué se propaga.
6. **Sin estado derivado duplicado.** Lo que se puede calcular del estado se
   calcula; no se guarda en paralelo para que luego se desincronice.
7. **La accesibilidad no es opcional.** Un control sin nombre accesible no pasa
   revisión (§8).
8. **Nombres en el dominio del problema**, no en el de la implementación:
   `AlertQueueRow`, no `TableRowWrapper2`.
9. **Comentarios que explican el porqué**, no el qué. Si hace falta un comentario
   para entender *qué* hace una línea, la línea está mal escrita.
10. **Los textos visibles no se escriben en el JSX**: salen del catálogo de
    mensajes, para que el fallback de localización del §8 sea posible.

### 10.4 Cómo se verifica

| Control | Qué impide |
| --- | --- |
| Lint de `className` literal con utilidades en `.tsx` | La regla 10.1 |
| Lint de color o longitud literal fuera de `tokens.css` | La regla 10.3.1 |
| `tsc` sin `any` implícito | La regla 10.3.4 |
| Pruebas de accesibilidad en las primitivas | La regla 10.3.7 |
| Revisión de PR con esta lista | El resto |

Los dos primeros controles **no existen todavía** y hay que escribirlos: sin
verificación automática, una regla de estilo dura lo que dura la disciplina del
revisor.

## 11. Contrato de datos que consume la interfaz

Alineado con el modelo de consulta de C-14 ya construido
([`event-query.ts`](../../modules/telemetry/src/event-query.ts)):

- La consulta exige ventana temporal y la interfaz nunca la omite.
- El `tenantId` **no se envía**: sale del lector autenticado en el servidor.
- `pageSize` por defecto 50; la interfaz no ofrece un selector mayor a 200.
- La respuesta no trae `raw` salvo capability; la interfaz **no asume** su
  presencia y no deja un hueco visual cuando falta.
- El cursor es opaco: no se parsea, no se construye, no se expone en la URL como
  dato con significado.

---

## 12. Dependencias y qué falta antes de implementar

| Necesita | Estado hoy |
| --- | --- |
| C-14 adaptador de consulta y API | Dominio construido, **sin adaptador** |
| C-17 alertas, triaje e incidentes | **No existe** |
| C-18 sesión, capabilities y BFF | **No existe** |
| C-27 catálogo de errores en API | Catálogo escrito; contrato de API pendiente |
| OpenSearch | **No provisionado** |

**Nada de este documento es implementable hoy de forma completa.** Lo que sí puede
adelantarse sin esas dependencias: tokens, primitivas, componentes de estado de
datos (§5.3) y los componentes de control (§5.2), porque su comportamiento depende
del contrato, no de los datos.

---

## 13. Preguntas abiertas

1. **Cardinalidad alerta↔incidente↔caso** sigue `UNRESOLVED` en el modelo de datos
   (U-008). Hasta resolverse, la interfaz no debe asumir que un incidente agrupa
   varias alertas ni lo contrario.
2. **Catálogo final de capabilities por endpoint** sigue `Proposed` (ADR-009). Los
   nombres usados en §3.1 son propuestos y deben confirmarse contra C-18.
3. **Antifraud** no tiene schema aceptado; no se diseña sección para él.
4. **Localización**: no hay decisión sobre idiomas soportados más allá del fallback.
5. **Densidad por defecto** de las tablas operativas: a validar con un analista real
   antes de fijarla.

---

[Plan de componentes](../project-management/component-delivery-plan.md) ·
[Identidad y autorización](../architecture/identity-and-authorization.md) ·
[Catálogo de errores](../error-catalog.md) ·
[Modelo de datos](../architecture/data-model-mer.md) ·
[C-14 — proyección y consulta](../project-management/c-14/README.md) ·
[C-15 — observabilidad](../project-management/c-15/README.md)
