# ADR-013 — Secret management abstraction

Estado: Proposed / C-03 Implemented · Fecha: 2026-09-17; implementación: 2026-09-21.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-13 prohíbe passwords/API keys/tokens directamente en PostgreSQL.

## Decision

Guardar secretRef y metadata mínima; SecretProvider resuelve con identidad técnica restringida. C-03 implementa el puerto neutral, referencias `secret://<namespace>/<name>`, errores seguros, caché por arranque y un adaptador de entorno encapsulado exclusivamente para desarrollo/test. Azure Key Vault/Vault siguen siendo opciones no seleccionadas; el proveedor productivo permanece pendiente.

## Alternatives

Secretos en tablas/config versionada exponen datos y dificultan rotación. Elegir un cloud desde dominio contradice independencia.

## Consequences

Rotación/versionado, revocación, redacción y errores seguros. No pasar secretos al navegador, mensajes de cola o logs. Cache solo memoria y acotada; no evita exposición en host comprometido.

## Trade-offs

Centralizar reduce dispersión pero crea dependencia de disponibilidad y bootstrap de identidad. Diseñar fallo seguro por conector, no fallback en claro.

## Validación y revisión

Las specs de C-03 prueban referencias inválidas, secreto ausente, acceso denegado,
proveedor no disponible, error sanitizado, resolución única y fallo de arranque.
Infraestructura aún debe confirmar provider/identidad, permisos y rotación antes de
activar conectores en producción.

ADR-025 añade el flujo de ingreso humano: el API Gateway acepta la credencial una
sola vez por una operación write-only y la entrega al SecretProvider externo. QAPAQ
persiste solo `secretRef`, fingerprint no reversible y metadata; no existe API/UI de
lectura del valor. El gateway es control plane, no vault. La identidad técnica del
adapter puede resolver únicamente su namespace en runtime y toda rotación se prueba
antes de revocar la versión anterior.

[Diseño relacionado](../architecture/security.md) · [Preguntas abiertas](../decisions/unresolved.md).
