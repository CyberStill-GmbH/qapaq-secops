# 04 · Especificación de pantallas

Estado: **especificación de diseño**. Fecha: 2026-10-02.

Cada pantalla se describe con: propósito, nivel de disponibilidad
([01](01-inventario-backend.md)), disposición, contenido exacto, acciones,
estados y criterios de aceptación. Los componentes citados están en
[05](05-componentes.md); los patrones de estado, error y confirmación en
[06](06-patrones-de-interaccion.md).

Convención de las tablas de columnas: **Ancho** es `fijo` (px), `auto`
(contenido) o `flex` (ocupa el sobrante). **Alin.** es izquierda (I) o derecha
(D).

---

## 0. Acceso (antes de la consola)

**Nivel:** API. **Base:** la pantalla actual de
[`application.tsx`](../../apps/web/src/app/application.tsx); se conserva intacta
en diseño.

Cambios de comportamiento necesarios:

| Hoy | Debe ser |
| --- | --- |
| El botón llama a `MockAdminApi.getSession()` | Navega a `/api/auth/start?returnTo=<ruta pedida>` (`window.location.assign`), no `fetch`. El BFF vuelve a esa ruta con un 303 |
| Mensajes de error inventados en el cliente | Al volver con `?authError=<código>&correlationId=`, se muestra el mensaje **del catálogo** para ese código; un código fuera del catálogo se ignora |
| Chip `MOCK` en el bloque Entra | Se retira en modo `entra`. En `local-development` muestra "Emisor local" y la lista de `/api/auth/local/principals` como enlaces |
| Pie "Acceso de demostración…" | Se retira en modo `entra` |

Estados de la pantalla de acceso, todos en el mismo espacio del mensaje bajo el
botón (`#auth-message`, ya existente), en `--text-2` o
`--state-fail` según el caso:

| Situación | Mensaje | Acción |
| --- | --- | --- |
| Redirigiendo | "Conectando con Microsoft Entra…" (ya existe) | botón en `loading` |
| `AUTH_FAILED` | "No fue posible iniciar sesión con esas credenciales." | "Intentar otra vez" |
| `PASSKEY_REQUIRED` | "Fuera de la red QAPAQ se requiere una passkey registrada." | Enlace a la guía de registro de passkey |
| `NETWORK_NOT_ALLOWED` | "No fue posible verificar el origen de la conexión." | "Conéctate desde la oficina o la VPN aprobada" |
| `RATE_LIMITED` | "Demasiados intentos. Vuelva a intentarlo más tarde." | Botón deshabilitado 60 s con cuenta regresiva en mono |
| `SESSION_EXPIRED` al volver | "Tu sesión terminó. Vuelve a iniciar sesión." | — |
| Sesión reemplazada (`?sessionNotice=superseded`) | Al entrar, toast informativo: "Se cerró tu sesión anterior en otro navegador." Después se limpia el parámetro de la URL (`history.replaceState`) | — |

Todo mensaje de error lleva debajo, en `--type-small` mono, el
`correlationId` con botón de copia.

---

## 1. Resumen

**Nivel:** API (secciones de alertas, incidentes, notificaciones, auditoría) +
DOMINIO (salud del pipeline). **Ruta:** `/`.

**Propósito:** que el usuario sepa en cinco segundos si hay algo que atender y
si puede confiar en lo que ve.

### 1.1 Disposición

```
┌ Resumen ──────────────────────────────────────── actualizado hace 8 s ─┐
│ ┌ Estado de la operación (franja, ancho completo) ────────────────────┐ │
│ │ ✓ API disponible · ! Ingesta sin datos de salud · ✓ Cadena íntegra  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ┌ Mi cola ─────────────────────────────┐ ┌ Críticas sin acuse ───────┐ │
│ │ ◆ P1 Inicio de sesión desde...  4 m  │ │ ◆ Teams · entregada 6 min │ │
│ │ ▲ P2 Creación de regla de...   12 m  │ │   sin acuse  [Acusar]     │ │
│ │ … 5 filas                             │ │                           │ │
│ │ Ver las 23 alertas abiertas →         │ └───────────────────────────┘ │
│ └──────────────────────────────────────┘                               │
│ ┌ Alertas abiertas por prioridad ──────┐ ┌ Incidentes ───────────────┐ │
│ │ P1 ◆  2   P2 ▲  7   P3 ■ 11  P4 ● 3  │ │ Abiertos 3 · Contenidos 1 │ │
│ │ Sin asignar: 9  ·  Más antigua: 2 h  │ │ Listos para cerrar 2 →    │ │
│ └──────────────────────────────────────┘ └───────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

Rejilla de 12 columnas: secciones de 8 + 4 en ≥ 1440 px; 12 apiladas por
debajo de 1024 px.

### 1.2 Secciones

Cada sección está envuelta en `SectionBoundary`: carga, error y vacío propios.
Una que falla no afecta a las demás.

| Sección | Capability | Fuente | Contenido |
| --- | --- | --- | --- |
| **Estado de la operación** | sesión | `/health/ready` + último `verify` si `audit.verify` | Hasta 3 `HealthMark` con texto. Mientras no haya API de salud del pipeline, el segundo ítem dice **"Ingesta: sin datos de salud"** en `--state-neutral`, nunca "OK" |
| **Mi cola** | `alerts.triage` | `GET /api/alerts` filtrado en cliente: `assigneeId = yo` y estado abierto, más `new` sin asignar | 5 filas máximo, orden prioridad → `occurredAt` asc (la más vieja primero dentro de la misma prioridad). Enlace "Ver las N alertas abiertas" |
| **Críticas sin acuse** | `notifications.read` | `GET /api/notifications` con `status ∈ {sent, indeterminate, fallback}` | Lista con canal, estado y antigüedad desde `sentAt`. Acción "Acusar" en línea. Si pasan 15 min desde `sentAt`, la antigüedad va en `--state-fail` |
| **Alertas abiertas por prioridad** | `alerts.read` | misma lista | Cuatro contadores con glifo; "Sin asignar" y "Más antigua". Cada contador es enlace a la lista filtrada |
| **Incidentes** | `incidents.read` | `GET /api/incidents` | Contadores por estado y por severidad; "Listos para cerrar" (`resolved`) solo si `incidents.close` |
| **Actividad sensible** | `audit.read` | `GET /api/audit/events` últimas 24 h | 8 filas: `access.sign_in` denegados, `soc.incident.close`, `soc.alert.close`. Enlace a auditoría |
| **Integridad** | `audit.verify` | `GET /api/audit/verify` | "Cadena íntegra · 1 000 eventos revisados · secuencia 48 213" o el número de violaciones en `--state-fail` |

**No hay** gráficos de tendencia en el Resumen: el backend no entrega series
temporales y un gráfico construido sumando en el cliente una lista sin
paginar mentiría al crecer.

### 1.3 Aceptación

- Un analista sin alertas asignadas ve en "Mi cola": *"No tienes alertas
  asignadas. Hay 4 nuevas sin asignar."* con enlace, nunca una sección vacía
  sin explicación.
- Si `GET /api/alerts` falla, "Mi cola" y "Alertas por prioridad" muestran
  `ErrorState` con `correlationId`; "Incidentes" sigue funcionando.
- Refresco automático cada 30 s mientras la pestaña está visible; nunca
  mientras un formulario está abierto.

---

## 2. Eventos

**Nivel:** DOMINIO (C-14 sin adaptador, sin ruta HTTP). **Ruta:** `/events`.
Se construye contra `MockAdapter` con el contrato de `event-query.ts`, con el
chip Demostración en la cabecera de la página.

**Propósito:** buscar telemetría normalizada en una ventana acotada, para
contextualizar una alerta.

### 2.1 Barra de consulta

```
[Ventana: Últimas 24 h ▾]  [Severidad ▾] [Categoría ▾] [Tipo ▾] [Resultado ▾] [Dataset ▾]   [Buscar]
```

| Control | Valores | Regla |
| --- | --- | --- |
| Ventana | 1 h, 24 h (por defecto), 7 d, 30 d, personalizada | **Máximo 90 días**: el selector no permite más y explica "La consulta admite hasta 90 días" en el propio selector. Zona horaria visible (`America/Lima`) |
| Severidad | `unknown`, `informational`, `low`, `medium`, `high`, `critical` | multiselección |
| Categoría | 16 valores del contrato | multiselección con búsqueda |
| Tipo (`kind`) | `event`, `alert`, `finding`, `state` | multiselección |
| Resultado | `success`, `failure`, `unknown` | multiselección |
| Dataset | `wazuh-alerts` hoy | select simple |

**No hay caja de texto libre.** El dominio no la admite, y una caja que no
busca lo que el analista escribe es peor que no tenerla. Si se agrega en el
backend, se ubica a la izquierda de la ventana.

### 2.2 Tabla

| Columna | Campo | Ancho | Alin. |
| --- | --- | --- | --- |
| Ocurrido | `occurredAt` | fijo 132 | I · mono tabular |
| Severidad | `severity.normalized` (+ `score`) | fijo 112 | I |
| Categoría | `category[]` (primera + "+N") | auto | I |
| Acción | `action` | auto | I · mono |
| Regla | `detection.rule.name` | flex | I |
| Identidad | `entities.identities[0].principal` | auto | I · mono |
| Recurso | `entities.resources[0].name` | auto | I |
| Resultado | `outcome` | fijo 96 | I |

Paginación: `CursorPagination` (solo "Anterior · Siguiente", sin total).
Tamaño de página 50; selector con 50, 100, 200.

### 2.3 Detalle del evento (drawer)

Bloques, en orden, cada uno un `DescriptionList`:

1. **Cabecera**: severidad, título (`detection.rule.name` o `action`),
   `occurredAt` absoluto.
2. **Origen**: `source.vendor`, `product`, `dataset`, `instanceId`,
   `nativeEventId`.
3. **Entidades**: identidades y recursos, cada uno con su `kind`.
4. **Severidad**: normalizada, `score`, valor original (`originalValue`,
   `originalLabel`, `originalScale`) y `mappingVersion`. Explica por qué el
   evento es "high": "Nivel Wazuh 9 → alta (escala provider-level-0-15)".
5. **Procedencia**: `connector`, versiones de parser y mapping,
   `timestampQuality`, `ingestionPath` como lista de saltos.
6. **Instantes**: `occurredAt`, `observedAt`, `receivedAt` con la diferencia
   entre ellos ("recibido 41 s después").
7. **Contenido original** (`raw`): solo dentro de `CapabilityGate
   events.read_raw`. Sin la capability, el bloque **no existe** (no hay
   título vacío ni candado).

---

## 3. Alertas

**Nivel:** API. **Ruta:** `/alerts`, `/alerts/:id`. Es la pantalla principal
del analista.

### 3.1 Disposición

```
Alertas                                                [actualizado hace 4 s]
Cola de alertas con prioridad, estado y asignación.
┌──────────────────────────────────────────────────────────────────────────┐
│ Abiertas 23 │ Nuevas 9 │ Reconocidas 6 │ Triadas 5 │ Escaladas 3 │ Cerradas │
├──────────────────────────────────────────────────────────────────────────┤
│ [Filtrar título…  /]  [Prioridad ▾] [Asignado ▾: Todos · Yo · Sin asignar] │
├──┬──────┬─────────────────────────────────┬────────────┬─────────┬───────┤
│☐ │◆ P1 92│ Inicio de sesión desde país nuevo│ Nueva      │ —       │ 4 min │
│☐ │▲ P2 71│ Creación de regla de reenvío     │ Reconocida │ 0192ab… │ 12 min│
└──┴──────┴─────────────────────────────────┴────────────┴─────────┴───────┘
```

### 3.2 Pestañas de estado

Patrón de Elastic Security. Pestaña = filtro por `status`; el contador es el
número de alertas en ese estado.

| Pestaña | Filtro | Por defecto |
| --- | --- | --- |
| Abiertas | `new`, `acknowledged`, `triaged`, `escalated` | **sí** |
| Nuevas | `new` | |
| Reconocidas | `acknowledged` | |
| Triadas | `triaged` | |
| Escaladas | `escalated` | |
| Cerradas | `closed` | sin contador (puede ser grande) |

La API pagina por cursor (50 por página, más reciente primero). Cada pestaña
pide su propia página con `?status=`. Los contadores **no** se pueden calcular
desde una página: hasta que exista el endpoint de agregados
([08 · B-08](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)),
la pestaña muestra el número **solo** cuando cabe en una página (`nextCursor`
nulo) y "50+" cuando no. La tabla termina con "Cargar más" mientras haya
`nextCursor`.

El orden por prioridad de §3.3 se aplica **dentro de lo cargado**. La API
ordena por `occurredAt`, así que una P1 antigua puede estar en una página
siguiente. Para la cola de trabajo se pide primero `?status=new` y luego
`?status=acknowledged`, que son pocas en un turno normal. Un orden global por
prioridad requiere que el servidor lo ofrezca.

### 3.3 Columnas

| Columna | Campo | Ancho | Alin. | Orden por defecto |
| --- | --- | --- | --- | --- |
| Selección | — | fijo 40 | — | |
| Prioridad | `priority` + `score` | fijo 88 | I | **1.º** P1→P4 |
| Título | `title` | flex | I | |
| Estado | `status` (+ `verdict` si existe, en segunda línea `--text-3`) | fijo 132 | I | |
| Asignado | `assigneeId` | fijo 120 | I · mono | |
| Incidente | `incidentId` | fijo 104 | I · mono enlace | |
| Ocurrida | `occurredAt` | fijo 96 | D · relativo | **2.º** más antigua primero dentro de la prioridad |

La franja izquierda de 3 px de cada fila lleva el color de prioridad. La fila
`new` sin asignar lleva el título en peso 550.

### 3.4 Drawer de alerta

```
┌ ◆ P1 · 95                                          [⤢] [×] ┐
│ Inicio de sesión desde país nuevo                          │
│ Nueva · Sin asignar · ocurrida 14:02:11 (hace 4 min)       │
│ ─────────────────────────────────────────────────────────  │
│ [Reconocer y asignarme]  [Asignar…]                        │  ← solo comandos válidos
│ ─────────────────────────────────────────────────────────  │
│ POR QUÉ ESTA PRIORIDAD                                     │
│  Severidad de origen (alta) .......................... 60  │
│  Identidad privilegiada .............................. +15 │
│  Intrusión con resultado exitoso ..................... +20 │
│  Puntuación final (0–100) ............................ 95  │
│ ─────────────────────────────────────────────────────────  │
│ DETALLE                                                    │
│  Identificador   0192ab4f-…  [copiar]                      │
│  Revisión        3                                         │
│  Incidente       —                                         │
│  Evento original raw:0192…  [ver]   ← solo con read_raw    │
│ ─────────────────────────────────────────────────────────  │
│ HISTORIAL (desde auditoría, si audit.read)                 │
│  14:06  Ana Lista   reconoció                              │
│  14:02  sistema     creó la alerta                         │
└────────────────────────────────────────────────────────────┘
```

**Bloque de acciones.** Se calcula con la tabla de
[01 · §4.1](01-inventario-backend.md#41-comandos-de-alerta). Se muestran
**solo** los comandos que pasan las tres condiciones: estado de origen,
capability y (para triaje) ser el asignado. Orden y jerarquía:

| Estado | Primario (blanco) | Secundarios |
| --- | --- | --- |
| `new` | Reconocer y asignarme | Asignar… |
| `acknowledged` (soy asignado) | Triar… | Asignar…, Cerrar… |
| `acknowledged` (no soy asignado) | — | Asignar… (si `alerts.assign`), Cerrar… |
| `triaged` + `true_positive` | Escalar | Abrir incidente…, Asignar…, Cerrar |
| `triaged` + otro veredicto | Cerrar | Asignar… |
| `escalated` | Abrir incidente… (si no tiene) | Cerrar… |
| `closed` | — | Reabrir |

Sin comandos disponibles, el bloque de acciones **desaparece** (no hay franja
vacía).

**Historial.** Se obtiene de `GET /api/audit/events` filtrando por recurso
cuando el BFF lo admita; hoy el filtro por recurso no está cableado, así que
el bloque solo se muestra si `audit.read` y se rotula "Historial reciente
(últimas 24 h)". Sin `audit.read` el bloque no existe.

### 3.5 Formularios de comando

Todos en un `CommandDialog` sobre el drawer (no a pantalla completa).

**Triar**

| Campo | Control | Regla | Mensaje |
| --- | --- | --- | --- |
| Veredicto | `RadioGroup` vertical con los 4 valores y una línea de ayuda cada uno | obligatorio | "Elige un veredicto." |
| Nota de triaje | `Textarea` 6 filas, contador "0 / 2000" | 10–2000 tras recortar | "La nota necesita al menos 10 caracteres." |

Botón: "Triar como *Verdadero positivo*" (el texto incluye el veredicto
elegido). Tras éxito, si el veredicto es `true_positive`, el drawer ofrece
"Escalar" como siguiente acción primaria.

**Cerrar**

- Nota obligatoria (≥ 10) si el estado no es `triaged`; opcional si lo es,
  con el rótulo "Nota de cierre (opcional)".
- Texto de confirmación: "La alerta quedará cerrada. Puedes reabrirla después."

**Asignar**

- `Combobox` de personas. Mientras no exista directorio de usuarios, campo de
  texto en mono para `subjectId`, con el atajo "Asignarme".

**Abrir incidente**

| Campo | Valor inicial | Regla |
| --- | --- | --- |
| Título | `title` de la alerta | 4–160 |
| Severidad | `critical` si P1, `high` si P2, `medium` si P3, `low` si P4 | catálogo |
| Resumen | vacío | 10–2000 |

Se envía con `expectedAlertRevision`. Tras éxito, el drawer muestra el enlace
al incidente creado.

### 3.6 Acciones masivas

Con filas seleccionadas aparece una barra fija sobre la tabla: "3
seleccionadas · Reconocer · Asignar a… · Limpiar". Solo comandos válidos para
**todas** las seleccionadas. Se ejecutan uno por uno; el resultado se informa
por fila ("2 reconocidas, 1 cambió mientras tanto · Ver").

### 3.7 Aceptación

- Un analista nunca ve "Triar" en una alerta asignada a otra persona.
- Un 409 recarga la alerta, mantiene el texto escrito en el formulario y dice
  "Otra persona cambió esta alerta. Revisa el estado nuevo antes de volver a
  enviar."
- `rawRef` ausente no deja un hueco: la fila "Evento original" no se dibuja.

---

## 4. Incidentes

**Nivel:** API. **Ruta:** `/incidents`, `/incidents/:id`.

### 4.1 Lista

Pestañas: **Activos** (`open`, `contained`, `eradicated`) · **Resueltos**
(`resolved`) · **Cerrados**. Densidad `cómoda` por defecto.

| Columna | Campo | Ancho | Alin. |
| --- | --- | --- | --- |
| Severidad | `severity` | fijo 112 | I |
| Título | `title` (+ `summary` truncado en segunda línea) | flex | I |
| Fase | `status` en `LifecycleStepper` compacto | fijo 200 | I |
| Propietario | `ownerId` | fijo 120 | I · mono |
| Alertas | `alertIds.length` | fijo 72 | D · tabular |
| Abierto | `openedAt` | fijo 96 | D · relativo |

Orden: severidad, luego `openedAt` asc.

### 4.2 Detalle

El detalle abre en **página** (no drawer) cuando se navega por URL, porque un
incidente se trabaja durante horas; desde la lista abre en drawer con botón
"Abrir en página" (`⤢`).

```
◆ Crítica · Incidente 0193…                                    [Acciones ▾]
Movimiento lateral desde estación de finanzas
Propietario 0191… · abierto hace 2 h

● Abierto ── ● Contenido ── ○ Erradicado ── ○ Resuelto ── ○ Cerrado
            (actual)

┌ Resumen ───────────────────────────┐ ┌ Alertas vinculadas (3) ─────────┐
│ texto del summary                   │ │ ◆ P1 … Triada · VP              │
│                                     │ │ ▲ P2 … Reconocida · sin veredic.│ ← bloquea cierre
└─────────────────────────────────────┘ └─────────────────────────────────┘
┌ Historial (auditoría) ──────────────────────────────────────────────────┐
```

**Fases.** `LifecycleStepper` con los cinco estados reales. `resolve` puede
saltar `eradicated` (desde `contained`): el paso se dibuja como "omitido" con
línea punteada, no como completado.

**Acciones** según [01 · §4.3](01-inventario-backend.md#43-comandos-de-incidente):

| Estado | Primaria | Secundarias |
| --- | --- | --- |
| `open` | Marcar contenido | Reasignar… |
| `contained` | Marcar erradicado | Marcar resuelto, Reasignar… |
| `eradicated` | Marcar resuelto | Reasignar… |
| `resolved` | Cerrar incidente… (si `incidents.close`) | Reabrir, Reasignar… |
| `closed` | — | Reabrir |

**Cerrar incidente** abre `ReasonRequiredDialog`:

- Motivo de cierre obligatorio, ≥ 10 caracteres.
- Si alguna alerta vinculada no tiene veredicto, el diálogo **no deja
  enviar** y lista cuáles son, con enlace a cada una: "2 alertas vinculadas
  aún no tienen veredicto. Triarlas antes de cerrar."
- Botón en estilo `danger`: "Cerrar incidente".

**Alertas vinculadas.** Se resuelven cruzando `alertIds` con
`GET /api/alerts` (no hay endpoint por incidente). Si el usuario no tiene
`alerts.read` (auditor), se muestran solo los identificadores en mono, sin
estado.

### 4.3 Aceptación

- El auditor ve la lista y el detalle **sin ningún botón de acción** y sin el
  menú "Acciones".
- "Cerrar incidente" no aparece para un analista (`incidents.close` ausente);
  la fase `resolved` se ve igual, sin explicación de por qué falta el botón.

---

## 5. Auditoría

**Nivel:** API. **Ruta:** `/audit`. Solo lectura; ninguna acción mutante.

### 5.1 Barra de consulta

`[Ventana ▾ (máx. 365 días)]  [Acción ▾]  [Resultado ▾]  [Actor]  [Recurso]  [Consultar]`

- Ventana y acción se envían al BFF. Resultado, actor y recurso se filtran en
  cliente sobre la página recibida **y la UI lo dice**: "Filtrado en esta
  página (50 de la consulta)". Cuando el BFF cablee esos filtros, el aviso
  desaparece.
- Acción: `Select` con las acciones emitidas hoy ([01 · §3.4](01-inventario-backend.md#34-auditoría)).

### 5.2 Tabla (densidad compacta)

| Columna | Campo | Ancho | Alin. |
| --- | --- | --- | --- |
| Secuencia | `sequence` | fijo 88 | D · mono |
| Instante | `occurredAt` | fijo 168 | I · absoluto con segundos |
| Actor | `actor.type` + `actor.id` | auto | I · mono |
| Acción | `action` | auto | I · mono |
| Recurso | `resource.type` / `resource.id` | flex | I · mono |
| Resultado | `outcome` | fijo 112 | I · `StatusChip` |
| Correlación | `correlationId` | fijo 112 | I · mono, copiable |

Orden ascendente (como lo entrega el BFF). Botón "Más recientes primero" que
invierte la página **actual** con aviso, hasta que el BFF ordene.

### 5.3 Detalle (drawer)

`DescriptionList` con todos los campos; `metadata` en `JsonViewer` (valores
redactados se muestran como `RedactedValue`); `hash` y `previousHash`
completos en mono con copia; `actor.ip` y `actor.sessionId` como
`RedactedValue` cuando llegan `[REDACTED]`.

### 5.4 Integridad (`/audit/integrity`, `audit.verify`)

Una sola acción: **"Verificar cadena"**. Resultado:

- Íntegra: `HealthMark` ok, "1 000 eventos revisados, sin violaciones. Último
  en la secuencia 48 213." y la nota "La verificación revisa los primeros
  1 000 eventos." (límite real del BFF).
- Con violaciones: tabla `code` (traducido) · `sequence` · `detail`, en
  `--state-fail`, con enlace a cada secuencia en la consulta de auditoría.

---

## 6. Notificaciones

**Nivel:** API. **Ruta:** `/notifications`. Patrón de PagerDuty: **entregada no
es atendida**.

### 6.1 Tabla

Pestañas: **Sin acuse** (`sent`, `indeterminate`, `fallback`) · **En curso**
(`pending`, `sending`) · **Fallidas** (`failed`) · **Acusadas**.

| Columna | Campo | Ancho | Alin. |
| --- | --- | --- | --- |
| Estado | `status` → `NotificationStatusChip` | fijo 200 | I |
| Canal | `channel` | fijo 140 | I |
| Intentos | `attemptCount` de 5 ("3 de 5") | fijo 88 | D · tabular |
| Entregada | `sentAt` | fijo 120 | D · relativo |
| Acuse | `acknowledgedBy` + `acknowledgedAt` | flex | I |
| Último fallo | `lastFailureClass` | fijo 132 | I |
| Acción | "Acusar" | fijo 96 | D |

`sent` se rotula **"Entregada · sin acuse"**, con el texto "sin acuse" en
`--state-warn`. Pasados 15 min desde `sentAt` sin acuse, la fila lleva el
glifo `!` en `--state-fail` y el texto "15 min sin acuse humano".

### 6.2 Acusar

Botón secundario por fila. Confirmación en línea (no diálogo): el botón pasa a
"Confirmar acuse" durante 4 s. Un 409 recarga la fila.

### 6.3 Lo que no se muestra

- "Procesar cola" (`drain`) no se ofrece en esta pantalla: es una operación
  técnica que en producción ejecuta un proceso, no una persona.
- No hay botón "Reintentar": no existe en el backend.
- La notificación no trae a qué alerta o incidente pertenece; la columna se
  agrega cuando el BFF la exponga ([08 · B-09](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)).

---

## 7. Plataforma

**Nivel:** DOMINIO. Las tres pantallas se construyen tras `MockAdapter` con
chip Demostración y **no se habilitan en producción** hasta tener API.

### 7.1 Salud y cobertura (`/platform/health`)

Lista de etapas/fuentes con `SourceHealthCard`:

| Elemento | Contenido |
| --- | --- |
| Estado | `healthy` / `degraded` / `failed` con `HealthMark` |
| Razones | cada razón de [01 · §3.5](01-inventario-backend.md#35-salud-del-pipeline-dominio-c-15) con el valor medido y el umbral: "Retraso de ingesta 7 min (degradado desde 5 min)" |
| Último éxito | relativo + absoluto |
| Cobertura | `coverage`, `quarantineRate`, `duplicateRate`, `lossless` ("sin pérdida" / "con pérdida") |
| Proveedor | componentes de `ProviderHealth` con `code` y `latencyMs` |

Fuentes del inventario: Wazuh (`planned`), Microsoft vía Wazuh (`enabled` por
decisión administrativa), Sophos y Cato (`post_mvp`). Una fuente `planned` se
muestra como "Planificada · sin datos", **nunca** como "Operativa".

### 7.2 Cuarentena (`/platform/quarantine`)

| Columna | Campo |
| --- | --- |
| Causa | `errorCode` traducido + `errorPath` en mono |
| Fuente / dataset | `lineage.sourceId`, dataset |
| Estado | `quarantined`, `reprocessing`, `resolved`, `discarded` |
| Intentos | `attemptCount` de 3 |
| En cuarentena | `quarantinedAt` |
| Último reproceso | `lastReprocessedAt` |

Detalle: linaje completo como cadena de cinco identificadores enlazados.
Reprocesar: `ReasonRequiredDialog` con motivo; deshabilitado (y explicado en
el diálogo, porque no es una capability sino un presupuesto) cuando
`attemptCount = 3`: "Se agotaron los 3 intentos de reproceso."

### 7.3 Credenciales (`/platform/credentials`)

Solo metadatos. Columnas: nombre lógico, propósito, propietario,
clasificación, estado, versión actual, huella (`RedactedValue`), vence,
rotada por / el.

Acciones: Crear, Rotar, Revocar. El formulario de material es un `Textarea`
de una sola escritura: **no tiene botón "mostrar"**, no se rellena al editar,
y tras enviar se borra del estado del componente. Texto fijo bajo el campo:
"El valor no se podrá ver después de guardarlo. Nunca lo pegues en un ticket."

Estado `RECONCILIATION_REQUIRED` se muestra con `--state-warn` y la razón
(`PROVIDER_STATE_UNKNOWN`, `METADATA_PERSISTENCE_FAILED`,
`CONCURRENT_STATE_CHANGE`).

---

## 8. Mi sesión (`/me`)

**Nivel:** API.

| Bloque | Contenido |
| --- | --- |
| Identidad | `subjectId` (mono), `tenantId` (mono) |
| Roles | lista de `roles` con su nombre en español ("Analista SOC") |
| Capabilities vigentes | lista agrupada (Alertas, Incidentes, Auditoría…) en mono; sin explicación de las que **no** tiene |
| Autenticación | `amr` traducido: "Contraseña + MFA", "Passkey (FIDO2)" |
| Sesión | "Una sesión activa por persona. Iniciar sesión en otro navegador cerrará esta." |
| Acción | Cerrar sesión |

---

## 9. Pantallas de sistema

| Pantalla | Cuándo | Contenido |
| --- | --- | --- |
| No disponible | Ruta sin capability **o** inexistente **o** `RESOURCE_UNAVAILABLE` | `--type-display`: "No disponible". Texto: "El recurso no existe o no está disponible para tu cuenta." `correlationId`. Botón "Ir al resumen". Idéntica en ambos casos |
| Sesión terminada | `SESSION_EXPIRED` / `AUTH_REQUIRED` en cualquier petición | Diálogo modal no cerrable: "Tu sesión terminó." + "Iniciar sesión" (vuelve a la ruta actual tras entrar). Lo que el usuario estaba escribiendo se conserva en memoria hasta el reingreso |
| Red no permitida | `NETWORK_NOT_ALLOWED` | Pantalla completa con el mensaje del catálogo y la acción "Conéctate desde la oficina o la VPN aprobada" |
| Error inesperado | `INTERNAL_ERROR` o respuesta fuera de catálogo | `ErrorState`: "Ocurrió un problema inesperado. No asumas que la operación se completó: revisa el estado del elemento." |
| `/errors/:code` | Enlace `helpRef` | Explicación del código desde el catálogo local: qué significa, qué hacer, qué **no** hacer |
