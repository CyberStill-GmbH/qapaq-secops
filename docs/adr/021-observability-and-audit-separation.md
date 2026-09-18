# ADR-021 — Separación de observabilidad y auditoría

Estado: Conditionally Accepted · Fecha de decisión aportada: 2026-09-18.

Responsables: Security, Compliance, Infraestructura y Platform.

Estado productivo: **BLOCKED UNTIL ROLLBACK, ARCHIVE AND ALERT TESTS PASS**.

## Context

U-006 mantenía sin resolver el proveedor de métricas, logs y traces, la custodia
del audit trail, el archivo inmutable, las llaves, los buffers y el destino de
alertas. Tratar observabilidad, auditoría de seguridad y telemetría externa como
un mismo flujo permitiría que sampling, retención operacional o una caída del
backend eliminaran evidencia necesaria.

La aplicación debe producir señales portables sin administrar el proveedor
corporativo. A la vez, las mutaciones críticas necesitan un registro atómico,
append-only y verificable que no dependa de stdout, traces, OpenSearch ni del
backend de observabilidad.

## Decision

QAPAQ SecOps separa tres planos:

1. **Operational Observability:** métricas, logs y traces para diagnosticar
   disponibilidad, errores, latencia, saturación, backlog y dependencias. Admite
   sampling y retención operacional.
2. **Security Audit Trail:** quién hizo qué, sobre qué recurso, con qué decisión
   de autorización y resultado. No admite sampling.
3. **Security Telemetry:** eventos de Wazuh, Microsoft, Sophos, Cato y otras
   fuentes. No sustituye el audit trail de QAPAQ.

La instrumentación usa OpenTelemetry, OTLP, W3C Trace Context, logs JSON
estructurados y métricas compatibles con Prometheus. API y workers exportan a un
OpenTelemetry Collector administrado por Infraestructura. El código de dominio no
depende del backend concreto.

Infraestructura selecciona y opera endpoint OTLP, autenticación, certificados,
backends, almacenamiento, disponibilidad, cuotas, retención, alert manager y
canales. Los backends locales solo sirven a desarrollo hasta existir aprobación
productiva.

Cada mutación de dominio y su `AuditEvent` se persisten en la misma transacción
PostgreSQL junto con `audit_outbox`. Si falla el audit insert, se revierte la
mutación. Eventos sin commit de negocio, como un login rechazado, usan un writer
durable específico.

El rol runtime solo obtiene `INSERT` y `SELECT` limitado sobre auditoría; no puede
ejecutar `UPDATE`, `DELETE` ni `TRUNCATE`. Las correcciones crean
`AUDIT_CORRECTION` y preservan el original.

Cada evento lleva secuencia, partición, `previousHash`, `eventHash` SHA-256 y
versión de schema sobre una representación canónica. La estrategia exacta de
partición se fija antes de implementar para preservar orden determinista. La
cadena detecta manipulación y gaps, pero no sustituye un archivo independiente.

El archive worker produce lotes, manifiestos firmados y checksum, los escribe en
object storage con capacidad WORM y verifica el objeto leído antes de marcar el
outbox como `ARCHIVED`. QAPAQ puede solicitar una firma, pero nunca recibe el
material privado. Infraestructura y Security custodian, rotan y auditan las
llaves; manifests históricos conservan `signingKeyVersion`.

La reconciliación continua usa una baseline inicial de cinco minutos y verifica
secuencia, hashes, gaps, duplicados, atraso, archivo y firma. Una reconciliación
completa diaria compara PostgreSQL, outbox, objetos y manifests por partición.
Una diferencia genera `AUDIT_RECONCILIATION_MISMATCH`, incidente y bloqueo de
purga; nunca se corrige silenciosamente.

Después de un restore se compara el último manifest válido con secuencia y hash
de PostgreSQL. Una divergencia activa `RECOVERY`, bloquea operaciones
privilegiadas y reconstruye la proyección consultable desde el archive. El estado
de dominio se reconcilia por separado.

Observabilidad y auditoría usan buffers distintos:

- Collector: máximo inicial de 6 horas o 10 GiB, lo que ocurra primero. Descarta
  primero DEBUG, INFO, traces exitosos sampled y observabilidad no crítica. Toda
  pérdida incrementa contadores explícitos. Audit nunca entra en esta cola.
- Audit archive: PostgreSQL más outbox, máximo inicial de 24 horas o 10 GiB.
  Warning a 5 min, degraded a 15 min, SEV2 a 30 min o 70%, SEV1 a 60 min o 85%,
  y fail-closed a 95% o ante riesgo de agotar PostgreSQL.

La caída de métricas/logs/traces no detiene operaciones ordinarias. La caída del
archive acumula outbox mientras exista margen seguro. La imposibilidad de insertar
auditoría revierte la mutación. Cerca del límite se bloquean permisos, reglas,
exports sensibles, configuración, holds, SOAR y acceso raw privilegiado; se
preservan consultas seguras, health, recuperación e ingesta necesaria.

Las alertas usan un canal operacional/on-call y otro canal corporativo
independiente de QAPAQ. El producto concreto queda a cargo de Infraestructura y
se integra por adapter. U-009 sigue exigiendo `LIMITED PRODUCTION / 8x5` mientras
no exista guardia SEV1 formal.

## Alternatives

- Usar logs o traces como auditoría permitiría sampling y pérdida por retención.
- Enviar auditoría solo a OpenSearch o al backend de observabilidad convertiría
  un índice derivado en registro probatorio.
- Escribir síncronamente solo en el archive externo acoplaría toda mutación a su
  disponibilidad sin atomicidad con el dominio.
- Fijar Grafana, Prometheus, Loki, Tempo u otro proveedor ahora inventaría una
  plataforma corporativa que Infraestructura no ha entregado.
- Una cadena hash únicamente en PostgreSQL no resiste a un administrador capaz
  de reescribir registros y hashes.

## Consequences

Los módulos instrumentan signals y producen eventos auditables, pero la gestión
de la plataforma de observabilidad, object storage, signing service y llaves queda
fuera de QAPAQ. Logs y traces no conceden acceso alternativo a raw, evidencia o
datos restringidos. Métricas evitan labels de alta cardinalidad o datos personales.

La operación puede continuar durante una pérdida acotada de observabilidad. La
integridad de auditoría exige fallar cerrado para mutaciones críticas y degradar
antes de agotar el buffer. El proveedor concreto puede cambiar sin modificar el
dominio, siempre que conserve OTLP y los contratos de custodia/firma.

## Trade-offs

El diseño añade outbox, canonicalización, hash chain, firma, WORM, reconciliación
y runbooks. Ese coste permite detectar modificación, eliminación, truncamiento y
rollback sin hacer que la disponibilidad del backend de métricas gobierne el SOC.

La cadena ofrece evidencia de integridad, no evita por sí sola una reescritura
total ni certifica admisibilidad legal. WORM, holds, retención y eliminación siguen
ADR-018; restore, severidad y soporte siguen ADR-020.

## Validación y revisión

Antes de producción deben aprobarse los 24 escenarios de U-006: atomicidad,
permisos append-only, redacción, propagación de contexto, cardinalidad, fallos del
Collector/archive/firma, drenaje, checksum, manipulación, gaps, duplicados,
rotación de llaves, rollback, reconciliación, fail-closed, alerta externa, recovery,
legal hold y RPO/RTO observado.

Infraestructura y Security deben registrar endpoint Collector, backends, retención,
storage WORM, custodios, signing service, llaves, buffers, canales, guardia y
runbooks. Estos valores son configuración/gate productivo; no reabren la decisión
arquitectónica mientras respeten los contratos aceptados.

[U-006](../decisions/unresolved.md) ·
[Observabilidad](../architecture/observability.md) ·
[Auditoría](../architecture/audit.md) ·
[Operación y continuidad](../architecture/operations-and-continuity.md)
