# ADR-004 — PostgreSQL for operational data

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-04 separa estado operacional de telemetría SOC masiva.

## Decision

PostgreSQL aloja estado de módulos, RBAC, auditoría operacional, outbox/inbox de efectos y metadata de lotes/archivos. No almacenar SecurityEvent masivo como JSONB ni un ledger por evento sin justificar volumen. ORM/esquema físico pendientes.

## Alternatives

Todo en PostgreSQL simplifica stores pero mezcla cargas incompatibles. Usar el indexador como fuente transaccional dificulta invariantes y atomicidad.

## Consequences

Migraciones por ownership, transacciones cortas y claves únicas para idempotencia. Auditoría crítica se inserta con la mutación; retención operacional evita crecimiento ilimitado.

## Trade-offs

Consistencia y transacciones a cambio de gestionar replicación/backup y coordinación con stores sin transacción distribuida.

## Validación y revisión

Validar esquema con casos de uso, workload de lotes/auditoría y restore; acordar RPO/RTO antes de producción.

[Diseño relacionado](../architecture/storage.md) · [Preguntas abiertas](../decisions/unresolved.md).
