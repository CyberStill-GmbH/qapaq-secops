# Identidad, sesiones y autorización

Estado de decisión: ACCEPTED por [U-003](../decisions/unresolved.md) y
[ADR-017](../adr/017-identity-and-authorization.md). Fecha de decisión aportada:
2026-09-18. Estado operacional: **BLOCKED UNTIL FEDERATION TESTS PASS**.

La aceptación define el contrato de seguridad. No demuestra que existan tenant,
app registration, licencias, Conditional Access, PIM, credenciales ni federación
probada en QAPAQ.

## Responsabilidades y organización

QAPAQ SecOps es una aplicación interna single-tenant. Microsoft Entra ID es el
único IdP humano ordinario y administra autenticación, credenciales, MFA,
recuperación de cuenta, Conditional Access, estado corporativo, dispositivos,
riesgo de identidad, revocación del proveedor y grupo inicial de admisión.

QAPAQ SecOps administra roles funcionales, capabilities, scopes, políticas por
operación, separación de funciones, aprobaciones, acceso temporal, autorización
sobre recursos, auditoría, revocación local y sesiones de aplicación. No guarda
passwords humanos ni ofrece autenticación local alternativa ordinaria.

La única organización de seguridad es `QAPAQ`. Filiales, agencias, unidades,
áreas y equipos son scopes de autorización, no tenants. No se propaga un
`tenant_id` empresarial ficticio por el dominio.

## Identidad y restricción del tenant

La identidad local se vincula mediante `entraTenantId + entraObjectId`, usando
los claims estables `tid` y `oid`. Email, UPN, nombre y username son atributos
descriptivos mutables y no identificadores primarios.

El endpoint de autenticación usa el tenant ID corporativo explícito; no usa
`/common` ni `/consumers`. Validar firma, issuer, audience, tenant ID, expiración,
not-before, nonce, state, PKCE y redirect URI exacta. Invitados y cuentas externas
se bloquean por defecto. Una excepción externa requiere aprobaciones de Identity
y Security, expiración, scope restringido, justificación, auditoría y revisión.

Pertenecer al tenant no concede acceso. La admisión exige simultáneamente:

1. membresía del grupo corporativo autorizado, denominado conceptualmente
   `QAPAQ-SecOps-Users`;
2. asignación local activa de rol y scope.

Identity administra el grupo. La aplicación verifica o sincroniza la admisión sin
sustituir al directorio.

## Flujo BFF y sesión

Se adopta OIDC con OAuth 2.0 Authorization Code, PKCE S256 y Backend for Frontend:

```text
Browser → NestJS BFF → Microsoft Entra ID → authorization code
        → NestJS intercambia code → sesión server-side → cookie segura
```

React no recibe ni almacena access tokens, refresh tokens, ID tokens ni client
secrets. No se guardan tokens o secretos de sesión en localStorage, sessionStorage
ni IndexedDB. Los tokens de Microsoft permanecen en backend y se cifran en el
almacén de sesión cuando deban persistirse.

La sesión es opaca y server-side. La cookie `__Host-qapaq_session` contiene solo
un identificador aleatorio y usa `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` y
ningún atributo `Domain`.

La sesión conserva como mínimo subject ID, `tid`, `oid`, authentication time,
authentication strength/context, grants y scopes activos, authorization version,
creación, última actividad, expiración absoluta y estado de revocación.

| Control | Valor inicial |
| --- | ---: |
| Inactividad | 30 minutos |
| Expiración absoluta | 8 horas |
| Aviso previo | 2 minutos |
| Vigencia de step-up privilegiado | 15 minutos |
| Cache de autorización | máximo 60 segundos |
| Sesiones concurrentes por usuario | 3 |

El timeout absoluto exige nueva autenticación. Polling, WebSocket y actividad
automática no renuevan la inactividad; solo actividad humana relevante puede hacerlo.

Toda mutación requiere token CSRF synchronizer o double-submit, validación de
Origin/Referer, CORS con allowlist exacta, SameSite, Content Security Policy,
protección de frames y headers seguros. `HttpOnly` no sustituye CSRF.

## MFA y Conditional Access

MFA es obligatorio en producción. Operaciones privilegiadas exigen autenticación
resistente a phishing, preferentemente FIDO2, passkey administrada, Windows Hello
for Business o certificado. SMS/OTP no bastan para acciones críticas cuando QAPAQ
disponga de métodos resistentes a phishing.

Según licencias y operación confirmadas por Identity, producción exige usuario
activo, MFA, dispositivo administrado/compliant, riesgo aceptable y ubicación/red
permitida cuando corresponda. Identity debe confirmar Conditional Access,
authentication strengths, device compliance y PIM antes de producción.

## Usuario local y autorización

`User` contiene `id`, `entraTenantId`, `entraObjectId`, `displayName`, `email`,
`status`, `authorizationVersion`, `lastLoginAt`, `lastDirectorySyncAt`, `createdAt`
y `updatedAt`; no contiene password hash. Estados: `PENDING`, `ACTIVE`,
`SUSPENDED`, `REVOKED`.

Se adopta RBAC + scoped capabilities + policy-based authorization:

```text
subject + capability + resource + scope + context = ALLOW | DENY
```

Deny-by-default. Controllers declaran `@Policy`; no comparan un rol con `ADMIN`.
El PolicyGuard es el Policy Enforcement Point HTTP, y los casos de uso sensibles
repiten autorización para impedir bypass desde workers, CLI o llamadas internas.

Scopes aceptados: `ORGANIZATION`, `BUSINESS_UNIT`, `BRANCH`, `TEAM` y
`ASSIGNED_RESOURCES`. Cada grant contiene subject, capability, scope type/id,
conditions, vigencia, otorgante, aprobador, razón y estado. El SOC central obtiene
`ORGANIZATION` solo mediante asignación explícita.

`USER` representa únicamente identidad autenticada y admitida; no es rol operativo
ni concede capabilities.

## Bundles de roles aceptados

- `VIEWER`: dashboards, métricas agregadas y recursos permitidos; sin mutación,
  raw, export, playbooks ni administración.
- `SOC_L1`: lectura y triaje en scope, autoasignación/escalamiento, notas,
  creación de incidente y falso positivo según política; sin cierres críticos,
  reglas, raw export, acciones destructivas ni permisos.
- `SOC_L2`: incluye L1; investiga, modifica lifecycle, correlaciona, administra
  evidencia, ejecuta playbooks de riesgo bajo/medio, solicita acciones críticas y
  resuelve incidentes; no aprueba su acción, asigna privilegios ni exporta raw.
- `SOC_MANAGER`: supervisa, reasigna, aprueba cierres/cambios permitidos y consulta
  métricas; no recibe identidad, secretos o infraestructura automáticamente.
- `DETECTION_ENGINEER`: crea, prueba, versiona y solicita publicación de reglas;
  publicación crítica requiere revisión/aprobación.
- `PLATFORM_ADMIN`: configuración técnica, integraciones, collectors, workers,
  catálogos y rotación autorizada de secret refs; sin aprobación propia, cierres,
  alteración de evidencia, raw export ni aprobación de respuesta crítica.
- `AUDITOR`: audit trail, configuraciones históricas, metadata y reportes
  sanitizados; sin mutaciones, playbooks, usuarios ni raw salvo grant excepcional.
- `ACCESS_ADMIN`: grants, roles no privilegiados, scopes, suspensión, sesiones y
  access reviews; sin autoasignación ni grants privilegiados de un solo aprobador.

## Privilegios, autoridad y separación de funciones

Capabilities críticas iniciales:

```text
access.grant.privileged       access.revoke
session.revoke.all            raw_event.read
raw_event.export              incident.export.sensitive
audit.export                  detection.publish
playbook.execute.high         playbook.execute.critical
playbook.approve.high         playbook.approve.critical
integration.configure.critical integration.secret.rotate
```

| Asignación | Solicitante | Aprobación requerida |
| --- | --- | --- |
| VIEWER | Manager/Access Admin | Access Admin |
| SOC_L1 | SOC Manager | Access Admin |
| SOC_L2 | SOC Manager | Access Admin + Security |
| SOC_MANAGER | Security management | Identity + Security |
| DETECTION_ENGINEER | SOC Manager | Security |
| PLATFORM_ADMIN | Platform lead | Identity + Security |
| AUDITOR | Audit management | Identity + Security |
| ACCESS_ADMIN | Identity/Security | Identity + Security |

Cada asignación registra solicitante, aprobador, justificación, ticket, scope,
inicio, expiración/revisión y resultado. El sistema impide autoasignación,
autoaprobación, aprobación por el ejecutor, alteración de evidencia por Platform
Admin, autopublicación crítica por Detection Engineer, autoaprobación SOAR por
SOC_L2 y grants privilegiados de un solo Access Admin.

Capabilities críticas son elegibles, temporales, justificadas, aprobadas, ligadas
a ticket/incidente, protegidas por step-up y auditadas. PIM gobierna grupos/roles
corporativos si está disponible; capacidades internas usan JIT equivalente.
Activación máxima inicial: 1 hora. Extender exige nueva aprobación.

Acciones SOAR altas/críticas exigen requester distinto de approver, capabilities
separadas, step-up vigente, target, razón, incident ID, preview/dry-run cuando
exista, parámetros, expiración, idempotency key y auditoría. Cambiar playbook,
versión, target, parámetros sensibles, actor o incidente invalida la aprobación.

## Raw y exportaciones

`raw_event.read` no es implícito para roles SOC. La vista ordinaria usa eventos
normalizados/minimizados. Raw evalúa scope, clasificación, necesidad, fuente, PII,
incidente y grant temporal; todo acceso sensible se audita.

Exportaciones raw/sensibles están deshabilitadas por defecto. Exigen capability,
scope, razón, ticket/incidente, step-up, aprobación cuando corresponda, filtro
temporal, manifest, clasificación, auditoría y expiración. Se ejecutan como jobs.
El archivo se cifra, lleva checksum, expira, limita descargas, registra cada
descarga, evita URLs permanentes y excluye secretos/campos prohibidos. Un reporte
sanitizado de auditoría no concede exportación raw.

## Identidades de servicio

`SERVICE_COLLECTOR`, `SERVICE_WORKER`, `SERVICE_INTEGRATION` y
`SERVICE_ANALYTICS` son independientes de humanos: sin login frontend ni roles
humanos, con capabilities mínimas, scope explícito, certificado/workload identity/
credencial administrada cuando exista, rotación, revocación individual y auditoría.
No se comparte una única service account entre integraciones.

## Versionado, revocación y directorio

Cada usuario tiene `authorizationVersion`; la sesión conserva la versión de
creación. Un cambio de rol, grant, scope o estado incrementa la versión, invalida
cache y deja de autorizar sesiones antiguas. Cambios críticos revocan todas las
sesiones. El cache nunca supera 60 segundos.

La aplicación soporta revocar una/todas las sesiones, suspensión local inmediata,
revocación/expiración de grants, cierre de WebSockets, cancelación de exports y
aprobaciones pendientes. El bloqueo local de emergencia se aplica en menos de
60 segundos. Para revocación inmediata, Identity revoca Entra y Security suspende
localmente; no se espera solo la expiración del access token.

El delta sync inicial corre cada 5 minutos y copia únicamente `oid`, `tid`, nombre,
email/UPN descriptivo, enabled/disabled y membresía del grupo de admisión. No copia
el directorio completo. Una caída de Graph no concede privilegios; la incertidumbre
sobre una cuenta privilegiada falla cerrada para nuevas operaciones críticas.

No existe contraseña maestra local. Identity administra cuentas break-glass en
Entra. Su acceso a la aplicación permanece fuera del uso cotidiano, requiere
activación explícita, alerta, auditoría, duración limitada y revisión posterior.

## Auditoría

Decisiones sensibles registran actor, subject, capability, resource, scope,
decision, reason, policyVersion, authorizationVersion, requestId, hash de sessionId,
timestamp y outcome. Auditar login/logout/rechazo, sesiones, grants, scopes, JIT,
aprobaciones, step-up, raw, exports, SOAR, denegaciones críticas y break-glass.
Nunca registrar tokens, cookies ni secretos.

## Pruebas mínimas de producción

La federación/autorización queda operacionalmente comprobada solo cuando pasen:

1. usuario autorizado entra con Entra ID y MFA;
2. usuario del tenant sin grupo de admisión es rechazado;
3. usuario externo es rechazado por defecto;
4. issuer incorrecto es rechazado;
5. audience incorrecta es rechazada;
6. token de otro tenant es rechazado;
7. token expirado es rechazado;
8. login sin PKCE/state/nonce válido es rechazado;
9. React no recibe tokens de Entra;
10. cookie aplica atributos seguros;
11. mutación sin CSRF es rechazada;
12. VIEWER no modifica alertas;
13. SOC_L1 hace triaje dentro de scope;
14. SOC_L1 no accede a otra agencia fuera de scope;
15. SOC_L2 no aprueba su propia acción crítica;
16. AUDITOR no modifica recursos;
17. PLATFORM_ADMIN no obtiene raw implícito;
18. ACCESS_ADMIN no se asigna capabilities;
19. cambio de rol invalida autorización anterior;
20. suspensión local revoca en menos de 60 segundos;
21. revocación cierra sesiones y WebSockets;
22. step-up expirado bloquea operación crítica;
23. export raw sin aprobación es rechazado;
24. export raw aprobado queda auditado;
25. service identity no usa endpoints humanos;
26. caída de Graph no concede privilegios;
27. denegaciones responden sin filtrar información.

## Gate de producción

Se pueden diseñar endpoints, guards, policies, mocks y pruebas sintéticas. No se
habilitan endpoints productivos hasta que Identity, Security y SOC validen tenant
ID, app registration, redirect URIs, certificados/credenciales, grupo, Conditional
Access, MFA, authentication strength, scopes/matriz, Graph sync, revocación,
step-up, break-glass y las pruebas anteriores.

[RBAC](rbac.md) · [seguridad](security.md) · [API](../api-guidelines.md) ·
[fuentes](../references.md).
