# ADR-010 — Vendor integrations through adapters

Estado: Proposed, parcialmente sustituido por ADR-019 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-10: proveedores heterogéneos y cambios futuros sin contaminar el dominio.

## Decision

Ports por capacidad y consumidor; Graph/AD/Cato/Sophos/Wazuh como adapters de
infraestructura; MISP futuro. ADR-019 acepta slices independientes para Wazuh,
Microsoft, Sophos y Cato dentro de Integrations & Collectors. Separar IdentityProvider
de directorio/secretos. Read-only inicial; remediación requiere contrato separado.

## Alternatives

SDK directo en dominio acelera un prototipo pero dificulta cambios/pruebas. Un mega-provider universal pierde semántica y obliga métodos vacíos.

## Consequences

Ficha por dataset con alcance, licencia, versión, mapping, raw, cursor y fallos.
Specs de integración usan servicios reales aislados y la conectividad externa se
prueba en ambiente autorizado; no se incorporan fakes como evidencia.

## Trade-offs

Traducción y mantenimiento de mappings a cambio de aislamiento. No ocultar diferencias de garantías de ACK, retención o capacidades bajo un port engañoso.

## Validación y revisión

Validar inventario y los 15 escenarios de ADR-019; no registrar `enabled` solo por configuración.

[Diseño relacionado](../architecture/integrations.md) · [Preguntas abiertas](../decisions/unresolved.md).
