# Contrato de consumo de API — QAPAQ SecOps Web

Estado: **contrato de frontend para revisión; BFF/operaciones no implementados**.
Base path: misma origen, `/api/v1`. Las respuestas pertenecen a tenant/scope
autorizado por el servidor; el cliente no envía un tenant arbitrario.

El contrato TypeScript está en `src/api/admin.ts`. `HttpAdminApi` define el
transporte futuro del BFF y `MockAdminApi` es un adaptador exclusivamente local
en memoria. La pantalla etiqueta cada fixture y acción como demostración; no
afirma que exista una sesión Entra ni una conexión de SOC real.

## Identidad y sesión

La autenticación humana definida por ADR-017 es Entra ID single-tenant con
Authorization Code + PKCE, terminada en el BFF. El navegador nunca recibe tokens
de proveedor ni envía contraseñas. La sesión real es una cookie opaca `HttpOnly`,
`Secure`, `SameSite=Lax` y de duración acotada; las operaciones mutables usan un
token anti-CSRF entregado por el BFF en `<meta name="qapaq-csrf">`.

| Método y ruta                     | Propósito                                                                           | Cuerpo/respuesta                         |
| --------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| `GET /api/v1/auth/entra/start`    | Inicia autorización Entra; el BFF genera state, nonce y PKCE y devuelve redirección | Sin credenciales de usuario en el SPA    |
| `GET /api/v1/auth/entra/callback` | Valida respuesta, estado, nonce y código; crea la sesión opaca                      | Redirige a la ruta interna permitida     |
| `GET /api/v1/session`             | Actor, bundle, scope, capabilities y tenant label                                   | `AdminSession`; sin access/refresh token |
| `POST /api/v1/session/logout`     | Revoca sesión y cookie                                                              | `{ "status": "ok" }`                     |

La vista actual ofrece **Simular acceso con Entra** y abre datos mock en memoria.
No llama a la ruta de inicio, no valida identidad y no debe usarse como login
corporativo.

## Operación de plataforma y SOC

| Método y ruta                                              | Capacidad propuesta        | Forma principal                                                                     |
| ---------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/v1/platform/overview`                            | `platform.health.read`     | `PlatformOverview`, `mode`, hora de evidencia, métricas y salud por dependencia     |
| `GET /api/v1/soc/alerts?limit=50&cursor=…`                 | `alerts.read@scope`        | `Page<AlertSummary>`; sin raw                                                       |
| `POST /api/v1/soc/alerts/{alertId}/acknowledgement`        | `alerts.acknowledge@scope` | `{}` → alerta actualizada; motivo/policy según endpoint final                       |
| `GET /api/v1/soc/incidents?limit=50&cursor=…`              | `incidents.read@scope`     | `Page<IncidentSummary>`                                                             |
| `GET /api/v1/platform/sources`                             | `integrations.read`        | `SourceSummary[]`; nunca secretos ni secretRef resoluble                            |
| `POST /api/v1/platform/sources/{sourceId}/replays`         | `integrations.manage`      | `{ from, to, reason }` → `OperationReceipt`; valida ventana/capacidad antes del job |
| `GET /api/v1/platform/services`                            | `platform.health.read`     | `ServiceHealth[]`; detalle limitado al scope del actor                              |
| `GET /api/v1/platform/access-requests?limit=50&cursor=…`   | `access.requests.read`     | `Page<AccessRequest>`; no concede privilegios                                       |
| `POST /api/v1/platform/access-requests`                    | `access.requests.create`   | `{ target, requestedBundle, scope, reason }` → estado de aprobación                 |
| `GET /api/v1/platform/audit-events?limit=50&cursor=…`      | `audit.read@scope`         | `Page<AuditEventSummary>` de solo lectura                                           |
| `GET /api/v1/platform/notifications`                       | `notifications.read`       | `NotificationDelivery[]`; payload externo minimizado                                |
| `POST /api/v1/platform/notifications/{deliveryId}/retries` | `notifications.retry`      | `{}` → estado; idempotencia y límites a cargo del backend                           |
| `GET /api/v1/soc/events?limit=50&cursor=…&q=…`             | `events.search@scope`      | `Page<SecurityEventSummary>`; campos normalizados, sin payload raw                  |
| `GET /api/v1/soc/cases?limit=50&cursor=…`                  | `cases.read@scope`         | `Page<CaseSummary>`; acceso filtrado por caso/scope                                 |
| `POST /api/v1/soc/cases`                                   | `incidents.create@scope`   | `{ title, severity, alertIds }` → caso creado y auditado                            |
| `GET /api/v1/detection/rules?limit=50&cursor=…`            | `rules.read@scope`         | `Page<DetectionRuleSummary>`; versión y estado                                      |
| `GET /api/v1/platform/quarantine`                          | `quarantine.read@scope`    | `QuarantineRecord[]`; motivo y estado, sin cuerpo raw                               |
| `POST /api/v1/platform/quarantine/{id}/reprocess`          | `quarantine.reprocess`     | `{ reason }` → recibo de operación; bounded, auditado y sujeto a policy             |
| `GET /api/v1/platform/sessions`                            | `sessions.read@scope`      | `SessionSummary[]`; identidad minimizada y solo dentro del scope                    |

Los bundles de la matriz son específicos: `PLATFORM_ADMIN` no hereda raw,
exportación ni grants. `ACCESS_ADMIN` mantiene separación de funciones, y no puede
aprobar su propia solicitud. La propuesta de autorización debe sustituirse por
capabilities confirmadas endpoint por endpoint antes de producción.

El selector de perfiles que aparece en la demo solo cambia el actor en memoria; no
representa una concesión real. En modo live el bundle y las capabilities provienen
exclusivamente de `GET /api/v1/session`, y el backend vuelve a autorizarlos por petición.

## Reglas de transporte y errores

- `HttpAdminApi` usa misma origen, `credentials: same-origin`, `cache: no-store`;
  nunca `Authorization: Bearer` desde el navegador.
- Mutaciones requieren `x-csrf-token`. Redirecciones fetch se rechazan.
- Listados aceptan un cursor opaco emitido por servidor; el cliente permite 50 por
  defecto y hasta 200, rechaza valores fuera del rango y el BFF vuelve a validar
  tamaño, filtros y vinculación del cursor al actor/tenant.
- La búsqueda de eventos exige `from` y `to`; el rango no supera 90 días. `tenantId`
  y cualquier scope salen de la sesión confiable, nunca de parámetros del navegador.
- Error recomendado: `{ "code": "CAPABILITY_DENIED", "correlationId": "…" }`;
  no devolver stack, raw, access token ni datos de otro tenant.
- Códigos mínimos: `UNAUTHENTICATED`, `CAPABILITY_DENIED`, `SCOPE_DENIED`,
  `CSRF_INVALID`, `VALIDATION_FAILED`, `RESOURCE_NOT_FOUND`, `STATE_CONFLICT`,
  `RATE_LIMITED`, `DEPENDENCY_UNAVAILABLE`, `CURSOR_INVALID`.
- Los endpoints mutables deben registrar auditoría durable con actor confiable,
  capability/scope, resultado, recurso, motivo cuando aplique y correlation ID.
- No mapear readiness de API a disponibilidad de PostgreSQL, Redis, object storage
  u OpenSearch sin checks autorizados e independientes por servicio.

## Tipos y fixture

Las interfaces de `src/api/admin.ts` son los shapes de frontend propuestos. La
respuesta live debe ajustarse al contrato canónico, PBI/ADR y DTOs del API; no
forzar al backend a devolver los contadores de esta demo. Todos los valores de
`src/api/mock-admin.ts` son sintéticos y volátiles: no se persisten ni notifican a
Microsoft Teams. Cambiar la implementación de mock a HTTP exige conexión explícita
con sesión real y capabilities del servidor.

## Funciones del MVP representadas

- resumen de servicios y cobertura, búsqueda normalizada por ventana temporal,
  alertas y acuse, incidentes, casos, reglas en lectura, fuentes, ingesta,
  cuarentena, notificaciones, accesos, sesiones y auditoría;
- inspección de alerta con Event UID/regla/procedencia; raw permanece fuera de la
  vista normal y requiere permiso separado;
- solicitud acotada de replay, solicitud de grant a doble control y retry
  notificación: se simulan en memoria sin efectos externos;
- servicios y enlaces muestran explícitamente el estado de evidencia disponible,
  pendiente o no verificada.
- publicación de reglas, creación/cierre de casos e incidentes, lectura raw,
  exportación, revocación de sesiones y aprobación de grants permanecen fuera de
  esta demo; requieren contratos/backend y capabilities verificadas.
