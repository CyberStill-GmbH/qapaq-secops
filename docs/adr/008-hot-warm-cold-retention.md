# ADR-008 — Hot/Warm/Cold retention

Estado: Proposed, parcialmente sustituido por ADR-018 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-09 exige histórico por auditoría/investigación sin costos ilimitados ni dependencia del tier en consumidores.

## Decision

Hot/warm como políticas de índices; cold en object storage con raw comprimido y derivados JSON/Parquet evaluados. HistoricalEventQueryService planea consulta/restore y devuelve cobertura, parcialidad y estado. [ADR-018](018-retention-privacy-custody.md) acepta la baseline, holds y gate; esta ADR conserva el diseño de consulta histórica.

## Alternatives

Conservar todo hot es caro; solo snapshots liga archivo a compatibilidad del motor. Consulta directa de Parquet podría evitar restore pero introduce otro motor.

## Consequences

Catálogo por lote/rango y manifiestos verificables; no eliminar origen hasta confirmar archivo. Restore selectivo temporal con cuota/TTL y reautorización de lectura.

## Trade-offs

Cold reduce coste a cambio de latencia/restauración y catálogo confiable. Un contrato uniforme no promete latencia uniforme ni resultados completos instantáneos.

## Validación y revisión

Ratificar la matriz de ADR-018 y ensayar restore, holds y deduplicación de rangos solapados antes de expiración automática.

[Diseño relacionado](../architecture/storage.md) · [Preguntas abiertas](../decisions/unresolved.md).
