# RBAC basado en capabilities

Estado: PROPOSAL · [ADR-009](../adr/009-capability-rbac.md).

## Modelo

access es dueño de users, roles, permissions, user_roles y role_permissions.
Usuario local referencia subject/issuer corporativo estable, no email mutable.
Roles dinámicos agrupan capabilities registradas por módulos; un administrador
no crea una capability ejecutable escribiendo un string nuevo en la base.

Asignación puede tener ámbito, vigencia y estado. Una capability responde «qué»;
scope y política del recurso responden «sobre cuáles». ABAC limitado a atributos
necesarios y probados, sin construir lenguaje de políticas general en MVP.

Evaluación: identidad activa → asignaciones vigentes → capabilities explícitas →
scope del recurso → restricciones de campo/estado → decisión. Deny por defecto.
Múltiples roles aportan unión de grants válidos dentro de sus scopes; prohibiciones
globales (suspensión, hold, segregación) prevalecen. No inferir jerarquías por nombre
ni usar wildcard * persistente para administradores.

## Catálogo inicial candidato

- alerts.read, alerts.acknowledge, alerts.close.
- incidents.read, incidents.create, incidents.assign, incidents.close; incidents.reopen propuesto para reapertura.
- cases.read, cases.create, cases.update.
- rules.read, rules.create, rules.update, rules.enable, rules.disable.
- integrations.read, integrations.manage.
- users.read, users.manage; roles.read, roles.manage.
- audit.read, audit.export; reports.read, reports.generate.
- Capacidades adicionales propuestas por riesgos: events.read, evidence.read, evidence.export, retention.manage, retention.hold, platform.health.read.

El catálogo es una propuesta contractual; no endpoints ni permisos ya instalados.
No permitir audit.export implícito por audit.read, ni evidence.read por events.read.
Cada endpoint declarará un conjunto con semántica allOf/anyOf explícita.

## Plantillas de roles para validar con SOC

- SOC_ANALYST_L1: lectura de alertas/contexto permitido, acknowledge, creación de incidente/case dentro del scope; no habilitar reglas, exportar raw ni cerrar incidentes por defecto.
- SOC_ANALYST_L2: investigación, asignación/cierre/reapertura y actualización de casos según política; exportación de evidencia es asignación adicional, no automática.
- SOC_ADMIN: administración SOC de reglas/conectores y coordinación; gestión de roles privilegiados sujeta a grant policy y segregación.
- AUDITOR: audit.read y reportes aprobados; exports requieren permiso explícito y propósito; sin mutaciones SOC.
- READ_ONLY: lectura de vistas/alertas permitidas; sin raw, secrets, exports ni administración.
- PLATFORM_ADMIN: salud, configuración técnica permitida y operación; no obtiene lectura de evidencia ni roles.manage automáticamente.

Son bundles recomendados, no matriz de grants aceptada. SOC debe validar recursos,
scopes y conflictos de funciones antes del seed de roles.

## Evitar autoescalada y roles obsoletos

roles.manage autoriza administrar dentro de un conjunto otorgable; no autoriza
otorgarse cualquier permiso ni borrar restricciones. Proponer doble control para
asignaciones privilegiadas, con iniciador distinto del aprobador. Evitar eliminar
el último administrador autorizado sin un procedimiento de recuperación probado.

Cambio de rol incrementa versión de autorización/invalida caches; operaciones
críticas consultan política vigente. Revisar sesiones suspendidas y jobs pendientes
al revocar; descargas revalidan acceso al entregar. Las cuentas técnicas tienen
roles limitados a su fuente/función y sin login interactivo.

## Evidencia de autorización

Cada caso de uso documenta actor, capabilities, scope, recurso, restricciones,
punto de enforcement y auditoría. Probar allow/deny, identidad inválida, recurso
ajeno, campos prohibidos, rol revocado, manipulación de IDs y ejecución diferida.
UI oculta acciones por experiencia de uso; backend sigue siendo autoridad.

[Flujo](../diagrams/05-authentication-authorization.mmd).
