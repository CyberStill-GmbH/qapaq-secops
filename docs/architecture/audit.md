# Auditoría de seguridad y cadena de custodia

Estado: **CONDITIONALLY ACCEPTED** por
[U-006/ADR-021](../adr/021-observability-and-audit-separation.md). Retención,
WORM y holds siguen [ADR-018](../adr/018-retention-privacy-custody.md); restore y
recovery siguen [ADR-020](../adr/020-operations-and-continuity.md).

Auditoría es una capacidad transversal, no un módulo de negocio. Cada módulo
produce sus eventos mediante contratos comunes. No se almacena en la cola de
observabilidad ni se reemplaza con logs, traces, SecurityEvent u OpenSearch.

## Ownership y separación de funciones

| Responsabilidad | Owner |
| --- | --- |
| Data owner del audit trail | Security / Compliance |
| Definición de eventos | Security + Platform |
| Producción correcta | QAPAQ SecOps |
| Custodia técnica y archivo WORM | Infraestructura |
| Llaves y certificados | Infraestructura + Security |
| Reconciliación | Platform + Security |
| Revisión de accesos | Compliance / Auditoría |
| Investigación de inconsistencias | Security |

Un administrador de aplicación no elimina audit records. Un custodio de
Infraestructura no aprueba por sí mismo eliminación ni liberación de legal hold.

## Contrato de AuditEvent

Todo evento contiene, según aplique:

```text
auditEventId
occurredAt
recordedAt
actorType
actorId
subjectId
sessionIdHash
authenticationContext
capability
action
resourceType
resourceId
scope
decision
reasonCode
policyVersion
authorizationVersion
requestId
traceId
sourceIpClassification
beforeReference
afterReference
outcome
errorCode
partition
sequence
previousHash
eventHash
schemaVersion
```

No guardar snapshots completos por defecto. Conservar campos modificados
allowlisted, referencias, valores no sensibles y hashes cuando corresponda. Un
secreto siempre se representa como `REDACTED`. `sourceIpClassification` deriva de
proxies confiables; request/session/trace IDs son referencias opacas, no bearer.

## Eventos requeridos

Auditar individualmente:

- login, logout, rechazo, creación y revocación de sesión;
- roles, scopes, capabilities, suspensión, JIT y step-up;
- acceso a raw, evidencia, auditoría y exports;
- reglas, publicación, integraciones y secretRefs;
- retención, legal hold, purga y configuración;
- creación/cierre de incidentes críticos y cambios sensibles de casos;
- solicitud, aprobación, ejecución y resultado `UNKNOWN` de SOAR;
- registro, habilitación, deshabilitación, versión y presupuesto de analítica
  Python, además de aceptación/rechazo de resultados, solo cuando U-007 se active;
- solicitud, envío, fallo y reintento de Teams; acuse, escalamiento y supresión de
  alertas críticas, con `notificationId` y alias de canal pero nunca la URL;
- emergencias y denegaciones de operaciones privilegiadas.

Lecturas ordinarias no sensibles pueden agregarse. Raw telemetry, evidencia,
accesos y auditoría siempre se registran individualmente.

## Atomicidad y append-only

```text
BEGIN
  change domain state
  INSERT audit_event
  INSERT audit_outbox
COMMIT
```

Si falla el `audit_event`, se revierte toda la operación y no se informa éxito.
Denegaciones o fallos sin commit de negocio usan un writer durable separado.
Acciones externas registran intención y resultado observado sin fingir atomicidad
con el proveedor.

El rol runtime solo tiene `INSERT` y `SELECT` limitado sobre auditoría. No posee
`UPDATE`, `DELETE` ni `TRUNCATE`. Correcciones crean un nuevo
`AUDIT_CORRECTION` que referencia el evento original. Mantenimiento y purga usan
cuenta separada, política U-004, hold y auditoría propia.

## Cadena de hashes

Antes del hash se canonicaliza el evento con algoritmo y versión explícitos:

```text
eventHash = SHA-256(previousHash + canonicalAuditEvent)
```

Cada partición conserva secuencia monotónica, `previousHash`, `eventHash` y
`schemaVersion`. La estrategia exacta de partición y coordinación de concurrencia
se fija antes de implementar; `partition + day` es una opción, no un valor
inventado. La cadena permite detectar modificación, eliminación, inserción fuera
de secuencia, rollback parcial y truncamiento.

Un hash guardado solo en PostgreSQL no protege contra una reescritura total. Por
eso el archivo independiente y firmado es obligatorio.

## Archivo inmutable y firma

El archive worker procesa `audit_outbox`, verifica la cadena y escribe batches en
object storage con capacidad WORM. Cada manifest contiene:

```text
manifestId
partition
firstSequence
lastSequence
eventCount
firstHash
lastHash
contentHash
createdAt
schemaVersion
signingKeyVersion
signature
```

El objeto usa cifrado, versionado, retención, legal hold, acceso restringido,
checksum, inventario y audit trail propio. Solo se marca `ARCHIVED` después de
leer el objeto almacenado y validar su checksum.

QAPAQ solicita la firma a un servicio administrado por Infraestructura/Security y
nunca obtiene la llave privada. Las llaves no se guardan en repositorio, base de
datos, Redis, configuración, imágenes, GitHub Actions ni logs. Rotación y
revocación conservan metadata para verificar manifests históricos.

## Reconciliación y detección de rollback

La reconciliación continua tiene baseline de cinco minutos y comprueba secuencia,
primer/último hash, conteo, gaps, duplicados, atraso, batches pendientes y firma.
La reconciliación completa diaria compara PostgreSQL, outbox, objetos, manifests,
hashes, secuencias, tamaños y fechas por partición.

Una diferencia crea `AUDIT_RECONCILIATION_MISMATCH` y un incidente; preserva
material, bloquea purga y no se corrige silenciosamente.

Después de restaurar PostgreSQL:

1. Verificar el último manifest válido.
2. Comparar su secuencia/hash con PostgreSQL.
3. Identificar eventos archivados ausentes en la base.
4. Entrar en `RECOVERY` y bloquear operaciones privilegiadas.
5. Reconstruir la proyección consultable desde el archive.
6. Abrir incidente y reconciliar el estado de dominio por separado.

Recuperar AuditEvent no demuestra que el dominio haya sido restaurado al mismo
punto; esa divergencia exige investigación.

## Buffer y fallo seguro

El audit confirmado permanece en PostgreSQL y outbox cuando archive o firma están
indisponibles. Baseline inicial: máximo de 24 horas o 10 GiB, lo primero que
ocurra.

| Estado | Condición |
| --- | --- |
| Warning | atraso ≥ 5 min |
| Degraded | atraso ≥ 15 min |
| SEV2 | atraso ≥ 30 min o buffer ≥ 70% |
| SEV1 | atraso ≥ 60 min o buffer ≥ 85% |
| Fail-closed | buffer ≥ 95% o riesgo de agotar PostgreSQL |

Los límites se ajustan con volumen medido, pero nunca quedan ilimitados. Cerca del
límite se bloquean administración de permisos, publicación de reglas, exports
sensibles, configuración, holds, SOAR y acceso raw privilegiado. Pueden continuar,
si es seguro, consultas ordinarias, dashboards, health, recuperación e ingesta
necesaria para no perder telemetría.

Si falla firma, no se crea manifest sin firma ni se marca archived. Si falla el
insert local, la mutación revierte inmediatamente.

## Alertas, privacidad y retención

Alertas mínimas: `AuditOutboxLagHigh`, `AuditArchiveFailed`,
`AuditReconciliationMismatch`, `AuditHashChainBroken`,
`AuditSigningUnavailable` y `AuditBufferNearCapacity`. Se enrutan fuera de QAPAQ
a Platform/Security/Compliance/Infraestructura según impacto y a dos destinos
independientes para SEV1.

Audit trail: Security, Compliance y auditor autorizado. Raw archive: custodios
expresamente autorizados. Evidencia: personal asociado al incidente. Logs y traces
no abren una vía alternativa de acceso.

U-004 determina plazo, holds y purga. El archivo conserva horizonte aprobado; la
base mantiene la ventana operacional necesaria. Cadena de custodia describe el
manejo y no certifica por sí sola admisibilidad legal.

## Gate productivo

Puede continuar el desarrollo de schema, writer, outbox, hash chain, manifests,
reconciler, exporters, alert rules, fakes y contract tests. Producción permanece
bloqueada hasta registrar storage WORM, custodios, signing service, llaves,
buffers, canales y runbooks, y superar los 24 escenarios de ADR-021.

[Flujo de auditoría](../diagrams/09-audit.mmd).
