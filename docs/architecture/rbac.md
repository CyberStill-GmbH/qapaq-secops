# RBAC basado en capabilities

Modelo de autorización: ACCEPTED por
[ADR-017](../adr/017-identity-and-authorization.md). Schema físico y catálogo final
por endpoint: PROPOSAL en [ADR-009](../adr/009-capability-rbac.md).

## Modelo

access es dueño de users, roles, permissions, user_roles y role_permissions.
Usuario local referencia `tid + oid` de Microsoft Entra ID, no email mutable.
Roles dinámicos agrupan capabilities registradas por módulos; un administrador
no crea una capability ejecutable escribiendo un string nuevo en la base.

Asignación puede tener ámbito, vigencia y estado. Una capability responde «qué»;
scope y política del recurso responden «sobre cuáles». ABAC limitado a atributos
necesarios y probados, sin construir lenguaje de políticas general en MVP.

Evaluación: identidad activa → asignaciones vigentes → capabilities explícitas →
scope del recurso → restricciones de campo/estado → decisión. Deny por defecto.
Múltiples roles aportan unión de grants válidos dentro de sus scopes; prohibiciones
globales (suspensión, hold, segregación) prevalecen. No inferir jerarquías por nombre
ni usar wildcard * persistente para administradores. Desde la actualización
operativa de 2026-10-06, `qapaq.platform.admin` recibe la unión explícita de
todas las capabilities SOC registradas actualmente en el runtime. Es una lista
finita y probada, no una herencia automática de capabilities futuras.

## Catálogo por concretar

- alerts.read, alerts.acknowledge, alerts.close.
- notifications.read, notifications.retry y notifications.manage; la entrega
  técnica no concede permiso para acusar una alerta.
- incidents.read, incidents.create, incidents.assign, incidents.close; incidents.reopen propuesto para reapertura.
- cases.read, cases.create, cases.update.
- rules.read, rules.create, rules.update, rules.enable, rules.disable.
- integrations.read, integrations.manage.
- users.read, users.manage; roles.read, roles.manage.
- audit.read, audit.export; reports.read, reports.generate.
- Capacidades adicionales propuestas por riesgos: events.read, evidence.read, evidence.export, retention.manage, retention.hold, platform.health.read.

ADR-017 acepta las capabilities críticas y la separación raw/export/JIT/SOAR. El
catálogo restante es propuesta contractual; no endpoints ni permisos instalados.
No permitir audit.export implícito por audit.read, ni evidence.read por events.read.
Cada endpoint declarará un conjunto con semántica allOf/anyOf explícita.

## Bundles aceptados

- SOC_L1: lectura/triaje en scope, notas y creación de incidente; sin reglas, raw export, cierres críticos ni administración.
- SOC_L2: investigación, lifecycle y evidencia; exportación raw y aprobación propia no son automáticas.
- SOC_MANAGER: supervisión y aprobaciones operativas; no administración técnica o de identidad implícita.
- DETECTION_ENGINEER: diseño/prueba/versionado de reglas; publicación crítica revisada.
- AUDITOR: audit.read y reportes aprobados; exports requieren permiso explícito y propósito; sin mutaciones SOC.
- VIEWER: lectura de vistas/alertas permitidas; sin raw, secrets, exports ni administración.
- PLATFORM_ADMIN: recibe las capabilities SOC actualmente registradas, incluidas las de auditoría sensible y escritura de secretos; no obtiene capabilities futuras, administración de usuarios/roles ni control de identidad hasta que se implementen y autoricen explícitamente.
- ACCESS_ADMIN: grants, scopes, suspensión y sesiones; no puede autoasignarse ni aprobar solo privilegios.

Son bundles aceptados; cada capability y endpoint requiere matriz y prueba antes
del seed productivo. Detalle en [identidad y autorización](identity-and-authorization.md).

## Evitar autoescalada y roles obsoletos

`roles.manage` autoriza administrar dentro de un conjunto otorgable; no autoriza
otorgarse cualquier permiso ni borrar restricciones. Aplicar doble control para
asignaciones privilegiadas, con iniciador distinto del aprobador. La doble
aprobación, JIT y separación de funciones están aceptadas. Evitar eliminar
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
