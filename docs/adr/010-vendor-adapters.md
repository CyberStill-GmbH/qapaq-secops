# ADR-010 — Vendor integrations through adapters

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-10: proveedores heterogéneos y cambios futuros sin contaminar el dominio.

## Decision

Ports por capacidad y consumidor; Graph/AD/Cato/Sophos/Wazuh como adapters de infraestructura; MISP futuro. Separar IdentityProvider de lectura de directorio y secretos. Read-only inicial; respuesta/remediación necesita contrato/autorización separados.

## Alternatives

SDK directo en dominio acelera un prototipo pero dificulta cambios/pruebas. Un mega-provider universal pierde semántica y obliga métodos vacíos.

## Consequences

Ficha por dataset con alcance, licencia, versión, mapping, raw, cursor y fallos. Tests con fakes no equivalen a conectividad probada.

## Trade-offs

Traducción y mantenimiento de mappings a cambio de aislamiento. No ocultar diferencias de garantías de ACK, retención o capacidades bajo un port engañoso.

## Validación y revisión

Validar ficha del piloto y contrato con fuente autorizada; no registrar fuentes como enabled solo por tener configuración.

[Diseño relacionado](../architecture/integrations.md) · [Preguntas abiertas](../decisions/unresolved.md).
