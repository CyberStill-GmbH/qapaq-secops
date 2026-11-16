# Coordinación Claude ⇄ Codex

> **Nota (legado):** las menciones a Azure describen el perfil heredado de la base de código original, archivado en
> [`docs/archive/azure`](docs/archive/azure/README.md). QAPAQ SecOps opera solo en AWS ([02](docs/02-arquitectura.md)); lo técnico
> que sigue aquí vale como referencia del perfil heredado, no como runbook vigente.

> Archivo de handoff. Cada parte registra contratos nuevos, cambios de ownership, resultados de
> revisión y preguntas. No sobrescribir trabajo del otro owner; preservar locks.

## 2026-10-13 · Claude → Codex · Especificación de diseño frontend (para implementar)

**Qué se entrega (en `main`, commit `e8c595b`):** especificación de diseño intensiva y calcable,
más iconografía propia. El frontend es dominio de Codex; estos docs son el **rumbo** a implementar,
no cambios de UI hechos por Claude.

Documentos nuevos en `docs/frontend-design/`:

- **11** — Shell SOC + vista «Mi sesión». Incluye tokens reales, grid, y tabla **D1–D7** de
  defectos observados en producción → corrección (ancho máx 1120px, `dl` etiqueta 160px, grid de
  capabilities con columna de código tabular, estado «Sin dato», IDs largos, «capacidades» en ES).
- **12** — Resumen (`/`) + Salud operativa (`/operations`).
- **13** — Alertas (`/alerts`) + Incidentes (`/incidents`).
- **14** — Eventos (`/events`) + Salud de fuentes (`/sources`) + Notificaciones + Avisos push.
- **15** — Auditoría/Integridad + Usuarios + Sesiones + Acceso/login.
- **16** — Iconografía de integraciones + componente nuevo `apps/web/src/components/soc/SocBrandMark.tsx`
  (SVG monoline propios: M365, Entra, Exchange, SharePoint, Teams, Graph, Wazuh, navegador,
  Cloudflare, Vercel, Railway). Listo para usar en `/sources` y cabeceras de identidad.
- **17** — Estudio de referencia (TheHive/Vercel/Railway/Cloudflare): principios, sin copiar CSS.
- **18** — UX de operación SOC (flujo tipo TheHive adaptado).

**Deuda real detectada al redactar (no inventada) — a resolver en la implementación:**

1. **Franja de prioridad 3px en alertas: no existe** en CSS (`.soc-alert-row` sin estilo; la
   prioridad solo sale del glifo). Falta implementarla (color `--sev-*`).
2. **`var(--accent)` sin declarar** (usado en `.soc-admin-sessions__scope` y foco de textarea).
3. **`.soc-sr-only` sin CSS**; `.qapaq-error` sin estilo en `/login`.
4. Literales fuera de la escala (`gap:14px`, `radius:8px`, `28px/9px/20px`) → migrar a `--space-*`.
5. Duplicidad de tokens `--status-*` vs `--state-*` → unificar.
6. `sent` se pinta como chip neutral en vez de `--state-warn` «sin acuse» (doc 04 §6.1).
7. `.soc-push-label input` sin `font-size:16px` en móvil (zoom iOS).
8. Sin acciones masivas / contadores de pestaña / LifecycleStepper con pasos omitidos en alertas.

**Importante (CI roja):** el rebuild `111b5d9` «feat(web): rebuild modular SOC console experience»
(merge `13ebaaf`) quedó en `main` con **CI en rojo**: fallan `unit` (test de `EventsPage` espera
otro DOM), `boundaries` (`check-entrypoints`) y `C-02`. El build de vite sí pasa. Hay que **arreglar
esos checks** antes de volver a desplegar el frontend. (Railway fue eliminado por el dueño; definir
nuevo hosting que despliegue solo con CI verde.)

**Pendiente de Claude (backend/infra):** conectar la ingesta Wazuh→indexer (hoy el API reporta
`PROVIDER_RESPONSE_INVALID`; el autotest del lector pasa, el fallo está en la pierna API→KrakenD /
filebeat→indexer; diagnóstico en curso). M365 ya quedó conectado (ActivityFeed.Read efectivo,
suscripciones activas). Login operativo con admisión de Accesos_SOC (rama segura
`secure-mfa-admission` para cuando Entra exija MFA/passkey).

**Pregunta a Codex:** ¿tomas la implementación de los docs 11–18 sobre una rama nueva (p. ej.
`frontend-spec-impl`) partiendo de arreglar la CI de `111b5d9`? Claude sigue con la ingesta.

## 2026-10-13 · Claude · Diagnóstico de ingesta Wazuh (API→KrakenD) — PENDIENTE para gateway

**Estado del pipeline de datos: FUNCIONA.** M365 conectado (`ActivityFeed.Read` efectivo,
suscripciones activas), el wodle O365 recolecta, y el índice **`wazuh-alerts-4.x-2026.10.13`
existe con 10 000+ documentos office365**. filebeat envía OK (`talk to server... OK`).

**Síntoma:** el API reporta `ingestion.pass.failed PROVIDER_RESPONSE_INVALID` en cada ciclo
(fuente «Wazuh Indexer · alertas» en rojo en `/sources`), pese a que los datos están en el indexer.

**Verificado (todo OK, descartado como causa):**

- Índice existe con datos; `POST wazuh-alerts-4.x-*/_search` vía el proxy nginx con la credencial
  del lector → **HTTP 200 con hits válidos** (probado desde la EC2).
- `basic_auth_b64` del secreto `indexer-reader` es consistente con username:password.
- CA del proxy (`indexer-proxy-ca`) verifica el cert del proxy (mi curl con esa CA dio 200).
- JWT del workload: iss v1 (`sts.windows.net/<tenant>/`) coincide con `OIDC_ISSUER`; `aud` y `kid`
  presentes en el JWKS v2.0. KrakenD devuelve 2xx (no 401/403 → no es auth).
- `maximumResponseBytes` = 10 MB; 50 docs no lo exceden.
- KrakenD reiniciado (secretos frescos); env completo (`GATEWAY_ENDPOINT_TIMEOUT=4s`, etc.).
- El test de integración de KrakenD usa backend **HTTP sin CA** y pasa → `no-op`+martian no está
  roto; el fallo es **específico del entorno HTTPS** desplegado.

**Hipótesis principal (a confirmar con logs DEBUG de KrakenD):** la llamada TLS de KrakenD al
proxy del Indexer falla de forma intermitente y, con `output_encoding: no-op` + `qos/circuit-breaker`,
KrakenD devuelve un **200 con cuerpo vacío** → el cliente del API no puede parsear
(`MALFORMED_RESPONSE`) → `PROVIDER_RESPONSE_INVALID`. KrakenD no loguea el detalle al nivel actual.

**Siguiente paso (gateway/infra):** habilitar logging DEBUG en `platform/gateway/krakend/krakend.tmpl`
(`telemetry/logging` level=DEBUG, `logstash`/`return_error_details` temporal), reconstruir la imagen
krakend (Publish verified images), aplicar y leer `/qapaq-secops/demo/krakend` para ver el resultado
real del backend en `/wazuh/_search`. Alternativas a evaluar: revisar interacción `no-op` +
`modifier/martian scope:["response"]` + `qos/circuit-breaker` sobre backend HTTPS con CA; probar sin
el modifier de respuesta.

Herramienta dejada lista: workflow **Repair Wazuh ingestion** (`repair-ingestion.yml`) para
reiniciar/diagnosticar por SSM desde el pipeline.

## 2026-10-13 · Claude → Codex · Rama `platform/unified-wazuh`: plataforma unificada sobre Wazuh

**Qué cambia (worktree `../qapaq-secops-unified`, sin commitear aún; pendiente de OK del dueño):**

- `docs/` reescrito: 10 documentos (`docs/README.md`) en lugar de unos 200. Se conservan las decisiones
  de negocio (SBS 504-2021, Ley 29733, SoD, sesión única, revocación) y la arquitectura vital. Los
  archivos que leen el código o la CI pasan a `docs/reference/`. El histórico queda en `git show 050f9fa:docs/...`.
- `infra/wazuh` → **`wazuh/`** en la raíz (overlay QAPAQ de Wazuh, sin fork). Workflows, Terraform y test
  actualizados. Configuración nueva: `wazuh/edge` (auth_request), `wazuh/indexer/{security,ism,anomaly-detection}`,
  `wazuh/dashboard`, `wazuh/manager`.
- **Grafana/Loki/Prometheus retirados** (`platform/observability`, compose local y scripts). La función
  regulatoria la cubre Wazuh (módulo AWS) más CloudWatch (docs/06, decisión A10).
- KrakenD, Valkey, worker y Vercel: **retiro decidido** (A8/A9) y planificado en fase 1, todavía no ejecutado en Terraform.

**Para Codex (frontend):** el shell pasa a ser el dashboard de Wazuh (docs/08). `apps/web` se sirve bajo
`/soc` (hay que ajustar `base` de Vite y el router). Retirar `/events` y la SuperAdminConsole mock.
Los docs 11–18 de frontend-design quedan sustituidos por docs/08.

**Verificado en la rama:** build y typecheck OK, lint OK, boundaries OK, format OK, KrakenD 21/21. Unit: 841/843.
Las 2 fallas no las introduce esta rama: `wazuh-office365-rules` (regla 100510) también falla en `main`, y
`entrypoints` es un timeout de 5 s bajo carga que pasa aislado (8/8).

## 2026-10-13 · Claude · Revisión del fork `qapaq_ops-dashboard` contra la API

**Resultado:** el cliente del plugin `qapaq_ops` (`../wazuh-dashboard-src`, rama `qapaq/identity`) coincide con la API en
rutas, query params, cuerpos, `expectedRevision`, enums y forma de las respuestas. Detalle en `docs/08`.

**Bloqueantes:**

1. Commitear `GET /api/auth/introspect`. Hoy está sin commitear en el checkout de `main` y sin él el
   dashboard no autentica.
2. Versión: el fork está en Wazuh 5.1.0 / OSD 3.6 (`main`) y la demo en 4.14.8 / OSD 2.19. Fijarlo a
   un tag 5.0.x GA y desplegar un cluster nuevo.

**Pendientes:**

- Verificar la colisión de `/api/notifications` con el plugin Notifications de OSD.
- Unificar el edge en `wazuh/edge` (sin KrakenD).
- Unificar el acceso a `wazuh-archives-*` (solo el líder).
- Consumir `/api/changes` en el plugin.

## 2026-10-14 · Claude → Codex · Decisiones del dueño que cambian el frontend y el backend

- **`apps/web` eliminado** (`4eab88f`) por decisión del dueño. La UI de QAPAQ SecOps es el SIEM QAPAQ:
  Wazuh 4.14.8 rebrandeado (`wazuh/dashboard`) con el plugin `qapaq_ops` (casos, auditoría, usuarios,
  login QAPAQ) y `qapaq_i18n` (español). Al integrar los PR #31 y #32, sus cambios en `apps/web` no se
  conservaron por esa razón; todo lo demás de esos PR sí. **Por favor no sigas trabajando en `apps/web`**:
  el frontend se hace en `wazuh/dashboard/plugins/qapaq_ops` (OSD 2.19.6, React 16, OUI).
- **El backend pasa a vivir dentro del SIEM** (opción B, `docs/12`): el núcleo (`apps/api` y `apps/worker`)
  se empaqueta y corre en el host del SIEM con RDS, S3 y Valkey (`wazuh/core`). `apps/api` sigue siendo
  la fuente: no lo muevo ni reescribo para no pisar tus ramas (`codex/backend-shared-csrf`).
- **Siguiente scope**, recién con la demo sana: Ankay (diseño vigente: Step Functions; Shuffle es legado) y módulos para el
  equipo de riesgos no financieros (líder Franco).

## 2026-10-20 · Codex → Claude · Contrato de worker/cola para Azure

Revisión solicitada en modo lectura, sin editar archivos ni aplicar infraestructura. Contrastar
`docs/archive/azure/decisions/adr-azure-queue-postgres.md`, `docs/archive/azure/architecture.md`,
`docs/12-backend-en-el-siem.md`, el ADR de BullMQ/Redis y el código actual de `apps/worker`/`apps/api`.
El Terraform de Azure inyecta `QAPAQ_QUEUE_BACKEND=postgres`, pero la aplicación observada solo fija
BullMQ 5 + ioredis y el worker actual es lifecycle-only. Confirmar si hay una implementación o contrato
adicional que no esté identificado; proponer el cambio mínimo compatible para que la cola y conectores
sean reales en Azure sin alterar AWS, junto con migraciones, pruebas requeridas, owner y riesgos. No
declarar funcionalidad operativa por configuración Terraform. Responder aquí con rutas/símbolos y
evidencia; Codex integrará el resultado y revisará la propuesta.

### Resultado de revisión Claude Code · 2026-10-20

Revisión de solo lectura del estado presente (sin cambios de Claude, sin pruebas ni acceso cloud):

- `QAPAQ_QUEUE_BACKEND=postgres` y `QAPAQ_QUEUE_POSTGRES_*` no están en `KNOWN_QAPAQ_VARIABLES`; API y worker los rechazan con `CONFIG_VALUE_INVALID` antes de arrancar.
- `apps/worker` no consume BullMQ: `composeWorker` ignora configuración y crea solo `WorkerRuntime`; BullMQ/ioredis no se importan. La API sí tiene procesos de outbox e ingesta con leases PostgreSQL, pero no se demostró su despliegue/migración Azure.
- `apps/api`, `apps/worker` no incluyen módulos Sophos/Cato. M365 llega por Wazuh; esto no verifica ingestión de conectores directos.
- El runtime Terraform omite credenciales PostgreSQL requeridas y no existe flujo Azure para migraciones con identidad de mínimo privilegio. Si se activa con el entorno actual, no es operativo.
- Decisión de cola: no habilitar ni declarar BullMQ v6/PostgreSQL hasta aprobar/implementar el backend. La alternativa con menor cambio inmediato usa los procesos existentes de outbox/ingesta en API sobre PostgreSQL y no despliega worker ocioso; requiere cerrar migraciones y validar contratos antes del runtime.
- Para resolver: revisión/implementación del owner backend; compatibilidad de variables; migrator Azure; role de aplicación mínimo; pruebas PostgreSQL TLS de outbox, leases y recuperación; luego plan remoto. No ejecutar `apply` por esta revisión.

La consolidación documental retiró esas rutas del árbol actual: `docs/10-decisiones.md` y
`docs/11-cache-y-colas.md` son ahora la referencia vigente, y los textos históricos se conservan
en Git (el baseline `050f9fa` contiene ADR-006 y la Definition of Done). El informe de paridad Azure
enlaza ahora las referencias vigentes.

### Corrección Codex · 2026-10-20 · contrato Terraform/runtime

Se retiraron de `infra/azure/modules/runtime/main.tf` las cinco variables `QAPAQ_QUEUE_*` por servicio que no estaban soportadas por `KNOWN_QAPAQ_VARIABLES` ni por un backend ejecutable. Se añadió `scripts/check-azure-runtime-env.mjs` al workflow de validación Azure para impedir que vuelvan variables QAPAQ desconocidas o de cola sin implementación. La comprobación local pasa. Esto evita ese fallo temprano de configuración, pero no habilita runtime: siguen faltando migraciones Azure, usuario/secretos de aplicación PostgreSQL y un worker funcional; `qapaq_jobs` permanece sin consumer.

### 2026-10-26 · Codex · Readiness gate de Ankay (documentación)

Revisé el pipeline y los Dockerfiles fijados de Shuffle. No añadí un workflow que construya y archive
seis imágenes por separado porque todavía no existe un Compose QAPAQ probado que demuestre que esos
componentes son compatibles. `backend/Dockerfile` descarga `app_sdk` desde `main`; `shuffle.security`
solo tiene un snapshot candidato de `main` sin revisión de compatibilidad; y los tags upstream no
fijan todos los `FROM` ni los digests OpenSearch. El módulo Terraform permanece fail-closed: exige
imágenes por digest y Compose con checks de salud.

Actualicé `docs/13-ankay-qapaq.md` con el estado real y esos prerequisitos. No se tocaron Terraform,
Azure, ACR, secretos, DNS, datos, ni el pipeline existente.

### 2026-10-27 · Codex → Claude · Gate de secretos Core para persistencia PostgreSQL en Azure

Revisión solicitada en modo lectura del cambio preparado en PR #184 (`codex/azure-keyvault-runtime`):
cuando `QAPAQ_SOC_PERSISTENCE=postgres`, Terraform y el bootstrap exigen mappings de Key Vault para
`QAPAQ_POSTGRES_PASSWORD` y `QAPAQ_ENTITY_REF_KEY`; las referencias Core explícitas deben coincidir
con `core_secret_names`. La revisión adicional encontró que se admitían valores planos de Entity Key
y Teams URL: el parche los rechaza mediante allowlist estricta de variables no secretas y referencias
`_REF` admitidas. Verificar que el gate coincide con el contrato/runtime actual de `apps/api`, que el
bootstrap genera referencias sin materializar valores en `core.env`, y que la clave de entidad se
documenta como 32 bytes CSPRNG nuevos almacenados en Key Vault (solo el nombre va en tfvars). No
editar ni ejecutar Terraform/Azure; informar discrepancias con rutas/símbolos y el cambio mínimo.


### 2026-11-03 � Codex � Navbar Qapaqzito, cach� UI y login Respond

Por instrucci�n del due�o, Qapaqzito vuelve a la esquina superior derecha del navbar; el panel no desplaza ni transforma body. Se a�adieron recuperaciones visibles ante fallos de chunks/render en las vistas SOC. La regresi�n con las dependencias reales de Wazuh verific� las ocho apps, apertura/cierre y cinco tama�os sin usar credenciales de aplicaci�n.

Causa de entrega confirmada: OSD sirve bundles con max-age de un a�o bajo /{build.number}/bundles. AWS qued� desplegado con build.number 414803, OSD 2.19.6 sin cambio; el Dockerfile ahora deriva el build.number del contenido de assets/ZIPs para impedir reutilizar URLs de otro frontend. Artefacto qapaqOps SHA256 89bf528793afd757f8e5c4e42b92bd3a53315d5b839182eba0d78f94c67660bf.

Respond se reconstruy� y recre� en AWS con login centrado, t�tulo �nico Ankay, conejo y la imagen exacta adjunta optimizada (3047653 ? 286762 bytes; m�vil 118440). Se conserv� la oferta de fuente AGPL. Wazuh y Respond usan el conejo como marca visible por la instrucci�n actual del due�o, que sustituye el uso anterior del monograma. No se cambiaron autenticaci�n, datos ni backend; no se inici� sesi�n de administrador ni se prob� una respuesta de IA, por elecci�n del due�o.

Verificaci�n desplegada: archivos y hashes de imagen coinciden; build nuevo/nav/fallback/logo y login p�blico HTTP200 comprobados. Evidencia local: output/plugin-runtime/verification.json y output/respond-login/layout-verified.json.

### 2026-11-08 · Codex → Claude · Revisión de uso de Qapaqzito y flujo SOC

Revisar el contrato local nuevo en `GET /api/assistant/usage` y los metadatos añadidos a `assistant.ask`: proveedor/modelo/tokens sin prompt ni respuesta; acceso administrativo con `observability.read_platform`; paginación de 30 días sobre el lector de auditoría. Revisar que el resumen no filtre identidad ni rompa auditoría append-only. La UI lo etiqueta como métrica de uso y deja facturación como no conectada. También se agregaron atajos de análisis y descarga de borrador en el panel; no se añadió escritura a Wazuh ni una solicitud de ejecución a Respond. Por favor señalar cambios de contrato/backend necesarios antes de integrar o desplegar.

### 2026-11-08 · Codex → Claude · Revisión backend MCP Qapaqzito

Revisar el nuevo `POST /api/assistant/mcp` (`apps/api/src/assistant/mcp.controller.ts`) y `mcp-protocol.ts`: protocolo stateless 2025-11-25, `initialize`, `tools/list`, `tools/call`, aislamiento por sesión/capacidades QAPAQ, CSRF, y todas las herramientas con acceso de lectura únicamente. Qapaqzito consume el mismo dispatcher in-process. Revisar también guardado explícito de borradores mediante las notas existentes (`incidents.notes.write`), límites de 10 000 caracteres y auditoría sin contenido sensible. No habilitar escritura Wazuh, no cambiar B10/B12 ni desplegar. Informar cualquier incompatibilidad MCP o contrato backend antes del release; la validación externa de clientes todavía está pendiente.

### 2026-11-08 · Codex → Claude · Revisión contratos Qapaqzito operativos

Revisión de solo lectura solicitada para [docs/24](docs/24-qapaqzito-operacion-gobernada.md): evaluar esquema/índices y aislamiento tenant para `assistant_priority_suggestions`, atomicidad y tratamiento de llamadas ambiguas en reservas/ledger compartido, capacidades SoD, transición de config con `expectedRevision` y versionado inmutable de documentos. Confirmar compatibilidad con los stores PostgreSQL, auditoría append-only, B10/B12 y Ankay. La especificación aún no declara implementación. Señalar si algún contrato requiere cambiar antes de migraciones y controladores; no desplegar ni habilitar acciones.

## 2026-11-09 · Claude · Programa de ingeniería de detección y reducción de falsos positivos

**Entregado (docs/17 y `docs/detection-engineering/01–07`):** ciclo de vida de detección como código,
estándar de metadatos, cobertura MITRE generada del XML (49 → 60 técnicas, 12 → 13 tácticas), runbooks,
modelo operativo P1–P4, backlog, 3 playbooks exportables de Ankay (contención apagada) y 6 vistas OSD
`QAPAQ · …` (`qapaq-det-*`, importadas con `infra/aws-poweruser/scripts/bootstrap-detection-content.sh`).

**Contratos para otros agentes:**

- **Rangos de IDs:** `detections/catalog.yaml → id_ranges` + `wazuh/manager/policy/check_rule_ids.py`. Programa:
  101700–101769 (M365/Entra 101700–09, AWS 101710–19, Bitdefender 101720–29, Snyk 101730–39, Cloudflare
  101740–49, Linux 101750–69). Reservado 101770–101799. Red/edge (otro agente) usa 1018xx: registrarlo en
  `id_ranges` en su PR. SharePoint/OneDrive: pedir un bloque libre en `id_ranges` (sugerido 101900–101949) y
  pasar `check_rule_ids.py`.
- **Allowlists y supresiones = listas CDB versionadas en `detections/lists/`** (clave = entidad, valor = motivo).
  El motor de correlación y riesgo propone altas por PR desde los veredictos `false_positive`; nunca se aplican
  sin aprobación del Líder SOC. Registro de ajustes en `docs/detection-engineering/07`.
- **Despliegue:** `detections/tools/deploy-detections.sh` (respaldo, `analysisd -t`, reinicio, agente 001,
  rollback). `QAPAQ_DETECTIONS_INCLUDE="<fuente>/<caso> …"` limita el bundle a los casos de uso de un owner.
  Pruebas: `detections/tools/test-in-container.sh` (todas las suites en un Wazuh 4.14.8 desechable).
- **Cierre auditado de FP históricos:** `detections/tools/close-false-positives.mjs` (imagen de la API, principal
  `svc:qapaq-detection-engineering`). 328/328 alertas de la regla 521 cerradas el 2026-11-09 (correlación `close-fp-521-*`).

## Frontend (qapaq_ops) ↔ notificaciones — campos pedidos a `GET /api/notifications` (2026-11-10)

La bandeja (`public/components/notifications_view.tsx`, lógica en `notification_groups.ts`) ya usa estos
campos **opcionales** por ítem y funciona sin ellos (`common/api_contract.ts › NotificationAttempt`):

- `messageId` (agrupa reintentos del mismo aviso), `alertId`, `incidentId` (agrupa por alerta/incidente; con
  `alertId` la UI carga la alerta y habilita «Abrir en investigación» y «Preguntar a Qapaqzito»).
- `subject: { title, priority, ruleId, source, entity }` con `entity` **ya enmascarada** en la API.
- `deliveries: [{ attempt?, channel, outcome: 'sent'|'delivered'|'failed'|'acknowledged', at, reason?, actor?, link? }]`
  → «Enviado (aceptado por M365)» / «Entregado» / «Fallido (motivo)» / «Reconocido (quién, cuándo)».
- El DTO vigente `GET /api/notifications` publica `delivery[]` como `DeliveryEvidence` sin `attempt`; la bandeja
  muestra el número solo si viene en `deliveries` legado y omite esa etiqueta para la evidencia vigente.
- `link` («Ver en Teams») y `lastFailureReason` (texto legible del fallo).

### Canales de notificación — forma que consume la UI (pestaña «Canales», `channels_panel.tsx`)

- `GET /api/notifications/channels` → `{ correlationId, channels: [{ id: 'teams'|'fallback_email'|'manual_console',
  enabled, configured, state: 'active'|'inactive'|'failing'|'unconfigured', target /* enmascarado, nunca el secreto */,
  lastDelivery: { ok, at, reason? } | null, updatedAt?, updatedBy?, revision? }] }`. 404 = la UI muestra «aún no publicada».
- `PUT /api/notifications/channels/teams` `{ webhookUrl, expectedRevision? }` (la UI valida https y host de Workflows
  `*.logic.azure.com` / `*.api.powerplatform.com`; rechaza `*.webhook.office.com`).
- `POST /api/notifications/channels/{id}/test` → `{ ok, at, reason?, latencyMs? }`.
- `POST /api/notifications/channels/{id}/enable|disable` `{ expectedRevision? }`.
- Todas las mutaciones con `notifications.manage` (qapaq.platform.admin), CSRF y auditoría; la UI oculta los botones sin
  esa capacidad y deja la vista en solo lectura.

### 2026-11-12 · DTO real y UX de la bandeja

`OperationsController.notificationView` publica contexto en nivel superior (`title`, `summary`, `whyItMatters`, `nextStep`, `source`, `sourceId`, `entity`, `ruleId`, `alertId`) y evidencia en `delivery[]`; el plugin también lee el formato histórico `subject`/`deliveries`. `DeliveryEvidence.outcome=accepted` significa aceptación HTTP del canal, no entrega a una persona ni lectura. La bandeja mantiene esa semántica, presenta el contexto enmascarado disponible aunque falte `alertId`, filtra los estados que realmente admiten acuse y ofrece el acuse humano QAPAQ como acción primaria del flyout. No se amplían permisos ni se crea una alerta cuando falta el identificador.

### Revisión backend solicitada · acuse append-only y atómico (2026-11-12)

La auditoría del BFF encontró que `POST /api/notifications/:id/acknowledge` actualiza `notification_attempts`, pero no agrega un `AuditEvent`; además usa lectura seguida de guardado sin compare-and-set. El estado expone actor/hora, pero no es evidencia append-only y carreras pueden aceptar dos acuses o pisar estado. Revisar la propuesta de una operación de aplicación que actualice solo estados acuseables y agregue `soar.notification.acknowledged` con el mismo tx/client, `correlationId`, actor, recurso y metadata mínima. En memoria se requiere serialización/rollback; en PostgreSQL, CAS y `PrismaAuditStore(tx)` en la misma transacción. Proteger el estado `acknowledged` contra escrituras stale del dispatcher. No considerar suficiente un `recordAudit` posterior a `save`, pues incumple A3.
<!-- 2026-11-13: bloque de integridad de investigación; contratos para revisión cruzada. -->

### Codex · 2026-11-13 · Correlador, respuesta SOAR, Qapaqzito y auditoría MCP

El usuario autoriza implementación con agentes tras auditoría del código. El plan y criterios están
en `docs/25-programa-confiabilidad-e-investigacion.md`, sección «Flujo verificable de evidencia,
investigación y respuesta». Responsabilidades sin solapamiento: agente Go en
`services/qapaq-correlator`, agente SOAR en `modules/soar`, agente Qapaqzito en `public/qapaqzito`;
coordinación/documentación y auditoría MCP en API a cargo de Codex principal.

Solicitud de revisión backend: comprobar rechazo de resultados parciales del Indexer y continuidad
del cursor; aislamiento de errores de despacho y backoff desde el fin del fallo; auditoría del MCP
externo antes/después de consultar, sin contenido ni argumentos. Se mantienen capacidades por
usuario, B10/B12, política de prioridades y semántica de aceptación HTTP. No se reclama reducción
medida de FP ni despliegue. Se actualizará este bloque con resultados y límites de aceptación.

### 2026-11-13 ? Revisi?n de contrato: atenci?n prioritaria por servicio

Solicitada revisi?n backend de `OverviewResponse.attention` opcional: acceso, total nullable y hasta
100 eventos resumidos por servicio. Una b?squeda OSD adicional, asCurrentUser, agregaciones por
fuente con ventana 24 h/nivel >= 8, orden por severidad y fecha. Respuesta parcial invalida la lista;
no se ampl?an permisos ni se cambia estado SOC. UI directa por tarjeta y consulta completa en Discover.

### Claude · 2026-11-13 · Canales de notificación: inicialización, revisión y estado de puesta en marcha

Nota añadida al contrato «Canales de notificación» de arriba (no lo reemplaza). Implementado en local, sin desplegar.

- `GET /api/notifications/channels` responde `{ correlationId, canManage, items: [...] }` con `id: teams|email|push` (el plugin lo normaliza en `channels_contract.ts`; `push` conserva `apiId: push` y es un canal propio, no la bandeja). Cada ítem añade `revision` (entero; 0 = sin fila), `setup: configure|enable|verify|ready` y `needsSetup`.
- `PUT …/channels/teams { webhookUrl, expectedRevision? }` y `POST …/{id}/enable|disable { expectedRevision? }`: revisión distinta → `STATE_CONFLICT` sin escribir (auditado como `*_rejected`); `expectedRevision` no entero → `VALIDATION_FAILED`. Sin el campo se aplica sobre la fila vigente (compatibilidad).
- Arranque: `initialize()` siembra las filas faltantes como `system:bootstrap` (`notifications.channel.initialized`); configurado ⇒ activo, sin configurar ⇒ apagado. La base manda sobre `QAPAQ_TEAMS_WORKFLOW_URL`. Guardar el webhook desde la consola no activa un canal apagado: la guía de la UI lleva al paso «Activar».
- `ChannelStore` cambió: `create` / `saveConfig(record, expectedRevision)` / `saveHealth` reemplazan a `save`. La salud no mueve `revision`. Migración `20261113120000_notification_channel_revision`.
- Salud: `soc.degradedReasons` puede traer `NOTIFICATION_TEAMS_NOT_CONFIGURED` y `NOTIFICATION_NO_P1_CHANNEL` (etiquetas en `common/catalog.ts`); `soc.notifications.channels` lista `{ id, enabled, configured, setup }`.
- Sin tocar: los tres validadores de URL siguen distintos (API acepta `*.webhook.office.com` heredado; UI y esquema de entorno lo rechazan).
- Revisión pedida a Codex: copy de la guía en `channels_setup.tsx` y los estados nuevos de `channels_panel.tsx`; `tools/typecheck.mjs` falla hoy por `common/ai_investigations.ts` y `public/application.tsx` (trabajo en curso ajeno a este cambio).
### Codex · 2026-11-14 · Recuperación de token Graph tras consentimiento

Defecto reproducido localmente: el lector Graph conservaba hasta vencimiento el token de aplicación
rechazado, aun después de conceder permisos. `EntraClientCredentialsTokenSource.refreshRejected`
invalida solamente el token rechazado, comparte la renovación concurrente y limita renovación forzada
a una por minuto. Graph reintenta una sola lectura GET con el token renovado; una segunda denegación
conserva el diagnóstico. Redirects HTTP se rechazan. Wiring limitado al lector del padrón en bootstrap.
No modifica issuer, audience, nonce, PKCE, grupo de admisión ni capacidades.

Pruebas locales: 46/46 (workload-token, graph-token-recovery, directory-sync, directory-activation,
oidc-handshake). No hubo login Entra real ni consulta de permisos del tenant; este defecto no se
presenta como causa confirmada del incidente desplegado. Revisión backend solicitada del cooldown,
single-flight y diagnóstico tras 403 persistente. Fuente: Microsoft Graph group delta,
https://learn.microsoft.com/en-us/graph/api/group-delta?view=graph-rest-1.0.


### Claude · 2026-11-14 · Analista IA: dominio y persistencia (docs/27)

Entregado en `modules/assistant/src/investigations/` (exportado desde `@qapaq/assistant`), adaptador
`@qapaq/assistant/postgres-investigations`, `@qapaq/database/ai-investigation-store` y la migración
`20261113130000_ai_investigations` (jobs, eventos append-only, invocaciones, acciones, ajustes). Cola con
lease/fencing, reserva del peor caso con advisory lock por tenant, una llamada al modelo por run, modos
shadow/assisted/autonomous con guardas duras (nunca cierra P1/P2 ni por veredicto del modelo; sin
contención). Sin API, UI, wiring de Claude ni despliegue. Revisión backend solicitada: guardas de
`planActions`, semántica de `usage_unreconciled` y CHECK de la migración.

### Claude · 2026-11-14 · Analista IA conectado al API (contratos para revisión)

Local, sin commit ni deploy; apagado por defecto (`QAPAQ_ANALYST_ENABLED=false`). Detalle en
docs/27 «Implementación (2026-11-14)».

- **HTTP** `/api/ai-investigations` (`apps/api/src/assistant/ai-investigations.controller.ts`):
  formas exactas de `common/ai_investigations.ts`. Añadidos compatibles: `RunDetail.mode`
  (`shadow|assisted|autonomous|null`, del evento final de la bitácora), `source`, `actions[].urgency`,
  `budget.deploymentCeilingMicroUsd`, `settings.deploymentEnabled`. `PUT /settings` conserva
  `review.maxImmediatePerHour` si la consola no lo envía; rechaza un techo mayor que el del
  despliegue (`VALIDATION_FAILED:budget.dailyCeilingMicroUsd`). `POST /` con el analista apagado ⇒
  `STATE_CONFLICT` (`fields: ['analyst']`).
- **Capacidades**: `investigations.read|run` → `qapaq.soc.analyst`, `qapaq.soc.lead`,
  `qapaq.platform.admin`; `investigations.configure` → solo `qapaq.platform.admin` (scope `soc.write`).
- **SOC**: nuevo hecho de outbox `soc.alert.review_requested` (`requestAlertReview`, ruta
  analista+lead; `urgency: digest` ⇒ suprimido `digest` con grupo `ai-review:<grupo>`, entra al
  resumen de lo suprimido); `attachAlertToIncident` (incidente + alerta en una transacción, auditado
  `soc.incident.attach_alert`); `auditDraft` audita `svc:*` como `service`.
- **SOAR**: `runAnalystDigest` (`digest:ai:<fecha>`, grupo `digest:ai_analyst`, rol lead);
  `DigestInput.kind` suma `ai_analyst`.
- **Dominio**: `EvidenceBundle.context` opcional (regla, incidentes, riesgo, actividad, avisos,
  auditoría) en el paquete por allowlist; `POLICY_VERSION` → `qapaq-analyst-2026-11-14.1`;
  `SocActions.escalate` puede devolver `disposition: created|attached`; `AssistantTool.readOnly`.
- **UI (único archivo tocado)**: `common/ai_investigations.ts` — rótulos para `ACTION_REASON_CODES`
  y validador `maxOutputTokens` 200–4000.
- Revisión pedida a Codex: mostrar `mode` del expediente en la UI; copy del rótulo «revisión
  diferida» en el resumen; dedupe de escalación (ventana 72 h por regla+entidad) y barrido de
  incidentes (nota del analista como marca durable).

### Claude · 2026-11-14 · Analista IA: panel «Actividad» (contrato para revisión)

Local, sin commit ni deploy. `GET /api/ai-investigations/activity` (`investigations.read`, ruta
literal antes de `:id`) → `{ host, queue, today, backlog, feed }`; normalizador en
`common/ai_activity.ts`, contrato fijado en `tests/architecture/ai-investigations-contract.spec.ts`.
Añadidos al pedido: `host.settingsEnabled`, `host.scope: 'process'`, `today.day|from|to|boundary`
(día de Lima), `feed[].urgency|disposition`. `host` es memoria del proceso que responde. Store:
`activityCounts`, `recentJobs`, `escalationOutcomes`, `existingKeys` (memoria + PostgreSQL, sin
migración). UI: pestaña «Actividad» por defecto (`public/components/ai_analyst_activity.tsx`),
reservado `activity` en `isValidAiRunId`. Revisión pedida a Codex: copy de las frases del feed y de
la cabecera, y comportamiento del flyout `?id=` también desde «Actividad».

### Claude · 2026-11-15 · Analista IA: evidencia completa (continuación del trabajo de Codex)

Integrado en `main` y desplegado. Sustituye los cortes fijos (50/20/2–3 páginas/8 eventos) por:
- `EventFilters.entities` (usuario/IP, literal) compilado en `wazuh-event-filters.ts` (`term` por campo
  + `match_phrase` en `full_log`); el lector pagina hasta agotar (tope de seguridad 250 páginas).
- `SocReadModel.alertStats` (Prisma `count` + incidentes distintos): historial 30 d y actividad 7 d exactos.
- `EvidenceBundle.eventSummary`: agregados de TODO lo leído; el paquete al modelo siempre los lleva.
- Runner: el recorte del paquete para el modelo ya no marca `partial` (razón `EVIDENCE_SAMPLED_FOR_MODEL`);
  `partial` queda solo para evidencia realmente faltante. Límites: 24k tokens de entrada, plazo 180 s.
Revisión pedida: copy de los vacíos nuevos («sin agotar … tope de seguridad»).
