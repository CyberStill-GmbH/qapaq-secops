# ADR-014 — Event-driven internal communication strategy

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-03/R-06: módulos desacoplados y efectos recuperables sin bus distribuido prematuro.

## Decision

Llamadas públicas síncronas para consultas/invariantes inmediatas; eventos versionados por outbox para efectos diferidos durables. Publicar después de commit; consumers idempotentes con inbox/clave del efecto. Eventos locales en memoria solo para tareas cuya pérdida sea aceptable y explícita.

## Alternatives

Todo síncrono amplifica fallos; todo por eventos complica consistencia y debugging. Event sourcing y Kafka no son requisito.

## Consequences

Definir productor, consumidor, schemaVersion, eventId, causation/correlation, orden por agregado cuando haga falta, retries y replay. No transacción distribuida ni eventos circulares. Escribir estado+outbox en misma transacción operacional.

## Trade-offs

Acoplamiento temporal menor a cambio de duplicados/eventualidad y recuperación. Orden global no garantizado; estado de UI muestra proyecciones pendientes.

## Validación y revisión

Demostrar caída en publish/mark y consumer commit/ack; verificar que replay no duplica alertas/notificaciones ni reejecuta acciones peligrosas.

[Diseño relacionado](../architecture/data-flow.md) · [Preguntas abiertas](../decisions/unresolved.md).
