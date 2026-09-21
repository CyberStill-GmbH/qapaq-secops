# ADR-011 — Contrato canónico SecurityEvent

Estado: Accepted / C-05 Implemented · Fecha: 2026-09-18; implementación: 2026-09-21.
Decisión aportada por el usuario; responsables de implementación: Desarrollo y SOC, con revisión de Seguridad y Arquitectura.

## Context

R-08 exige una representación interna estable para eventos de seguridad. Los formatos
de Wazuh, Microsoft 365, Cato Networks y Sophos difieren en identidad, tiempo,
taxonomía y severidad. Consumirlos directamente acoplaría detecciones, búsqueda y
auditoría a cada proveedor. ECS y OCSF sirven como referencias de interoperabilidad,
pero adoptar cualquiera de ellos como dominio interno trasladaría a Qapaq una
superficie mayor que la necesaria para el MVP.

## Decision

Adoptar `qapaq.security-event` como contrato canónico interno, con versión inicial
`1.0.0` y JSON Schema Draft 2020-12 como definición normativa. El artefacto vive en
`packages/contracts/src/security-event/security-event.schema.json`, junto a su
implementación compilable. Tipos TypeScript, validadores,
documentación y mappings de OpenSearch serán generados o verificados contra ese
schema.

El schema normativo implementado se ubica en
`packages/contracts/src/security-event/security-event.schema.json`; esta ruta
reemplaza la ruta de artefacto prevista originalmente para mantener schema, tipos,
validador y API en un único paquete compilable. El contrato distingue `recordId`, UUIDv7 de cada recepción física, de `eventUid`,
identidad lógica estable. La estrategia de `eventUid` y su confianza dependen del
dataset; un hash heurístico no autoriza descarte automático. Cada reintento o replay
conserva `eventUid` y crea un `recordId` nuevo. No se declara entrega exactly-once.

ECS 9.5.0 y OCSF 1.9.0 quedan fijados como referencias para perfiles de salida.
Qapaq no incluirá `ecs.version` ni versión OCSF en el evento canónico, y solo una
proyección validada podrá declarar compatibilidad. Actualizar una referencia exige
ADR, análisis de impacto, corpus de regresión y nueva versión del mapping. Esta
decisión no expresa conformidad legal o regulatoria.

La taxonomía, severidad, identidad, tiempos, preservación de raw, extensiones,
evolución y validación se definen en
[SecurityEvent y contratos](../architecture/event-model.md). Un evento inválido no
se indexa como válido: se conserva su raw, pasa a cuarentena/DLQ con causa y versiones
del conector/parser, emite métricas y puede reprocesarse.

## Alternatives

- Adoptar ECS completo: facilita el ecosistema Elastic, pero amplía el dominio y
  acopla el contrato al motor de búsqueda.
- Adoptar OCSF completo: ofrece clases de seguridad ricas, pero impone una taxonomía
  más amplia que el alcance probado.
- Mantener contratos por proveedor: reduce trabajo inicial y multiplica lógica,
  reglas y dashboards incompatibles.
- Usar solo un hash de payload: es reproducible, pero confunde eventos legítimos
  idénticos y no demuestra identidad lógica.

## Consequences

Cada conector necesita mapping y corpus versionados. Detección, correlación,
indexación y exportación consumen el contrato interno, no payloads de proveedor.
Los valores desconocidos se preservan con límites en `extensions.<vendor>` y no
expanden mappings dinámicos. Raw se guarda separado; el evento conserva referencia
y SHA-256. La clasificación de manejo será `UNASSIGNED` hasta que U-004 apruebe el
catálogo aplicable.

## Trade-offs

El núcleo propio reduce el acoplamiento, pero Qapaq asume gobernanza de schemas,
taxonomías y mappings. La deduplicación prudente conserva más eventos cuando la
identidad es débil. Los perfiles ECS/OCSF requieren mantenimiento y pruebas por
versión.

## Validación y revisión

U-010 queda aceptada. C-05 cubre schema, tipos, catálogos, validador, corpus y
contract tests; los criterios que pertenecen a C-12/C-13 y a entornos autorizados
siguen su propio gate. U-010 se cierra integralmente cuando
existan: schema ejecutable; diccionario y taxonomía; mapping de alertas Wazuh
derivadas de Microsoft 365 probado; corpus; pruebas de contrato en CI; pruebas de
replay/idempotencia; cuarentena y reproceso; verificación de hash raw; reporte de
cobertura ECS/OCSF; bloqueo de declaraciones de compatibilidad no probadas; y
aprobación SOC/Desarrollo y Seguridad. Cambios incompatibles requieren versión
mayor y ADR; mappings cambian con versión independiente y no reescriben historia.

[Registro U-010](../decisions/unresolved.md) · [Estrategia de pruebas](../testing-strategy.md).
