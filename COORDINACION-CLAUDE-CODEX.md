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
