# Operación y continuidad

Los objetivos de balanceo, KrakenD replicado, polling escalonado, cola recuperable
y despliegues rolling están consolidados en la
[arquitectura resiliente](qapaq-secops-resilient-architecture.md) y
[ADR-030](../adr/030-resilient-platform-architecture.md). Esta guía define cómo
demostrar continuidad; la topología dibujada no sustituye pruebas de falla,
restore y capacidad.

Estado de diseño: **CONDITIONALLY ACCEPTED** por
[U-009/ADR-020](../adr/020-operations-and-continuity.md). Fecha aportada por el
usuario: 2026-09-18. Producción está **BLOCKED UNTIL RESTORE AND RECOVERY TESTS
PASS**.

## Principios y alcance

QAPAQ SecOps debe poder ejecutar ingesta/detección 24x7, degradarse explícitamente,
recuperar desde checkpoints/replay, restaurar backups, drenar backlog y reconciliar
datos/efectos. La continuidad se demuestra restaurando y midiendo; no por HTTP 200,
restart automático, dashboard, retención del origen o alta disponibilidad declarada.

Cubre API/BFF, frontend, PostgreSQL, workers, colas/schedulers, conectores,
checkpoints, OpenSearch, detección/correlación, auditoría, exports, SOAR e
integraciones. Infraestructura opera Wazuh y productos fuente; QAPAQ observa su
disponibilidad como dependencia.

ADR-021 separa observabilidad operacional del audit trail. La pérdida del
Collector no detiene operaciones ordinarias; la imposibilidad de insertar audit
crítico revierte la mutación. El atraso de archive aplica thresholds y fail-closed
propios antes de agotar PostgreSQL.

## Criticidad y objetivos de recuperación

| Clase | Capacidades |
| --- | --- |
| C1 Critical | ingesta, checkpoints, detección, audit trail y evidencia |
| C2 Essential | incidentes, autenticación, autorización y API operacional |
| C3 Operational | búsqueda, dashboards, administración y reportes |
| C4 Deferred | exports masivos, histórico y jobs no urgentes |

La recuperación sigue C1 → C2 → C3 → C4. SOAR crítico solo se reanuda después de
reconciliar acciones previas.

| Componente | RPO propuesto | RTO propuesto |
| --- | ---: | ---: |
| Checkpoints de ingesta | 5 min | 2 h |
| Telemetría adquirida durablemente | 15 min | 4 h |
| Alertas, incidentes y asignaciones | 15 min | 4 h |
| Usuarios, roles, scopes y políticas | 15 min | 4 h |
| Audit trail y evidencia | 5 min | 4 h |
| Índices derivados | 1 h | 8 h |
| Configuración y reglas | 15 min | 4 h |
| Dashboards/reporting derivados | no aplica | 8 h |
| Exports históricos | no aplica | 24 h |
| Estado SOAR crítico | 5 min | 4 h |

RPO es estado previo al fallo potencialmente perdido. RTO se mide desde la
declaración hasta recuperación verificada de datos y capacidad. Son objetivos
provisionales; no garantías. Pérdida confirmada de auditoría, evidencia o acciones
críticas es SEV1 aunque esté dentro de la ventana de backup.

## Recuperación de telemetría

```text
last durable checkpoint → determine replay window → rewind checkpoint
→ fetch again → deduplicate → normalize → process → reconcile
```

La ventana recuperable es el mínimo entre retención del producto/API/cola,
retención Wazuh si aplica, checkpoint disponible y retención QAPAQ. Una fuente sin
replay limita el RPO a la última adquisición durable y queda como riesgo explícito.

## SLO, latencia y SLI

Targets mensuales iniciales: 99.5% para ingesta/checkpoints,
normalización/detección, API de alertas/incidentes y autorización local; 99.0% para
búsqueda/dashboards y jobs/exports no críticos. La caída de una fuente externa se
reporta separadamente y no se resta matemáticamente del SLO interno.

| Flujo desde recepción QAPAQ | Objetivo inicial |
| --- | ---: |
| recepción → persistencia durable | p95 ≤ 60 s |
| persistencia → normalización | p95 ≤ 2 min |
| persistencia → alerta determinística | p95 ≤ 5 min |
| actualización de incidente visible | p95 ≤ 5 s |
| revocación local de acceso | ≤ 60 s |

Medir por separado `sourceEventTime → platformReceivedAt` y
`platformReceivedAt → processedAt`. El primer tramo incluye proveedor e
Infraestructura; el segundo mide QAPAQ.

SLI:

- Ingesta: intervalos con progreso válido de checkpoint / intervalos con fuente disponible.
- Processing: eventos terminados o rechazados explícitamente / adquiridos durablemente.
- Freshness: `processedAt - platformReceivedAt`.
- API: requests válidos satisfechos / requests válidos totales.

No son fallos internos las denegaciones autorizadas, payloads inválidos ni rate
limits correctos. Sí lo son 5xx, timeout interno, respuesta incorrecta, corrupción
o éxito sin persistencia.

Cada SLO tiene error budget mensual: 50% activa revisión; 75% limita releases no
esenciales; 100% congela cambios funcionales no críticos. No se redefine un SLI
retroactivamente para ocultar incumplimientos.

## Modos operacionales y degradación

Estados visibles en API, dashboard y observabilidad: `NORMAL`, `DEGRADED`,
`INGEST_ONLY`, `READ_ONLY`, `RECOVERY`, `MAINTENANCE`.

- `INGEST_ONLY` prioriza adquisición y suspende enrichment no crítico, reporting,
  exports, histórico, recomputación y baja prioridad.
- `READ_ONLY` permite consultas, sin mutaciones ni SOAR.
- `RECOVERY` restaura, reproduce y reconcilia.
- `MAINTENANCE` requiere ventana aprobada y comunicada.

Comportamiento por fallo:

- PostgreSQL: no mutaciones, SOAR ni grants; solo ingesta si existe ruta durable
  independiente; nunca confirmar lo no persistido.
- OpenSearch: conservar ingesta, suspender indexación/búsqueda interactiva, marcar
  degradado y drenar tras recuperación.
- Redis/cola: no aceptar jobs no durables; reconstruir commands críticos; Redis no
  es registro único de acciones.
- IdP: bloquear login nuevo, respetar vigencia de sesiones, no extender privilegio
  y usar solo emergencia aprobada por U-003.
- Una fuente: aislarla, conservar checkpoint, alertar stale y replay al recuperar;
  las demás continúan.
- Detection: adquirir durably, no avanzar checkpoint de procesamiento y replay.
- Dependencia SOAR: resultado `UNKNOWN`, reconciliar antes de reintentar y fail
  closed para acciones críticas.

## Backlog y backpressure

Medir `incoming_rate`, `processing_rate`, `queue_depth`, `oldest_message_age` y
`estimated_drain_time`. `drain_time = backlog / (processing_rate - incoming_rate)`
solo vale si processing supera ingreso; de otro modo el estado es `DEGRADED`.

Baseline de aceptación: procesar 2× carga sostenida durante el ejercicio, seguir
aceptando tráfico, drenar dos horas de backlog en máximo cuatro, sin pérdida,
duplicados ni OOM, con 30% de margen de almacenamiento y cola decreciente. Se
reemplaza por cifras medidas tras benchmark.

Backpressure: GREEN normal; YELLOW reduce jobs no críticos; ORANGE activa
ingest-only y limita consultas; RED protege capacidad durable con rechazo explícito
o aislamiento por prioridad. Nunca descartar silenciosamente. Un rechazo registra
rango/fuente/dataset, genera incidente e intenta replay cuando sea posible.

## Mantenimiento, despliegue y rollback

Baseline: ventana regular máxima de dos horas, semanal solo con cambio aprobado,
aviso de cinco días hábiles; emergencia tan pronto como sea posible. Fecha/hora se
acuerda con Infraestructura y SOC. La ventana no permite perder eventos.

Durante mantenimiento se preservan checkpoints/entrada, se evitan schemas
incompatibles, se valida backlog, ejecutan smoke tests y confirma drenaje. No hay
mantenimiento regular durante SEV1, investigación crítica, restore, bloqueo de
auditoría o freeze. Solo se excluye del SLO si fue aprobado, comunicado, dentro de
ventana/duración y sin pérdida/corrupción.

Cada despliegue registra owner, ventana, impacto, prueba, migración compatible,
health/smoke, aborto, rollback y observación. Una migración irreversible exige
backup verificado, restore ensayado, aprobación y roll-forward. No cambiar
simultáneamente de forma incompatible schema, producer, consumer, normalizer y reglas.

## Backup, restore y orden de recuperación

U-004 gobierna retención. Operación exige backups automatizados, cifrados,
inventariados, monitoreados, con permisos separados, integridad, expiración y
restore aislado. Crear artefacto no demuestra recuperabilidad.

Restore valida schema/migraciones, conteos/checksums, RBAC/scopes, incidentes,
evidencia/auditoría, checkpoints/jobs, holds/deletion ledger, índices/reglas,
secretRefs, archivos, login y creación/consulta de incidente. Reaplica revocaciones,
eliminaciones, expiraciones, permisos, cancelación de exports y holds posteriores.

Orden: acceso/conectividad/DNS/secretRefs; PostgreSQL/autorización;
auditoría/evidencia; checkpoints/commands; colas/workers; ingesta; normalización;
detección/correlación; OpenSearch/búsqueda; API/frontend; reporting/exports; SOAR
reconciliado al final.

Ejercicios trimestrales: PostgreSQL, índices/snapshot, replay y evidencia.
Semestrales: recuperación integral y tabletop mayor. Anual: ejercicio con equipos.
Repetir después de cambios importantes. Antes de producción: restore de base e
índice, replay, drenaje, revocación y reconciliación SOAR en dry-run contra adapter autorizado.

## Severidad, soporte y ownership

- SEV1: pérdida/corrupción, evidencia/auditoría inaccesible, ingesta/detección
  detenidas, acceso no autorizado, SOAR incorrecto, credencial privilegiada
  comprometida o RTO imposible. ACK 15 min, respuesta 30 min, update cada 30 min.
- SEV2: fuente crítica caída, backlog sin drenaje, API parcial, búsqueda crítica o
  detección atrasada. ACK 1 h, respuesta 4 h, update cada 2 h.
- Teams indisponible con notificaciones críticas pendientes: SEV1. Sin pendientes
  críticas: SEV2 inicial. Mantener outbox, mostrar `TEAMS_DEGRADED` y activar el
  canal secundario aprobado; no bloquear ingesta ni persistencia.
- SEV3: dashboard/export/integración no crítica/job manual. ACK 1 día hábil,
  respuesta 2 días hábiles.
- SEV4: consulta/mejora sin impacto. ACK 2 días hábiles; planificado.

Targets SEV1 solo aplican con guardia formal. Modelo recomendado: ejecución y
monitoreo 24x7; analistas en horario aprobado; on-call técnico SEV1 rotativo;
SEV2…4 en horario de soporte. Sin calendario, contactos, escalamiento, acceso de
emergencia, política laboral y handoff aprobados, declarar
`LIMITED PRODUCTION / 8x5`. Nunca asignar guardia permanente a una sola persona.

| Capacidad | Responsible | Accountable |
| --- | --- | --- |
| Aplicación | Platform/Development | Service Owner |
| Infraestructura | Infrastructure | Infrastructure Owner |
| PostgreSQL/backups | Infrastructure/Platform | Service Owner |
| Connectors | Platform/Development | Service Owner |
| Productos fuente | Infrastructure/Source Owner | Source Owner |
| Wazuh | Infrastructure | Infrastructure Owner |
| Detección | SOC/Detection Engineering | SOC Manager |
| Triaje/incidentes | SOC | SOC Manager |
| RBAC | Access Administration | Security |
| SOAR | Platform + SOC | Security Management |
| Teams Workflow y canal | Infrastructure/Microsoft 365 | Infrastructure Owner |
| Política, payload y entrega | Platform + SOC | SOC Manager |
| Continuidad/ejercicios | Platform + Infrastructure | Service Owner |
| Comunicación | Incident Commander | Security Management |

Antes de producción, cada equipo genérico se reemplaza por rol o persona corporativa.

## Runbooks y dashboard operacional

Catálogo mínimo:

```text
service-startup.md
service-shutdown.md
postgres-restore.md
search-restore.md
checkpoint-replay.md
backlog-drain.md
source-outage.md
identity-outage.md
queue-recovery.md
credential-revocation.md
disk-capacity.md
certificate-expiration.md
deployment-rollback.md
soar-reconciliation.md
security-incident.md
audit-archive-recovery.md
audit-reconciliation.md
observability-outage.md
teams-notification-outage.md
critical-alert-unacknowledged.md
```

Cada runbook declara trigger, precondiciones,
permisos, pasos, validación, aborto, rollback, owner, escalamiento y evidencia. Otra
persona distinta del autor ejecuta exitosamente cada runbook crítico.

Dashboard: estado por componente/fuente, checkpoint age, ingestion lag, queue depth,
oldest age, drain time, processing/error rate, almacenamiento, backups, último
restore, certificados, SLO/error budget, versión y modo operacional. Sin alertas y
responsables, el dashboard no constituye monitoreo.

## Gate productivo

Puede continuar desarrollo aislado de APIs, workers, conectores, UI, dashboards,
detecciones, specs con componentes reales, pruebas y runbooks. Producción requiere objetivos aprobados,
Service Owner, modelo horario aceptado, backups y restore demostrados, replay/drenaje
medidos, runbooks ejecutados, dependencias y escalaciones registradas, y estas pruebas:

1. Reinicio de API sin pérdida.
2. Reinicio de worker durante un batch.
3. Relectura idempotente del batch.
4. Caída temporal de PostgreSQL.
5. Caída temporal de búsqueda.
6. Caída de la cola.
7. Indisponibilidad de una fuente.
8. Expiración o revocación de credencial.
9. Acumulación controlada de backlog.
10. Drenaje con tráfico entrante.
11. Restauración de PostgreSQL.
12. Restauración de búsqueda.
13. Recuperación de checkpoint.
14. Reaplicación del deletion ledger.
15. Conservación de legal holds.
16. Verificación de audit trail.
17. Evidencia recuperada con checksum válido.
18. SOAR en dry-run contra adapter autorizado sin doble ejecución.
19. Modo read-only.
20. Modo ingest-only.
21. Rollback de versión.
22. Runbook ejecutado por persona distinta de su autor.
23. Medición real del RPO.
24. Medición real del RTO.
25. Informe con gaps y acciones correctivas.

La habilitación de notificaciones críticas añade, sin sustituir este gate, los
veinte escenarios de [ADR-022](critical-alert-notifications.md#pruebas-de-aceptación).
