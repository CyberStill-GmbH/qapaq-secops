# ADR-005 — OpenSearch/Wazuh for telemetry

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-05 sitúa Wazuh en el centro y requiere búsqueda de telemetría sin construir un SIEM sustituto.

## Decision

Consumir Wazuh mediante adapters, separando Manager y Indexer. Evaluar reutilizar Indexer compatible para consultas/proyecciones permitidas; no desplegar otro OpenSearch por defecto ni alterar índices administrados por Wazuh.

## Alternatives

Duplicar en cluster independiente aísla carga pero duplica coste y operación; podría justificarse después. PostgreSQL masivo y SIEM custom contradicen el alcance.

## Consequences

EventQueryPort aísla motor y schemas. Normalización Qapaq preserva IDs de origen y deduplicación por dataset. La compatibilidad del entorno real no está demostrada.

## Trade-offs

Reuso reduce operación pero exige presupuesto de carga y compatibilidad/versiones; índices derivados pueden duplicar datos y requieren retención explícita.

## Validación y revisión

Inventariar versión, permisos y topología; validar consulta y carga en entorno autorizado antes de elegir ubicación de proyecciones.

[Diseño relacionado](../architecture/storage.md) · [Preguntas abiertas](../decisions/unresolved.md).
