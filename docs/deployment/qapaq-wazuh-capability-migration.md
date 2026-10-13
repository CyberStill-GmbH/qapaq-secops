# Migración de QAPAQ SecOps a la edición QAPAQ Wazuh

Fecha: 2026-10-13. Este documento compara las capacidades descritas y servidas por
`qapaq-secops` con las del plugin Wazuh local (`wazuh-dashboard-plugins` 5.1.0) y fija
dónde deben integrarse. No declara lista una función solo porque exista un contrato o una
pantalla: cada fila conserva su estado real y sus gates.

## Decisión de producto

El artefacto final es una edición de Wazuh con marca QAPAQ. OpenSearch Dashboards y los
plugins Wazuh siguen siendo la plataforma y el motor SIEM. Los módulos de SOC propios de
QAPAQ se integran en el servidor y la UI de los plugins, usando los contratos, reglas y
pruebas existentes de `qapaq-secops`. El navegador nunca accede directamente a Manager,
Indexer ni PostgreSQL.

Las funciones de agentes, inventario, decoders, ruleset, alertas, vulnerabilidades,
compliance, MITRE ATT&CK y ejecución técnica de Active Response permanecen en Wazuh.
No se reescriben ni se duplican en QAPAQ. Las capacidades de negocio se autorizan y
auditan en el servidor QAPAQ; cuando una acción ejecuta Wazuh, QAPAQ valida primero la
capability, el scope, aprobación y razón, y luego invoca la API Wazuh con una identidad
técnica mínima.

## Mapa de capacidades verificadas y portabilidad

La columna QAPAQ separa código de dominio probado, API realmente servida y función que
solo tiene especificación. La columna Wazuh describe el plugin del checkout local: la app
Wazuh corre dentro de OpenSearch Dashboards y consulta Indexer/Manager mediante sus
controladores; no se encontró un backend SOC QAPAQ ya fusionado en este plugin. La ruta
`/api/qapaq/*` existente es un puente configurado hacia el BFF/API actual, no una migración
de esos módulos al proceso Wazuh.

| Capacidad / diferenciador | Código QAPAQ que ya existe | Cobertura nativa Wazuh | Qué se porta/reutiliza en Wazuh | Gate verificable |
| --- | --- | --- | --- | --- |
| Inicio de sesión Entra y sesión SOC | API real `/api/auth/{start,callback,session,logout}`; sesiones opacas, MFA/passkey y política de red están en `apps/api`/`modules/access`, con specs. | Dashboard soporta proveedores de autenticación de OpenSearch Security y tiene login propio; no aplica roles ni sesión de negocio QAPAQ. | Mantener la única vista QAPAQ de login y su flujo BFF; conectar sesión QAPAQ con la sesión OpenID del Dashboard. El resto de pantallas de QAPAQ no se copia. | **Integración**: configuración del IdP/Security, cookie y rutas same-origin, cierre de sesión conjunto, Basic humano bloqueado y pruebas E2E con Entra. La pantalla local por sí sola no prueba federación operativa. |
| Roles, capabilities y sesiones administrativas | Código de autorización/roles, tenant, asignación, revocación y sincronización del padrón; `/api/admin/users`, `/api/admin/sessions` y pruebas en `modules/access`/`apps/api`. | OpenSearch Security controla roles e índices; el plugin Wazuh consume el contexto autenticado de Dashboards. No modela capabilities QAPAQ por caso/acción. | Portar el evaluador y catálogo de capabilities al servidor del plugin y usarlos también para construir navegación. Mantener roles técnicos de OpenSearch para la administración de la plataforma. | **Portabilidad**: todavía falta integrar esas comprobaciones a todas las rutas SOC y definir el mapeo de grupo/app-role Entra en el despliegue. Ocultar enlaces nunca sustituye autorización server-side. |
| Búsqueda de eventos | `/api/events`, lector Indexer, filtros tipados y consulta `qapaq-events-v1`; `modules/connectors` y `modules/telemetry` tienen contratos y specs. Raw se proyecta solo con `events.read_raw`. | Discover/threat hunting ya busca eventos e índices Wazuh; no hace falta otra pantalla general de búsqueda. | Reutilizar Discover, filtros e índices nativos; portar solo el parser/filtros compatibles y reglas de redacción/acceso raw al contexto de permisos QAPAQ. | **Datos**: Indexer y patrón de índices accesibles; el inventario indica que la fuente puede responder `disabled` si no está configurada. Verificar filtros que dependen del grupo de regla Wazuh. |
| Triage, score y priorización | API real de alertas y comandos; los módulos `detection`/`soc` implementan scoring explicable, correlación, promoción, asignación y transiciones; hay specs unitarias. La prioridad consultada depende de eventos Wazuh normalizados y configuración. | Wazuh produce alertas por reglas, severidad y grupos; Case Management permite actualizar campos de caso, pero no equivale al workflow de triage QAPAQ. | Reusar Discover/alertas e índices; migrar lógica de scoring, motivos, ownership, veredicto, revisión optimista y auditoría a una app nativa del plugin. Enlazar por ID del finding/evento; no duplicar la cola. | **Integración funcional**: probar mapeo de documentos y cobertura de reglas/datasets; alinear comando/revisión con el evento de origen; habilitar cada mutación tras autorización por tenant/recurso. |
| Incidente, tareas, notas y timeline | API real `/api/incidents*` y `/api/incidents/:id/{tasks,notes,timeline}`; `modules/soc` contiene lifecycle, concurrencia y almacenamiento PostgreSQL; existen specs unitarias e integración. Notas son append-only y cierre valida tareas requeridas. | Case Management nativo es tabla/findings `wazuh.case.*`, detalle, tags y comentarios editables; las rutas del plugin actualizan el documento del finding directamente. No ofrece el modelo QAPAQ completo. | Conservar la entrada y componentes EUI de Case Management; portar verticalmente el agregado de incidentes y el lifecycle QAPAQ. Hacer del finding una referencia. Reemplazar escrituras viejas con una migración/compatibilidad explícita para evitar dos fuentes mutables. | **Migración de datos y seguridad**: inventariar documentos existentes, mapear estado/comentarios, migrar con repetición y rollback, y cerrar el endpoint de escritura anterior o hacerlo pasar por la política QAPAQ. PostgreSQL/runtime deben estar disponibles. |
| Auditoría de negocio | `/api/audit/events` y `/api/audit/verify`; cadena append-only con secuencia/hash y redacción por capability en `platform/audit`/API, con pruebas de dominio. | OpenSearch/Wazuh tienen logs de seguridad/operación; el plugin no entrega la auditoría QAPAQ por actor, decisión, scope y recurso ni la verificación de su cadena. | Portar el ledger, eventos de auditoría y proyección redactada al servidor Wazuh; conservar los logs nativos como otra fuente, no mezclarlos. | **Producción**: persistencia operativa, retención/backup y acceso auditor deben verificarse. WORM/firmado externo no está probado ni debe afirmarse como disponible. |
| Salud, estado de fuentes y cambios | `/api/sources/health`, `/api/operations/health` y `/api/changes` existen; el runtime evalúa observaciones/checkpoints y tiene specs. Cobertura real es la fuente conectada en el entorno, no un catálogo universal. | Wazuh expone salud de manager, cluster y agentes. No mide por sí solo entrega/frescura por conector externo QAPAQ. | Portar los monitores y agregarlos a las vistas nativas de salud. Reutilizar salud Wazuh para la capa de agentes/cluster. | **Configuración/telemetría**: fuentes activadas, worker de ingesta ejecutándose y observaciones persistidas. `/health/ready` de QAPAQ no certifica PostgreSQL, Redis ni OpenSearch. |
| Office 365 / Microsoft 365 | Wazuh-specific mapping y normalización en `modules/telemetry/src/wazuh-office365.ts`, con tests; Wazuh ingestion/provider y polling están en `modules/connectors`/`apps/api`. La ruta `/api/events` entrega la proyección. | Wazuh tiene módulo Office 365 e ingesta/reglas nativas. | Mantener el módulo nativo de adquisición; reutilizar/migrar el mapper normalizado, deduplicación e identidad de fuente solo donde la edición QAPAQ los necesite, evitando una segunda ingesta del mismo stream. | **Operación**: tenant Graph, credenciales, permisos, checkpoints y fuente activa. Los tests de mapper no demuestran que el tenant entregue eventos en producción. |
| Notificaciones y dispositivos | API real de outbox/acuse, dispatcher Teams, fallback correo y Web Push en `modules/soar`, con tests de transporte y de política. | Wazuh tiene notificación y Active Response configurables, pero no el outbox QAPAQ, acuse humano ni fallback correlacionado por usuario. | Portar el outbox/dispatcher QAPAQ y sus contratos; reutilizar Wazuh para notificaciones puramente técnicas. No duplicar un aviso ya cubierto por la misma política. | **Integración**: endpoint Teams/Graph, correo, VAPID/service worker y destinatarios del padrón. Se requiere prueba con servicios reales; los tests locales no acreditan entrega. |
| SOAR no-code | No hay motor Shuffle en `modules/soar`: existe dispatcher de notificaciones. ADR-028 decide Shuffle y describe el adaptador, pero su ejecución/callback todavía no está implementada. | Wazuh Active Response ejecuta acciones nativas en endpoints; no es un editor general de playbooks ni sustituye Shuffle. | Integrar Shuffle por webhook de salida desde outbox QAPAQ. Portar capability, aprobación, catálogo/versión autorizada, idempotencia, correlación, reconciliación y auditoría. Mantener Active Response como ejecutor nativo permitido detrás del adapter QAPAQ. | **Bloqueante U-008**: implementar adapter/worker/callback, secreto y red privados, autenticación anti-replay, allowlist de workflows/acciones y pruebas timeout/replay/duplicado/revocación. No exponer webhook ni credenciales al browser. |
| Ingesta robusta, cuarentena y replay | Código de normalización, contrato, inbox/outbox, checkpoint, deduplicación y replay de ventana/cuarentena en `modules/telemetry`; tests unitarios e integración Prisma/Postgres. El polling de Wazuh está compuesto en runtime. | Wazuh ingesta sus fuentes nativas y persiste alertas/eventos; no ofrece estos controles QAPAQ de cada manifest/registro. | Portar los módulos de dominio/adapters y worker a la capa server del plugin o servicio privado QAPAQ integrado; no reimplementar el pipeline en UI. | **Gate de producto/runtime**: no hay API de consola para administrar/reprocesar todos estos objetos; worker, Postgres y raw-store deben configurarse. No anunciar cuarentena/replay como listo en UI por tener dominio y tests. |
| Evidencia/raw y retención | `s3-raw-store` implementa almacenamiento raw con hash/referencia y pruebas; `events.read_raw` controla proyección. No aparece una API de exportación/custodia probatoria completa. | Indexer conserva documentos/eventos operativos, no un ledger de evidencia WORM QAPAQ. | Reutilizar referencias/hash y control de lectura; implementar exportación/custodia como módulo server separado antes de exponerla. | **No implementado como producto**: bucket, cifrado/retención/WORM, permisos, recuperación y exportación verificable; no prometer evidencia inmutable. |
| Antifraude, MISP/CTI y Python | No se encontró un módulo de producto/API QAPAQ de antifraude o MISP en el código funcional inspeccionado. La detección actual tiene score/correlación sobre eventos SOC, no un motor antifraude financiero. | El plugin Wazuh ya incluye MITRE ATT&CK, reglas/decoders e integraciones CTI propias; conservarlas si se necesitan. | No portar funcionalidades solo documentadas ni crear un segundo CTI. Añadir una integración concreta al plugin usando componentes existentes solo después de localizar implementación fuente, contratos y casos de prueba. | **No hay código fuente QAPAQ equivalente que migrar**; aprobación de alcance, fuente de datos y requisitos financieros son previos. |

**Resumen de estado:** las capacidades con API/código utilizable para portar ya están en login,
control de acceso, triage/incidentes, auditoría, salud, eventos, notificaciones y modelos de
ingesta. No están aún implementadas dentro del runtime Wazuh por el mero hecho de existir en
QAPAQ o de estar disponibles tras el puente. Shuffle, gestión de evidencia con garantía WORM,
antifraude y MISP propio son gates/no equivalencias, no funcionalidades terminadas.

El inventario funcional real de QAPAQ está en
[`docs/frontend-design/01-inventario-backend.md`](../frontend-design/01-inventario-backend.md).
La clasificación de producto en `docs/requirements/01-capability-map.md` no representa
por sí sola el estado de implementación.

## Reutilización del Case Management nativo

El plugin Wazuh registra `case-management` y presenta findings con los campos
`wazuh.case.title`, `status`, `severity`, `priority`, `user.name` y `tags`; su servidor
lee y escribe esos datos en el documento del finding. QAPAQ ya tiene un modelo distinto
de incidente, tareas obligatorias, notas append-only, timeline y `expectedRevision`.

La implementación QAPAQ debe conservar la entrada y experiencia nativa de Case Management,
pero sustituir sus escrituras de negocio por el servicio de casos QAPAQ. La alerta/finding
de Wazuh conserva su ID y es una referencia, no una segunda copia mutable del caso. Antes
de cambiar el endpoint hay que inventariar datos existentes, definir una migración repetible,
probar rollback y asegurar que un usuario no pueda actualizar el caso llamando directamente
al endpoint antiguo.

## Ubicación de código y datos

- UI nativa: plugin `plugins/main` de `wazuh-dashboard-plugins`, construido con los
  componentes y rutas existentes de OpenSearch Dashboards.
- API SOC: rutas same-origin `/api/qapaq/*` del servidor Wazuh con allowlist de endpoints,
  que reusan por ahora los controladores/casos de uso ya implementados en `apps/api` y
  `modules/*`. La migración de esos módulos al runtime del plugin se hace verticalmente;
  no se copia la SPA ni se muestra otra API al usuario.
- Identidad: contrato del BFF QAPAQ (`/api/auth/start`, callback, sesión y logout), cookie
  HttpOnly, misma política de tenant y sesión. El Indexer autentica el Dashboard con OpenID;
  no confundir la cookie del BFF con la cookie del Dashboard.
- Datos: PostgreSQL conserva casos, grants y auditoría; Indexer es consulta de alertas y
  eventos; Manager conserva agente y detección. Réplicas Dashboard stateless comparten las
  claves y DB necesarias para rolling updates, sin estado local de sesión de negocio.
- Seguridad: denegación en servidor en cada request. Ocultar el menú sin capability es una
  mejora de UX, no el control de acceso.

## Branding y UI

El sistema visual fuente está en `docs/frontend-design/02-sistema-visual.md` y la guía de
login en `docs/frontend-design/15-auditoria-usuarios-sesiones-acceso-spec.md`. En la edición
QAPAQ se fijan fondo casi negro, superficies por luminosidad, acento ámbar reservado, Q como
marca y densidad de herramienta SOC. Solo se conserva la pantalla y el flujo de login QAPAQ;
las vistas de la SPA se descartan. La navegación, favicon, logos de OpenSearch, login y
plugins usan el mismo branding. Las funciones se construyen como apps nativas con componentes
EUI/Wazuh existentes.

El primer cambio local reemplaza favicon/PWA y logos de la plataforma, fija el título
QAPAQ SecOps, activa el tema oscuro y limita el selector de autenticación del Dashboard a OpenID en
`/workspace/qapaq-dashboard` (`feat/qapaq-branding`). El login está en
`/workspace/qapaq-wazuh-security-dashboard-plugin` (`feat/qapaq-entra-login`). Ninguno se
ha publicado ni ha pasado build integrado todavía. La guía de vistas QAPAQ se migra una
pantalla a la vez, validando densidad y permisos por rol antes de agregar la siguiente.

La rama local del plugin Wazuh contiene una ruta experimental de puente same-origin
`/api/qapaq/*`, un cliente web que conserva la cookie HttpOnly y obtiene el token CSRF en
memoria, y tests unitarios de allowlist y aislamiento de cookies. El upstream se fija con
`wazuh.qapaqApiUrl`; el handler limita métodos a GET/POST y filtra rutas. Esto permite
llamar temporalmente al backend QAPAQ actual, pero **no porta** ese backend al runtime
Wazuh, no prueba su despliegue y no convierte el puente en la arquitectura final.

La allowlist incluye salud, cambios, lectura y comandos de alertas/incidentes, auditoría,
notificaciones, usuarios/sesiones de administración y suscripciones push. Deja fuera
`/api/ingest/security-events` y las rutas de operación/configuración de ingesta; por eso no
toda la API QAPAQ funciona a través de ese puente. Login `/api/auth/*` sigue siendo una
integración aparte same-origin, no una ruta del puente. Antes de usar cualquier flujo
faltante, se debe añadir solo la ruta necesaria con validación y tests; no abrir un proxy
genérico. La migración objetivo es portar los casos de uso QAPAQ al servidor del plugin y
mantener el puente solo durante el corte vertical probado.

La plataforma se configura con locale `es-419` y las cadenas del login, el cliente QAPAQ y
los errores del puente están en español. La selección de locale no traduce automáticamente
las cadenas nativas de los plugins Wazuh: la edición todavía requiere traducir y probar sus
catálogos antes de afirmar que toda la interfaz está en español.

El ajuste de `opensearch_security.auth.type` quita Basic de la pantalla del Dashboard,
pero no cambia por sí solo la autenticación del Indexer. El checkout oficial `wazuh-indexer`
inspeccionado no contiene la configuración `authc` aplicada al cluster; esta se debe cerrar
en el Security plugin operativo, con OpenID para personas y Basic restringido al tráfico
interno de la identidad técnica (o equivalente). El Indexer no debe aceptar acceso directo
desde redes de analistas. No se deben borrar las credenciales técnicas del Dashboard.

## Secuencia de entrega

1. Cerrar login y sesión con BFF, OpenID, configuración backend, logout y pruebas Entra.
2. Aplicar branding global y tema oscuro; revisar logo, título, favicon, accesibilidad y
   navegación responsive en la plataforma y el plugin Wazuh.
3. Portar primero los agregados y pruebas existentes de QAPAQ al servidor del plugin,
   manteniendo contratos, IDs y estados; construir vistas nativas con EUI/Wazuh para
   alert→incidente/case→tareas/notas/timeline. El puente sirve solo de transición.
4. Portar authorization/capabilities y auditoría append-only antes de permitir mutaciones;
   luego integrar salud de fuentes, mapper M365 y notificaciones según sus gates de runtime.
5. Integrar Shuffle por webhook desde el outbox QAPAQ; en la primera etapa, la UI nativa
   consume catálogo/estado QAPAQ y el editor se usa en Shuffle. No exponer el webhook en
   navegador ni permitir escrituras directas de Shuffle a Indexer/Manager.
6. Migrar dashboards de investigación y datos de Case Management en ambiente aislado; luego
   ejecutar CI, fault injection, compatibilidad rolling y pruebas de carga.
7. Solo después preparar Terraform y despliegue. No destruir recursos ni tocar el entorno
   existente antes de comparar state, dependencias y plan de cambios.
