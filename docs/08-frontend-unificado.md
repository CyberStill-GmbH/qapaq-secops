# 08 · Frontend unificado

## Decisión

El **dashboard de Wazuh es el shell**. Lo que ya hace bien no se rehace: Discover, dashboards,
agentes, vulnerabilidades, FIM, MITRE, reglas y gestión de índices. QAPAQ aporta casos, gobierno
y cambios en vivo **dentro** del mismo shell, como plugin nativo de OpenSearch Dashboards.

## Estado real (revisado el 2026-10-22)

La fuente versionada del frontend de demo es el overlay `wazuh/dashboard/` de este repositorio,
compilado contra **Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6**. El repositorio externo
`qapaq-dashboard` y su base Wazuh 5.x / OSD 3.x son una línea de migración separada: no se mezclan
en el artefacto actual por incompatibilidad de plugins y protocolos.

| Pieza | Dónde | Estado |
| --- | --- | --- |
| Marca QAPAQ y navegación de Wazuh | `wazuh/dashboard/patches/`, `assets/`, `plugins/qapaq_ops` | Overlay fijado a OSD 2.19.6 |
| Login QAPAQ y rutas de dashboard | `plugins/qapaq_ops/server` y `wazuh/edge/` | Se conserva el flujo de identidad existente |
| Vistas SOC: alertas, incidentes, notificaciones, auditoría, usuarios/sesiones y fuentes | `plugins/qapaq_ops/public/components/` | Compiladas dentro del dashboard |
| Solicitud y aprobación de roles | `plugins/qapaq_ops/public/components/access_view.tsx` + `apps/api/src/soc/admin-role-grants.controller.ts` | En rama de trabajo; pendiente PR, CI y despliegue |
| Cliente de la API (same-origin, cookie, CSRF, contrato) | `plugins/qapaq_ops/public/api/` y `common/api_contract.ts` | CSRF se obtiene de la sesión QAPAQ |
| Edge nginx y Security plugin (proxy auth) | `wazuh/edge/` y `wazuh/indexer/security/` | Fuente del despliegue en este repo |

**`apps/web` se eliminó** (`4eab88f`): sus vistas viven en el plugin `qapaq_ops`.

## Contrato frontend ↔ backend (verificado contra `apps/api`)

| Llamada del plugin | Endpoint del backend | Resultado |
| --- | --- | --- |
| `GET /auth/session` (identidad, capacidades, `csrfToken`) | `auth.controller.ts:111` | ✓ Mismos campos |
| `GET /alerts?status&priority&q&pageSize=50&cursor` | `soc.controller.ts:97` | ✓ Filtros y paginación (máx. 200) |
| `GET /alerts/:id` → `{alert}`; `POST /alerts/:id/commands {name, expectedRevision, …}` | `:144`, `:155` | ✓ Comandos, veredictos y estados iguales |
| `POST /incidents {alertId, title, severity, summary, expectedAlertRevision}` | `:190` | ✓ |
| `GET /incidents`, `GET /incidents/:id`, `POST /incidents/:id/commands` | `:287`, `:232`, `:326` | ✓ |
| Tareas, notas y timeline (`pageSize=200`) | `incident-work.controller.ts:111–279` | ✓ Incluye `openRequiredCount` y `transitions` |
| `GET /audit/events`, `GET /audit/verify` | `audit.controller.ts` | ✓ |
| `GET /admin/users`, `GET /admin/sessions`, `POST /admin/sessions/:ref/revoke {reason, expectedRevision}` | `admin-*.controller.ts` | ✓ |
| `GET /sources/health` → `{checkedAt, sources}` | `sources-health.controller.ts` | ✓ |
| Login `/api/auth/start?returnTo=`, retorno con `authError`, `correlationId` y `sessionNotice=superseded` | `auth.controller.ts`, `return-to.ts` | ✓ `safeReturnTo` acepta rutas del dashboard |
| Logout: `/qapaq/logout` → `GET /auth/session` (CSRF) → `POST /auth/logout` | `auth.controller.ts:152` | ✓ |
| Proxy auth: `GET /api/auth/introspect` → 204 con `x-qapaq-user` y `x-qapaq-roles` | `apps/api/src/soc/auth.controller.ts`, edge y Security plugin | Verificar con el runbook de release en el entorno objetivo; el build no prueba identidad en vivo |
| Administración de roles: grant, solicitud, bandeja y aprobación | `/api/admin/users/:oid/role-grant`, `/api/admin/users/:oid/role-requests`, `/api/admin/role-requests` | En esta rama; no afirmar que está desplegado hasta aprobación del PR y migración de BD |
| Qapaqzito: `GET /assistant/status`, `POST /assistant/messages` | `assistant.controller.ts` | En rama; ver «Asistente Qapaqzito» abajo. Sin despliegue ni prueba con la API real |

### Asistente Qapaqzito (contrato)

Panel acoplado al borde izquierdo en la cola y el detalle de alertas
(`plugins/qapaq_ops/public/components/assistant_panel.tsx`). El backend es el único que habla con
Anthropic (`@anthropic-ai/sdk`, modelo `QAPAQ_ASSISTANT_MODEL`, por defecto `claude-sonnet-5-5`).

- **Autorización:** capability `assistant.use` (analista SOC y administrador de plataforma, bajo el
  scope `soc.write` porque envía datos a un tercero). Sin ella, ambos endpoints responden
  `RESOURCE_UNAVAILABLE`. `POST` exige CSRF como cualquier mutación.
- **`GET /api/assistant/status`** → `{name, configured, model, limits: {messageMaxLength, maxTurns}}`.
  `configured=false` es el estado «sin configuración» de la UI.
- **`POST /api/assistant/messages`** `{message, conversationId?, context?: {alertId?, incidentId?}}` →
  `{conversationId, reply: {text, truncated, declined}, model, toolsUsed, usage}`. El historial vive
  en el servidor (memoria, 30 min sin uso); el cliente solo envía el mensaje nuevo.
- **Seudonimización:** UPN, correo, IP, hostname, cuenta `DOMINIO\usuario`, nombres del padrón y la
  persona que conversa salen como `ent_…` (D-10b, misma clave HMAC que la consola). `reply.text` llega
  re-resuelto. Ni el texto ni las entidades entran a la auditoría (`assistant.message`: actor,
  correlación, herramientas, llamadas y tokens).
- **Herramientas (solo lectura, revalidan capability y tenant):** `list_alerts`, `get_alert`,
  `related_alerts_by_entity`, `soc_summary`, `incident_log`.
- **Topes:** 4 000 caracteres por mensaje, 20 mensajes por conversación, 20 mensajes cada 10 min por
  persona (`RATE_LIMITED`), 6 llamadas al modelo y 150 000 tokens por petición, 55 s de plazo (el
  edge corta a 65 s). Al llegar a un tope responde con `truncated=true`.
- **Errores:** `FEATURE_NOT_CONFIGURED` (503, sin API key), `DEPENDENCY_DEGRADED` (proveedor caído),
  `VALIDATION_FAILED` con `fields=["conversationId"]` (conversación llena) y `RESOURCE_UNAVAILABLE`
  (conversación vencida o ajena).
- **Secreto y egress:** el API lee `QAPAQ_ANTHROPIC_API_KEY_REF` o, en modo Key Vault, el nombre
  convenido `qapaq-anthropic-api-key`, sin pasar por el bootstrap de la VM. Terraform concede la
  lectura y abre `api.anthropic.com` solo con `siem_host.assistant_secret_name`.

**Endpoints del backend que el plugin todavía no usa:**

| Endpoint | Para qué | Prioridad |
| --- | --- | --- |
| `GET /api/changes` (long-poll; SSE en fase 2) | Cambios en vivo, el diferencial frente al auto-refresh de OSD | **Alta** |
| `GET /api/notifications`, `POST /api/notifications/:id/acknowledge` | Bandeja y acuse humano (N6) | Alta |
| `/api/me/push/*` | Avisos en el dispositivo | Media |
| `GET /api/incidents/:id/alerts` | Alertas vinculadas en una sola llamada | Media |
| `GET /api/operations/health` | Salud operativa | Media |
| `GET /api/admin/users/:oid` (sesiones de una persona) | Detalle para revocar | Baja |
| `/api/admin/users/:oid/role-requests` + `/api/admin/role-requests/:id/{approve,reject}` | Solicitud con SoD, aprobación separada, auditoría y revocación al completar ([04](04-identidad-y-acceso.md)) | En rama; la aprobación privilegiada requiere step-up aún no disponible |

## Riesgos detectados

1. **Compatibilidad de versión.** Mantener el artefacto de demo fijado a Wazuh 4.14.8 / OSD 2.19.6.
   La migración al repositorio `qapaq-dashboard` y a Wazuh 5.x / OSD 3.x requiere una rama y un
   ciclo de compatibilidad propios, con sus plugins recompilados y pruebas de integración; no forma
   parte del build de demo actual.
2. **Colisiones de rutas `/api/*`.** OSD, el plugin de Wazuh y los plugins incluidos usan sus
   propias `/api/*`. El edge enruta a QAPAQ solo una allowlist de prefijos. **Hay que verificar
   `/api/notifications`:** el plugin *Notifications* de OSD (que el fork incluye vía
   `wazuh-dashboard-notifications`) usa ese prefijo. Si colisiona, se restringe la regla de nginx
   a las rutas exactas de QAPAQ (`/api/notifications` y `/api/notifications/<uuid>/acknowledge`) o
   se renombra la ruta del backend.
3. **Dos edges.** `qapaq/deploy/nginx/qapaq-dashboard.conf` (fork) y `wazuh/edge/qapaq-edge.conf`
   (este repo) ya están alineados en allowlist y rutas públicas. El del fork todavía apunta a KrakenD
   (`127.0.0.1:8080`); el de este repo va directo a la API y cachea `introspect` 5 s. **Fuente de
   verdad:** el despliegue vive en `wazuh/` (este repo), y el fork conserva solo código.
4. **Roles distintos.** El fork da `wazuh-archives-*` (raw) también al analista. Este repo lo
   reserva al líder (minimización, N2). Hay que unificar en `wazuh/indexer/security/`.
5. **Sin cambios en vivo.** El plugin carga al montar y no consume `/api/changes`, así que la cola
   no se actualiza sola.

## Vínculos entre SIEM y casos

Desde una alerta QAPAQ se abre Discover filtrado por entidad y ventana
(`app/data-explorer/discover#?_q=(query:'data.office365.UserId:"…"')`). Desde un documento de
Wazuh, un *field formatter* del plugin abre `/app/qapaq-alerts?id=<id>`.

## Cambios en vivo

- **Backend hoy:** long-poll `GET /api/changes?after=<cursor>` (2,5 s, por secuencia de auditoría).
- **Fase 2:** sin KrakenD (que cortaba a 4 s), `GET /api/changes/stream` como **SSE**, con fallback
  al long-poll. El plugin lo usa para refrescar la cola y los casos, para el contador del header y
  para avisos `core.notifications.toasts` con las alertas P1 en cualquier pantalla.
- OSD por sí mismo solo tiene *auto-refresh* por intervalo en Discover y en los dashboards.
