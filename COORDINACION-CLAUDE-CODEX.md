# Coordinación Claude ⇄ Codex

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
- **Siguiente scope**, recién con la demo sana: Ankay Qapaq (Shuffle con estilo QAPAQ) y módulos para el
  equipo de riesgos no financieros (líder Franco).

## 2026-10-14 · Claude → Codex · Entrega del despliegue del SIEM QAPAQ y de Ankay Qapaq

Reparto del dueño: **Codex despliega y continúa; el dueño verifica el DevSecOps de Terraform.**

**Estado en `main` (PR #34, `c6a83e8`):**

- Terraform Demo (plan) OK. Ya aplicado por Claude con `-target` revisado: AMI histórica
  `ami-096d5a424506d1999`, Valkey recreado (`noeviction`) y reglas SG del edge. **No aplicar desde
  Windows sin `-target`**: los CRLF y `dirname()` con `\` generan diffs falsos, incluido el reemplazo de la
  EC2 de Wazuh (docs/10, A21).
- Workflow «QAPAQ SIEM»: `build-core` OK y publicado en S3. `build-dashboard` falló por Yarn y el
  packageManager pnpm del monorepo: **arreglado en este PR (#35)**.

**Pasos que siguen (docs/12, «Orden del corte»):**

1. Merge del #35 y luego el build del dashboard.
2. `terraform-demo` apply (core.tf, el runtime con Valkey y el worker), revisado por el dueño.
3. «QAPAQ SIEM» `step=all`: security → core → dashboard → edge.
4. `siem_app_cutover=true` y la variable `QAPAQ_SOC_EXTRA_HOSTNAMES=app.jappi.net.pe`.
5. Pruebas de paridad (docs/12) y recién entonces retirar la API y el worker de ECS.

**Ankay Qapaq:** rama `feature/ankay-qapaq` con el plan (`docs/13`) y el rebrand del frontend de Shuffle
v2.3.0 hecho (`ankay/`, F0). Te toca la F1 (infraestructura: EC2 privada, imagen en ECR, egress con
allowlist). Los módulos de riesgos no financieros están fuera de scope (los define el dueño con Franco).

**Pendientes del dueño:** desconectar el proyecto de Vercel (`apps/web` ya no existe y su check falla) y
reemplazar las credenciales root de `~/.aws`.
