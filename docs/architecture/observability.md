# Observabilidad operacional

Estado: **CONDITIONALLY ACCEPTED** por
[U-006/ADR-021](../adr/021-observability-and-audit-separation.md) y
[ADR-025](../adr/025-security-access-observability-hardening.md). Los SLI/SLO,
modos y continuidad siguen [ADR-020](../adr/020-operations-and-continuity.md).
Producción está **BLOCKED UNTIL ROLLBACK, ARCHIVE, ACCESS, RESTORE AND ALERT TESTS PASS**.

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
Infraestructura y el backend seleccionado por ADR-025 es Grafana OSS + Loki +
Prometheus:

```text
QAPAQ API / workers → OTLP → OpenTelemetry Collector → Loki (logs)
QAPAQ API / workers → Prometheus scrape/Collector → Prometheus (métricas)
SOC/Platform → Grafana OSS → Loki/Prometheus
```

El dominio no importa SDK de proveedores. Infraestructura define endpoint,
autenticación, certificados, retención, almacenamiento, cuotas, disponibilidad,
soporte, Alertmanager y canales. Loki queda detrás de proxy autenticado/mTLS;
Prometheus, exporters y `/metrics` no se exponen a Internet; Grafana usa Entra y
red QAPAQ sin acceso anónimo. Los backends locales no acreditan producción.

Este stack no incluye un backend de trazas. Se preservan W3C Trace Context y
`traceId`/`spanId` correlacionables en logs; almacenar/buscar trazas con Tempo u otro
producto requiere decisión posterior de capacidad y retención.

QAPAQ produce señales correctas y expone health seguro. No administra el
Collector, su almacenamiento ni la infraestructura productiva.

El dashboard no queda reservado a Infraestructura: `qapaq.soc.lead` debe poder
consultar señales operativas del flujo SOC y `qapaq.platform.admin` esas señales
más salud técnica de QAPAQ. El analista ve en la consola el resumen de frescura y
cobertura que necesita para decidir si una búsqueda es confiable. El auditor no
recibe logs operacionales por heredar permisos de audit. La matriz completa y sus
límites están en el [baseline de acceso](security-access-observability-baseline.md).

El runtime implementa `observability.read_soc` y
`observability.read_platform`. `GET /api/operations/health` devuelve un resumen
para sesiones con `alerts.read`, agrega `soc` al líder SOC y agrega `platform` al
administrador de plataforma. El auditor queda denegado; la API omite secciones sin
capability. `/operations` consume esa API por el BFF autenticado y no muestra logs
operacionales crudos. La edad de la última alerta solo describe la señal observada;
no declara sana la fuente. El resumen de cobertura es `NO_DATA` hasta C-5. Grafana no
forma parte funcional de esta vista ni se habilita con un enlace sin SSO, tenant
isolation y pruebas de denegación.

### Acceso con Grafana OSS y Entra

Grafana OSS ofrece roles básicos (`Viewer`, `Editor`, `Admin`) y organizaciones;
los roles RBAC finos y personalizados pertenecen a Enterprise/Cloud. En QAPAQ,
Entra asignará únicamente `Viewer` mediante `org_mapping`: `qapaq.soc.lead` entra
en la organización de operación SOC y `qapaq.platform.admin` entra en las
organizaciones SOC y plataforma. El admin de plataforma de QAPAQ no recibe el rol
`GrafanaAdmin`; `allow_assign_grafana_admin` queda deshabilitado y el acceso
requiere grupo Entra permitido y mapeo estricto. El analista consume el resumen
redactado por la API QAPAQ, y el auditor sigue limitado al audit trail.

Las organizaciones de Grafana separan dashboards y datasources; no son por sí
solas un control de filas por tenant. Para cualquier fuente multi-tenant, el
backend debe autenticar el acceso y fijar el tenant autorizado fuera del query del
navegador. En Loki esto requiere `auth_enabled: true`, asignación servidor-side de
`X-Scope-OrgID` y `multi_tenant_queries_enabled: false`, salvo una necesidad
administrativa explícita y auditada. El datasource no puede aceptar un tenant
arbitrario del usuario. La implementación requiere pruebas negativas entre tenant,
grupo y organización, además de comprobar que un `Viewer` no puede editar
dashboards, fuentes ni usuarios. Las [capacidades y mapeos de Entra de Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/entraid/)
y [aislamiento multi-tenant de Loki](https://grafana.com/docs/loki/latest/operations/multi-tenancy/)
son la base de esta decisión; no equivalen a autorización QAPAQ ya implementada.

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
security_events_normalized_total
security_events_quarantined_total
security_event_schema_validation_failed_total
security_event_unclassified_total
security_event_raw_integrity_failed_total
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
versión de schema/mapping y código de error usan vocabularios acotados. Dashboards muestran cobertura,
gaps, freshness y última recolección exitosa; cero alertas no implica fuente sana.

## Logs

Los logs contienen timestamp UTC, nivel, service, environment, version, operación,
outcome, duración, `errorCode`, `sourceId` acotado, `requestId` y `traceId` opacos
cuando corresponda. Alertas y automatización usan códigos estables, no texto libre. La URL del workflow
de Teams nunca aparece en logs, traces, métricas, auditoría ni errores.

Nunca registrar tokens, cookies, passwords, API keys, client secrets,
authorization headers, connection strings, cuerpos raw completos, evidencia, PII
innecesaria ni parámetros SOAR sensibles. Redactar también excepciones de SDK.

Para `/qapaq-api/`, el access log de Nginx registra método, `$uri`, status,
request ID, bytes y duración solamente. No registrar `$request`, `$request_uri`,
`$args`, `$query_string`, referer ni IP de cliente en esa ruta. La prueba local con
un upstream 502 confirmó que el `error_log` estándar también puede escribir la
request line con su query string. Por eso C-12 configura en esa ubicación
`error_log /dev/null emerg;`: los errores de request de Nginx para este proxy se
suprimen, mientras el access log redactado conserva status, request ID y duración.
La telemetría de aplicación debe conservar causa y `correlationId` sin URL; el
dashboard de errores debe alertar con las métricas del BFF/API. Este trade-off
reduce detalle de diagnóstico Nginx por request y requiere comprobar que los 5xx
siguen visibles por las métricas de aplicación y el access log seguro. No se
suprimen errores globales de Nginx ni los de otras ubicaciones. La directiva
`error_log` admite contexto `location` según la [documentación oficial de Nginx](https://nginx.org/en/docs/ngx_core_module.html#error_log).

ALB access logs quedan deshabilitados hasta que exista redacción probada. El template actual de
user data conserva el formato previo para nuevas instancias; la aplicación por
SSM de esta política y la incorporación al próximo reemplazo planificado requieren
verificación de `nginx -t`, reload y rollback. El cambio del demo se ejecuta por el
workflow manual [.github/workflows/qapaq-api-no-query-logging.yml](../../.github/workflows/qapaq-api-no-query-logging.yml),
que llama a [qapaq-api-no-query-logging.sh](../../infra/aws/scripts/qapaq-api-no-query-logging.sh)
y ofrece `apply`/`rollback`; no se ha aplicado desde este checkout. La plantilla se
actualiza en el próximo reemplazo planificado. Las decisiones de privacidad de
correlación están en D-10b del canal de coordinación. La prueba en contenedor
Nginx estable cubrió `nginx -t`, query canary ante 502, repetición y rollback
idempotentes y rechazo de configuración conflictiva; no valida el host AWS ni
CloudWatch.

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

Puede continuar instrumentación, dashboards, alert rules y specs con componentes
reales aislados.
Producción requiere endpoint OTLP, backends, retención, cuotas, canales, guardia y
runbooks registrados, además de las pruebas de caída, pérdida contabilizada,
redacción, cardinalidad y propagación definidas por ADR-021.
