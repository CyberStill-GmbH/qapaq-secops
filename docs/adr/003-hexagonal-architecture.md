# ADR-003 — Hexagonal Architecture

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-02/R-10 y las reglas de dependencia del adjunto exigen independencia del dominio frente a frameworks, persistencia y fabricantes.

## Decision

Dominio puro; aplicación define casos de uso y ports; infraestructura implementa; presentation adapta entradas. Composition root ensambla. Por defecto los ports de IO pertenecen a aplicación. Interfaces solo con consumidor real.

## Alternatives

Capas controller/service/ORM sin límites filtran persistencia. Interfaces por cada clase añaden ruido. Arquitectura limpia completa con múltiples abstracciones uniformes puede sobredimensionar el MVP.

## Consequences

DTO/ORM/vendor se traducen en el borde. Imports internos cruzados y escrituras en tablas ajenas se prohíben; aliases y type-only se revisan.

## Trade-offs

Más mapeos y disciplina a cambio de pruebas y reemplazo de adapters sin reescribir invariantes.

## Validación y revisión

Demostrar reglas automáticas con una violación de prueba y revisión manual de DI; no aceptar solo un árbol vacío.

[Diseño relacionado](../architecture/dependency-rules.md) · [Preguntas abiertas](../decisions/unresolved.md).
