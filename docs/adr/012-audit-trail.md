# ADR-012 — Audit trail strategy

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-12 exige auditabilidad de acciones, distinta de logs y SecurityEvent.

## Decision

Auditoría crítica local en la misma transacción que mutación, append-only para runtime y outbox para archivo protegido. Diffs permitidos/redactados, actor y razón. Fallar mutación si no persiste auditoría; denegaciones usan registro separado.

## Alternatives

Solo logs pierde integridad/semántica. Solo llamada síncrona a archivo externo acopla disponibilidad y no da transacción con negocio. Event sourcing global añade complejidad no requerida.

## Consequences

Verificación de manifests/digests y acceso separado. Archivo remoto puede degradar con buffer durable limitado y alarmas; definir umbral fail-closed. Hash local no protege de administrador total.

## Trade-offs

Atomicidad y trazabilidad frente a coste operacional, retención y custodia de llaves. WORM/firma requieren proveedor y aceptación, no son capacidades presumidas.

## Validación y revisión

Probar rollback, denegación, export y atraso de archivo; acordar custodios, retención, buffer y controles contra manipulación.

[Diseño relacionado](../architecture/audit.md) · [Preguntas abiertas](../decisions/unresolved.md).
