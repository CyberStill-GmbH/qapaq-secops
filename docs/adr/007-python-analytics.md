# ADR-007 — Python workers for analytics

Estado: Proposed, parcialmente sustituido por ADR-016 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-07 contempla analítica/parsers/enrichment, sin sustituir el backend principal ni crear servicios prematuros.

## Decision

Preparar contratos versionados. ADR-016 acepta Python 3.14.7, uv 0.12.15,
Ruff, mypy o Pyright y pytest, además del límite de concurrencia inicial para
benchmark. El transporte/proceso hijo de este ADR permanece Proposed. NestJS
mantiene scheduling, permisos y persistencia; Python no escribe tablas operacionales.

## Alternatives

TypeScript o capacidades Wazuh cubren MVP simple. Python consumiendo BullMQ directamente introduce compatibilidad y doble operación; servicio HTTP autónomo añade una frontera no necesaria hoy.

## Consequences

Python valida entrada/salida y limita tiempo/memoria; no accede directamente a PostgreSQL operacional. Runner resuelve referencias autorizadas y entrega lotes limitados; resultados se revalidan.

## Trade-offs

Segundo runtime, serialización y coste de arranque frente a ecosistema analítico. No crear proceso por evento de alta tasa: lotes medidos y benchmark primero.

## Validación y revisión

Caso analítico, benchmark y schemas conformes en ambos runtimes. Cambiar transporte requiere decisión explícita; el MVP puede no ejecutar Python.

[Diseño relacionado](../architecture/event-model.md) · [Preguntas abiertas](../decisions/unresolved.md).
