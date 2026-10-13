# Plan Sprint 5 — ingesta Wazuh, eventos, salud de fuentes, usuarios Entra y trabajo de incidente

Estado: **aprobado para implementación; en curso**. Fecha: 2026-10-12. Responsable backend:
Claude. Responsable web: Codex, con imágenes de las vistas finales revisadas **antes** de
escribir React (ver §7).

Este plan convierte en entregas los diseños ya aceptados:

- [events-read-through.md](../architecture/events-read-through.md) (eventos);
- [source-health.md](../architecture/source-health.md) (salud por fuente);
- [entra-soc-user-admin.md](../architecture/entra-soc-user-admin.md) (usuarios Entra);
- [incidentes-investigacion.md](../frontend-design/incidentes-investigacion.md) (tareas y notas).

Cada fase dice qué se construye, qué queda fuera, cómo se prueba y qué gate humano necesita.
Nada se presenta como operativo sin evidencia (ADR-024).

## 1. Hallazgo que reordena el trabajo

La revisión de faltantes encontró que **en AWS no hay ningún camino de Wazuh a las alertas
del SOC**:

- `POST /api/ingest/security-events` solo responde con identidad local (E2E);
- el worker es un proceso sin trabajo;
- KrakenD no publica `/wazuh/*` porque `WAZUH_INDEXER_URL` no está definido en el demo;
- el cliente del gateway espera un token de workload estático que nadie emite.

Sin esto, las alertas de Microsoft 365 llegan al Indexer de Wazuh pero nunca al SOC. Además,
el explorador de eventos y la salud de fuentes leen del mismo proveedor. Por eso la
**fase 0 es la ingesta** y va primero.

## 2. Decisiones

| ID | Decisión | Motivo |
| --- | --- | --- |
| S5-D1 | La ingesta corre **dentro del proceso API** como un bucle con lease en PostgreSQL, igual que el despachador de notificaciones. El worker sigue sin trabajo hasta que exista una razón para separarlo. | La promoción (correlación, priorización, outbox) vive en el runtime del API. Llevarla al worker obligaría a duplicarla o a abrir una ruta de servicio interna. El lease con fencing hace seguro tener varias réplicas. |
| S5-D2 | El API obtiene el token de workload para KrakenD con **client credentials de Entra** sobre su propio app registration (`<OIDC_AUDIENCE>/.default`), con caché hasta 60 s antes de su vencimiento. | KrakenD ya valida JWT de Entra con ese issuer y esa audiencia. No agrega secretos nuevos: usa el client secret que el API ya tiene. |
| S5-D3 | El Indexer se lee con un usuario interno de **solo lectura** (`qapaq_reader`, rol con `read` sobre `wazuh-alerts-*`). Lo crea un workflow por SSM y su Basic auth vive en Secrets Manager y solo llega a KrakenD. | Mínimo privilegio. El API nunca ve credenciales del Indexer. |
| S5-D4 | La ingesta y la salud de fuentes comparten la **observación de poll**: cada pasada registra intento, resultado, filas vistas y error normalizado. | Es la única señal verificable de un poll exitoso vacío (source-health §«Decisión aceptada»): QAPAQ sí consultó el Indexer y obtuvo cero filas. |
| S5-D5 | `GET /api/events` es una **lectura directa** (read-through) del Indexer con filtros compilados por código. No guarda copia ni acepta DSL del navegador. | Wazuh sigue siendo el dueño de la telemetría (source-health §Propósito). |
| S5-D6 | Usuarios Entra v1 = **padrón de solo lectura** del grupo `QAPAQ-SecOps-Users`, más presencia y sesiones por persona. Los cambios de rol con aprobación SoD quedan para v2. | Los roles siguen siendo app roles de Entra. Persistir grants exige migrar autorización (entra-soc-user-admin §Identidad), y no se hace a medias. |
| S5-D7 | El padrón usa **delta query** de Graph para miembros, con `deltaLink` persistido y sincronización completa ante un 410; los dueños se releen completos en cada ciclo. Lease por tenant. | Corrige la decisión inicial de resincronización completa para alinearse con la guía del repositorio (estado delta persistido, páginas parciales, 429). Detalle en [diseno-backend-sprint5](diseno-backend-sprint5.md) §2.5. |
| S5-D8 | Tareas y notas cuelgan del **incidente** (no se crea `Case`). Las notas son append-only; una corrección es una nota nueva que referencia la anterior. | Cierra U-008 para el MVP con el menor cambio de modelo, y deja auditoría sin ediciones silenciosas. |
| S5-D9 | Cerrar un incidente exige que todas las **tareas obligatorias** estén `done` o `cancelled`. Cancelar una obligatoria requiere motivo. | El cierre del caso tiene que reflejar el trabajo comprometido (patrón TheHive). |

## 2.1 Requisito transversal: datos en vivo (S5-D10)

El producto pide que los datos nuevos aparezcan sin refrescar y con una animación suave.

| ID | Decisión | Motivo |
| --- | --- | --- |
| S5-D10 | Feed de cambios por **long-poll**: `GET /api/changes?after=<cursor>`. El servidor retiene la petición hasta ~2,5 s y responde en cuanto hay cambios. La fuente es la cadena de auditoría, con secuencia por tenant. | KrakenD CE corta toda respuesta al `GATEWAY_ENDPOINT_TIMEOUT` (4 s): ni SSE ni WebSocket sobreviven al gateway. Long-poll da latencia menor a 1 s, funciona con varias réplicas porque lee de PostgreSQL y no requiere infraestructura nueva. |

**Contrato:**
- respuesta: `{ cursor, changes: [{ seq, resource: { type, id }, kind, at }], resync }`;
- `kind` vale `created`, `updated` o `removed`;
- el feed lleva solo **qué cambió**, nunca el contenido ni el actor. Cada tipo se filtra por la capability de lectura del recurso:
  - `alert` → `alerts.read`;
  - `incident`, `incident_task` e `incident_note` → `incidents.read`;
  - `notification` → `notifications.read`;
  - `session` → `sessions.read`;
- sin `after`, devuelve el cursor actual (punto de partida);
- si el cliente quedó muy atrás (más de 500 cambios), responde `resync: true` y la UI recarga la vista una vez.

**Web:**
- recarga solo el recurso afectado;
- inserta las filas nuevas con una transición de entrada (opacidad y desplazamiento, ~200 ms) y resalta brevemente las actualizadas;
- respeta `prefers-reduced-motion`;
- pausa el long-poll con la pestaña oculta y lo reanuda al volver.

Reemplaza el polling de 60 s de las vistas actuales.

## 3. Fase 0 — ingesta Wazuh → SOC en AWS

**Estado: código TERMINADO; activación pendiente en AWS** ([sprint5-activacion](../deployment/sprint5-activacion.md)). Pruebas: pasada 6/6 y extremo a extremo con el runtime; cursor en PostgreSQL; token de workload; acceso a Wazuh probado contra OpenSearch 3.7, la API de Wazuh 4.14.7 y nginx.

**Construye:**

1. **`WorkloadTokenProvider`** (port + adapter de Entra client credentials), con caché y sin
   registrar el token nunca.
2. **`IngestionPoller`** en `apps/api/src/runtime`:
   - bucle cada `QAPAQ_INGESTION_INTERVAL` (60 s por defecto);
   - toma el lease del cursor `(tenant, source, dataset)`;
   - lee la ventana `[watermark − solape, ahora − retraso]` con `SecurityEventProvider.readPage`, página a página hasta `QAPAQ_INGESTION_MAX_PAGES`;
   - normaliza con `normalizeWazuhAlert` y llama a `promoteEvent` (ya idempotente por evento);
   - avanza el watermark solo cuando terminó la página;
   - registra la observación de poll.
3. **Persistencia** (migración C-19):
   - `soc_ingestion_cursors` (watermark, lease, `claim_id`, revisión);
   - `source_poll_observations` (idempotente por `observation_id`, retención de 1 año).
   - Hay versión en memoria para dev/test.
4. **Configuración**:
   - `QAPAQ_INGESTION_SOURCE = disabled | wazuh` (por defecto `disabled`, explícito en producción);
   - con `wazuh` son obligatorios `QAPAQ_WAZUH_GATEWAY_BASE_URL`, la clave de firma de cursor y el `sourceId`.
5. **Infra**:
   - KrakenD recibe `WAZUH_INDEXER_URL` (IP privada del Wazuh, puerto 9200), `WAZUH_INDEX_PATTERN=wazuh-alerts-4.x-*`, `WAZUH_BASIC_AUTH_B64` (secreto) y la CA del Indexer;
   - el API recibe las variables de ingesta;
   - workflow `configure-wazuh-indexer-reader.yml` (crea o rota `qapaq_reader` por SSM y publica la CA del Indexer).

**Fuera:** la custodia de crudos en MinIO (C-04 sigue siendo la ruta del worker) y el replay histórico.

**Pruebas:**
- unidades del poller (ventana, solape, watermark, error a mitad de página, lease vencido, segunda réplica);
- contrato del proveedor contra un gateway falso (ya existe);
- integración PostgreSQL del cursor y las observaciones;
- smoke contra el Wazuh 4.14.7 local con un documento sintético que termina como alerta SOC.

**Gate humano:** dispatch del workflow del lector del Indexer y `apply`. En Entra, el app
registration debe exponer un Application ID URI y emitir tokens v2 para client credentials;
se verifica con `az` antes de activar.

## 4. Fase 1 — `GET /api/events`

**Estado: TERMINADA (código).** Compilador de filtros, proveedor con orden y cursor ligado a filtros, BFF y gateway. Falta la evidencia contra el Indexer del demo.

**Construye:**

- extensión de `EventQuery` con `filters` (severidad, categoría, outcome), compilados por el adapter a `bool.filter` según la tabla versionada de `wazuh-normalization.ts`;
- cursor firmado que incluye el hash de los filtros;
- endpoint `GET /api/events?from&to&severity&category&outcome&cursor&pageSize` (`events.read`):
  - responde `SecurityEvent` normalizados; `raw` solo con `events.read_raw`;
  - rango máximo efectivo de 31 días; página de 50 por defecto y 200 como máximo;
  - si la fuente está deshabilitada, `RESOURCE_UNAVAILABLE` sin datos simulados;
- ruta en KrakenD (allowlist de query) y en el contract test.

**Pruebas:** DSL exacto por filtro, multiselección de severidad por bandas, cursor
alterado o con otros filtros rechazado, redacción de `raw` por rol, errores sin DSL, host
ni índice.

## 5. Fase 2 — salud por fuente

**Estado: TERMINADA (código).** Reducer, bitácora append-only, endpoint y anuncio por el feed. La actividad por suscripción de Office 365 se mide al terminar las pasadas, como máximo cada 5 min, con una agregación acotada y persistida.

**Construye:**

- dominio determinista `evaluateSourceHealth(observations, policy, now)` en `modules/telemetry`, con estados `unknown | healthy | degraded | failed | disabled` (umbrales: degradado tras 2 intervalos sin éxito, fallo tras 3, por fuente);
- tabla `source_health_transitions` (append-only), escrita solo al cambiar de estado;
- actividad por suscripción de Office 365: una consulta acotada (máximo de `timestamp` por `data.office365.Subscription`, tamaño fijo de 10) en la misma pasada del poller, informativa, que nunca pone una fuente en verde por sí sola;
- endpoint `GET /api/sources/health` con capability nueva `sources.health.read` (lead, auditor, admin). Devuelve por fuente y dataset estado, razón, `lastAttemptAt`, `lastSuccessAt`, `lastEventAt`, fallos consecutivos, actividad por suscripción y las últimas transiciones;
- `operations/health` incorpora el peor estado de fuente.

**Fuera:** incidente operativo automático por fuente caída y acknowledge o mantenimiento
(v2; necesitan cola propia).

**Pruebas:** éxito con cero filas (sí avanza `lastSuccessAt`, no avanza `lastEventAt`),
error y reintento, umbrales, recuperación, idempotencia de la observación, aislamiento por
tenant.

## 6. Fase 3 — usuarios Entra (padrón v1)

**Estado: código TERMINADO; activación sujeta al consentimiento de Graph.** Delta persistido, adapter de Graph, store en memoria y en PostgreSQL, `/api/admin/users`, dueños como admin. Además se agregaron asignaciones del deploy (`QAPAQ_ROLE_BINDINGS`) y dueños declarados (`QAPAQ_GROUP_OWNER_OIDS`). La sesión guarda el OID de Entra: las bajas del grupo y los ex dueños pierden sus sesiones en el ciclo siguiente.

**Construye:**

- port `DirectoryReader` con adapter Graph (client credentials, `GET /groups/{id}/transitiveMembers/microsoft.graph.user` con `$select=id,displayName,userPrincipalName,accountEnabled`, paginación `@odata.nextLink`, `Retry-After`);
- `DirectorySync` con lease cada 15 min:
  - reemplaza el padrón del tenant solo si la lectura terminó completa (una página parcial nunca borra miembros);
  - quien sale del grupo pasa a `pending_removal` y sus sesiones QAPAQ se revocan;
- tablas `directory_members` y `directory_sync_state`;
- endpoints con capability `users.read` (admin):
  - `GET /api/admin/users?q&status&cursor&pageSize`;
  - `GET /api/admin/users/{oid}`;
  - `GET /api/admin/users/{oid}/sessions`;
  - presencia derivada de sesiones (umbral de 5 min configurable).
  - Revocar sigue en `POST /api/admin/sessions/{ref}/revoke`;
- configuración `QAPAQ_DIRECTORY_SYNC = disabled | graph` y `QAPAQ_DIRECTORY_GROUP_ID`. Deshabilitado, la lista responde `DEPENDENCY_UNAVAILABLE` con `syncStatus: disabled`, sin padrón inventado.

**Fuera (v2):** solicitudes y aprobación de rol, suspensión y grants persistidos.

**Pruebas:** paginación, 429 con `Retry-After`, lectura parcial que no borra, miembro que
sale, aislamiento por tenant, que nunca se registre ni exponga el token, enumeración (un
`oid` fuera del grupo da `RESOURCE_UNAVAILABLE`).

**Gate humano:** permiso de aplicación de Graph `GroupMember.Read.All` (más `User.Read.All`
si `accountEnabled` lo exige; se confirma en el tenant sandbox) con consentimiento de
administrador, y el object ID del grupo.

## 7. Fase 4 — tareas y notas de incidente

**Estado: TERMINADA (2026-10-12).** Dominio, memoria, PostgreSQL (migración
`20261013120000_s5_incident_work`), endpoints, gateway y documentación en
[01-inventario-backend §1.4.1](../frontend-design/01-inventario-backend.md). Pruebas:

- 11 unitarias de dominio y caso de uso;
- 3 BFF;
- integración PostgreSQL de compare-and-set, cierre bloqueado y append-only por trigger;
- roles: el runtime no puede editar notas.

Durante la fase apareció un bug latente: repetir `bootstrap-roles` volvía a dar UPDATE sobre
las tablas append-only. Se corrigió en `roles.sql`.

**Construye:**

- dominio en `modules/soc`:
  - `IncidentTask` (`open | in_progress | done | cancelled`, `required`, responsable, vencimiento, revisión);
  - `IncidentNote` (append-only, `correctsNoteId`).
  - Comandos: `start`, `complete`, `reopen`, `cancel` (motivo obligatorio si es obligatoria), `assign`;
- regla de cierre S5-D9 (`REQUIRED_TASKS_OPEN`);
- tablas `incident_tasks` e `incident_notes` (migración C-19). El runtime no puede borrar ni actualizar notas;
- capabilities nuevas: `incidents.tasks.write` y `incidents.notes.write` (analista, lead, admin). La lectura usa `incidents.read`;
- endpoints:
  - `GET` y `POST /api/incidents/{id}/tasks`;
  - `POST /api/incidents/{id}/tasks/{taskId}/commands`;
  - `GET` y `POST /api/incidents/{id}/notes`.
  - CSRF y `expectedRevision` en mutaciones, auditoría en cada cambio y paginación con cursor;
- timeline: `GET /api/incidents/{id}/timeline`, que une auditoría del incidente, tareas, notas y alertas vinculadas en orden estable y declara el tipo y la fuente de tiempo de cada entrada.

**Pruebas:** transiciones válidas e inválidas, cierre bloqueado por obligatoria abierta,
nota inmutable, deny por capability y tenant, CSRF, conflicto de revisión.

## 8. Web (Codex) — imágenes primero

Para cada vista Codex entrega primero una imagen de la vista final en
`docs/frontend-design/references/` (escritorio y móvil), basada **solo** en los contratos de
este plan. Claude revisa contra contrato y capabilities, y solo entonces Codex escribe
React. Vistas:

1. `/events`: explorador con rango, filtros, tabla, detalle y crudo condicionado;
2. `/sources`: salud por fuente, con estados, razones, tiempos y suscripciones;
3. `/admin/users`: padrón, presencia, sesiones y estado de sincronización;
4. `/incidents/:id`: pestañas Tareas, Bitácora y Timeline, y guardia de cierre.

Regla común: los estados desconocidos o sin dato se muestran como tales, nunca en verde
por omisión.

## 9. Orden y criterio de terminado

1. Fase 4: sin dependencias externas; da valor inmediato al demo.
2. Fase 0, y en paralelo la infra de la fase 0.
3. Fase 1.
4. Fase 2.
5. Fase 3: el código queda listo y la activación espera el consentimiento.

Una fase está terminada cuando tiene:

- typecheck, lint y formato limpios, y pruebas unitarias e integración PG verdes;
- ruta en el gateway y contract test;
- documentación actualizada (inventario backend, checklist de release);
- registro en `COORDINACION-CLAUDE-CODEX.md`.

Las fases con dependencia externa se declaran «listas para activar», no «operativas»,
hasta tener evidencia en AWS.
