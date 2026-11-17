# 08 · Frontend unificado

**Identidad vigente:** la Q de QAPAQ (negro `#080808`, tinta `#f4f4f5`, ámbar `#c49a5a`) en Wazuh y Ankay; Qapaqzito es la Q con cara. Respond usa el título único **Ankay**.

> Leyenda: **[verificado]**, **[sin verificar]** (existe en el repo, no probado en AWS) y
> **[propuesto]**. Arquitectura general en [02](02-arquitectura.md).

## Sistema visual QAPAQ

![Icono de la aplicación QAPAQ SecOps](../wazuh/dashboard/assets/svg/qapaq_app_icon.svg)

La guía [Identidad visual QAPAQ - Frontend](brand/qapaq-visual-identity.md) fija la paleta (negro, grises y ámbar como único acento), la tipografía del sistema, la Q de QAPAQ y sus variantes, Qapaqzito y la mascota del Analista IA. Los colores de severidad y estado no son de marca.

## Decisión

El **dashboard de Wazuh es el shell**. Lo que ya hace bien no se rehace: Discover, dashboards,
agentes, vulnerabilidades, FIM, MITRE, reglas y gestión de índices. QAPAQ aporta casos, gobierno
y cambios en vivo **dentro** del mismo shell, como plugin nativo de OpenSearch Dashboards (`qapaq_ops`).

**Servido tras CloudFront [propuesto]:** el borde único es CloudFront + WAF. `/` va al Dashboard
(origen: el nodo Wazuh en EC2, por NLB/ALB privado con origen restringido a CloudFront) y `/api`
va a API Gateway HTTP → Lambda. El navegador sigue viendo un solo origen, así que la sesión
(cookie, CSRF) funciona *same-origin* como hoy. Ni el Dashboard ni el Indexer se exponen a
Internet.

## Estado del repositorio (revisado el 2026-10-22; migración a AWS propuesta)

La fuente versionada del frontend de demo es el overlay `wazuh/dashboard/` de este repositorio,
compilado contra **Wazuh 4.14.8 / OpenSearch Dashboards 2.19.6**. El repositorio externo
`qapaq-dashboard` y su base Wazuh 5.x / OSD 3.x son una línea de migración separada: no se mezclan
en el artefacto actual por incompatibilidad de plugins y protocolos.

| Pieza | Dónde | Estado (código) |
| --- | --- | --- |
| Marca QAPAQ y navegación de Wazuh | `wazuh/dashboard/patches/`, `assets/`, `plugins/qapaq_ops` | Overlay fijado a OSD 2.19.6 |
| Login QAPAQ y rutas de dashboard | `plugins/qapaq_ops/server` y `wazuh/edge/` | Se conserva el flujo de identidad existente |
| Vistas SOC: alertas, incidentes, notificaciones, auditoría, usuarios/sesiones y fuentes | `plugins/qapaq_ops/public/components/` | Compiladas dentro del dashboard |
| Solicitud y aprobación de roles | `plugins/qapaq_ops/public/components/access_view.tsx` + `apps/api/src/soc/admin-role-grants.controller.ts` | En rama de trabajo; pendiente PR, CI y despliegue |
| Cliente de la API (same-origin, cookie, CSRF, contrato) | `plugins/qapaq_ops/public/api/` y `common/api_contract.ts` | CSRF se obtiene de la sesión QAPAQ |
| Edge nginx y Security plugin (proxy auth) | `wazuh/edge/` y `wazuh/indexer/security/` | Fuente del despliegue en este repo. En AWS, CloudFront hace de borde público; nginx queda solo como proxy auth local del nodo [propuesto] |

**`apps/web` se eliminó** (`4eab88f`): sus vistas viven en el plugin `qapaq_ops`.

## Contrato frontend ↔ backend (verificado contra `apps/api`)

| Llamada del plugin | Endpoint del backend | Resultado |
| --- | --- | --- |
| `GET /auth/session` (identidad, capacidades, `csrfToken`) | `auth.controller.ts:111` | ✓ Mismos campos |
| `GET /alerts?status&priority&q&pageSize=50&cursor` | `soc.controller.ts:97` | ✓ Filtros y paginación (máx. 200) |
| `GET /alerts/:id` → `{alert}`; `POST /alerts/:id/commands {name, expectedRevision, …}` | `:144`, `:155` | ✓ Comandos, veredictos y estados iguales |
| `POST /incidents {alertId, title, severity, summary, expectedAlertRevision}` | `:190` | ✓ |
| `GET /incidents`, `GET /incidents/:id`, `POST /incidents/:id/commands` | `:287`, `:232`, `:326` | ✓ |
| Tareas, notas y timeline (`pageSize=200`) | `incident-work.controller.ts:111–279` | ✓ Incluye `openRequiredCount` y `transitions` |
| `GET /audit/events`, `GET /audit/verify` | `audit.controller.ts` | ✓ |
| `GET /admin/users`, `GET /admin/sessions`, `POST /admin/sessions/:ref/revoke {reason, expectedRevision}` | `admin-*.controller.ts` | ✓ |
| `GET /sources/health` → `{checkedAt, sources}` | `sources-health.controller.ts` | ✓ |
| Login `/api/auth/start?returnTo=`, retorno con `authError`, `correlationId` y `sessionNotice=superseded` | `auth.controller.ts`, `return-to.ts` | ✓ `safeReturnTo` acepta rutas del dashboard |
| Logout: `/qapaq/logout` → `GET /auth/session` (CSRF) → `POST /auth/logout` | `auth.controller.ts:152` | ✓ |
| Proxy auth: `GET /api/auth/introspect` → 204 con `x-qapaq-user` y `x-qapaq-roles` | `apps/api/src/soc/auth.controller.ts`, edge y Security plugin | Verificar con el runbook de release en el entorno objetivo; el build no prueba identidad en vivo |
| Administración de roles: grant, solicitud, bandeja y aprobación | `/api/admin/users/:oid/role-grant`, `/api/admin/users/:oid/role-requests`, `/api/admin/role-requests` | En esta rama; no afirmar que está desplegado hasta aprobación del PR y migración de BD |
| Analista IA (`common/ai_investigations.ts`, `public/api/ai_investigations.ts`): `GET /ai-investigations?status&cursor&pageSize`, `GET /ai-investigations/:id`, `POST /ai-investigations {alertId}` (`created=false` ⇒ corrida reutilizada), `POST /ai-investigations/:id/{cancel,retry} {expectedRevision}`, `GET /ai-investigations/budget`, `GET`/`PUT /ai-investigations/settings {settings, expectedRevision}`, `GET /ai-investigations/:id/report`, `GET /ai-investigations/digest?from&to`, `GET /ai-investigations/activity` (`common/ai_activity.ts`) | Backend implementado en local, apagado por defecto (`apps/api/src/assistant/ai-investigations.controller.ts`, 2026-11-14; ver docs/27) | [sin verificar] UI local contra el contrato acordado; capacidades `investigations.read`, `.run`, `.configure`. Un 404 se muestra como «no habilitado o publicado». Costos siempre rotulados como estimados (facturación no conectada). El prefijo `ai-investigations` está en la allowlist de los tres edges |

**Endpoints del backend que el plugin todavía no usa:**

| Endpoint | Para qué | Prioridad |
| --- | --- | --- |
| `GET /api/changes` (long-poll; SSE en fase 2) | Cambios en vivo, el diferencial frente al auto-refresh de OSD | **Alta** |
| `GET /api/notifications`, `POST /api/notifications/:id/acknowledge` | Bandeja y acuse humano (N6) | Alta |
| `/api/me/push/*` | Avisos en el dispositivo | Media |
| `GET /api/incidents/:id/alerts` | Alertas vinculadas en una sola llamada | Media |
| `GET /api/operations/health` | Salud operativa | Media |
| `GET /api/admin/users/:oid` (sesiones de una persona) | Detalle para revocar | Baja |
| `/api/admin/users/:oid/role-requests` + `/api/admin/role-requests/:id/{approve,reject}` | Solicitud con SoD, aprobación separada, auditoría y revocación al completar ([04](04-identidad-y-acceso.md)) | En rama; la aprobación privilegiada requiere step-up aún no disponible |

## Riesgos detectados

1. **Compatibilidad de versión.** Mantener el artefacto de demo fijado a Wazuh 4.14.8 / OSD 2.19.6.
   La migración al repositorio `qapaq-dashboard` y a Wazuh 5.x / OSD 3.x requiere una rama y un
   ciclo de compatibilidad propios, con sus plugins recompilados y pruebas de integración; no forma
   parte del build de demo actual.
2. **Colisiones de rutas `/api/*`.** OSD, el plugin de Wazuh y los plugins incluidos usan sus
   propias `/api/*`. El edge enruta a QAPAQ solo una allowlist de prefijos. **Hay que verificar
   `/api/notifications`:** el plugin *Notifications* de OSD (que el fork incluye vía
   `wazuh-dashboard-notifications`) usa ese prefijo. Si colisiona, se restringe la regla de nginx
   a las rutas exactas de QAPAQ (`/api/notifications` y `/api/notifications/<uuid>/acknowledge`) o
   se renombra la ruta del backend.
3. **Dos edges.** `qapaq/deploy/nginx/qapaq-dashboard.conf` (fork, apunta a KrakenD) y
   `wazuh/edge/qapaq-edge.conf` (este repo, directo a la API). **Fuente de verdad:** `wazuh/` en este
   repo; el fork conserva solo código. En AWS [propuesto] el borde público es CloudFront (rutas `/` y
   `/api`) y la allowlist de prefijos `/api/*` se traslada a sus *behaviors*; KrakenD se retira.
4. **Roles distintos.** El fork da `wazuh-archives-*` (raw) también al analista. Este repo lo
   reserva al líder (minimización, N2). Hay que unificar en `wazuh/indexer/security/`.
5. **Cambios en vivo (actualización local 2026-11-11).** La auditoría anterior observó que el
   plugin no consumía `/api/changes`. El código local ya incluye un `ChangeFeed` compartido por
   las apps QAPAQ y el aviso P1; los consumidores recargan alertas, incidentes, notificaciones,
   salud de fuentes y sesiones por sus endpoints normales. Esto no prueba la latencia ni el
   funcionamiento del servicio desplegado; ver el estado y sus límites abajo.
6. **Proxy auth con la API en Lambda [propuesto].** Cada petición al Dashboard dispara
   `GET /api/auth/introspect`. Con Lambda añade latencia y arranques en frío: se mantiene el
   caché de 5 s en el edge del nodo y se evalúa concurrencia provisionada para esa ruta. La
   revocación en ≤ 5 s debe re-medirse en este camino ([04](04-identidad-y-acceso.md)).

## Vínculos entre SIEM y casos

Desde una alerta QAPAQ se abre Discover filtrado por entidad y ventana
(`app/data-explorer/discover#?_q=(query:'data.office365.UserId:"…"')`). Desde un documento de
Wazuh, un *field formatter* del plugin abre `/app/qapaq-alerts?id=<id>`.

## Cambios en vivo

- **API local:** `GET /api/changes?after=<cursor>` usa long-poll de hasta 2,5 s y una secuencia
  basada en auditoría. El feed entrega referencias de recursos, no su contenido; cada consumidor
  vuelve a consultar el endpoint autorizado de alertas, incidentes, notificaciones, fuentes o
  sesiones.
- **Plugin local:** un solo `ChangeFeed` por página del Dashboard comparte la consulta entre las
  apps QAPAQ y el aviso P1. Las vistas activas se refrescan cuando cambia un recurso relevante; una
  pestaña oculta pausa las consultas y el regreso a primer plano las reanuda. Ante errores, el feed
  aplica backoff; no es una garantía de entrega instantánea ni una cola durable de cambios.
- **Despliegue:** esta implementación local no está validada en el Dashboard publicado ni en AWS.
  Si se retoma API Gateway HTTP con Lambda, hay que verificar el límite del long-poll, consumo de
  invocaciones y latencia real antes de declarar el mecanismo operativo. El SSE de respuesta no se
  considera disponible en API Gateway HTTP; las alternativas quedan sujetas a la decisión
  [10](10-decisiones.md).

## Investigación de alertas

`/app/qapaq-alerts?id=<alerta>&investigate=1` (botón «Investigar» del detalle y de las alertas
vinculadas a un incidente) y `/app/qapaq-alerts?investigate=1&entity=<tipo>:<valor>&at=<ISO>` (pivote
por entidad). Rutas del servidor del plugin, siempre `asCurrentUser` (proxy auth, nunca admin):

| Ruta | Qué hace |
| --- | --- |
| `GET /api/qapaq_ops/investigation/source?ruleId&at&description` | Documento de origen en `wazuh-alerts-*` (regla + descripción ±5 min; la API de alertas no guarda el `_id`) |
| `GET /api/qapaq_ops/investigation/related?e=<tipo:valor>&at&window=1h\|24h\|7d&exclude` | Línea de tiempo de la misma entidad (equipo, usuario, IP, proyecto Snyk, zona Cloudflare, cuenta) y conteo por entidad |
| `GET /api/qapaq_ops/investigation/event?id` | JSON del documento fuente para el visor, saneado y limitado a 64 KiB UTF-8; elimina recursivamente `full_log` y `previous_output`, además de los campos M365 sensibles |

La vista muestra el logotipo del origen, chips MITRE (enlazan a attack.mitre.org), entidades con
pivotes (Threat Hunting, Discover, alertas QAPAQ, investigar la entidad), el chip **Riesgo** del
correlador (`/api/risk/entities`, solo si responde), un visor JSON plegable del documento fuente
saneado y limitado a 64 KiB UTF-8, el incidente vinculado con sus notas (API de incidentes) y «Preguntar
a Qapaqzito» (evento `qapaq:qapaqzito:ask`, ver
`common/qapaqzito_bridge.ts`).

La selección de entidades que aparece como pivotes queda alineada con el límite de consulta: se usan
como máximo ocho y la misma selección alimenta el KQL de Threat Hunting/Discover y la búsqueda de la
timeline. Las pruebas focalizadas del plugin y la suite Vitest integrada pasaron en la validación
local del 2026-11-11; esto cubre código local, no una investigación M365 real ni el Dashboard
desplegado.

El origen de una alerta usa `_id` exacto cuando está disponible. Como la API de alertas no conserva
siempre ese ID, el fallback consulta `ruleId + description` dentro de ±5 min; si no encuentra hit,
reintenta sin descripción y elige el timestamp más cercano. No exige una coincidencia única, por lo
que sigue siendo heurístico y puede seleccionar un documento distinto si hay eventos parecidos.

Los reportes de investigación recogen páginas completas de la consulta autorizada antes de exportar;
no se limitan a los eventos que el analista ya cargó en la timeline. La colección se hace desde el
navegador con la identidad actual de OpenSearch Dashboards (`asCurrentUser`) y devuelve resúmenes
`InvestigationEventSummary` allowlisted y saneados. El reporte nunca serializa `_source` ni `full_log`;
los campos M365 `Parameters`, `ModifiedProperties`, `response`, `MailboxOwnerUPN`, `recipientList`,
`InternetMessageId` y `NetworkMessageId` se excluyen del visor JSON sin procesar, mientras que los
metadatos de correo que el contrato admite se exponen aparte en el DTO scrubbed.

La UI permite descargar CSV UTF-8 con BOM y separador regional, un libro `.xlsx` OOXML con hojas de
resumen, eventos, actividad agrupada e identificadores exactos de mensaje, o abrir un expediente A4
horizontal para **Imprimir / guardar PDF** desde el navegador. El PDF es la impresión de HTML local:
no existe renderer PDF server-side. La barra de progreso muestra avance por páginas y filas que se
recibieron o serializaron; para XLSX continúa por preparación, XML y empaquetado. Se puede cancelar
la consulta o generación y reintentar tras un error. Un fallo de acceso no produce un reporte parcial.

La consulta conserva en memoria los DTO allowlisted hasta el límite de 10.000 eventos y no crea jobs durables. Con File System Access, XLSX se escribe por bloques en el archivo elegido; sin esa API, usa Blob en memoria con máximo de 50 MiB. La vista PDF se prepara como HTML local y va añadiendo las filas de las tablas en lotes mientras se serializan; al completar abre el diálogo de impresión del navegador. Es una vista previa HTML progresiva, no un PDF parcial ni un renderer server-side. Ninguno de estos flujos se reanuda al cerrar la sesión; no hay artifact store privado ni descarga con ACL de servidor. El CSV conserva los eventos recogidos y distingue el total encontrado.

La timeline y los reportes agrupan **actividad** por entidad coincidente y hasta 15 minutos entre
eventos consecutivos; un evento puede aparecer en varios grupos. El XLSX y el expediente imprimible
añaden **IDs exactos de mensaje**, solo para coincidencias compartidas de `NetworkMessageId`, o de
`InternetMessageId` cuando falta el primero. Solo presentan IDs compartidos por más de un evento;
nunca combinan IDs de red distintos. El CSV solo incluye la agrupación temporal. La cercanía temporal
no demuestra causalidad; un ID coincidente tampoco demuestra hilo ni dirección enviado/recibido. Los
metadatos de correo son opcionales y dependen del esquema y evento del feed de auditoría M365. No se
lee contenido de buzones, y no se ha validado la cobertura de estos campos en un tenant real.

### Paginación e informes locales de investigación (estado al 2026-11-11)

La ruta `related` acepta un cursor de continuación. Cada página tiene hasta 100 resúmenes allowlisted
y usa PIT con `search_after`, timestamp descendente y `_shard_doc` para desempatar dentro del snapshot.
El cursor contiene PIT, posición y fingerprint SHA-256 de entidades, ancla, ventana y exclusión; el
servidor rechaza filtros alterados. Cada página busca con `asCurrentUser`; extiende el PIT por dos
minutos y lo cierra al terminar. Si la consulta se abandona, el PIT vence por keep-alive. La timeline
indica cargados frente al total, permite continuar y conserva lo ya mostrado si una página falla;
el analista puede reintentar la página o reiniciar la consulta. Las páginas del mismo PIT ven un
snapshot fijo; una consulta reiniciada abre un snapshot nuevo del Indexer.

Los botones de reporte recorren las páginas completas desde la primera consulta, con los mismos
filtros y sesión, y muestran progreso monotónico por trabajo recibido. CSV y expediente imprimible
serializan filas en bloques de 250, ceden el hilo de UI entre bloques y actualizan el progreso de
generación; XLSX informa el render por filas y el empaquetado por partes. Cancelar aborta la petición y
la serialización; tras error, el analista puede volver a intentar. Para el límite de 10.000 eventos,
el resultado indica truncamiento y requiere refinar filtros; no se presenta un parcial como completo.
CSV/XLSX/PDF imprimible contienen el resumen de origen y los DTO scrubbed, no el JSON fuente. XLSX y
la impresión incluyen grupos temporales y, cuando existen metadatos opcionales, una sección separada
de coincidencias exactas por ID. El PDF depende del diálogo del navegador; no es generación PDF en
servidor. La sesión no guarda un job durable ni puede reanudar el reporte tras cerrar el navegador.

**Validación:** pruebas locales cubren paginación, cursor, ACL, sanitización M365, formato de reporte,
progreso y cancelación. No equivalen a build/validación visual del Dashboard desplegado, acceso al
Indexer de un tenant real ni comprobación de campos M365 reales.

## Navegación del SIEM (auditoría 2026-11-09)

`common/navigation.ts` + `public/navigation.ts` (`application.registerAppUpdater`): categorías en
español y apps sin servicio ocultas del menú (la URL sigue respondiendo; los permisos siguen en el
Security plugin y la API QAPAQ). Recorrido con lider@qapaq.pe en dev.security.qapaq.pe:

| Categoría | App (id) | Decisión | Motivo |
| --- | --- | --- | --- |
| Resumen | Resumen del SOC (`qapaq-overview`), Resumen del SIEM (`wz-home`), Paneles, Informes PDF del SIEM (`reporting`), Informes programados (`reports-dashboards`) | Se mantienen | Portada, paneles QAPAQ por proveedor e informes |
| Monitoreo | Cola de alertas, Notificaciones, Agentes (`endpoints-summary`), Salud de fuentes | Se mantienen | Vigilancia en vivo |
| Investigación | Incidentes, Threat Hunting, Discover, MITRE ATT&CK | Se mantienen | Datos en `wazuh-alerts-*` |
| Investigación | **Analista IA** (`qapaq-ai-analyst`, tras Incidentes) | Nueva [sin verificar] | Pestañas Actividad (por defecto: mascota `qapaq-ai-analyst-qapaqzito-160.webp`/2x, estado Activo/Detenido/Apagado del proceso que responde, KPI del día de Lima, cola y atraso sin expediente, feed de 24 h con enlaces al expediente y al incidente/alerta; sondeo de 5 s solo con la pestaña visible), Operación (investigaciones, expediente `?id=`, presupuesto del día), Informes (resumen por periodo e informe por investigación en `.md`) y Configuración (modo sombra/asistido/autónomo, acciones y límites; edición solo con `investigations.configure`). `?alertId=` precarga «Investigar alerta» desde el detalle de una alerta |
| Detección | Vulnerabilidades, Malware y rootcheck, FIM, SCA, Inventario, Reglas, Decodificadores, Listas CDB, Probar reglas | Se mantienen | SCA pide elegir agente (estado vacío propio de Wazuh) |
| Cumplimiento | Políticas, Auditoría e integridad, PCI DSS, GDPR, HIPAA, NIST 800-53, TSC | Se mantienen | ~4 000 eventos etiquetados en 30 días |
| Integraciones | Integraciones + accesos QAPAQ por proveedor con su logotipo (Microsoft 365 / Entra ID, Bitdefender, Snyk, Cloudflare, AWS → paneles QAPAQ), Docker | Se mantienen / nuevos | Los accesos abren los paneles QAPAQ |
| Integraciones | Office 365 (módulo Wazuh) | Se mantiene, renombrada | `ActivityFeed.Read` y suscripciones están activos desde 2026-11-10. Confirma la salud y frescura en Salud de fuentes: muestra última lectura correcta, último evento y conteo/último evento por flujo M365. El permiso concedido no garantiza que cada flujo siga recibiendo eventos. |
| — | Módulo AWS de Wazuh (`amazon-web-services`) | Oculta; «AWS» abre el panel QAPAQ | Filtra `rule.groups: amazon` y el receptor QAPAQ usa `aws`: salía siempre vacío |
| Respuesta | **Ankay** (`ankay`, antes «SOAR») | Renombrado | «SOAR» queda como descripción |
| Administración | Usuarios y sesiones, Mi sesión, Grupos de agentes, Estado/Estadísticas/Logs/Configuración del manager, Ajustes de la app SIEM, APIs del manager, Consola API, Roles del manager, Índices, Instantáneas, Consola del Indexer, Editor de visualizaciones, Administración del dashboard | Se mantienen | Uso de administración; Índices/Instantáneas muestran «sin permisos» a roles sin ISM |
| — | Google Cloud, GitHub, Microsoft Graph API | Ocultas | Sin integración (Graph mostraba «Please set up API credentials») |
| — | Clúster | Oculta | Manager de un solo nodo |
| — | Alertas y monitores (`alerting`), Detección de anomalías, Mapas, Notificaciones de OSD, Datos de ejemplo, Acerca de | Ocultas | Sin uso; `alerting` y los canales de OSD daban error de permisos al líder; duplicaban vistas QAPAQ |

Otros arreglos: el título de pestaña ya no repite «QAPAQ SecOps», cada vista QAPAQ fija su migaja de
pan (antes quedaba «Resumen» de la app de Wazuh) y el informe PDF de la app de Wazuh lleva cabecera,
pie y color QAPAQ (`customization.*` en el `wazuh.yml` que escribe `deploy-host.sh` y
`REPORTS_PRIMARY_COLOR` en la imagen).

### Escritura de informes XLSX desde Qapaqzito

Cuando el navegador admite File System Access, el analista elige el archivo y Qapaqzito escribe el XLSX por bloques, esperando el destino entre escrituras y actualizando el progreso con filas ya serializadas. El estado de éxito aparece tras cerrar el archivo. El límite local es 50 MiB y 10.000 eventos. En navegadores sin esta capacidad, se usa descarga Blob en memoria y se comunica esa diferencia.

El PDF de Qapaqzito abre una vista HTML A4 con cabecera/contexto y añade filas en lotes de 250, mostrando el avance y cediendo el event loop entre lotes; al completarse abre la impresión del navegador. La persona elige **Guardar como PDF**. La salida no es un PDF incremental ni se genera en servidor. Cancelar detiene el render y cierra la ventana de trabajo. Para una respuesta sin cita se ofrece **Solo respuesta de Qapaqzito**; un expediente requiere evidencia que la sesión pueda consultar.
