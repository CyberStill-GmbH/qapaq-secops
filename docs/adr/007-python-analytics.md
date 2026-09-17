# ADR-007 — Python workers for analytics

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-07 contempla analítica/parsers/enrichment, sin sustituir el backend principal ni crear servicios prematuros.

## Decision

Preparar contratos JSON versionados. Activar Python solo para carga justificada; propuesta inicial de ejecución como proceso hijo acotado del runner Node, stdin/stdout JSON y referencias seguras, sin shell ni endpoint público. Node mantiene scheduling, permisos y persistencia. Si no satisface volumen, revisar este ADR antes de otro transporte.

## Alternatives

TypeScript o capacidades Wazuh cubren MVP simple. Python consumiendo BullMQ directamente introduce compatibilidad y doble operación; servicio HTTP autónomo añade una frontera no necesaria hoy.

## Consequences

Python valida entrada/salida y limita tiempo/memoria; no accede directamente a PostgreSQL operacional. Runner resuelve referencias autorizadas y entrega lotes limitados; resultados se revalidan.

## Trade-offs

Segundo runtime, serialización y coste de arranque frente a ecosistema analítico. No crear proceso por evento de alta tasa: lotes medidos y benchmark primero.

## Validación y revisión

Caso analítico, benchmark y schemas conformes en ambos runtimes. Cambiar transporte requiere decisión explícita; el MVP puede no ejecutar Python.

[Diseño relacionado](../architecture/event-model.md) · [Preguntas abiertas](../decisions/unresolved.md).
