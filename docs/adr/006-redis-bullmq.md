# ADR-006 — Redis/BullMQ for asynchronous jobs

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-06 prescribe Redis/BullMQ y resiliencia inicial sin Kafka.

## Decision

Usar JobQueuePort implementado con BullMQ para trabajos acotados con referencias, no raw enorme. Asumir entrega al menos una vez; persistir admisión/manifiestos y outbox para reconciliar. Consumidores y efectos idempotentes; jobs fallidos/cuarentena con replay controlado.

## Alternatives

Event emitter en memoria no cubre recuperación. Kafka puede servir para otros volúmenes, pero no hay necesidad cuantificada. Cola no sustituye archivo.

## Consequences

Configurar persistencia y noeviction de Redis, monitorear memoria/lag y validar límites. Redis caído pausa publicación; no adelantar checkpoints sin aceptación durable.

## Trade-offs

Menor complejidad que un bus distribuido a cambio de capacidad y semántica que deben medirse; añade reconciliación y operación Redis.

## Validación y revisión

Probar caída tras commit/publicación y efecto/ack, pérdida de Redis y reencolado; acordar capacidad y presupuesto de reintentos.

[Diseño relacionado](../architecture/data-flow.md) · [Preguntas abiertas](../decisions/unresolved.md).
