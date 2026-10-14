# 08 · Frontend unificado

## Decisión

El **dashboard de Wazuh es el shell**. Lo que ya hace bien no se rehace: Discover, dashboards,
agentes, vulnerabilidades, FIM, MITRE, reglas y gestión de índices. QAPAQ aporta casos, gobierno
y cambios en vivo **dentro** del mismo shell, como plugin nativo de OpenSearch Dashboards.

## Estado real (revisado el 2026-10-13)

El frontend se construye en el **fork `qapaq_ops-dashboard`**: repo local `../wazuh-dashboard-src`,
rama `qapaq/identity`, sin commitear todavía. Lo trabaja otra sesión.

| Pieza | Dónde | Estado |
| --- | --- | --- |
| Marca y tema QAPAQ (logos, favicon, tema v9 claro/oscuro, `qapaq_ops_v7_theme_overwrite.css`) | Núcleo del fork (`src/core/...`, `packages/osd-ui-shared-deps/qapaq`) | En curso |
| Login QAPAQ en `/qapaq/login` y `/qapaq/logout`. `/app/login` y `/login` se reescriben ahí | `src/plugins/qapaq_ops/server` | Hecho |
| Vistas: alertas, incidentes (tareas, notas, timeline), auditoría e integridad, acceso (usuarios y sesiones), fuentes, Mi sesión | `src/plugins/qapaq_ops/public` | Hecho |
| Cliente de la API (mismo origen, cookie, CSRF desde `/auth/session`, errores del catálogo) | `public/api/client.ts`, `common/api_contract.ts` | Hecho |
| Edge nginx y Security plugin (proxy auth) | `qapaq/deploy/` en el fork, y `wazuh/edge` más `wazuh/indexer/security` en este repo | Hay **dos copias**: ver abajo |

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
| Proxy auth: `GET /api/auth/introspect` → 204 con `x-qapaq-user` y `x-qapaq-roles` | Trabajo en curso **sin commitear en `main`** | ⚠ Bloqueante: sin esto el dashboard no autentica |

**Endpoints del backend que el plugin todavía no usa:**

| Endpoint | Para qué | Prioridad |
| --- | --- | --- |
| `GET /api/changes` (long-poll; SSE en fase 2) | Cambios en vivo, el diferencial frente al auto-refresh de OSD | **Alta** |
| `GET /api/notifications`, `POST /api/notifications/:id/acknowledge` | Bandeja y acuse humano (N6) | Alta |
| `/api/me/push/*` | Avisos en el dispositivo | Media |
| `GET /api/incidents/:id/alerts` | Alertas vinculadas en una sola llamada | Media |
| `GET /api/operations/health` | Salud operativa | Media |
| `GET /api/admin/users/:oid` (sesiones de una persona) | Detalle para revocar | Baja |
| `PUT /api/admin/users/:oid/roles` | Cambio de rol con revocación ([04](04-identidad-y-acceso.md)) | Todavía no existe en el backend |

## Riesgos detectados

1. **Versión (bloqueante).** El fork parte de `main` de `wazuh-dashboard`, que es **Wazuh 5.1.0 /
   OSD 3.6.0** en desarrollo. La demo corre **Wazuh 4.14.8 / OSD 2.19.6**, y un dashboard 3.6 no
   habla con un Indexer 2.19. Hay dos salidas:
   - **(a) Recomendada:** fijar el fork al tag `v5.0.x` GA y desplegar un cluster Wazuh 5 nuevo para
     la plataforma unificada (adelanta la fase 4). Sale una sola vez y sin backport.
   - (b) Rebasear el fork sobre el tag `v4.14.8`. Los cambios de núcleo (tema, login, logos) van a
     tener conflictos, y habría que rehacerlos al pasar a 5.x.
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
