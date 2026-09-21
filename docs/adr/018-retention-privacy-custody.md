# ADR-018 — Retención, privacidad y custodia

Estado: Conditionally Accepted · Fecha de decisión aportada: 2026-09-18.

Responsables: Legal, Compliance, Security, SOC e Infraestructura.

Estado operacional: eliminación automática bloqueada hasta aprobar la matriz de retención.

## Context

U-004 necesitaba distinguir la conservación operativa, probatoria, contractual y
regulatoria por dataset. La Resolución SBS N.° 504-2021 exige preservar evidencia
forense y asegurar acceso, salida y eliminación de información confidencial en
servicios de terceros, pero no establece un plazo universal para todos los logs
del SOC. Aplicar un TTL único, conservar indefinidamente o tratar backups como
archivo produciría riesgos de pérdida de evidencia, exceso de datos y cumplimiento.

## Decision

QAPAQ SecOps adopta una política diferenciada por dataset, clasificación,
finalidad, evento de inicio y autoridad aplicable. El orden de precedencia es:
hold o requerimiento de autoridad; obligación validada; necesidad probatoria o de
seguridad aprobada; baseline interna; eliminación verificable.

Se aprueban el modelo de clasificación, los tiers HOT/COLD/EVIDENCE, los
contratos de inventario, hold, custodia, purge receipt y deletion ledger, y los
plazos de [la política canónica](../architecture/retention-privacy-custody.md) como
baseline técnica provisional. Los periodos de cinco años son una propuesta
conservadora, no una atribución automática a la SBS.

La eliminación automática productiva permanece bloqueada hasta que Legal y
Compliance ratifiquen la matriz normativa y los responsables aprueben datasets,
plazos, triggers, regiones, backups, holds, sanitización, custodia, restauración
y purga. Mientras tanto, producción solo permite purga manual aprobada y auditada;
los lifecycles automáticos se prueban con datos sintéticos.

## Alternatives

- Un TTL global simplifica operación, pero ignora finalidades y obligaciones.
- Conservar todo indefinidamente preserva evidencia, pero contradice minimización,
  eleva exposición y coste, y hace inviable una eliminación demostrable.
- Delegar el ciclo de vida solo al índice no cubre blobs, backups, exports, holds
  ni restauraciones.
- Usar snapshots como archivo conserva dependencia del motor y no sustituye un
  formato, catálogo y manifest verificables.

## Consequences

Cada dataset productivo necesita owner, custodio, finalidad, clasificación,
ubicaciones, trigger, periodos, autoridades, backup y método de eliminación.
OpenSearch separa datasets con políticas incompatibles. La privacidad se aplica
en ingesta; secretos detectados se cuarentenan. Evidencia y auditoría crítica usan
inmutabilidad selectiva, hash y cadena de custodia. Los holds suspenden purgas en
su alcance exacto y se revisan cada 90 días. Backups expiran y reaplican el
deletion ledger al restaurarse. Cada purga emite un comprobante reconciliable.

La residencia no se presume limitada a Perú. Toda región, réplica, soporte,
subprocesador y transferencia necesita evaluación y aprobación. El proveedor
debe soportar exportación, integridad, migración de holds, salida y evidencia de
eliminación.

## Trade-offs

La separación HOT/COLD/EVIDENCE reduce coste y limita inmutabilidad, a cambio de
catálogo, orquestación, llaves, restauraciones y verificaciones adicionales. La
baseline permite diseñar contratos antes de la ratificación legal, pero mantiene
un gate explícito para evitar borrado destructivo prematuro.

## Validación y revisión

Antes de habilitar el lifecycle productivo deben aprobarse y ejecutarse los 20
escenarios de aceptación de la política canónica, incluidos hold granular, WORM,
SHA-256, purga parcial, restore aislado, deletion ledger, regiones y reconciliación.
Revisar la decisión ante cambio normativo, contractual, de dataset, región,
subprocesador, método de borrado o capacidad de inmutabilidad.

[U-004](../decisions/unresolved.md) ·
[Política canónica](../architecture/retention-privacy-custody.md) ·
[Almacenamiento](../architecture/storage.md) · [Auditoría](../architecture/audit.md)
