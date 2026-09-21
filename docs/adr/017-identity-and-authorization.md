# ADR-017 — Identidad, sesión y autorización

Estado: Accepted · Fecha de decisión: 2026-09-18, indicada por el usuario.

Decision owners: Security + SOC + Identity.

Estado operacional: BLOCKED UNTIL FEDERATION TESTS PASS.

## Context

U-003 mantenía sin decidir IdP, tenant, sesión, scopes, autoridad de asignación,
revocación y controles privilegiados. Sin esa política, ningún endpoint sensible
podría habilitarse de forma segura. QAPAQ ya trabaja con AD, Microsoft 365 y Graph,
pero el repositorio no demuestra configuración, licencias ni conectividad.

## Decision

Adoptar Microsoft Entra ID como único IdP humano ordinario para una aplicación
single-tenant. Usar OIDC Authorization Code con PKCE S256 y BFF NestJS; React solo
recibe una cookie opaca de sesión server-side. Identificar personas por `tid + oid`.

La aplicación aplica RBAC con capabilities, scopes y políticas por recurso/contexto,
deny-by-default. Roles son bundles; privilegios críticos usan JIT, step-up,
aprobación dual y separación de funciones. La decisión completa, valores iniciales,
roles, revocación y gates está en
[identidad y autorización](../architecture/identity-and-authorization.md).

## Alternatives

Autenticación local duplicaría passwords, MFA, recuperación y bajas. Tokens en el
SPA ampliarían exposición y acoplarían sesión al navegador. Claims de roles Entra
no expresan scopes ni recursos SOC. Un rol ADMIN universal concentra identidad,
configuración, evidencia, exports y SOAR. Multitenancy confundiría agencias con
organizaciones separadas sin requisito.

## Consequences

Identity opera el plano corporativo; QAPAQ SecOps conserva decisión local y
revocación. Se requieren almacén de sesión seguro, CSRF, sincronización Graph,
versionado de autorización, JIT/aprobaciones y auditoría detallada. La pérdida de
Graph no concede nuevos privilegios. La aplicación no guarda passwords humanos.

La decisión está aceptada, pero producción permanece bloqueada hasta demostrar
federación, licencias/políticas, revocación, matriz y los 27 escenarios mínimos.

## Trade-offs

El BFF y la sesión server-side reducen exposición de tokens a costa de estado,
CSRF y operación del almacén. Scopes/JIT/doble aprobación mejoran mínimo privilegio
y blast radius, pero exigen gobernanza y más flujos. Entra reduce autenticación
propia, pero mantiene dependencia operacional del proveedor y de Identity.

## Validación y revisión

Ejecutar el gate de producción del documento canónico con configuración real y
evidencia sanitizada. Revisar ante cambio de IdP, estructura organizacional,
licenciamiento, amenazas de sesión o requisitos de acceso externo. Un test fallido
no revierte la decisión: mantiene bloqueada la habilitación afectada.

[U-003 aceptada](../decisions/unresolved.md) ·
[fuentes consultadas](../references.md).
