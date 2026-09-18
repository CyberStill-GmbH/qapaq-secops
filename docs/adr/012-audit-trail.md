# ADR-012 — Audit trail strategy

Estado: Proposed, parcialmente sustituido por ADR-018 · Fecha: 2026-09-17.
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

Atomicidad y trazabilidad frente a coste operacional, retención y custodia de llaves. ADR-018 acepta WORM selectivo para auditoría privilegiada y evidencia, sujeto a proveedor y pruebas; no presume capacidades desplegadas.

## Validación y revisión

Probar rollback, denegación, export y atraso de archivo; aplicar custodios, retención, holds y WORM de ADR-018. Buffer y comportamiento ante atraso siguen U-006.

[Diseño relacionado](../architecture/audit.md) · [Preguntas abiertas](../decisions/unresolved.md).
