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
