# 08 · Brechas y decisiones pendientes

Estado: **registro vivo**. Fecha: 2026-10-02.

Lo que la interfaz necesita y el backend no entrega todavía, más las
contradicciones entre documentación, mock y código. Cada brecha tiene un
identificador para citarla desde los demás documentos.

---

## 1. Contrato de API

Existen **tres contratos distintos** y solo uno funciona:

| Fuente | Prefijo | Errores | Estado |
| --- | --- | --- | --- |
| Código del BFF (`apps/api`) | `/api/*` | catálogo de `packages/contracts` (12 códigos, cuerpo plano con `action`) | **Real** |
| [`API_CONTRACT.md`](../../apps/web/API_CONTRACT.md) / [`admin.ts`](../../apps/web/src/api/admin.ts) | `/api/v1/*` | `UNAUTHENTICATED`, `CAPABILITY_DENIED`, `CSRF_INVALID`… | No existe |
| [`error-catalog.md`](../error-catalog.md) | — | `ERR-AUTH-001`… con cuerpo `{ error: {…} }` | No coincide con el código |

**Decisión de esta especificación:** el frontend se construye contra el BFF
real. `admin.ts`, `mock-admin.ts` y `API_CONTRACT.md` se retiran o se
reescriben para reflejar el contrato real cuando se migre la consola. La
consola C-21 ([`console.tsx`](../../apps/web/src/app/console.tsx),
[`client.ts`](../../apps/web/src/api/client.ts)) ya consume el BFF real y es
el punto de partida técnico; la consola de producto
([`SuperAdminConsole.tsx`](../../apps/web/src/components/admin/SuperAdminConsole.tsx))
aporta la estructura visual.

Diferencias de nombres que la migración debe corregir en el código web:

| Mock | Real |
| --- | --- |
| `events.raw.read`, `events.search` | `events.read_raw`, `events.read` |
| `alerts.acknowledge` | `alerts.triage` |
| `incidents.create`, `incidents.manage` | `incidents.write`, `incidents.close` |
| `severity` de alerta `INFORMATIONAL`…`CRITICAL` | `priority` `P1`…`P4` |
| Estados de alerta `enriching`, `triage`, `investigating`, `confirmed`, `false_positive` | `new`, `acknowledged`, `triaged`, `escalated`, `closed` + `verdict` |
| Estados de incidente `investigating`, `containment`, `eradication`, `recovery` | `open`, `contained`, `eradicated`, `resolved`, `closed` |
| Notificación `delivered`/`retrying`/`failed` + reintento | 7 estados + acuse; sin reintento |
| 8 bundles (`SOC_L1`, `VIEWER`…) | 4 roles `qapaq.*` |

---

## 2. Brechas que bloquean la interfaz

| ID | Brecha | Impacto en UI | Solución propuesta en backend | Mitigación mientras tanto |
| --- | --- | --- | --- | --- |
| B-01 | ~~CSRF no implementado~~ | — | **Resuelta** · [§2.1](#21-registro-de-resolución-b-01-b-02-b-03) | — |
| B-02 | ~~Sin paginación en alertas, incidentes, notificaciones~~ | Los contadores por estado siguen en cliente (B-08) | **Resuelta** · [§2.1](#21-registro-de-resolución-b-01-b-02-b-03) | — |
| B-03 | ~~`/api/auth/callback` responde JSON, no redirige~~ | — | **Resuelta** · [§2.1](#21-registro-de-resolución-b-01-b-02-b-03) | — |
| B-04 | Sesión sin `displayName` ni correo | Barra superior y asignaciones muestran IDs | Guardar `name` y `preferred_username` del `id_token` | `MonoId` del `subjectId` |
| B-05 | Sin `GET /api/incidents/:id` | Enlace profundo de Teams a incidente exige cargar la lista | Agregar la ruta | Cargar lista y buscar |
| B-06 | Cursor de auditoría ignorado; filtros `actorId`, `resourceType`, `resourceId`, `outcome` no cableados | Solo primera página; historial por elemento imposible | Reenviar `cursor` y filtros | Filtro en cliente con `PartialResultBanner` |
| B-07 | Sesión sin expiración visible; el refresco periódico renueva la inactividad | Sin aviso de vencimiento; sesión eterna con la pestaña abierta | `idleExpiresAt`/`absoluteExpiresAt` en la sesión; peticiones de fondo marcadas que no renueven | Pausa del refresco a los 10 min sin interacción |
| B-08 | Sin agregados (conteo por estado/prioridad) | Pestañas y Resumen dependen de la lista completa | Endpoint de conteos | Conteo en cliente |
| B-09 | Notificación sin `aggregateId`, severidad, `createdAt` | No se sabe qué alerta originó la notificación | Exponer `aggregateType`, `aggregateId`, `severity` | Columna omitida |
| B-10 | Sin principal local para `qapaq.platform.admin` | No se prueba esa composición | Agregar al emisor local | — |
| B-11 | Motivo de dominio colapsado en 422/404 genérico | El usuario no sabe qué corregir | Devolver `reason` en el cuerpo (`NOTE_REQUIRED`…) sin romper la no enumeración | Validación previa en cliente |
| B-12 | Comando de incidente desconocido → 500 fuera de catálogo | Error sin `correlationId` | Validar `name` | Enviar solo los seis nombres válidos |
| B-13 | `secrets.write` nunca efectiva (ningún scope la incluye) | Credenciales inalcanzable | Scope de plataforma | Pantalla DOMINIO |
| B-14 | Acuse de notificación no auditado | El acuse no aparece en el historial | Auditar `soar.notification.acknowledge` | La UI no promete que quede registrado |
| B-15 | Sin ruta de eventos (C-14 sin adaptador ni OpenSearch) | Búsqueda de eventos solo en demostración | Adaptador + `GET /api/events` | DOMINIO |
| B-16 | Sin API de salud del pipeline ni cobertura por fuente (C-15) | No se puede afirmar que la ingesta está al día | `GET /api/platform/health` con `evaluateHealth` | "Ingesta: sin datos de salud" |

### 2.1 Registro de resolución: B-01, B-02, B-03

Fecha: 2026-10-02. Rama `fix/bff-login-redirect-pagination-csrf`.

**Cómo se encontraron.** Al levantar el inventario de [01](01-inventario-backend.md)
se contrastó cada ruta del BFF (`apps/api/src/soc/*.controller.ts`) con lo que
necesita la interfaz de [04](04-pantallas.md). Las tres brechas aparecieron leyendo
el código, no en producción. Ninguna prueba las detectaba porque las pruebas
validaban el comportamiento tal como estaba: el callback probaba un `200` con JSON,
las listas probaban que llegaba todo y ninguna mutación probaba un rechazo por
origen.

#### B-03 · El navegador quedaba frente a un JSON tras Entra

| | |
| --- | --- |
| Síntoma | Después de autenticarse en Entra, el navegador mostraba `{"subjectId":…,"capabilities":[…]}` en `/api/auth/callback` y la persona tenía que escribir la URL de la consola a mano |
| Causa | El callback de OIDC es una **navegación de nivel superior**, pero se había escrito como si lo consumiera un `fetch`: `reply.status(200).send({...})` |
| Riesgo | Bloqueaba el flujo real con Entra. Además exponía `subjectId` y la lista de capabilities en una página que queda en el historial del navegador |

**Solución.**

1. `GET /api/auth/start?returnTo=<ruta>` acepta el destino. Lo valida
   [`safeReturnTo`](../../apps/api/src/http/return-to.ts) y lo guarda **del lado
   del servidor**, atado al `state` del handshake y de un solo uso, igual que el
   propio `state`.
2. El callback responde **`303 See Other`** con `Cache-Control: no-store`:
   - éxito: `Set-Cookie` y `Location: <returnTo>`. Si la sesión nueva cerró otra
     abierta, se agrega `?sessionNotice=superseded`;
   - fallo: `Location: <returnTo>?authError=<CÓDIGO>&correlationId=<uuid>`. El
     código es el público del catálogo (`AUTH_FAILED`, `PASSKEY_REQUIRED`,
     `NETWORK_NOT_ALLOWED`, `RATE_LIMITED`), **nunca** el motivo interno
     (`LOCKED_OUT`, `NO_ROLE_ASSIGNED`).
3. La consola C-21 inicia sesión con `returnTo=/console.html` y, si vuelve con
   `authError`, muestra el mensaje **del catálogo**. Solo acepta códigos que estén
   en el catálogo, así que la URL no puede inyectar texto.

**Mitigación del riesgo nuevo (open redirect).** Un parámetro `returnTo` es la
entrada clásica de una redirección abierta. Se rechazan y caen a `/`:

| Entrada | Por qué se rechaza |
| --- | --- |
| `https://evil.example/…` | URL absoluta |
| `//evil.example/…` | relativa al protocolo: el navegador la trata como otro host |
| `/\evil.example` | algunos navegadores normalizan `\` a `/` |
| `/api/…` | la redirección no puede apuntar a la propia API |
| `alerts` | no empieza en `/` |
| más de 512 caracteres o con caracteres de control | entrada anómala |

Además del filtro sintáctico, la ruta se resuelve con `new URL()` contra un
origen de prueba y se exige que el origen resultante no cambie.

#### B-02 · Los listados devolvían todo

| | |
| --- | --- |
| Síntoma | `GET /api/alerts`, `/api/incidents` y `/api/notifications` respondían todas las filas del tenant en cada petición |
| Causa | Los controladores filtraban y ordenaban en memoria, sin límite. La paginación de ADR-016 solo se había aplicado a auditoría |
| Riesgo | Respuestas que crecen sin límite con las alertas cerradas: más latencia, más memoria por petición y un vector de denegación de servicio. La interfaz no tenía forma de pedir "las siguientes 50" |

**Solución.** Paginación por cursor común en
[`pagination.ts`](../../apps/api/src/http/pagination.ts):

- `?pageSize=` de 1 a 200, **50 por defecto**. Un valor fuera de rango o no
  entero se **rechaza** con `422 VALIDATION_FAILED` y `fields: ['pageSize']`, no
  se recorta (ADR-016).
- `?cursor=` opaco; la respuesta agrega `nextCursor` (`null` en la última página).
- **Paginación por clave, no por desplazamiento.** El cursor guarda el instante
  y el `id` del último elemento entregado. Orden: más reciente primero; a igual
  instante desempata el `id`, así que el orden es total. Una alerta nueva que
  llega entre dos páginas no desplaza ni duplica filas.
- El cursor queda **atado al listado y a su filtro** (`alerts:status=new`).
  Reusarlo en otra consulta o alterarlo devuelve `422` con `fields: ['cursor']`.
- El cursor **no concede acceso**: el filtro por tenant y capability se aplica
  antes de paginar. No hace falta firmarlo, porque manipularlo solo puede
  devolver filas que la persona ya puede ver.
- Orden por listado: alertas por `occurredAt`; incidentes por `openedAt` (antes
  salían en orden de inserción); notificaciones por `createdAt`.

La consola C-21 agrega el botón "Cargar más alertas" cuando hay `nextCursor`.

**Lo que no cubre.** Los contadores por estado de las pestañas
([04 · §3.2](04-pantallas.md#32-pestañas-de-estado)) ya no pueden calcularse con
una sola página: siguen pendientes en B-08. El cursor de auditoría (B-06) es un
problema distinto y sigue abierto.

#### B-01 · Las mutaciones no tenían protección CSRF

| | |
| --- | --- |
| Síntoma | Ningún `POST` comprobaba que la petición viniera de la consola. El diseño de identidad lo exigía ([identidad y autorización](../architecture/identity-and-authorization.md), criterio 11: "mutación sin CSRF es rechazada") |
| Causa | La sesión es una cookie que el navegador adjunta sola. `SameSite=Lax` era la **única** barrera |
| Riesgo | `Lax` frena el caso común, pero no un subdominio comprometido del mismo sitio ni un navegador que no lo aplique. En esos casos, una página ajena podía reconocer o cerrar alertas, abrir o cerrar incidentes, acusar notificaciones o cerrar la sesión de la persona |

**Solución.** Dos barreras independientes en
[`csrf.ts`](../../apps/api/src/http/csrf.ts) y
[`session-actor.ts`](../../apps/api/src/soc/session-actor.ts):

1. **Token sincronizado ligado a la sesión**:
   `HMAC-SHA256(clave del proceso, "qapaq.csrf.v1:" + sessionId)` en base64url.
   - Se entrega en `GET /api/auth/session` como `csrfToken`. Esa respuesta solo
     la lee código del mismo origen, porque el BFF no habilita CORS.
   - El cliente lo reenvía en `x-csrf-token` en toda mutación y lo guarda **solo
     en memoria**: no va a `localStorage` ni a una cookie legible.
   - Se compara en tiempo constante.
   - No agrega estado: revocar o reemplazar la sesión invalida el token, porque
     deriva del identificador.
2. **`Sec-Fetch-Site: cross-site` se rechaza** aunque el token sea válido.

Las mutaciones protegidas son:
- `POST /api/alerts/:id/commands`, `POST /api/incidents` y
  `POST /api/incidents/:id/commands`;
- `POST /api/notifications/:id/acknowledge` y `POST /api/notifications/drain`;
- `POST /api/auth/logout`.

Orden de evaluación: primero la sesión (un anónimo recibe `401`, no `403`), luego
el token, y **solo después** el caso de uso. Una petición rechazada no ejecuta ni
audita el comando.

Quedan fuera dos rutas:
- `POST /api/ingest/security-events`: no usa sesión y solo existe en
  `local-development`.
- `GET /api/auth/callback`: es una navegación, y su protección es el `state` de
  OIDC.

Error nuevo en el catálogo
([`catalog.ts`](../../packages/contracts/src/api-error/catalog.ts)):

| Código | HTTP | Mensaje | Acción | Reintentable |
| --- | --- | --- | --- | --- |
| `REQUEST_NOT_VERIFIED` | 403 | "No fue posible verificar la solicitud. Recargue la página e intente de nuevo." | `reload_resource` | no |

**Mitigación residual.** La clave HMAC vive en memoria y cambia en cada
arranque. Hoy es coherente, porque las sesiones también viven en memoria y un
reinicio invalida ambas. Cuando las sesiones pasen al adaptador PostgreSQL, la
clave debe salir del SecretProvider (C-24) y rotarse junto con él. Si no, un
reinicio dejaría sesiones válidas con tokens inválidos.

#### Verificación

| Prueba | Resultado |
| --- | --- |
| [`apps/api/test/bff.spec.ts`](../../apps/api/test/bff.spec.ts): callback 303 a `returnTo`; seis formas de open redirect; fallo con código público y sin cookie; aviso de sesión reemplazada | pasa |
| Mismo archivo: token distinto por sesión; sin token → 403 y la alerta no cambia; token de otra sesión → 403; `cross-site` con token → 403; mismo origen → 201; sin sesión → 401; logout forjado no cierra la sesión | pasa |
| Mismo archivo: recorrido completo por páginas sin repetir ni perder; alerta nueva entre páginas; `pageSize` 0, 201, `abc`, `-1`, `1.5` rechazados; cursor ajeno o alterado rechazado; incidentes y notificaciones paginan | pasa |
| [`apps/web/test/console.spec.tsx`](../../apps/web/test/console.spec.tsx): el cliente adjunta el token solo a mutaciones y lo descarta al cerrar sesión | pasa |
| [`tests/e2e/soc-vertical.spec.ts`](../../tests/e2e/soc-vertical.spec.ts) (Playwright contra el BFF real): el navegador vuelve a `/console.html` tras el emisor; reconocer y triar funcionan con CSRF | 8/8 |
| `pnpm test:unit` · `typecheck` · `lint` · `boundaries` | 620/620 · sin errores · sin errores · sin violaciones |

Las pruebas del BFF inician sesión desde una IP de oficina distinta en cada
caso. El límite real de C-25 (30 callbacks por minuto y origen) no se relajó para
las pruebas: se aisló cada caso.

---

## 3. Funcionalidad planificada sin backend

Documentada en `docs/` y en el mock; **sin dominio**. No se diseñan pantallas
completas hasta que exista; aquí se reserva su lugar.

| Funcionalidad | Grupo del riel cuando exista | Referencia |
| --- | --- | --- |
| Reglas de detección (ciclo de vida, publicación con revisión, simulación, métricas) | ANÁLISIS | `04-rbac-matrix.md`, MER `detection_rules` |
| Accesos: grants, solicitudes, aprobación dual, JIT, revisiones | GOBIERNO | ADR-017, MER `access_grants` |
| Sesiones de otros usuarios y revocación | GOBIERNO | identidad y autorización |
| Playbooks SOAR y aprobaciones | OPERACIÓN | MER `playbook_versions` |
| Casos distintos de incidente | OPERACIÓN | MER `cases`, U-008 |
| Notas y adjuntos de evidencia | dentro de alerta/incidente | RBAC "Attach evidence" |
| SLA y métricas de equipo | Resumen | `operations-and-continuity.md` |
| Exportaciones (job con manifiesto y expiración) | GOBIERNO | ADR-018 |
| Replay de fuente, configuración de conectores | PLATAFORMA | `source-inventory.yaml` |

---

## 4. Contradicciones documentales

| Tema | Documento | Código | Esta especificación sigue |
| --- | --- | --- | --- |
| Concurrencia de sesión | `REJECT_NEW` (rechaza la nueva) | `superseded` (la nueva reemplaza) | Código |
| Ventana de consulta | 24 h por defecto, 30 d máx. (ADR-016) | 90 d (C-14) | Código (90 d), con 24 h por defecto |
| Estados de alerta e incidente | MER aceptado (7 estados cada uno) | 5 estados cada uno | Código |
| Catálogo de errores | `error-catalog.md` | `packages/contracts` | Código |
| Nivel WCAG | sin decidir (U-014) | — | AA provisional |

Cada contradicción debe cerrarse actualizando el documento o el código; la
interfaz no puede seguir a ambos.

---

## 5. Preguntas abiertas

1. **U-008**: cardinalidad alerta↔incidente↔caso. La UI asume lo que hace el
   código: un incidente agrupa N alertas, una alerta pertenece a un incidente.
2. **U-013**: catálogo final de capabilities por endpoint, en particular para
   plataforma (salud, cuarentena).
3. **Directorio de personas** para asignar y reasignar (hoy `assigneeId` es
   texto libre sin validar).
4. **Densidad por defecto**: validar `compacta` en la cola con analistas reales
   en turno.
5. **Idiomas**: solo español base; inglés sin decidir.
