# Observabilidad operacional

Estado: **CONDITIONALLY ACCEPTED** por
[U-006/ADR-021](../adr/021-observability-and-audit-separation.md). Los SLI/SLO,
modos y continuidad siguen [ADR-020](../adr/020-operations-and-continuity.md).
Producción está **BLOCKED UNTIL ROLLBACK, ARCHIVE AND ALERT TESTS PASS**.

## Separación de señales

QAPAQ mantiene tres planos independientes:

- **Operational Observability:** métricas, logs y traces de la aplicación.
- **Security Audit Trail:** acciones y decisiones dentro de QAPAQ, sin sampling.
- **Security Telemetry:** eventos externos recibidos de las fuentes SOC.

Un `ApplicationLog`, trace o evento Wazuh no sustituye un `AuditEvent`. La
retención o caída del backend operacional no puede eliminar auditoría confirmada.

## Contrato y ownership

API y workers se instrumentan con OpenTelemetry, exportan por OTLP, propagan W3C
Trace Context, emiten logs JSON estructurados y métricas compatibles con
Prometheus. El destino es un OpenTelemetry Collector administrado por
Infraestructura:

```text
QAPAQ API / workers → OTLP → OpenTelemetry Collector → backend corporativo
```

El dominio no importa SDK de proveedores ni conoce productos de métricas, logs o
traces. Infraestructura define endpoint, autenticación, certificados, backends,
retención, almacenamiento, cuotas, disponibilidad, soporte, alert manager y
canales. Los backends locales de desarrollo no acreditan operación productiva.

QAPAQ produce señales correctas y expone health seguro. No administra el
Collector, su almacenamiento ni la infraestructura productiva.

## Métricas mínimas

```text
http_requests_total
http_request_duration_seconds
http_errors_total
connector_fetch_total
connector_fetch_failed_total
connector_records_fetched_total
connector_records_durable_total
connector_records_rejected_total
connector_records_duplicate_total
connector_checkpoint_age_seconds
connector_ingestion_lag_seconds
connector_gap_detected_total
queue_depth
queue_oldest_job_age_seconds
worker_job_duration_seconds
worker_job_failed_total
worker_retry_total
audit_events_created_total
audit_outbox_pending
audit_outbox_oldest_age_seconds
audit_archive_failed_total
audit_reconciliation_mismatch_total
database_pool_active
database_pool_waiting
dependency_request_duration_seconds
dependency_errors_total
detection_evaluated_total
detection_alerts_created_total
detection_failed_total
soar_action_requested_total
soar_action_executed_total
soar_action_failed_total
soar_action_unknown_total
teams_notifications_requested_total
teams_notifications_sent_total
teams_notifications_failed_total
teams_notification_duration_seconds
teams_notification_queue_depth
teams_notification_oldest_age_seconds
critical_alert_acknowledgment_seconds
critical_alert_unacknowledged_total
observability_dropped_records_total
observability_export_failed_total
```

Si U-007 se activa, añadir `analytics_jobs_total`, `analytics_jobs_failed_total`,
`analytics_job_duration_seconds`, conteos de input/output/rechazo, fallos de
contrato, límites de recursos y timeouts. Estas métricas no justifican desplegar
Python en el MVP.

No usar como labels: user/email/IP, incident/alert/event/request/session ID,
hostname individual, texto libre de error ni URL con parámetros. Fuente, entorno,
versión y código de error usan vocabularios acotados. Dashboards muestran cobertura,
gaps, freshness y última recolección exitosa; cero alertas no implica fuente sana.

## Logs

Los logs contienen timestamp UTC, nivel, service, environment, version, operación,
outcome, duración, `errorCode`, `sourceId` acotado, `requestId` y `traceId` opacos
cuando corresponda. Alertas y automatización usan códigos estables, no texto libre. La URL del workflow
de Teams nunca aparece en logs, traces, métricas, auditoría ni errores.

Nunca registrar tokens, cookies, passwords, API keys, client secrets,
authorization headers, connection strings, cuerpos raw completos, evidencia, PII
innecesaria ni parámetros SOAR sensibles. Redactar también excepciones de SDK.

## Traces y propagación

El trace cubre, cuando aplique:

```text
HTTP → use case → repository → enqueue → worker → connector
     → normalization → detection → alert creation
```

`traceId` y `requestId` se propagan entre HTTP, outbox y BullMQ, con longitud y
formato validados. No se confía en un ID externo como identidad o autorización.

Baseline inicial de sampling:

| Tráfico | Sampling |
| --- | ---: |
| Requests exitosos ordinarios | 10% |
| Errores | 100% |
| Operaciones privilegiadas | 100% |
| SOAR | 100% |
| Administración de accesos | 100% |
| Exportaciones | 100% |
| Pruebas sintéticas | 100% |

Un trace completo nunca sustituye auditoría transaccional.

## Buffer y comportamiento de fallo

El Collector usa como baseline inicial el menor de 6 horas o 10 GiB. Ante
saturación descarta, en orden: DEBUG, INFO, traces exitosos sampled y señales no
críticas. Nunca recibe el audit trail. Cada descarte y fallo de exportación queda
contabilizado.

Si métricas, logs o traces están indisponibles, la aplicación continúa, usa el
buffer y alerta por una ruta externa. No oculta la pérdida ni confirma que existe
monitoreo cuando el Collector está caído.

Liveness comprueba proceso/event loop. Readiness depende del rol y de las
dependencias mínimas para operar con seguridad. Health detallado exige
autorización y redacta topología y credenciales. Un monitor externo detecta la
caída total porque QAPAQ no puede avisar cuando está detenido.

## SLI, modos y alertas

ADR-020 gobierna SLI/SLO, error budgets y los modos `NORMAL`, `DEGRADED`,
`INGEST_ONLY`, `READ_ONLY`, `RECOVERY` y `MAINTENANCE`. Las señales distinguen
fallo interno, dependencia externa, ausencia de datos y cero detecciones.

Alertas mínimas:

```text
ObservabilityCollectorUnavailable
ObservabilityRecordsDropped
ConnectorCheckpointStale
ConnectorGapDetected
QueueBacklogGrowing
QueueCannotDrain
WorkerFailureRateHigh
DatabasePoolExhausted
SearchUnavailable
SoarActionUnknown
CertificateExpiring
BackupFailed
RestoreTestOverdue
```

Cada regla declara impacto, severidad, owner, threshold, runbook, canales y
criterio de resolución. Se requieren un canal operacional/on-call y otro canal
corporativo independientes del dashboard QAPAQ. El proveedor se conecta mediante
adapter y no se hardcodea.

Routing base: Platform/Infraestructura para runtime y Collector; Platform, Source
Owner y SOC para fuentes; SOC/Security/Platform para SOAR desconocido. SEV1 usa
guardia, canal corporativo y ticket; sin guardia formal se mantiene
`LIMITED PRODUCTION / 8x5` conforme a ADR-020.

## Privacidad y retención

Métricas agregadas: Platform e Infraestructura. Logs: Platform y Security cuando
corresponda. Traces: Platform con acceso restringido. Ninguno otorga una vía para
evadir el RBAC de raw, evidencia o auditoría.

U-004/ADR-018 gobierna retención: logs ordinarios operacionales, fallos con plazo
aprobado, métricas según capacidad y traces de corta duración con sampling. La
retención del proveedor operacional nunca determina la del audit trail.

## Gate productivo

Puede continuar instrumentación, dashboards, alert rules, fakes y contract tests.
Producción requiere endpoint OTLP, backends, retención, cuotas, canales, guardia y
runbooks registrados, además de las pruebas de caída, pérdida contabilizada,
redacción, cardinalidad y propagación definidas por ADR-021.
