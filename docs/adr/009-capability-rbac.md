# ADR-009 — RBAC capability-based permissions

Estado: Proposed, parcialmente sustituido por ADR-017 · Fecha: 2026-09-17.
Origen: solicitud de arquitectura; detalles recomendados pendientes de revisión.
Aceptación: no registrada; responsables propuestos SOC, Arquitectura, Seguridad e Infraestructura según impacto.

## Context

R-11 requiere roles dinámicos granulares y permisos explícitos por API.

## Decision

Modelo users/roles/permissions/user_roles/role_permissions en access. Catálogo
resource.action, roles dinámicos y scopes; reglas de objeto/campo en aplicación.
Deny por defecto, sin `if role == ADMIN`. [ADR-017](017-identity-and-authorization.md)
acepta el modelo, scopes, bundles, autoridad, JIT y separación de funciones. El
schema físico y catálogo final por endpoint siguen Proposed.

## Alternatives

Roles ADMIN/USER son insuficientes. Claims del IdP solos no representan permisos SOC. Motor ABAC general agrega complejidad innecesaria antes de definir scopes.

## Consequences

Invalidar caches al revocar; reautorizar jobs humanos/descargas. roles.manage no permite otorgar cualquier capability ni autoescalar.

## Trade-offs

Flexibilidad y least privilege a cambio de gobernanza de grants y matriz de pruebas. RBAC no sustituye autorización de objeto ni inventa multitenancy.

## Validación y revisión

Materializar las políticas aceptadas; probar federación, revocación, acceso
cruzado, autoescalada y el gate de ADR-017 antes del primer endpoint productivo.

[Diseño relacionado](../architecture/rbac.md) · [Preguntas abiertas](../decisions/unresolved.md).
