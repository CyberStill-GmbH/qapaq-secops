# 01 · Inventario funcional del backend

Estado: baseline funcional actualizado al 2026-10-13 para la revisión de demo. Los
cambios locales del sprint aún requieren CI, integración real y publicación; no implica
release aceptado.

Este documento enumera **lo que el backend hace hoy**, con los nombres exactos
que la interfaz debe consumir. Es la fuente para el resto de la carpeta: si una
pantalla de [04](04-pantallas.md) usa un campo, ese campo está aquí.

Cada funcionalidad tiene un nivel de disponibilidad. El nivel decide cómo se
construye la pantalla ([06 · §1](06-patrones-de-interaccion.md#1-niveles-de-disponibilidad)).

| Nivel | Significado | Cómo se construye en el frontend |
| --- | --- | --- |
| **API** | Ruta HTTP servida por el BFF (`apps/api`) | Contra el BFF real. Sin mock. |
| **DOMINIO** | Lógica en `modules/*` o `platform/*` sin ruta HTTP | No se presenta como una operación disponible. Se documenta la brecha y se ocultan controles sin API. |
| **DOC** | Solo existe en `docs/` o en el mock web | Se documenta como futuro; no se anuncia ni se simula como activo. |

---

## 1. Rutas HTTP reales

Las rutas vigentes se enumeran por superficie debajo; el total histórico de 20 ya quedó
obsoleto por los incrementos de Sprint 5. No hay prefijo `/api/v1`. Las del mock
([`admin.ts`](../../apps/web/src/api/admin.ts),
[`API_CONTRACT.md`](../../apps/web/API_CONTRACT.md)) bajo `/api/v1/*` **no
existen** ([08 · §1](08-brechas-y-decisiones.md#1-contrato-de-api)).

### 1.1 Salud (sin sesión)

| Método | Ruta | Respuesta 200 | Error |
| --- | --- | --- | --- |
| GET | `/health/live` | `{ status: 'ok', service }` | 503 `{ status: 'unavailable' }` |
| GET | `/health/ready` | igual | 503 igual |

El proxy de Vite reescribe `/api/health/*` → `/health/*`. "Ready" no comprueba
PostgreSQL, Redis ni OpenSearch (no hay contribuidores); la UI no debe decir
más de lo que mide (ya lo hace el login: *"No verifica PostgreSQL, Redis ni
OpenSearch"*).

### 1.2 Autenticación

| Método | Ruta | Uso en UI | Respuesta |
| --- | --- | --- | --- |
| GET | `/api/auth/start?returnTo=` | **Navegación de nivel superior** (no `fetch`) desde el botón "Continuar con Microsoft Entra". `returnTo` es la ruta de la consola a la que volver | 302 a Entra (o al emisor local) |
| GET | `/api/auth/callback` | Destino de Entra | **303** a `returnTo` con `Set-Cookie`; `?sessionNotice=superseded` si cerró otra sesión. Fallo: 303 a `returnTo?authError=<código>&correlationId=` ([08 · §2.1](08-brechas-y-decisiones.md#21-registro-de-resolución-b-01-b-02-b-03)) |
| GET | `/api/auth/session` | Arranque de la consola y tras cada 401 | `{ subjectId, tenantId, roles[], capabilities[], amr[], csrfToken, correlationId }` |
| POST | `/api/auth/logout` | Cerrar sesión (con `x-csrf-token`) | 204, cookie borrada. No cierra sesión en Entra |
| GET | `/api/auth/local/principals` | Solo `local-development`: selector de identidad de prueba | `[{ username, displayName, roles[], amr[] }]` |

La sesión **no devuelve** nombre visible, correo, expiración ni estado. La
barra superior muestra `subjectId` abreviado en mono hasta que el BFF exponga
`displayName` ([08 · B-04](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)).

Cookie `qapaq_session`: `HttpOnly; SameSite=Lax; Path=/`; `Secure` en
producción. React nunca la lee.

**Reglas comunes a todas las rutas de las secciones 1.3 a 1.5:**

- **Mutaciones**: todo `POST` con sesión exige la cabecera `x-csrf-token` con
  el `csrfToken` de `/api/auth/session`. Sin token, con el token de otra sesión
  o con `Sec-Fetch-Site: cross-site` → `403 REQUEST_NOT_VERIFIED`, y el comando
  no se ejecuta. El token se guarda solo en memoria.
- **Listados**: `?pageSize=` de 1 a 200 (50 por defecto; fuera de rango →
  `422`, no se recorta) y `?cursor=` opaco. La respuesta trae `nextCursor`,
  `null` en la última página. El cursor sirve solo para el listado y el filtro
  que lo produjeron. Orden: más reciente primero.

### 1.3 Alertas

| Método | Ruta | Capability | Entrada | Respuesta |
| --- | --- | --- | --- | --- |
| GET | `/api/alerts` | `alerts.read` | `?status=` (valor exacto), `pageSize`, `cursor` | `{ correlationId, items: AlertView[], nextCursor }`, orden `occurredAt` desc |
| GET | `/api/alerts/:id` | `alerts.read` | — | `{ correlationId, alert: AlertView }` |
| POST | `/api/alerts/:id/commands` | según comando (§4.1) | `{ name, expectedRevision, verdict?, note?, assigneeId? }` | 201 `{ correlationId, alert }` |

`AlertView`:

| Campo | Tipo | Presentación |
| --- | --- | --- |
| `id` | string | mono, abreviado a 8 caracteres con copia del completo |
| `title` | string | texto principal de la fila |
| `priority` | `P1`…`P4` | `SeverityIndicator` (glifo + rótulo + color) |
| `score` | 0–100 | número tabular junto a la prioridad, en `--text-3` |
| `status` | `AlertStatus` | `StatusChip` |
| `assigneeId` | string \| null | "Sin asignar" en `--text-3` cuando es null |
| `verdict` | `TriageVerdict` \| null | etiqueta traducida; vacío si null |
| `incidentId` | string \| null | enlace al incidente |
| `occurredAt` | ISO | `RelativeTime` con absoluto |
| `revision` | number | invisible; se envía como `expectedRevision` |
| `reasons` | `{ code, detail }[]` | lista "Por qué esta prioridad" en el detalle |
| `rawRef` | string, **opcional** | solo existe con `events.read_raw`; la clave **no viene** si falta la capability |

No se exponen `triageNote`, `eventRecordId`, `createdAt`, `updatedAt`.

### 1.4 Incidentes

| Método | Ruta | Capability | Entrada | Respuesta |
| --- | --- | --- | --- | --- |
| POST | `/api/incidents` | `incidents.write` | `{ alertId, title, severity, summary, expectedAlertRevision }` todos obligatorios | 201 `{ correlationId, incident }` |
| GET | `/api/incidents` | `incidents.read` | `pageSize`, `cursor` | `{ correlationId, items: IncidentView[], nextCursor }`, orden `openedAt` desc |
| GET | `/api/incidents/:id` | `incidents.read` | — | `{ correlationId, incident: IncidentView }` |
| GET | `/api/incidents/:id/alerts` | `incidents.read` y `alerts.read` | `pageSize`, `cursor` | `{ correlationId, incidentId, items: AlertView[], nextCursor, totalCount, unavailableCount, truncated }`, orden `occurredAt` desc |
| POST | `/api/incidents/:id/commands` | `close` → `incidents.close`; resto → `incidents.write` | `{ name, expectedRevision, closureReason?, ownerId? }` | 201 `{ correlationId, incident }` |

`GET /api/incidents/:id` cierra la brecha
[08 · B-05](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz).

`GET /api/incidents/:id/alerts` resuelve las alertas vinculadas con la misma proyección
redactada de `GET /api/alerts` (sin `rawRef` para quien no tiene `events.read_raw`), así la
consola no consulta alerta por alerta:
- resuelve como máximo 200 vínculos y `truncated` indica si había más;
- un vínculo que no se puede leer en el tenant solo suma a `unavailableCount`;
- sin una de las dos capabilities, o con un incidente inexistente, responde
  `RESOURCE_UNAVAILABLE`.

### 1.4.1 Tareas, bitácora y timeline del incidente (Sprint 5 · fase 4)

| Método | Ruta | Capability | Entrada | Respuesta |
| --- | --- | --- | --- | --- |
| GET | `/api/incidents/:id/tasks` | `incidents.read` | `pageSize`, `cursor` | `{ correlationId, incidentId, items: TaskView[], nextCursor, totalCount, openRequiredCount }`, orden `createdAt` desc |
| POST | `/api/incidents/:id/tasks` | `incidents.tasks.write` + CSRF | `{ title, required, description?, assigneeId?, dueAt? }` | 201 `{ correlationId, task }` |
| POST | `/api/incidents/:id/tasks/:taskId/commands` | `incidents.tasks.write` + CSRF | `{ name: start\|complete\|reopen\|cancel\|assign, expectedRevision, assigneeId?, reason? }` | 201 `{ correlationId, task }` |
| GET | `/api/incidents/:id/notes` | `incidents.read` | `pageSize`, `cursor` | `{ correlationId, incidentId, items: NoteView[], nextCursor, totalCount }`, orden `createdAt` desc |
| POST | `/api/incidents/:id/notes` | `incidents.notes.write` + CSRF | `{ body, correctsNoteId? }` | 201 `{ correlationId, note }` |
| GET | `/api/incidents/:id/timeline` | `incidents.read` | `pageSize`, `cursor` | `{ correlationId, incidentId, transitions, items: TimelineEntry[], nextCursor, totalCount }` |

`TaskView`: `id`, `incidentId`, `title`, `description`, `status` (`open | in_progress |
done | cancelled`), `required`, `assigneeId | null`, `dueAt | null`, `createdBy`, `createdAt`,
`updatedAt`, `completedAt | null`, `cancellationReason | null`, `revision`.

`NoteView`: `id`, `incidentId`, `authorId`, `body`, `createdAt`, `correctsNoteId | null`. No
existe editar ni borrar: una corrección es otra nota con `correctsNoteId`.

`TimelineEntry`:
- `id`, `kind`, `at`, `actorId | null`, `summary`, `ref { type, id }`;
- `kind` es uno de: `incident.opened`, `incident.transition`, `incident.closed`, `alert.linked`, `task.created`, `task.completed`, `task.cancelled` o `note.added`;
- `timeSource` vale `provider` (hora del evento en la fuente: alertas) o `recorded` (hora en que QAPAQ lo registró).
- `recordedAt`: hora en que QAPAQ registró la entrada. En alertas difiere de `at` (que es la hora en la fuente); en el resto coincide.

`transitions` indica si el timeline incluye contener, erradicar, resolver, reabrir y
reasignar, que salen de la auditoría:
- `included`: el lector tiene `audit.read`;
- `partial`: hay más de una página o el caso es más antiguo que el rango de auditoría;
- `requires_audit_read`: el lector no puede leerlas. La UI debe decirlo, no ocultarlo.

Reglas:
- cerrar el incidente con una tarea obligatoria `open` o `in_progress` responde 422
  (`VALIDATION_FAILED`). Cancelar una obligatoria exige `reason` de 10 a 500 caracteres;
- un incidente `closed` no admite tareas ni notas nuevas hasta reabrirlo;
- sin capability, inexistente o id que no es UUID: `RESOURCE_UNAVAILABLE`. Revisión obsoleta: 409 `STATE_CONFLICT`.
- capabilities por rol: `incidents.tasks.write` e `incidents.notes.write` las tienen analista, lead y admin; el auditor solo lee.

`IncidentView`: `id`, `title`, `severity`, `status`, `ownerId`, `alertIds[]`,
`summary`, `openedAt`, `closedAt | null`, `revision`. No se expone
`closureReason`.

### 1.5 Notificaciones críticas

| Método | Ruta | Capability | Respuesta |
| --- | --- | --- | --- |
| GET | `/api/notifications` | `notifications.read` | `{ items: [{ id, status, channel, attemptCount, sentAt, acknowledgedAt, acknowledgedBy, lastFailureClass }], nextCursor }`, orden de creación desc; admite `pageSize` y `cursor` |
| POST | `/api/notifications/:id/acknowledge` | `notifications.read` | 201 `{ correlationId, status: 'acknowledged' }`; 409 si no fue entregada o ya fue acusada |
| POST | `/api/notifications/drain` | `notifications.dispatch` + CSRF | `{ correlationId, results: string[] }`; pasada manual acotada. El despacho habitual es automático. Solo se muestra a SOC lead/platform admin autorizados. |

La notificación **no trae** la alerta o el incidente que la originó, ni
severidad, ni destino. No hay reintento manual.

### 1.6 Auditoría

| Método | Ruta | Capability | Entrada | Respuesta |
| --- | --- | --- | --- | --- |
| GET | `/api/audit/events` | `audit.read` | `from`, `to` **obligatorios** (≤ 365 días), `pageSize` 1–200 (50), `action?` exacto | `{ nextCursor, items: AuditProjection[] }` en orden **ascendente** de secuencia |
| GET | `/api/audit/verify` | `audit.verify` | — | `{ ok, checked, headSequence, violations: [{ code, sequence, detail }] }` |

`AuditProjection`: `id`, `sequence`, `occurredAt`, `actor { id, type,
sessionId?, ip? }`, `action`, `resource { type, id }`, `outcome`,
`correlationId`, `reason?`, `metadata`, `hash`, `previousHash`.

- `actor.sessionId` y `actor.ip` llegan como `'[REDACTED]'` sin
  `audit.read_sensitive`. La UI los muestra como `RedactedValue`, no como
  texto literal.
- **El cursor no funciona**: el controlador no lo reenvía
  ([08 · B-06](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)).
- `verify` revisa solo los primeros 1000 eventos.

### 1.7 Ingesta de prueba

`POST /api/ingest/security-events` — solo en `local-development`, sin sesión.
Recibe un `SecurityEvent` 1.0.0 y responde `{ outcome: 'promoted' | 'duplicate'
| 'not_promoted' }`. **No tiene pantalla de producto**; es una herramienta de
desarrollo.

---

## 2. Identidad y autorización real

### 2.1 Roles y capabilities efectivas

Cuatro roles de aplicación de Entra. No hay jerarquía ni bundles. Un rol
desconocido no concede nada.

| Rol | Capabilities efectivas (rol ∩ scopes del BFF) |
| --- | --- |
| `qapaq.soc.analyst` | `events.read`, `alerts.read`, `alerts.triage`, `alerts.assign`, `incidents.read`, `incidents.write`, `incidents.tasks.write`, `incidents.notes.write`, `notifications.read` |
| `qapaq.soc.lead` | Analyst + `events.read_raw`, `incidents.close`, `notifications.dispatch`, `observability.read_soc`, `sources.health.read`, `audit.read` |
| `qapaq.auditor` | `audit.read`, `audit.read_sensitive`, `audit.verify`, `incidents.read`, `sources.health.read` |
| `qapaq.platform.admin` | Unión explícita de capabilities actuales, incluidas auditoría sensible, salud, `users.read`, `sessions.read`, `sessions.revoke` y `secrets.write`; no incluye futuras capabilities. |

**La interfaz decide por capability, nunca por rol.** El rol se muestra en el
perfil; no se usa en un `if`.

Consecuencias de diseño directas:

- El **auditor no ve alertas** (`alerts.read` ausente): su navegación no tiene
  "Alertas".
- El **administrador de plataforma** ve las superficies actuales que autoriza su sesión,
  incluidas Usuarios SOC, Sesiones, Salud operativa/plataforma, fuentes y auditoría.
- Eventos y salud de fuentes ya tienen rutas BFF; los controles visibles se limitan a las
  capabilities efectivas y al contrato que el runtime habilite.

### 2.2 Inicio de sesión

| Regla | Valor | Efecto en UI |
| --- | --- | --- |
| Dentro de red QAPAQ | exige MFA (`mfa`, `ngcmfa`, `otp`, `rsa` o passkey) | — |
| Fuera de red | exige passkey (`fido`, `hwk`, `phr`) | Error `PASSKEY_REQUIRED` con instrucción concreta |
| Cadena de proxies no confiable | rechazo | `NETWORK_NOT_ALLOWED` |
| Límite de intentos | 30 / 60 s por IP | `RATE_LIMITED` |
| Bloqueo | 5 fallos (origen nuevo) o 10 (conocido) en 15 min; 1 min que se duplica hasta 30 min | Se presenta como `AUTH_FAILED`: **no se revela el bloqueo** |
| Sin rol | — | `AUTH_FAILED`, mismo mensaje que credencial inválida |

### 2.3 Sesión

| Regla | Valor |
| --- | --- |
| Inactividad | 30 min, se renueva con cada petición autenticada |
| Absoluta | 8 h |
| Concurrencia | **una por persona; la nueva reemplaza a la anterior** (`superseded`). La anterior recibe `SESSION_EXPIRED` en su siguiente petición |
| Callback | informa `supersededSessions` (número de sesiones cerradas) |

La UI no recibe la hora de expiración. El aviso de "la sesión vence en 2 min"
del diseño de identidad **no es construible** sin un campo nuevo
([08 · B-07](08-brechas-y-decisiones.md#2-brechas-que-bloquean-la-interfaz)).

---

## 3. Enumeraciones exactas

Valores del código. Columna "Rótulo" es el texto en español que la UI muestra;
el valor del backend no se muestra salvo en vistas técnicas.

### 3.1 Alerta

| `status` | Rótulo | Abierta |
| --- | --- | --- |
| `new` | Nueva | sí |
| `acknowledged` | Reconocida | sí |
| `triaged` | Triada | sí |
| `escalated` | Escalada | sí |
| `closed` | Cerrada | no |

| `verdict` | Rótulo |
| --- | --- |
| `true_positive` | Verdadero positivo |
| `false_positive` | Falso positivo |
| `benign` | Benigno |
| `duplicate` | Duplicado |

| `priority` | Umbral de `score` | Rótulo |
| --- | --- | --- |
| `P1` | ≥ 85 | P1 · Crítica |
| `P2` | ≥ 65 | P2 · Alta |
| `P3` | ≥ 35 | P3 · Media |
| `P4` | < 35 | P4 · Baja |

| `reasons[].code` | Rótulo en "Por qué esta prioridad" |
| --- | --- |
| `BASE_SEVERITY` | Severidad de origen |
| `PRIVILEGED_IDENTITY` | Identidad privilegiada (+15) |
| `CRITICAL_ASSET` | Activo crítico (+15) |
| `SUCCESSFUL_INTRUSION` | Intrusión con resultado exitoso (+20) |
| `REPEATED_ACTIVITY` | Actividad repetida (+10) |
| `EXTERNAL_EXPOSURE` | Activo expuesto a internet (+10) |
| `MAINTENANCE_WINDOW` | Dentro de ventana de mantenimiento |
| `KNOWN_BENIGN` | Regla marcada como benigna |
| `INFORMATIONAL_ONLY` | Solo informativa |

### 3.2 Incidente

| `status` | Rótulo | | `severity` | Rótulo |
| --- | --- | --- | --- | --- |
| `open` | Abierto | | `critical` | Crítica |
| `contained` | Contenido | | `high` | Alta |
| `eradicated` | Erradicado | | `medium` | Media |
| `resolved` | Resuelto | | `low` | Baja |
| `closed` | Cerrado | | | |

### 3.3 Notificación

| `status` | Rótulo | Se puede acusar |
| --- | --- | --- |
| `pending` | En cola | no |
| `sending` | Enviando | no |
| `sent` | **Entregada · sin acuse** | sí |
| `indeterminate` | Entrega no confirmada | sí |
| `fallback` | Por canal alterno | sí |
| `failed` | Fallida | no |
| `acknowledged` | Acusada por una persona | — |

| `channel` | Rótulo |
| --- | --- |
| `teams` | Microsoft Teams |
| `fallback_email` | Correo alterno |
| `manual_console` | Consola (manual) |

`lastFailureClass`: `transient` (temporal), `permanent` (permanente),
`ambiguous` (resultado desconocido).

### 3.4 Auditoría

`outcome`: `allowed` (permitido), `denied` (denegado), `succeeded`
(completado), `failed` (fallido). `actor.type`: `user`, `service`, `system`.

Violaciones de cadena (`verify`): `TAMPERED` (registro alterado), `FORKED`
(bifurcación), `GAP` (hueco de secuencia), `OUT_OF_ORDER` (fuera de orden).

Acciones emitidas hoy: `access.sign_in`, `soc.alert.created`,
`soc.alert.{acknowledge|assign|triage|escalate|close|reopen}`,
`soc.incident.open`,
`soc.incident.{contain|eradicate|resolve|close|reopen|reassign}`,
`soar.notification.{sent|fallback}`.

### 3.5 Salud del pipeline (DOMINIO, C-15)

Estado `healthy` / `degraded` / `failed` con razones:

| Razón | Degradado | Caído |
| --- | --- | --- |
| `DEPENDENCY_DOWN` | — | cualquier dependencia dura |
| `NO_RECENT_SUCCESS` | 900 s | 3600 s |
| `INGESTION_LAG` | 300 s | 1800 s |
| `QUARANTINE_RATE` | 5 % | 25 % |
| `ERROR_RATE` | 10 % | 50 % |

---

## 4. Reglas de negocio que la interfaz debe aplicar antes de enviar

El BFF **colapsa** el motivo de rechazo: casi todo error de dominio llega como
`VALIDATION_FAILED` sin `fields`, y "no asignado" o "incidente cerrado" llegan
como `RESOURCE_UNAVAILABLE`. Si la UI deja que el servidor rechace, el analista
no sabrá qué hizo mal. Por eso **cada regla siguiente se valida en el
formulario**, y el servidor queda como segunda barrera.

### 4.1 Comandos de alerta

| Comando | Desde → hacia | Capability | Validación previa en UI |
| --- | --- | --- | --- |
| `acknowledge` | `new` → `acknowledged` | `alerts.triage` | Si no hay asignado, el actor queda asignado: el botón dice "Reconocer y asignarme" |
| `assign` | `new`/`acknowledged` → `acknowledged`; `triaged` → `triaged` | `alerts.assign` | `assigneeId` obligatorio |
| `triage` | `acknowledged` → `triaged` | `alerts.triage` + **ser el asignado** | `verdict` obligatorio; nota 10–2000 caracteres tras recortar; si el actor no es el asignado la acción **no se ofrece** |
| `escalate` | `triaged` → `escalated` | `alerts.triage` | Solo si `verdict = true_positive` |
| `close` | `acknowledged`/`triaged`/`escalated` → `closed` | `alerts.triage` | Nota ≥ 10 caracteres si el estado no es `triaged` |
| `reopen` | `closed` → `acknowledged` | `alerts.triage` | — |

Todo comando lleva `expectedRevision`. Un 409 significa que otra persona cambió
la alerta: la UI recarga y muestra el estado nuevo
([06 · §5](06-patrones-de-interaccion.md#5-concurrencia-y-revisión)).

### 4.2 Abrir incidente desde alerta

- Una alerta solo puede estar en **un** incidente (`incidentId`). Si ya tiene,
  la acción se sustituye por el enlace al incidente.
- `title`, `summary` y `severity` no se validan en el servidor. La UI exige
  título 4–160 caracteres, resumen 10–2000 y severidad del catálogo.
- El propietario es quien lo abre.

### 4.3 Comandos de incidente

| Comando | Desde → hacia | Capability | Validación previa en UI |
| --- | --- | --- | --- |
| `contain` | `open` → `contained` | `incidents.write` | — |
| `eradicate` | `contained` → `eradicated` | `incidents.write` | — |
| `resolve` | `contained`/`eradicated` → `resolved` | `incidents.write` | — |
| `close` | `resolved` → `closed` | `incidents.close` | Motivo ≥ 10 caracteres; **ninguna alerta vinculada sin veredicto** (la UI lo comprueba con `alertIds` y la lista de alertas, y enumera las pendientes) |
| `reopen` | `resolved`/`closed` → `open` | `incidents.write` | — |
| `reassign` | cualquiera salvo `closed` | `incidents.write` | `ownerId` obligatorio |

`attach_alert` existe en el dominio pero **el controlador no lo admite**: no se
ofrece. Un nombre de comando desconocido produce un 500 fuera de catálogo; la
UI solo envía los seis nombres de la tabla.

### 4.4 Acuse de notificación

Solo desde `sent`, `indeterminate` o `fallback`. El acuse **no se audita**
hoy; la UI no debe decir "registrado en auditoría".

---

## 5. Capacidades de dominio sin API (nivel DOMINIO)

Diseñadas en [04](04-pantallas.md) para ubicarlas en la navegación desde el
principio. Se construyen con `MockAdapter` y chip de demostración.

| Funcionalidad | Módulo | Contrato que la UI respetará |
| --- | --- | --- |
| Búsqueda de eventos | `modules/telemetry/src/event-query.ts` | `from`/`to` obligatorios, ventana ≤ 90 días; `pageSize` 50 (máx. 200, se rechaza, no se recorta); filtros `severity[]`, `category[]`, `kind[]`, `outcome[]`, `dataset`; cursor opaco; **sin texto libre** ni orden configurable; `raw` ausente sin `events.read_raw` |
| Evento normalizado | `packages/contracts/src/security-event` | Ver [04 · §2](04-pantallas.md#2-eventos) para campos |
| Cuarentena y reproceso | `modules/telemetry/src/quarantine-reprocess.ts` | Estados `quarantined`, `reprocessing`, `resolved`, `discarded`; presupuesto de 3 intentos; causas `RAW_TOO_LARGE`, `RAW_NOT_OBJECT`, `MISSING_TIMESTAMP`, `INVALID_TIMESTAMP`, `MISSING_RULE`, `INVALID_RULE_LEVEL`, `INVALID_RULE_IDENTITY`, `CONTRACT_VALIDATION_FAILED`; linaje `sourceId → manifestId → inboxId → rawEventReferenceId → recordId` |
| Salud del pipeline y cobertura | `platform/observability/src/pipeline-health.ts` | §3.5; `coverage`, `quarantineRate`, `duplicateRate`, `lossless` |
| Salud del proveedor Wazuh | `modules/connectors` | `healthy`/`degraded`/`unhealthy` con componentes `{ name, status, code, latencyMs, message }`; 16 códigos `PROVIDER_*` |
| Credenciales de integración | `platform/configuration/src/control-plane` | Crear, rotar, revocar, leer metadatos. Estado `ACTIVE`, `REVOKED`, `RECONCILIATION_REQUIRED`; huella `hmac-sha256:v1:…`; **nunca el valor** |
| Puntos de control | `modules/telemetry/src/checkpoint-advance.ts` | `cursor`, `revision`, `sourceGeneration`, `lastOccurredAt` |

---

## 6. Solo en documentación o mock (nivel DOC)

No existe dominio. **No se construye pantalla**; se reserva el lugar en la
navegación como ítem ausente (no deshabilitado) y se documenta qué haría.

- Reglas de detección: ciclo de vida, versiones, publicación, simulación,
  métricas de disparo y de falsos positivos.
- Grants, solicitudes de acceso, revisiones, JIT, break-glass, step-up.
- Listado y revocación de sesiones de otros usuarios.
- Playbooks SOAR, ejecuciones, aprobación dual, kill switch.
- Casos como entidad distinta de incidente (el código trata incidente = caso).
- Notas o comentarios libres (solo existen `triageNote` y `closureReason`).
- SLA, métricas de equipo, exportaciones, reportes.
- Reproceso masivo, replay de fuentes, configuración de conectores.
- Bundles de rol (`SOC_L1`, `VIEWER`…) y scopes `ORGANIZATION`…`ASSIGNED_RESOURCES`.

## Datos en vivo · `GET /api/changes` (S5-D10)

| Método | Ruta | Capability | Entrada | Respuesta |
| --- | --- | --- | --- | --- |
| GET | `/api/changes` | sesión válida; cada tipo se filtra por su capability de lectura | `after` (cursor; omitido = punto de partida) | `{ correlationId, cursor, changes: Change[], resync }` |

`Change`: `{ seq, resource: { type, id }, kind: 'created' | 'updated', at }`. Tipos y
capability que los habilita:

| Tipo | Capability |
| --- | --- |
| `alert` | `alerts.read` |
| `incident`, `incident_task`, `incident_note` | `incidents.read` |
| `notification` | `notifications.read` |
| `session` | `sessions.read` |

Uso:

1. Al montar la vista, `GET /api/changes` sin `after` para obtener el cursor actual.
2. En bucle, `GET /api/changes?after=<cursor>`. Si no hay cambios, la respuesta llega a los
   ~2,5 s con `changes: []`; si los hay, llega de inmediato. Siempre se guarda el `cursor`
   devuelto.
3. Por cada cambio visible en la vista, se recarga ese recurso por su endpoint normal y se
   anima su entrada o actualización.
4. `resync: true` (cliente muy atrasado) significa recargar la vista una vez y seguir con el
   cursor nuevo.
5. Con la pestaña oculta se pausa el bucle; al volver se retoma con el último cursor.

El feed nunca incluye contenido, actor ni motivo. Cursor mal formado: 422 `VALIDATION_FAILED`.
Sin sesión: 401.

## Explorador de eventos · `GET /api/events` (Sprint 5 · fase 1)

| Método | Ruta | Capability | Entrada | Respuesta |
| --- | --- | --- | --- | --- |
| GET | `/api/events` | `events.read`; `raw` solo con `events.read_raw` | `from`, `to` (ISO 8601 UTC; por defecto las últimas 24 h; máximo 31 días), `severity` y `category` (lista separada por comas), `outcome` (`success \| failure`), `pageSize` (1–200; 50 por defecto), `cursor` | `{ correlationId, status, window: { from, to }, items: EventView[], unparsedCount, nextCursor }` |

- `status: "ok"` significa que la fuente respondió. `status: "disabled"` significa que la fuente
  no está configurada: llega sin filas, y la UI debe decir que no hay fuente, no «sin eventos».
- Orden: lo más reciente primero. La paginación es solo por cursor (Anterior/Siguiente), sin
  total ni números de página. El cursor queda ligado a los filtros y al orden; con otros
  filtros responde 422 en `cursor`.
- `EventView`: `recordId`, `eventUid`, `occurredAt`, `receivedAt`, `kind`, `severity`,
  `category[]`, `outcome`, `action | null`, `title | null`, `rule { id, groups } | null`,
  `identities[]`, `resources[]`, `source`, `extensions | null` y `raw` (solo con
  `events.read_raw`: es el documento original del Indexer).
- `unparsedCount`: documentos de la página que no se pudieron normalizar; la UI lo informa.
- Límite de los filtros: `category` y `outcome` filtran por los grupos de la regla Wazuh. Lo que
  la proyección de Office 365 agrega a partir del registro (por ejemplo `email` por
  `Workload`) puede no quedar incluido. `unclassified` y `unknown` no son filtrables (422).
- Errores: entrada inválida 422 con los campos; proveedor caído 503 `DEPENDENCY_DEGRADED`, sin
  detalles internos.

## Salud por fuente · `GET /api/sources/health` (Sprint 5 · fase 2)

| Método | Ruta | Capability | Respuesta |
| --- | --- | --- | --- |
| GET | `/api/sources/health` | `sources.health.read` (lead, auditor, admin) | `{ correlationId, checkedAt, sources: SourceHealthView[] }` |

`SourceHealthView`:

| Campo | Contenido |
| --- | --- |
| `sourceId`, `dataset`, `displayName`, `enabled` | Identidad de la fuente y si la ingesta está habilitada |
| `state` | `unknown \| healthy \| degraded \| failed \| disabled` |
| `reason` | `DISABLED \| NO_OBSERVATIONS \| PERMANENT_ERROR \| NO_RECENT_SUCCESS \| CONSECUTIVE_FAILURES \| NEVER_SUCCEEDED \| RECENT_SUCCESS` |
| `lastAttemptAt`, `lastSuccessAt`, `lastEventAt` | Instantes; `null` = «Sin dato» |
| `consecutiveFailures`, `lastErrorClass` | Fallos seguidos y código neutral del último error (`null` si la última pasada fue bien) |
| `policy` | `{ intervalMs, degradeAfterMs, failAfterMs }`: la UI puede explicar el umbral |
| `subscriptions` | `{ measuredAt, windowHours, items: [{ stream, lastEventAt, eventsInWindow }] }` o `null` si todavía no hubo medición. Actividad por suscripción de Office 365 en 24 h; se mide como máximo cada 5 min. Es informativa: un stream callado (`eventsInWindow = 0`) puede ser normal y no decide el estado. `lastEventAt: null` = nunca tuvo eventos |
| `transitions[]` | Últimas 20 transiciones, cada una `{ id, fromState, toState, reason, at }` |

- El estado se evalúa al leer, con la hora actual: una ingesta detenida se ve degradada o
  caída sin esperar una escritura.
- `unknown` y `disabled` nunca van en verde. Un éxito con cero filas es salud
  (`lastSuccessAt`), no actividad (`lastEventAt`).
- Las transiciones también llegan por `GET /api/changes` como recurso `source` (con
  `sources.health.read`).

## Padrón del grupo de admisión · `/api/admin/users` (Sprint 5 · fase 3)

| Método | Ruta | Capability | Respuesta |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | `users.read` (admin) | `{ correlationId, sync, items: UserView[], totalCount }` |
| GET | `/api/admin/users/:oid` | `users.read` | `{ correlationId, user: UserView, sessions: [{ ref, current, state, createdAt, lastSeenAt, revocationReason, amr, revision }] }` |

`sync`: `{ mode: 'disabled' | 'graph', status: 'never' | 'ok' | 'failed' | null, lastAttemptAt,
lastSuccessAt, lastErrorClass, stale }`.
- Si `lastErrorClass` es `DIRECTORY_FORBIDDEN`, falta el consentimiento de Graph: la UI lo dice así.
- `stale` significa que no hubo éxito en tres intervalos.

`UserView`:

| Campo | Contenido |
| --- | --- |
| `oid`, `displayName`, `upn`, `accountEnabled` | Datos del padrón. `accountEnabled: null` = no medido |
| `membership` | `member \| removed \| null`. `null`: persona declarada en el deploy o dueño que no es miembro |
| `isOwner` | Dueño del grupo |
| `roles[]` | Rol efectivo |
| `roleOrigin` | `group_owner \| deploy_binding \| entra_app_role \| none`; `none` = «Sin acceso asignado» |
| `lastSeenAt` | Última solicitud autenticada en QAPAQ; no indica presencia en pantalla |
| `activeSessions` | Sesiones activas en QAPAQ |

- Con la sincronización deshabilitada no hay padrón. Solo aparecen las identidades declaradas en
  el deploy (dueños y asignaciones), sin nombre: no se inventa nadie.
- Las sesiones se asocian por UPN (la sesión guarda `preferred_username`). Para revocar se usa
  `POST /api/admin/sessions/:ref/revoke`.
- Reglas de rol del producto: el dueño del grupo es administrador; la persona analista tiene una
  asignación del deploy; el resto de los miembros queda «Sin acceso asignado».
- Pérdida de acceso: en cada ciclo de sincronización, toda baja del padrón pierde sus sesiones
  activas (motivo `membership_removed`), y un dueño que deja de serlo pierde las suyas
  (`ownership_removed`), salvo que siga declarado como dueño en el deploy. Queda un AuditEvent
  `access.session.revoked` por cada sesión. Las sesiones abiertas antes de este cambio no traen
  OID y vencen por su tope absoluto.

### Consulta textual `q` (gramática `qapaq-events-v1`)

`GET /api/events?q=<consulta>` es una alternativa a los filtros tipados; produce exactamente los
mismos filtros.

```text
severity:high,critical AND category:authentication AND outcome:failure
```

- **Campos:**
  - `severity`: `informational | low | medium | high | critical`;
  - `category`: catálogo del contrato salvo `unclassified`;
  - `outcome`: `success | failure`, un solo valor.
- **Forma:** un predicado por campo, unidos solo con `AND`. Los valores van separados por coma
  y significan «cualquiera de». No distingue mayúsculas.
- **Límites:** 512 caracteres, 3 predicados, 16 valores por campo, 128 tokens. Solo ASCII
  imprimible.
- **Rechazado con posición:** `OR`, `NOT`, paréntesis, comillas, comodines, regex, `=`, `;`,
  `|`, funciones, comentarios, texto libre, campos del proveedor (`rule.level`, `data.*`) y
  palabras clave SQL.
- **Exclusión:** `q` con `severity`, `category` u `outcome` en la misma petición → 422 sobre
  esos cuatro campos. No hay precedencia silenciosa.
- **Errores:**
  - sintaxis → 422 `VALIDATION_FAILED` con `fields: ["q"]`, sin repetir la consulta;
  - categoría válida en la gramática que la fuente no puede filtrar (p. ej. `threat`) → 422
    sobre `q`.
- **Detalle en la UI:** usar el mismo parser de `@qapaq/contracts` (`parseEventsQuery`). Da
  `{ code, position, expected[] }` para marcar el error en línea. `formatEventsQuery(filters)`
  sincroniza el editor con los filtros visuales.
- **Respuesta:** `query: { grammar: "qapaq-events-v1", canonical }` con la forma canónica. El
  cursor queda ligado a los filtros resultantes: cambiar la consulta lo invalida.
- **Privacidad:** el API no registra peticiones (Fastify sin logger), KrakenD no tiene access
  log, el borde nginx no registra query string (C-12) y el ALB no tiene access logs. En el
  navegador, no persistir `q` en la URL ni en el historial.

## Avisos del SOC: Teams por rol, correo de respaldo y dispositivo (Sprint 5)

**Política de la organización** (`modules/soar/src/notification-routing.ts`):

| Evento | Roles avisados |
| --- | --- |
| Alerta P1 creada | analista, lead |
| Alerta P1 escalada | lead, admin |
| Incidente crítico abierto | lead, admin |

- **Teams:** una tarjeta en el canal del SOC con **@mención** de cada destinatario. Los correos
  salen del padrón del grupo y su rol efectivo; «sin acceso asignado» no recibe nada.
- **Correo de respaldo:** si Teams no confirma la entrega, el mismo aviso va por correo a los
  mismos destinatarios. Si tampoco sale, queda en la bandeja de la consola, que exige acuse.
- **Dispositivo (Web Push):** cada persona activa sus dispositivos. El push no lleva contenido:
  el service worker pide el detalle a `GET /api/me/push/pending` con la sesión.

### `/api/me/push` (`notifications.read`: analista, lead, admin)

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/api/me/push/config` | `{ enabled, vapidPublicKey, maximumDevices }` para `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` |
| GET | `/api/me/push/subscriptions` | Mis dispositivos: `{ id, label, service, createdAt, lastSuccessAt }` (sin endpoint ni claves) |
| POST | `/api/me/push/subscriptions` | `{ endpoint, keys: { p256dh, auth }, label }` con CSRF. Solo endpoints de servicios de push conocidos (422 `endpoint`); máximo 10 dispositivos (409) |
| POST | `/api/me/push/subscriptions/:id/revoke` | Quitar un dispositivo propio (CSRF) |
| POST | `/api/me/push/test` | Aviso de prueba a mis dispositivos (CSRF) → `{ delivered }` |
| GET | `/api/me/push/pending` | Lo que el service worker muestra: `items[{ type, id, title, severity, at, url }]` (P1 abiertas e incidentes críticos de los últimos 30 min que la sesión puede ver) |

Reglas de UX, como en los SOC de referencia:
- el permiso del navegador se pide **solo** al pulsar «Activar en este dispositivo», nunca al
  cargar la página;
- con `enabled: false` se muestra «Avisos al dispositivo no disponibles en este ambiente»;
- en iOS, Web Push funciona solo con la consola instalada en la pantalla de inicio
  (Safari 16.4 o superior); la UI debe explicarlo en ese caso.
