# 04 · Identidad y acceso

## Modelo

- **Entra ID decide quién es la persona y si puede entrar** (grupo SOC y app roles).
  **QAPAQ decide qué puede hacer**: capacidades, scope, SoD y auditoría.
- **Un solo login para todo.** El login TypeScript existente protege la consola de casos **y**
  el dashboard de Wazuh. No hay usuarios locales de Wazuh para personas. Los usuarios internos
  quedan solo para servicios (`qapaq_reader` y `wazuh-wui`) y para el break-glass.

## Flujo

```mermaid
sequenceDiagram
  participant B as Navegador
  participant N as nginx edge
  participant Q as QAPAQ API
  participant E as Entra ID
  participant D as Wazuh Dashboard
  participant I as Wazuh Indexer
  B->>N: GET /app/wz-home
  N->>Q: auth_request /api/auth/introspect (cookie qapaq_session)
  Q-->>N: 401
  N-->>B: 302 /qapaq/login?nextUrl=/app/wz-home (plugin qapaq_ops)
  B->>N: GET /qapaq-api/api/auth/start?returnTo=/app/wz-home
  N->>Q: rewrite to /api/auth/start
  B->>E: Authorization Code + PKCE
  E-->>B: /qapaq-api/api/auth/callback?code&state
  B->>N: callback externo con prefijo /qapaq-api/
  N->>Q: rewrite a /api/auth/callback
  Q->>Q: valida id_token, amr/passkey, grupo, roles
  Q-->>N: Set-Cookie OIDC y de sesión
  N-->>B: reescribe Path OIDC; conserva Path=/ de sesión → 302 return
  B->>N: GET /app/wz-home
  N->>Q: introspect
  Q-->>N: 204 x-qapaq-user, x-qapaq-roles
  N->>D: x-proxy-user / x-proxy-roles (los del cliente se descartan)
  D->>I: misma identidad (proxy auth, noop backend)
```

## Piezas

| Pieza | Estado | Archivo |
| --- | --- | --- |
| OIDC PKCE, `state`/`nonce`, validación RS256, `amr` y passkey fuera de la red | Implementado en API; build/despliegue de esta rama pendiente | `modules/access/src/{oidc-handshake,id-token,sign-in,network}.ts` |
| Sesión opaca (30 min de inactividad, 8 h absolutas, hash en Postgres) | Implementada para producción | `modules/access/src/session.ts` |
| `GET /api/auth/introspect` → 204 con `x-qapaq-user` y `x-qapaq-roles` | Implementado; expuesto al navegador bajo `/qapaq-api/api` | `apps/api/src/soc/auth.controller.ts` |
| nginx `auth_request` y proxy same-origin | Implementado en el edge de Wazuh; smoke de despliegue pendiente | `wazuh/edge/qapaq-edge.conf` |
| Security plugin `proxy` (Indexer y Dashboard) | Integrado en overlay QAPAQ de Wazuh | `wazuh/indexer/security/`, `wazuh/dashboard/opensearch_dashboards.qapaq.yml` |
| Revocación al salir del grupo (Graph delta) | Implementada en runtime | `apps/api/src/runtime/directory-sync.ts` |

## Por qué proxy auth y no OIDC nativo de OSD

| Criterio | OIDC nativo de OSD | QAPAQ como proxy de identidad |
| --- | --- | --- |
| Passkey obligatoria fuera de la red | No | Sí (`network.ts`) |
| Revocación al salir del grupo SOC | Solo al expirar el token | Inmediata: cada request pasa por `introspect` |
| Revocación administrativa de sesión | No | Sí, en `/api/admin/sessions` |
| Auditoría del acceso | Logs de OSD | Cadena hash QAPAQ |
| Esfuerzo | Solo configuración | Configuración más el endpoint, que ya existe |

La configuración OIDC nativa queda como **fallback** documentado en
`wazuh/dashboard/opensearch_dashboards.qapaq.yml` (comentada).

## Mapeo de roles

| Rol Entra (`x-proxy-roles`) | Rol OpenSearch (`roles_mapping.yml`) | Rol Wazuh API (`run_as`) |
| --- | --- | --- |
| `qapaq.platform.admin` | `all_access` | `administrator` |
| `qapaq.soc.lead` | `qapaq_soc_lead` (lectura de `wazuh-*` y AD) | `readonly` + `active-response` (vía QAPAQ, no directo) |
| `qapaq.soc.analyst` | `qapaq_soc_analyst` (lectura de `wazuh-alerts-*`) | `readonly` |
| `qapaq.auditor` | `qapaq_auditor` (lectura sin export) | `readonly` |

## Administración de usuarios: estado, cambio de rol y revocación inmediata

Es un diferencial de negocio: ni Wazuh ni OSD lo tienen. **Cualquier cambio de acceso corta la
sesión al instante, en la consola y en el dashboard.**

### Lo que ya existe en el backend TS

| Función | Endpoint o mecanismo | Archivo |
| --- | --- | --- |
| Padrón del grupo SOC: membresía, `accountEnabled`, rol efectivo **y su origen**, última actividad, sesiones activas y si la sincronización está vieja | `GET /api/admin/users`, `GET /api/admin/users/:oid` | `apps/api/src/soc/admin-users.controller.ts` |
| Sesiones recientes y revocación manual | `GET /api/admin/sessions`, `POST /api/admin/sessions/:ref/revoke` | `apps/api/src/soc/admin-sessions.controller.ts` |
| **Salida del grupo en Entra → revocación automática** | Graph delta → `removedMembers` → `revokeSessionsByOid` (auditado) | `apps/api/src/runtime/directory-sync.ts` |
| Origen del rol: dueño del grupo, grupo admin, binding de deploy o app role de Entra | `explainRole` | `apps/api/src/runtime/role-grants.ts` |

### Lo que falta (fase 1, código TS)

1. **Cambiar el rol desde QAPAQ**: `PUT /api/admin/users/:oid/roles` con `If-Match: <version>`.
   - Persistencia: tabla `role_assignments` (tenant, oid, roles, version, grantedBy, approvedBy,
     reason). Se agrega como origen `qapaq_assignment` en `explainRole`, con precedencia sobre
     `deploy_binding` y `entra_app_role`.
   - Capacidad nueva `users.roles.assign` (Access Admin o Administrador de plataforma).
   - SoD: nadie cambia su propio rol. Subir a `qapaq.soc.lead` o `qapaq.platform.admin` crea una
     **solicitud pendiente** que otra persona aprueba con step-up. Bajar o quitar un rol es
     inmediato, porque reducir privilegio no necesita doble control.
   - **En la misma transacción:** el grant, el `AuditEvent` y `revokeSessionsByOid(oid,
     'ROLE_CHANGED')`. La persona vuelve a entrar y recibe el rol nuevo.
2. **Más disparadores de revocación en la sincronización Graph:**
   - `accountEnabled` pasa a `false` → revocar (`ACCOUNT_DISABLED`).
   - Cambio de app role en Entra (diff de `servicePrincipals/{id}/appRoleAssignedTo` en cada
     ciclo) → revocar (`ENTRA_ROLE_CHANGED`).
3. **Corte en vivo, no en la próxima request.** La revocación publica `session.revoked` en
   `/api/changes`. La consola cierra la sesión al recibirlo. El dashboard la pierde en ≤ 5 s por
   la caché de `auth_request`. OSD con proxy auth no guarda sesión propia, así que no queda una
   sesión zombi (verificar en la demo).
4. **Asociar por OID en el padrón.** La sesión ya guarda `oid` cuando el token lo trae
   (`openSession`), pero `admin-users.controller.ts` todavía agrupa las sesiones por UPN. Hay que
   pasar a agrupar por `oid` para que la vista y la revocación sigan siendo exactas aunque cambie
   el UPN.

### Una sola sesión por persona (ya existe)

- Al abrir una sesión nueva, todas las sesiones `active` previas de la misma persona (mismo
  `subjectId` y tenant) pasan a `superseded` (`modules/access/src/session.ts:119`,
  `secops-runtime.ts:855`). El login redirige con `sessionNotice=superseded` para avisar.
- **En la plataforma unificada se extiende sola al dashboard.** El dashboard no tiene sesión
  propia y usa la de QAPAQ por proxy auth. Si alguien entra desde otro navegador, la primera
  sesión pierde la consola **y** el dashboard (≤ 5 s por la caché del edge). El estado
  `superseded` se ve en «Sesiones» y queda auditado.
- **Riesgo a cerrar (fase 1):** el reemplazo se hace en un bucle después de crear la sesión nueva,
  no de forma atómica. Dos logins casi simultáneos podrían dejar dos sesiones activas. Hay que
  agregar un índice único parcial en Postgres `(tenant_id, subject_id) WHERE state = 'active'` y
  hacer el reemplazo en la misma transacción.

### Estado que ve el admin

| Estado | Regla |
| --- | --- |
| **En línea** | Sesión activa con `lastSeenAt` dentro del idle de 30 min |
| **Inactiva** | Sesión activa pero sin actividad reciente |
| **Sin sesión** | Ninguna sesión activa |
| **Sin rol** | Origen `none`. Entra al grupo, pero QAPAQ la deniega con `NO_ROLE_ASSIGNED` |
| **Deshabilitada en Entra** | `accountEnabled = false` |
| **Fuera del grupo** | `membership = removed`. Sesiones ya revocadas |

## Pendientes y riesgos

0. **IP del cliente detrás del edge (corregido en esta rama).** El edge del host Wazuh llegaba a
   la API por el ALB **público** (`/qapaq-api/`). La API veía la EIP del host como cliente, fuera de
   la cadena de proxies confiables (`10.0.0.0/16`), así que la política de red trataba a todos como
   externos y exigía passkey. Ahora el edge usa Cloud Map dentro de la VPC (reglas
   `public_proxy_to_api` y `api_from_public_proxy`, salida `qapaq_edge_api_origin`), y la API ve la
   IP real del usuario.

1. **Stores en memoria.** El handshake OIDC, el lockout y la clave CSRF se crean en memoria al
   arrancar (`secops-runtime.ts:246-275`). Con más de una réplica, o tras un reinicio, el login y
   el CSRF fallan. Hay que moverlos a Postgres y a Secrets Manager antes de escalar la API.
2. **Coste del `introspect`.** Cada request del dashboard dispara uno. nginx lo cachea 5 s por
   cookie (`proxy_cache`). Una revocación tarda como máximo 5 s en aplicarse.
3. **Cabeceras de confianza.** nginx **borra** las `x-proxy-*` que manda el cliente. El Indexer
   solo acepta proxy auth desde `internalProxies` (127.0.0.1).
4. **Redirect URI.** Entra debe registrar exactamente
   `https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback`. El proxy reescribe el prefijo
   para la API y ajusta `Path` de la cookie OIDC a la ruta pública; ambos comportamientos se
   verifican en los smokes antes de declarar listo el login.
5. **Sin step-up.** No hay reautenticación para acciones sensibles (aprobar SOAR, conceder roles).
   Hay que añadir `max_age`/`prompt=login` en la fase 3.
