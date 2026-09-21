# ADR-006 — Redis/BullMQ for asynchronous jobs

Estado: Proposed, parcialmente sustituido por ADR-016 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-06 prescribe Redis/BullMQ y resiliencia inicial sin Kafka.

## Decision

Usar JobQueuePort implementado con BullMQ para trabajos acotados con referencias,
no raw enorme. ADR-016 acepta Redis 8.10.1 y BullMQ 5.81.5 para jobs operacionales,
límites/concurrencia/retries iniciales y at-least-once idempotente. No acepta
BullMQ como backbone de telemetría. Persistir admisión/manifiestos/outbox para
reconciliar; jobs terminales quedan en dead-letter o cuarentena.

## Alternatives

Event emitter en memoria no cubre recuperación. Kafka puede servir para otros volúmenes, pero no hay necesidad cuantificada. Cola no sustituye archivo.

## Consequences

Configurar persistencia y noeviction de Redis, monitorear memoria/lag y validar límites. Redis caído pausa publicación; no adelantar checkpoints sin aceptación durable.

## Trade-offs

Menor complejidad que un bus distribuido a cambio de capacidad y semántica que deben medirse; añade reconciliación y operación Redis.

## Validación y revisión

Probar caída tras commit/publicación y efecto/ack, pérdida de Redis y reencolado; acordar capacidad y presupuesto de reintentos.

[Diseño relacionado](../architecture/data-flow.md) · [Preguntas abiertas](../decisions/unresolved.md).
