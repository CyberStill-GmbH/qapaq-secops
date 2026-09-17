# ADR-013 — Secret management abstraction

Estado: Proposed · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-13 prohíbe passwords/API keys/tokens directamente en PostgreSQL.

## Decision

Guardar secretRef y metadata mínima; SecretProvider resuelve con identidad técnica restringida. Azure Key Vault/Vault son opciones; EnvironmentSecretAdapter solo entorno local/CI controlado. Proveedor productivo pendiente.

## Alternatives

Secretos en tablas/config versionada exponen datos y dificultan rotación. Elegir un cloud desde dominio contradice independencia.

## Consequences

Rotación/versionado, revocación, redacción y errores seguros. No pasar secretos al navegador, mensajes de cola o logs. Cache solo memoria y acotada; no evita exposición en host comprometido.

## Trade-offs

Centralizar reduce dispersión pero crea dependencia de disponibilidad y bootstrap de identidad. Diseñar fallo seguro por conector, no fallback en claro.

## Validación y revisión

Infraestructura confirma provider/identidad, permisos y rotación; probar rechazo/expiración sin exponer valores antes de activar conectores.

[Diseño relacionado](../architecture/security.md) · [Preguntas abiertas](../decisions/unresolved.md).
