# Observabilidad de la plataforma

Estado: PROPOSAL. Proveedor y objetivos numéricos pendientes en U-006/U-009.

## Señales y ownership

Logs estructurados de request/job con timestamp UTC, nivel, module, operation,
outcome, duration, correlationId y errorCode seguro. Añadir traceId/spanId cuando
existan. No raw, tokens, connection strings ni headers completos. Redactar también
errores de SDK. ApplicationLog no es el archivo auditado.

Métricas: admisión/eventos válidos/rechazados por fuente y motivo acotado, lag de
fuente e ingesta, backlog y edad máxima, retries, jobs fallidos/cuarentena,
throughput de normalización/detección/indexación, freshness de contexto,
latencia/error de API y vendors, conexiones a stores, espacio/buffer de archivo,
atraso de auditoría y duración/coste de restore/export.

No usar eventId, userId, IP, correlationId ni mensaje libre como labels de métricas.
Fuente/instancia requieren cardinalidad controlada. Dashboards muestran cobertura,
gaps y última recolección exitosa, no solo conteos de alertas.

## Correlación y tracing

Generar/validar correlationId en el borde; no aceptar headers arbitrariamente largos
ni confiar en IDs externos como identidad. Propagarlo en outbox/job y llamadas
internas. Un lote tiene trace/receipt propios; fan-out preserva causation/event IDs
sin convertirlos en labels. Diferenciar correlación técnica de correlación SOC.

OpenTelemetry es candidato para instrumentación portable, no servicio desplegado.
Añadir tracing detallado cuando ayude a diagnosticar la pipeline; sampling para
traces, nunca para auditoría requerida. Resolver proveedor/retención antes de exportar.

## Health y degradación

Liveness verifica proceso/event loop y no falla porque Graph o Sophos están caídos.
Readiness se define por rol de proceso y operación: API requiere dependencias
mínimas para servir de forma segura; workers dependen de lo que necesitan para
consumir. Health detallado autenticado expone estados redacted, no credenciales ni
topología sensible. Endpoints exactos se definirán al implementar.

Fallo de un vendor marca ese conector degraded/paused y eleva alerta interna;
la plataforma conserva funciones independientes. Caída de indexador deja búsqueda
degradada y backlog observable; no declarar «sin eventos». Ausencia de datos y cero
detecciones son estados distintos. Monitor externo debe detectar caída total
porque el propio backend no puede notificarse estando detenido.

## SLI, SLO y alertas

Medir latencia admisión→normalización, evento→alerta, consulta por tier, éxito de
API, frescura por dataset y durabilidad/reconciliación. SLO/RPO/RTO serán acordados
con SOC/Infraestructura tras mediciones; ningún valor propuesto equivale a SLA.

Alertas accionables: backlog crece sin drenar, checkpoint estancado, secretos por
expirar, cuarentena anómala, archivo/auditoría retrasado, storage cerca del límite,
restore fallido y pérdida de cobertura. Umbrales según piloto, dueño y runbook;
evitar una notificación por cada retry. Destinos aprobados y datos mínimos.

Pruebas: caída selectiva, redacción de excepciones, propagación de contexto,
detección de fuente silenciosa y alerta externa de caída global.
