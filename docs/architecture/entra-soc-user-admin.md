# Administración de usuarios SOC vinculados a Microsoft Entra

Estado: **requisito confirmado; diseño y UI contra contrato terminados; integración BFF/Entra pendiente**.
Este diseño define la frontera entre pertenencia corporativa, roles QAPAQ y sesiones
observadas. Entra sigue siendo la autoridad de identidad; la consola nunca recibe tokens de
Graph ni muestra a todo el directorio.

## Requisito de alcance

Administración muestra solamente usuarios que pertenezcan al grupo Entra configurado para
QAPAQ SOC (`QAPAQ-SecOps-Users`, ID de objeto en configuración segura). Incluye miembros sin
rol QAPAQ con estado «Sin acceso asignado» para que la brecha de provisión sea visible. No
busca globalmente el tenant ni admite elegir el grupo desde el navegador.

El panel admin necesita:

- lista y búsqueda server-side por nombre/UPN y estado de cuenta;
- rol/capabilities/scope efectivos y vigencia;
- última autenticación de app y actividad humana más reciente;
- estado de cuenta Entra y estado de membresía sincronizada;
- sesiones QAPAQ activas/recientes con inicio, último uso y método MFA; acción auditable
  para revocar sesiones si el permiso lo permite;
- flujo auditado para solicitar/cambiar/retirar role grant con vista previa de impacto.

«Conectado» significa **sesión QAPAQ activa con actividad reciente**, no presencia en
Microsoft Teams ni un dato de Entra. Mostrar `Activo ahora` solo si `lastSeenAt` está dentro
del umbral operativo acordado y la sesión no está revocada ni expirada; de otro modo
`Visto hace …`, `Sin sesión`, o `Estado de sesión no disponible`. La primera versión puede
usar 5 minutos para presencia reciente como valor configurable, no como garantía de que la
persona esté mirando la pantalla.

## Identidad, sincronización y roles

Las claves son `(tid, oid)`; nombre/email/UPN son descriptores mutables. El backend consulta
Graph para el grupo configurado mediante identidad de workload con permisos mínimos de solo
lectura; cursor `deltaLink` y sync state se guardan del lado servidor. No llamar Graph desde
React, no aceptar tokens Graph del usuario y no guardar `accessToken` en tablas/logs.

Graph informa **quién puede acceder** (miembro del grupo). QAPAQ administra **qué puede
hacer** (role grants/scopes y capacidades). La UI distingue los roles de producto presentes
en el token/runtime hoy (`qapaq.soc.analyst`, `qapaq.soc.lead`, `qapaq.auditor`,
`qapaq.platform.admin`) de los bundles de destino documentados (`VIEWER`, `SOC_L1`,
`SOC_L2`, `SOC_MANAGER`, `DETECTION_ENGINEER`, `AUDITOR`, `PLATFORM_ADMIN`, `ACCESS_ADMIN`).
No mostrar un catálogo aspiracional como si estuviera aprovisionado. Una migración debe
mapear los cuatro roles existentes a grants QAPAQ persistidos y versionados antes de retirar
los app roles; no combinar grants y token roles de manera ambigua.

La consola puede iniciar cambios de rol entre miembros del grupo. El grant vive en QAPAQ,
filtrado por alcance y vigencia, con razón/ticket, `authorizationVersion`, actor, aprobador y
auditoría. Mantener la separación ya aceptada: no autoasignación, no autoaprobación; rol
privilegiado requiere aprobador distinto y step-up. Desactivar acceso local revoca sesiones
QAPAQ en el SLA; retirar al usuario del grupo Entra corta nuevas sesiones al sincronizarse y
la política de revocación termina sesiones existentes según el SLA configurado. La consola
no cambia membresía del grupo ni estado global de cuenta en Entra.

## Contratos BFF propuestos

```http
GET /api/admin/users?q=&status=&cursor=&pageSize=50
GET /api/admin/users/{oid}
GET /api/admin/users/{oid}/sessions?cursor=&pageSize=50
POST /api/admin/users/{oid}/role-requests
GET /api/admin/role-requests?status=pending&cursor=&pageSize=50
POST /api/admin/role-requests/{requestId}/approve
POST /api/admin/role-requests/{requestId}/reject
POST /api/admin/users/{oid}/sessions/{sessionId}/revoke
POST /api/admin/users/{oid}/suspend
POST /api/admin/users/{oid}/restore
```

Contrato mínimo de lista para implementar la vista (sin campos Graph innecesarios):

```ts
type EntraSocUser = {
  oid: string; displayName: string; upn: string;
  accountEnabled: boolean; membership: 'member' | 'pending_removal';
  grantStatus: 'active' | 'none' | 'suspended';
  roles: ('qapaq.soc.analyst' | 'qapaq.soc.lead' | 'qapaq.auditor' | 'qapaq.platform.admin')[];
  capabilities: string[]; lastSignInAt: string | null; lastSeenAt: string | null;
  presence: 'active_recently' | 'seen' | 'no_session' | 'unknown';
  activeSessions: number; revision: number;
};
type EntraSocUserPage = {
  items: EntraSocUser[]; nextCursor: string | null;
  lastDirectorySyncAt: string | null; syncStale: boolean;
  presenceThresholdMinutes: number;
};
```

La búsqueda solo indexa miembros sincronizados del grupo, por displayName/UPN; `status`
acepta `all|active|none|suspended` sobre el grant QAPAQ. La lista siempre muestra estado de
cuenta/membresía y presencia en columnas propias. Listar sesiones entrega `id`,
`startedAt`, `lastSeenAt`, `expiresAt`, `revokedAt` y métodos MFA (`amr`), sin tokens.
Una solicitud de rol incluye `action: grant|revoke`, uno de los cuatro roles runtime,
`reason`, `ticket?` y `expectedRevision`; su resultado es siempre `pending_approval` hasta
resolución independiente. La bandeja incluye `requesterOid`, `targetOid`, `approvalStage`
(`access|security`) y `priorApproverOid`. Aprobar/rechazar exige `expectedRevision`, motivo y SoD. Cambiar
capability fuera de catálogo o usar un bundle destino aún no implementado devuelve 422; el
frontend no publica los bundles aspiracionales de ADR-017 como opciones actuales.
Revocar una sesión y suspender/restablecer acceso QAPAQ también exigen `reason` (y la versión
actual del usuario en suspensión/restablecimiento). Suspender corta todas las sesiones
QAPAQ de la identidad dentro de una transacción; revocar termina solo la sesión seleccionada.
Ninguna de estas acciones llama a Entra. El último `ACCESS_ADMIN` no se puede suspender y un
usuario no puede suspenderse ni retirar su propio grant privilegiado.
La revocación responde con la sesión actualizada; suspensión/restablecimiento devuelve al
usuario actualizado con nueva `revision`. Todos devuelven `correlationId`.

Toda ruta deriva tenant y group ID desde config/actor. Lista con cursor en backend y campos
mínimos; `oid` nunca se usa para cambiar a una persona fuera del grupo sincronizado. Las
respuestas incluyen `correlationId`, `lastDirectorySyncAt`, estado fresco/obsoleto y resumen
de capabilities; nunca tokens, secretos o headers Graph. La aprobación recibe `expectedRevision`
y rechaza conflicto/autoaprobación.

Capability inicial a diseñar: `users.read`, `sessions.read`, `sessions.revoke`,
`roles.request`, `roles.approve`, `roles.approve.privileged`, `users.suspend`. Mantener `notifications.dispatch`
independiente. El user request confirma que platform admin debe consultar el roster SOC y
participar en la administración. La asignación objetivo de este bloque es:

| Bundle QAPAQ | Capabilities de administración | Límite |
| --- | --- | --- |
| `PLATFORM_ADMIN` | `users.read`, `sessions.read`, `sessions.revoke`, `roles.request`, `users.suspend` | Puede ver el roster SOC y solicitar cambios; no puede aprobar cambios de rol. No suspende su cuenta ni al último aprobador. |
| `ACCESS_ADMIN` | `users.read`, `sessions.read`, `sessions.revoke`, `roles.request`, `roles.approve`, `users.suspend` | Resuelve grants tras validar solicitante/objetivo/aprobadores y step-up; no autoaprueba ni retira su último grant. |
| Revisor de Seguridad privilegiado | `users.read`, `roles.approve.privileged` | Solo segunda etapa para grants privilegiados, distinto del solicitante, objetivo y aprobador de Acceso. |

`ACCESS_ADMIN` aún no es app role/runtime real. El despliegue de la capacidad requiere bootstrap
auditado de al menos dos aprobadores humanos por proceso separado y prueba de que la pérdida
de uno no bloquea las operaciones ni permite aprobarse a sí mismo. El grant de
`qapaq.platform.admin` requiere una etapa de Acceso y otra de Seguridad, con actores distintos;
`roles.approve` solo no satisface el segundo control si la policy marca el grant como
privilegiado. Cualquier permiso para
editar datos del directorio queda fuera de QAPAQ.

## Persistencia y presencia

Antes de activar el panel: reemplazar el `InMemorySessionStore` de producción por un store
PostgreSQL compartido con optimistic concurrency/revision, persistir sujetos/grants locales,
estado de sync de Graph y membresías (solo campos declarados), revocación y auditoría. El
runtime actual mantiene sesiones en memoria y reemplaza la sesión anterior; la política
documental aceptada `REJECT_NEW` debe reconciliarse antes de presentar presencia precisa o
revocación multirréplica.

Retención de sesiones acorde a política de auditoría; el listado no debe convertirse en un
log de red completo. Guardar IP solo cuando el control de acceso lo requiera, mascarla por
defecto en UI y nunca exponerla a roles generales. Polling automático no refresca la
inactividad de una sesión objetivo.

### Sesiones administrativas disponibles hoy

`GET /api/admin/sessions?pageSize&cursor` y
`POST /api/admin/sessions/{ref}/revoke` cubren C-10(b) sin depender del padrón Graph.
La vista `/admin/sessions` está disponible con `sessions.read`; revocar además requiere
`sessions.revoke`, token CSRF, motivo de 10–500 caracteres y la revisión leída. El API
impide revocar la sesión actual, audita la operación y limita la consulta a los siete días
recientes y 2.000 sesiones. La consola muestra estado de sesión y hora de última solicitud
autenticada; eso no demuestra que la persona esté frente a la pantalla. No presenta IP.

Esta vista permite revisar y contener sesiones existentes. No reemplaza el roster Entra,
no encuentra miembros que aún no iniciaron sesión y no cambia roles; eso requiere C-10(c),
consentimiento de Graph y persistencia de grants. Por tanto `/admin/users` permanece
deshabilitada hasta que su integración pase las pruebas de grupo y autorización.

## Fallos y consistencia

- Graph `429` respeta `Retry-After`, delta cursors y backoff; sync concurrentes usan lease.
- No se interpreta una página parcial como roster completo ni se borra membresía por timeout.
- Si el sync está viejo, marcar datos desactualizados, no permitir grants nuevos privilegiados;
  las decisiones críticas revalidan membresía de frescura permitida.
- Una caída de Graph no revela si un `oid` específico existe. Los errores de login conservan
  la respuesta genérica de no enumeración.
- Suspensión local/role grant/revocación son transacciones QAPAQ auditables y no ejecutan
  cambios a Entra, Microsoft 365 ni licencias.

## Entrega y pruebas

1. Configurar el object ID único del grupo de admisión; aplicar aislamiento single tenant y
   validar membresía sin depender solo del claim `groups` (token overage y sync delta).
2. Implementar lector Graph de solo lectura, delta sync y normalización estable por `oid`.
3. Migrar app-role runtime a role grants locales persistidos con traducción explícita y
   revisión de los cuatro roles actuales.
4. Persistir sesiones/actividad y endpoint de presencia; validar login concurrido,
   expiración, revocación y consistencia entre réplicas.
5. Implementar autorización BFF, UI roster/roles/sesiones, aprobación SoD, auditoría y
   pagination; jamás esconderse tras controles solo client-side.
6. Probar miembro/no miembro, invitado, usuario sin grant, token groups overage, paginación
   delta, Graph timeout/429, group removal, cross-tenant, filtración de token y enumeración.
7. Validar en tenant sandbox autorizado antes de pedir Graph application permissions en el
   tenant corporativo.

La vista React vive en `apps/web/src/components/soc/UserAdministrationPage.tsx`, se monta en
`/admin/users` y requiere `users.read`; cargar sesiones requiere además `sessions.read` y
crear solicitudes `roles.request`. La navegación no aparece para quien no tenga lectura. Aún
no hay endpoint/capability en backend, por tanto no está habilitada en ningún rol actual y
no se deben emitir esas capabilities antes de que sync, grants, sesiones y SoD estén activos.
El selector ofrece únicamente los cuatro roles runtime. La UI no simula roster ni requests;
sin BFF mostrará el error contractual del API.

## Referencias

- [Identidad, sesiones y autorización](identity-and-authorization.md)
- [Matriz de roles](../requirements/04-rbac-matrix.md)
- [Superficie de permisos Microsoft Graph: confirmar mínimo exacto antes del consent](https://learn.microsoft.com/graph/permissions-reference)

