# Adaptación del dashboard de Wazuh a QAPAQ (frontend SOC único)

**Estado:** plan de adaptación + config lista (2026-10-13). **Base inspeccionada:** clon de
`github.com/wazuh/wazuh-dashboard` (rama por defecto) = **OpenSearch Dashboards 3.6.0** (fork tipo
Kibana, 1.9 GB, 14 620 archivos). Clonado en `../wazuh-dashboard-src` (aislado, fuera del repo; **no
se versiona** aquí por tamaño).

> Objetivo (decisión de producto): un **único dashboard SOC QAPAQ** basado en el dashboard de
> Wazuh — con **nuestro login Entra ID**, **nuestros colores y SVG (arte QAPAQ)**, y **lo mejor de
> nuestro backend** (casos/SOAR/auditoría) integrado. En vez de un frontend desde cero.

## Decisión de alcance (2026-10-13): fusión con Wazuh, solo lo diferencial
QAPAQ SecOps **se fusiona en Wazuh**. Regla única: **si Wazuh/OpenSearch lo hace de forma nativa,
QAPAQ lo elimina**; QAPAQ conserva solo lo que Wazuh **no tiene** y que justifica el producto.

### Lo que se conserva (diferencial)
| # | Diferencial | Por qué Wazuh no lo cubre | Código que se conserva |
| --- | --- | --- | --- |
| D1 | **Casos/incidentes con triaje** (veredicto + nota, asignación, cierre con motivo, compare-and-set, unidad de trabajo estado+auditoría+outbox) | Wazuh no tiene gestión de casos | `modules/soc`: `alert.ts`, `incident.ts`, `incident-work.ts`, `use-cases.ts`, `memory-unit-of-work.ts`, `ports.ts`, `infrastructure/` |
| D2 | **Priorización con contexto QAPAQ** (identidades privilegiadas, activos críticos, exposición, repetición → reason codes), supresión por mantenimiento y **promoción idempotente** a caso | Wazuh da `rule.level`, no contexto de negocio | `modules/detection`: `prioritization.ts`, `promotion.ts`, `ports.ts` |
| D3 | **Auditoría append-only con cadena de hash** (verificación, archivo JSONL, reconciliación; evidencia SBS) | El Indexer es mutable; no hay cadena verificable | `platform/audit` completo |
| D4 | **Notificación CRITICAL a Teams con acuse humano** (reintento con mismo `client-request-id`, fallo ambiguo, fallback, `SENT` ≠ acuse) | La integración nativa de Wazuh es fire-and-forget, sin acuse ni dedupe | `modules/soar`: `dispatcher.ts`, `delivery-policy.ts`, `notification*.ts`, `teams-*.ts`, `postgres-attempt-store.ts` |
| D5 | **Autorización por capacidad/recurso/campo** sobre la API QAPAQ, validando el JWT de Entra que trae el dashboard | OpenSearch Security protege índices, no casos ni campos de QAPAQ | `modules/access`: `id-token.ts`, `capabilities.ts`, `authorization.ts`, `ports.ts` |
| D6 | **Arte QAPAQ** (marca, SVG de integraciones, tokens de color) | — | `SocBrandMark.tsx` → SVG sueltos; tokens de `docs/frontend-design/11` → tema OUI |

Soporte mínimo que también queda: `platform/configuration` (recortado a las variables vigentes),
`platform/database` (solo tablas de D1–D4), `packages/contracts/api-error`, `apps/api` (solo
controladores de D1–D5) y `apps/worker` (solo outbox→Teams).

### Lo que se elimina (Wazuh/OSD lo hace nativo)
| Hoy en QAPAQ | Lo reemplaza | Se borra |
| --- | --- | --- |
| Ingesta Wazuh→QAPAQ (admisión durable, raw store S3, normalización, checkpoints, cuarentena) | OSD lee el **Indexer directo** | `modules/telemetry`, `modules/connectors`, `modules/soc/{ingestion,memory-ingestion,events,source-health}.ts` |
| Gateway KrakenD hacia el Indexer | Ya no hay hop de lectura | `platform/gateway/krakend` |
| Esquema canónico `SecurityEvent` | Documento `wazuh-alerts-*` tal cual | `packages/contracts/{security-event,events-query}` |
| Vistas Eventos, Alertas, Resumen, Salud de fuentes, Salud operativa | Discover, Threat Hunting, dashboards Wazuh, estado de agentes/módulos | `apps/web` entero; `events`, `sources-health`, `operations*`, `changes` controllers |
| Correlación propia | Reglas Wazuh (`if_matched_sid`, `frequency`) | `modules/detection/correlation.ts` |
| Login OIDC/BFF, sesión opaca, sesión única, login local, lockout, passkey fuera de red | Security plugin `openid` + **Entra** (Smart Lockout y Conditional Access nativos) | `modules/access/{oidc-handshake,session,sign-in,lockout,network,memory-*}.ts`, `postgres-session-store.ts`, `apps/api/src/access/local-issuer.ts`, `auth`, `local-auth`, `admin-sessions` controllers |
| Administración de usuarios / directorio sincronizado | Grupos/app roles de Entra → `roles_mapping` | `directory.ts`, `postgres-directory-store.ts`, `admin-users.controller.ts` |
| Push web (PWA) y página de notificaciones | Notificaciones de OSD + Teams (D4) | `modules/soar/push.ts`, `postgres-push-store.ts`, `me-push.controller.ts` |
| Observabilidad del pipeline (Grafana/Loki/Prometheus) | Sin pipeline propio que vigilar; estado de Wazuh en su dashboard | `platform/observability` (queda solo log estructurado del API) |
| Recolección M365 | Wodle `office365` de Wazuh (ya activo) | — (solo `ossec.conf`) |

**Tablas Prisma que se eliminan:** `AccessSession`, `DirectoryMember`, `DirectoryOwner`,
`DirectorySyncState`, `EventInbox`, `IngestionManifest`, `QuarantinedEvent`, `RawEventReference`,
`SocIngestionCursor`, `Source`, `SourceCheckpoint`, `SourceHealthTransition`,
`SourcePollObservation`, `SourceStreamActivity`, `PushSubscription`.
**Se conservan:** `SocAlert`, `SocIncident`, `IncidentNote`, `IncidentTask`, `DetectionCandidate`,
`AuditEvent`, `OutboxMessage`, `SocOutboxMessage`, `NotificationAttempt` y las de secretos
(`ManagedSecret`, `SecretVersion`, `SecretLifecycle*`, `SecretReconciliation`).

### Cómo entra una alerta a QAPAQ sin ingesta propia
La **integración nativa de Wazuh** (`<integration>` en `ossec.conf`, script `custom-qapaq`) envía
solo alertas con `level ≥ 10` (umbral ajustable) a `POST /api/detections` de QAPAQ con
`{index, _id, rule.id, rule.level, agent, timestamp}` — **referencia, no copia**. QAPAQ aplica D2 y,
si promueve, abre caso (D1); el detalle se lee del Indexer al abrir la alerta en el dashboard.
Sin KrakenD, sin cursores, sin raw store.

## Licencias (verde para comercial, con matices)
- **Base OpenSearch Dashboards = Apache 2.0** (permisiva, comercial-friendly).
- **Plugins de Wazuh = GPLv2** (copyleft, **sin cláusula de red**: un SaaS no obliga a liberar tu
  código, a diferencia del AGPL de TheHive). Conservar avisos de licencia/atribución al redistribuir.
- Conclusión: **viable** para un producto comercial. Mantener un `NOTICE`/atribución.

## Matriz de factibilidad (qué es config vs código)
| Pieza | Esfuerzo | Cómo |
| --- | --- | --- |
| **Logos / título / favicon** | 🟢 Config | `opensearchDashboards.branding` en `opensearch_dashboards.yml` + assets QAPAQ |
| **Login Entra ID** | 🟢 Config | OpenSearch **Security plugin** con `auth.type: openid` contra Entra (OIDC) |
| **Roles: admin asigna a miembros del grupo** | 🟢 Config | Claim `roles`/`groups` de Entra → `roles_mapping` de OpenSearch (igual que Accesos_SOC) |
| **Colores / tema** | 🟡 Build | Variables SASS de OUI/EUI → recompilar tema (claro/oscuro) con tokens QAPAQ |
| **SVG / iconos** | 🟡 Mixto | Branding SVG = config; iconos EUI = override del set (registro de iconos) |
| **Casos / SOAR / auditoría (lo nuestro)** | 🔴 Código | Plugin de OSD que consume la API de QAPAQ, o app enlazada |

## Arquitectura resultante
- **OSD se conecta directo al Wazuh Indexer** → las vistas SIEM (discover, alertas, visualize)
  funcionan nativas. Esto **sortea el hop de ingesta KrakenD** para ver alertas: ya no hace falta que
  el API lea el índice para mostrar SIEM.
- **El backend QAPAQ** (NestJS: casos, triaje tipo TheHive, SOAR, auditoría con integridad, admisión
  Entra) se integra como **plugin de OSD** que llama a `/api/*` de QAPAQ, o como pestaña enlazada.
- **Un solo login** (Entra) para todo, un solo shell, arte QAPAQ.

## Dónde vive el fork
- **Repo nuevo `qapaq-dashboard`** (fork de `wazuh-dashboard`), NO vendorizar los 1.9 GB en
  `qapaq-secops`.
- Las personalizaciones QAPAQ se mantienen como **overlay pequeño** (este doc + `config/` + assets +
  tema + plugin) aplicado sobre la base, para poder rebasear cuando Wazuh/OSD actualicen.

---

## 1 · Branding (config — dropear en `config/opensearch_dashboards.yml`)
```yaml
opensearchDashboards.branding:
  logo:
    defaultUrl: "/plugins/qapaqBranding/assets/qapaq-logo.svg"
    darkModeUrl: "/plugins/qapaqBranding/assets/qapaq-logo.svg"
  mark:
    defaultUrl: "/plugins/qapaqBranding/assets/qapaq-mark.svg"
    darkModeUrl: "/plugins/qapaqBranding/assets/qapaq-mark.svg"
  loadingLogo:
    defaultUrl: "/plugins/qapaqBranding/assets/qapaq-mark.svg"
  faviconUrl: "/plugins/qapaqBranding/assets/favicon-32.png"
  applicationTitle: "QAPAQ SecOps"
  useExpandedHeader: false
```
Assets QAPAQ: reutilizar `apps/web/public/qapaq-mark-source.png` / los SVG de `SocBrandMark.tsx` y
`wazuh_login_bg.svg` → reemplazar por un `qapaq-login-bg.svg` con la Q y `#080808`.

## 2 · Login Entra (config del Security plugin — OIDC)
En `config/opensearch_dashboards.yml`:
```yaml
opensearch_security.auth.type: "openid"
opensearch_security.openid.connect_url: "https://login.microsoftonline.com/45f2f938-dbe3-4a3e-8a54-930893f94ef8/v2.0/.well-known/openid-configuration"
opensearch_security.openid.client_id: "336d44fe-b99d-4cfd-9c6e-0ed2d7e48998"
# client_secret vía keystore (NO en texto plano):
#   bin/opensearch-dashboards-keystore add opensearch_security.openid.client_secret
opensearch_security.openid.scope: "openid profile email"
opensearch_security.openid.base_redirect_url: "https://<dashboard-qapaq>/"
opensearch_security.openid.verify_hostnames: true
opensearch_security.openid.subject_key: "preferred_username"
opensearch_security.openid.roles_key: "roles"   # o "groups" si usamos el claim de grupos
```
En OpenSearch (`config/opensearch-security/config.yml`), dominio authc `openid_auth_domain` con
`openid_connect_url` al mismo metadata de Entra. **Quitar el login propio de Wazuh/basic** = poner
`auth.type: openid` (OSD deja de mostrar su formulario y redirige a Entra).

## 3 · Roles: admin asigna a miembros del grupo (igual que Accesos_SOC)
- Entra ya emite el claim (`roles` del app registration, o `groups`). El **admin asigna el app role /
  agrega al grupo** en Entra — exactamente el modelo que ya tienes.
- Mapear en `config/opensearch-security/roles_mapping.yml`:
```yaml
all_access:            # admin de plataforma
  backend_roles: ["qapaq.platform.admin"]
qapaq_soc_analyst:     # rol propio con permisos de lectura/triaje
  backend_roles: ["qapaq.soc.analyst"]
qapaq_auditor:
  backend_roles: ["qapaq.auditor"]
```
`backend_roles` = valores del claim `roles`/`groups` de Entra. Así, **agregar a alguien al grupo /
darle el app role en Entra ⇒ obtiene el rol en el dashboard**, sin tocar el dashboard. Mismo control
que QAPAQ hoy.

## 4 · Colores y arte (tema — requiere build)
- OSD/Wazuh usa **OUI/EUI** (variables SASS). Los colores NO están en `wz_v7_theme_overwrite.css`
  (eso son bugfixes); están en el tema compilado (`legacy_dark_theme.css` y el sistema OUI).
- Plan: definir un **tema QAPAQ** overrideando variables OUI (`$ouiColorPrimary`, fondos, texto) con
  los tokens de `docs/frontend-design/11`: `#080808` (fondo), ámbar `#c49a5a` (marca/selección),
  grises de jerarquía, y recompilar (`yarn osd bootstrap && yarn build`). Dark-first.
- Iconos: branding por config (arriba); para iconos de UI, override del set EUI o un plugin que
  registre los SVG de `SocBrandMark.tsx`.

## 5 · Integrar lo nuestro (plugin de OSD)
- Crear plugin `qapaqOps` con **solo tres entradas** de nav: **Casos** (D1, incluye el triaje de
  alertas promovidas — flujo TheHive del doc 18), **Auditoría/Integridad** (D3) y **Acuses** (D4).
  Sin «Mi sesión», usuarios ni salud de fuentes: eso es de OSD/Entra.
- El lado servidor del plugin reenvía el token Entra de la sesión OSD como `Authorization: Bearer`
  a `/api/*` de QAPAQ, que lo valida (D5). Las vistas SIEM (discover/alertas) quedan nativas de OSD.
- Acción contextual en la alerta de OSD: «Abrir caso en QAPAQ» (promoción manual, misma ruta D2).

## Pasos de arranque (orden)
1. Crear repo `qapaq-dashboard` = fork de `wazuh-dashboard` (pin a OSD 3.6.0 / release Wazuh estable).
2. Aplicar branding (§1) + assets QAPAQ. `yarn osd bootstrap`.
3. Configurar Entra OIDC (§2) + role mapping (§3) contra el Indexer de demo.
4. Tema QAPAQ (§4): variables OUI + rebuild.
5. Plugin `qapaqOps` (§5) incremental.
6. Despliegue: imagen del dashboard (Apache/GPLv2 + NOTICE) junto al Indexer.

## Nota de proporción
Esto reemplaza el frontend desde cero **y recorta el backend** a D1–D5 (ver «Decisión de alcance»).
Login, sesiones, usuarios, ingesta, KrakenD y observabilidad del pipeline pasan a Wazuh/OSD/Entra.
M365 sigue entrando por el wodle `office365` de Wazuh.

## Orden del recorte (sin romper `main`)
1. Integración `custom-qapaq` + `POST /api/detections` (nueva entrada D2) funcionando en paralelo.
2. API acepta Bearer Entra (D5) además de la sesión BFF; plugin `qapaqOps` contra ella.
3. Borrar `apps/web`, controladores de login/sesión/usuarios/eventos/fuentes/operaciones.
4. Borrar `modules/telemetry`, `modules/connectors`, `platform/gateway`, `platform/observability`
   y los archivos listados de `access`/`soc`/`soar`/`detection`/`contracts`.
5. Migración Prisma que elimina las 15 tablas; ajustar `platform/configuration` y CI.
Cada paso en su PR con CI verde.
