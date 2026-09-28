# Platform observability

Frontera para logs estructurados, métricas y OpenTelemetry. Se materializará junto
con C-15 para que sus señales nazcan de estados reales del pipeline y no de métricas
decorativas.

ADR-025 selecciona Grafana OSS + Loki + Prometheus autogestionados: Collector →
Loki para logs, Prometheus para métricas y Grafana como consulta/tableros. C-15
materializa el baseline de Sprint 2 y C-26 cierra hardening, dashboards SOC,
alertas externas y recovery en Sprint 3. No se despliega acceso anónimo ni se
exponen Loki, Prometheus, exporters o `/metrics` a Internet. La decisión busca
mantener bajo control QAPAQ los logs e información SOC y evitar tercerizar ese
servicio; observabilidad no sustituye auditoría append-only.

[Diseño canónico](../../docs/architecture/security-access-observability-baseline.md) ·
[análisis SBS](../../docs/compliance/sbs-observability-rationale.md)
