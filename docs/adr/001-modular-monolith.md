# ADR-001 — Modular Monolith

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-01/R-03: equipo pequeño y evolución sin reescritura. La modularidad debe existir sin coste prematuro de sistemas distribuidos.

## Decision

Mantener un monolito modular con ocho módulos y ownership explícito. API y ejecución asíncrona pertenecen al mismo producto/release; separar un runner por carga no crea autonomía de servicio. La restricción sin microservicios es requisito; la agrupación funcional ahora está aceptada en [ADR-015](015-operational-scope-and-ownership.md). Este ADR conserva Proposed para los detalles de release/procesos y evolución.

## Alternatives

Monolito sin límites facilita inicio pero dificulta cambios. Microservicios agregan operación/consistencia distribuida sin demanda cuantificada.

## Consequences

Contratos públicos, auditoría y límites de importación desde el primer vertical. Un fallo de dependencia aún puede afectar un proceso compartido.

## Trade-offs

Menor coste operacional a cambio de release coordinado y escalado inicialmente conjunto. Extraer solo con cuello de botella o aislamiento demostrado, contrato estable y dueño de operación.

## Validación y revisión

Ownership y límites operacionales aceptados por ADR-015. Comprobar una vertical valida implementación, no condiciona esa aceptación; reevaluar detalles técnicos tras medición de capacidad o necesidades de aislamiento.

[Diseño relacionado](../architecture/modules.md) · [Preguntas abiertas](../decisions/unresolved.md).
