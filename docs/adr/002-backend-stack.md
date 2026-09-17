# ADR-002 — NestJS + TypeScript

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-02 prescribe Node.js/TypeScript/NestJS, React/TypeScript y un backend estructurado.

## Decision

Usar NestJS para composición, presentation y adapters; dominio TypeScript puro. React consume contratos de API. Versiones, gestor de paquetes y ORM siguen sin seleccionar. Esta tarea no genera proyecto.

## Alternatives

Express es más mínimo pero requeriría definir más convenciones; Python como backend principal contradice el requisito. No se evalúa cambiar el stack prescrito sin nueva instrucción.

## Consequences

Aprovechar módulos/DI/guards/pipes sin introducir decoradores de framework en dominio. Un tipo TS no sustituye validación runtime.

## Trade-offs

Convenciones y tooling compartidos a cambio de aprendizaje y riesgo de acoplamiento al contenedor; contenerlo en bordes.

## Validación y revisión

Elegir versiones mantenidas y tooling compatible mediante una decisión posterior; demostrar boot, validación y boundaries.

[Diseño relacionado](../architecture/repository-structure.md) · [Preguntas abiertas](../decisions/unresolved.md).
