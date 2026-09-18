# ADR-002 — NestJS + TypeScript

Estado: Proposed, parcialmente sustituido por ADR-016 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-02 prescribe Node.js/TypeScript/NestJS, React/TypeScript y un backend estructurado.

## Decision

Usar NestJS para composición, presentation y adapters; dominio TypeScript puro.
React consume contratos de API. [ADR-016](016-toolchain-and-capacity-baseline.md)
acepta versiones, ESM, Fastify, pnpm y Prisma. Este ADR conserva Proposed para
otros detalles de realización y no afirma que el proyecto ya exista.

## Alternatives

Express es más mínimo pero requeriría definir más convenciones; Python como backend principal contradice el requisito. No se evalúa cambiar el stack prescrito sin nueva instrucción.

## Consequences

Aprovechar módulos/DI/guards/pipes sin introducir decoradores de framework en dominio. Un tipo TS no sustituye validación runtime.

## Trade-offs

Convenciones y tooling compartidos a cambio de aprendizaje y riesgo de acoplamiento al contenedor; contenerlo en bordes.

## Validación y revisión

Materializar la baseline aceptada con manifests/lockfiles; demostrar boot,
validación, tests y boundaries antes de declarar el toolchain operativo.

[Diseño relacionado](../architecture/repository-structure.md) · [Preguntas abiertas](../decisions/unresolved.md).
