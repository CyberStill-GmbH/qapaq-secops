# ADR-005 — OpenSearch/Wazuh for telemetry

Estado: Proposed, parcialmente sustituido por ADR-019 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-05 requiere integrar Wazuh sin confundirlo con la plataforma SOC completa.

## Decision

Consumir Wazuh mediante adapters, separando Manager e Indexer. ADR-019 fija QAPAQ
SecOps como producto central y Wazuh como fuente/componente independiente. Evaluar
reutilizar Indexer compatible para consultas permitidas sin alterar índices gestionados.

## Alternatives

Duplicar en cluster independiente aísla carga pero duplica coste y operación; podría justificarse después. PostgreSQL masivo y SIEM custom contradicen el alcance.

## Consequences

EventQueryPort aísla motor y schemas. Normalización Qapaq preserva IDs de origen y deduplicación por dataset. La compatibilidad del entorno real no está demostrada.

## Trade-offs

Reuso reduce operación pero exige presupuesto de carga y compatibilidad/versiones; índices derivados pueden duplicar datos y requieren retención explícita.

## Validación y revisión

Inventariar versión, permisos y topología; validar consulta y carga en entorno autorizado antes de elegir ubicación de proyecciones.

[Diseño relacionado](../architecture/storage.md) · [Preguntas abiertas](../decisions/unresolved.md).
