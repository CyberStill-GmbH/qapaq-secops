# ADR-020 — Operación y continuidad

Estado: Conditionally Accepted · Fecha de decisión aportada: 2026-09-18.

Responsables: Infraestructura, Platform, SOC y Security Management.

Estado productivo: bloqueado hasta superar pruebas de restore y recovery.

## Context

U-009 debía definir criticidad, pérdida tolerable, tiempo de recuperación, SLO,
degradación, soporte y ownership sin inventar cloud ni infraestructura. Un backup
configurado, proceso reiniciado o HTTP 200 no demuestra continuidad: el equipo debe
restaurar, reconciliar datos y medir RPO/RTO. Software encendido 24x7 tampoco
demuestra atención SOC 24x7 sin guardia, escalamiento y autoridad para responder.

## Decision

QAPAQ SecOps se diseña para ingesta/detección automatizada 24x7, degradación
controlada, checkpoints durables, procesamiento idempotente, replay, backups
verificables, capacidad de drenaje, owners y procedimientos ensayados.

Se aceptan condicionalmente las clases C1…C4, los objetivos provisionales de
RPO/RTO/SLO/latencia, error budgets, modos operacionales, backpressure,
mantenimiento, recuperación, severidad, soporte, ownership, catálogo de runbooks y
25 pruebas definidos en [la política canónica](../architecture/operations-and-continuity.md).

La ejecución técnica y monitoreo serán 24x7. La atención humana usa el horario
aprobado y requiere guardia formal para SEV1. Si no existe, el servicio se declara
`LIMITED PRODUCTION / 8x5` y no se presenta como SOC operativo 24x7.

Producción permanece bloqueada hasta aprobar objetivos, nombrar Service Owner,
aceptar cobertura 24x7 o limitación 8x5, configurar backups, demostrar restore,
medir replay/drenaje, ejecutar runbooks críticos y registrar escalaciones.

## Alternatives

- Confiar en alta disponibilidad del proveedor no demuestra recuperación de datos
  ni reconciliación de efectos.
- Tratar todas las capacidades como igual prioridad alarga la recuperación crítica.
- Reanudar SOAR junto con los workers puede repetir acciones externas cuyo resultado
  quedó desconocido.
- Publicar 24x7 sin guardia confunde disponibilidad del software con capacidad de
  respuesta humana.
- Fijar cloud/IaC en esta decisión acoplaría continuidad a infraestructura que no
  forma parte del alcance documental.

## Consequences

La recuperación prioriza acceso/conectividad, PostgreSQL/autorización,
auditoría/evidencia, checkpoints/commands, colas/workers, ingesta, normalización,
detección, búsqueda, API/UI, reporting y finalmente SOAR reconciliado.

Los estados `NORMAL`, `DEGRADED`, `INGEST_ONLY`, `READ_ONLY`, `RECOVERY` y
`MAINTENANCE` serán visibles. Los SLI separan indisponibilidad interna de
dependencias y `sourceEventTime → platformReceivedAt` de
`platformReceivedAt → processedAt`. Consumir error budget limita releases.

La pérdida de auditoría, evidencia o acciones críticas es SEV1 incluso dentro de
una ventana de backup. Los objetivos siguen siendo targets, no garantías, hasta
que un ejercicio mida resultados reales.

## Trade-offs

Backups, replay, aislamiento, capacidad de drenaje y ejercicios frecuentes añaden
coste operativo, pero reducen pérdida silenciosa y recuperación improvisada. Los
modos degradados preservan C1 a cambio de suspender exports, reporting y analítica.
Recuperar SOAR al final eleva RTO de automatización para evitar efectos duplicados.

## Validación y revisión

Antes de producción deben superarse las 25 pruebas de la política canónica, medir
RPO/RTO, registrar gaps y asignar acciones correctivas. Revisar objetivos después
de benchmarks, incidentes, ejercicios, cambios de proveedor/schema/cifrado/lifecycle,
variación de carga, cambio de horario o cambio de ownership.

[U-009](../decisions/unresolved.md) ·
[Operación y continuidad](../architecture/operations-and-continuity.md) ·
[Runbooks](../runbooks.md)
