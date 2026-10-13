# 09 · Evaluación del frontend y brechas para un SOC operativo

Fecha de evaluación inicial: 2026-10-06. Alcance: revisión del frontend,
sus estilos, cliente HTTP, controladores BFF y capabilities; incluye validación
E2E y revisión visual en navegador local. No es una validación de una
instalación productiva.

Este documento registra qué tan cerca está la interfaz actual de una consola
profesional de operación SOC, qué fricciones concretas tiene y qué falta para
que un administrador gestione usuarios, niveles de acceso y sesiones. La
especificación de pantallas y sistema visual sigue en [01–08](README.md); este
informe la contrasta con la implementación que carga hoy la aplicación.

## 1. Resumen ejecutivo

La aplicación carga [`SocConsole`](../../apps/web/src/components/soc/SocConsole.tsx)
y presenta una consola operativa propia, conectada al BFF real. Tiene una base
visual coherente: navegación por grupos, tema oscuro, tablas densas, prioridad
legible, panel lateral para alertas, accesos por capability, estados degradados,
actualización periódica y enlaces profundos.

La principal limitación no es que falte una capa visual. La consola solo puede
mostrar y ejecutar lo que sirve el BFF: alertas, incidentes, notificaciones,
auditoría, verificación de integridad y sesión propia. Búsqueda real de eventos,
salud/cobertura de la ingesta, administración de identidades y gestión de
sesiones de otras personas no tienen rutas del BFF. En consecuencia, hoy no
permite supervisar una cola SOC de extremo a extremo ni operar los controles que
el usuario pide para administración.

Se implementaron mejoras en resumen, búsqueda remota, paginación, navegación por
teclado, detalle por enlace directo, identidad de sesión y adaptación a móvil.
Siguen pendientes la cronología de respuesta, salud de fuentes, gestión de
identidades/sesiones y algunos nombres de responsables que dependen de datos de
asignación legibles en el backend.

## 2. Qué existe y cuál consola es la vigente

| Área | Implementación actual | Evaluación |
| --- | --- | --- |
| Entrada de producto | `apps/web/src/app/application.tsx` renderiza `SocConsole` cuando hay sesión | Es la consola que debe guiar el diagnóstico actual. |
| Operación SOC | Alertas, incidentes, notificaciones críticas, resumen, auditoría e integridad | Usa rutas `/api/*` reales y capacidades de la sesión. |
| Búsqueda de eventos | Existe `events.read`, pero no hay ruta de producto en el BFF | `/events` queda fuera de navegación/búsqueda rápida; un enlace directo explica que falta el BFF y lleva a alertas correlacionadas. |
| Salud de ingesta | La barra informa `API disponible`; el resumen reconoce `Ingesta sin datos de salud` | El estado del API no prueba que las fuentes estén entregando eventos. La etiqueta del resumen es honesta, pero no hay diagnóstico accionable por origen. |
| Administración heredada | `SuperAdminConsole` y componentes `admin/*` | Es una experiencia de demostración basada en `/api/v1/*`, contrato que el BFF no sirve. No representa administración operativa vigente. |

No se deben interpretar pantallas del mock como funcionalidades disponibles.
El [inventario del backend](01-inventario-backend.md) y [brechas](08-brechas-y-decisiones.md)
son la referencia para el contrato real.

## 3. Hallazgos de UX y presentación

### P1 · El resumen no distingue una muestra de una cola completa

[`SummaryPage`](../../apps/web/src/components/soc/SocSummaryPage.tsx) consulta
una página de alertas/incidentes/notificaciones. Ahora solicita totales
autorizados para alertas e incidentes y los muestra en el encabezado de cada
panel; las filas siguen siendo una muestra reciente. Notificaciones conserva
el rótulo explícito “página consultada”, porque ese endpoint aún no devuelve un
total completo.

**Pendiente:** agregar agregados por prioridad/estado, pendientes de acuse y
edad de la alerta más antigua; mantener visible el alcance temporal de cada
tarjeta.

### P1 · Búsqueda y filtros no recorren el conjunto de resultados

En [`AlertQueuePage`](../../apps/web/src/components/soc/AlertQueuePage.tsx),
la búsqueda de texto y la prioridad ahora se aplican en servidor, y el cursor
queda ligado a esos filtros. En [`AuditPage`](../../apps/web/src/components/soc/AuditPage.tsx),
“Actor o recurso” se aplica a la página actual y la propia interfaz lo aclara.
Esto es insuficiente para investigación y auditoría cuando el registro buscado
no está entre los primeros 50 resultados.

**Pendiente:** agregar filtros temporales, fuente, host/identidad y correlación
cuando el modelo y los permisos lo permitan; auditoría aún no expone todos sus
filtros desde esta interfaz.

### P1 · No hay una vista de salud de fuentes que ayude a responder

La consola distingue correctamente disponibilidad del BFF de salud de ingesta,
pero no hay información por fuente sobre último evento, retraso, cobertura,
errores de colector o backlog. “API disponible” puede ser cierto mientras una
fuente crítica está desconectada.

**Recomendación:** implementar API y vista de salud/cobertura por fuente con
último evento recibido, retraso, estado, eventos procesados/rechazados, colas,
dependencias y vínculo a runbook. Mantener separados “servicio disponible”,
“fuente enviando” y “pipeline al día”. Mostrar cuándo se comprobó cada señal.

### P1 · Falta el flujo de investigación de alerta a respuesta

El drawer muestra prioridad, estado, asignación, veredicto, razones y referencia
al evento crudo si el rol la permite. Permite reconocer, triar, escalar, abrir
incidentes, cerrar y reabrir. Sin embargo, los datos actuales no incluyen una
línea de tiempo de actividad, notas/historial visible, entidades relacionadas,
eventos vecinos, enriquecimiento, adjuntos/evidencia ni acciones de respuesta
coordinadas. El usuario puede cambiar el estado, pero no reconstruir desde una
vista el contexto que justifica la decisión.

**Recomendación:** agregar cronología auditable, eventos relacionados y
entidades pivoteables, fuente/regla y explicación de detección, notas/evidencias
con autor y hora, historial de asignación, y relación explícita alerta ↔
incidente ↔ notificación. Para respuesta automática, mostrar aprobación,
alcance, resultado y rollback de cada playbook; no presentar una acción SOAR
como exitosa hasta confirmar su ejecución.

### P2 · Identidad y responsabilidad aparecen como IDs técnicos

La sesión ahora expone nombre y correo cuando el IdP los entrega; cuando falta
esa información se comunica expresamente. La asignación de alertas e incidentes
aún se representa como ID abreviado o completo. En los turnos,
esto dificulta reconocer a la persona responsable y transferir trabajo.

**Pendiente:** ofrecer personas elegibles y su nivel de acceso al asignar; no
confiar en el nombre enviado por el navegador para autorizar.

### P2 · Los refrescos no comunican claramente frescura ni estado de carga

Resumen y alertas consultan cada 15 segundos; incidentes cada 30. En algunos
flujos se conserva la lista mientras se recarga, pero no hay señal global clara
de “actualizando”, datos posiblemente antiguos o último refresco fallido. Una
respuesta previa puede parecer información actual tras un problema de red.

**Recomendación:** mostrar “actualizado hace…”, indicador discreto durante la
consulta, antigüedad de los datos, y una advertencia persistente cuando no se
pudo actualizar. Separar carga inicial, actualización en segundo plano, dato
parcial, dato vencido y error. Para colas críticas, evaluar SSE/WebSocket con
reconexión visible; mantener actualización manual disponible.

### P2 · Incidentes y auditoría necesitan continuidad de navegación

Incidentes ahora cuentan con `GET /api/incidents/:id`, por lo que los enlaces
profundos funcionan aunque el elemento no esté en la página cargada. Auditoría
ya recibe cursor y filtros en el BFF, aunque la UI todavía no cablea el cursor en el
cliente y su filtro de actor/recurso es local. La vista no ofrece búsqueda
global por correlación que conecte alerta, incidente y registro de auditoría.

**Pendiente:** llevar la paginación de auditoría hasta la interfaz; preservar
filtros y elemento seleccionado en URL; ofrecer navegación
entre el evento auditado y el recurso relacionado cuando el permiso lo permita.

### P2 · Diseño oscuro sólido, jerarquía operativa aún mejorable

Los estilos de `soc-shell.css` aportan un lenguaje coherente (oscuro, acento
ámbar contenido, tipografía de sistema y foco visible). Las tablas densas y el
drawer son apropiados para escritorio. Aun así, no hay en la cola un panorama
compacto del turno con volumen por prioridad, vencimientos/SLA, carga por
analista y alertas sin asignar. Algunos estados usan tonos cercanos y texto
pequeño; en pantallas estrechas la navegación colapsa automáticamente y el
usuario pierde los rótulos de grupo.

**Recomendación:** priorizar la cola accionable sobre tarjetas decorativas,
añadir distribución del trabajo y SLA solo cuando existan datos confiables,
reforzar contraste/tamaño en metadatos y validar 1280×720, zoom 200 %, teclado,
lectores de pantalla y operación en móvil. El color debe acompañar rótulo y
forma, nunca ser la única señal.

## 4. Requisitos del administrador solicitados

El requisito del producto es que el administrador de plataforma pueda usar las
funciones SOC actuales y consultar/gestionar el acceso QAPAQ de las personas del
grupo de admisión Entra configurado. La consola actual solo concede a
`qapaq.platform.admin` la unión explícita y finita de las capabilities SOC
registradas; las capabilities de administración de identidad aún no existen. La nueva
vista React de `/admin/users` está integrada contra el contrato documentado y permanece
oculta para todo usuario actual porque el BFF/capabilities aún no están implementados. El
mock `admin/*` muestra datos sintéticos y no representa usuarios, sesiones ni roles activos.

El dominio de acceso conserva estado de sesión y una función para revocar una
sesión, pero `SessionStore` solo permite crear, buscar por ID, listar sesiones
activas por sujeto y actualizar. No existe todavía ruta backend para que el
administrador liste usuarios, cambie roles o bloquee una cuenta. La nueva UI cubre
el contrato objetivo; la operación sigue bloqueada hasta entregar backend,
autorización, persistencia, auditoría y sincronización Entra.

### 4.1 Comportamiento esperado

Agregar una sección **Administración** solo después de implementar autorización y
el contrato BFF. El roster debe contener exclusivamente miembros del grupo Entra
`QAPAQ-SecOps-Users` configurado en servidor, incluidos miembros sin grant QAPAQ.
No debe enumerar el directorio completo ni cambiar grupos o cuentas en Entra.
La vista debe permitir:

1. Ver cuentas habilitadas, suspendidas y pendientes; buscar por nombre,
   correo, equipo y nivel; mostrar último acceso, MFA/estado de identidad y
   quién hizo el último cambio.
2. Ver sesiones con estado “activa recientemente” basado en `lastSeenAt`, hora
   de inicio, último uso, método de autenticación y origen permitido según la
   política de exposición. “Conectado” debe definirse por un umbral configurable
   y comunicarse como actividad reciente, no como presencia en tiempo real.
3. Asignar y retirar niveles de acceso mediante un catálogo explícito de roles
   y scopes. Mostrar una vista previa de capabilities efectivas antes de
   guardar; rechazar combinaciones fuera de política.
4. Bloquear/restablecer acceso a la aplicación y revocar sesiones de una
   persona o dispositivo. Distinguir el bloqueo de cuenta, retiro del rol y
   cierre de una sola sesión, ya que tienen distinto alcance.
5. Exigir motivo para cambios sensibles, confirmación con el objetivo y el
   impacto visibles, y registrar actor, objetivo, valor anterior/nuevo, motivo,
   hora y correlación en auditoría inmutable.
6. Mostrar resultado inmediato y errores accionables; al revocar, invalidar la
   sesión objetivo en el servidor y reflejar el cambio en el listado.

### 4.2 Decisión de autorización que debe quedar explícita

"Administrador con todas las funciones SOC" aplica al conjunto de capabilities
SOC que existe hoy: la unión es explícita y finita e incluye auditoría sensible y
escritura de secretos. No se heredan capacidades futuras. La administración de
identidades se añade por capabilities separadas (`users.read`, `sessions.read`,
`roles.request`, `roles.approve`, entre otras), con scope de tenant y auditoría.
Platform Admin puede leer el roster SOC y solicitar cambios; los grants
privilegiados requieren aprobación independiente/step-up. No puede autoasignarse,
autoaprobarse, retirar su propia sesión ni bloquear al último administrador.

El estado de conexión se deriva de sesiones QAPAQ persistidas y `lastSeenAt`; se
rotula como actividad reciente con umbral configurable, no presencia de Teams ni
tiempo real. Retirar la pertenencia al grupo Entra corta acceso al sincronizarse;
una suspensión local solo bloquea QAPAQ y debe llamarse “acceso a QAPAQ suspendido”.

## 5. Brechas de plataforma necesarias para cerrar el objetivo

| Capacidad | Estado observado | Trabajo requerido |
| --- | --- | --- |
| Usuarios / niveles | Sin endpoint de administración ni capability de identidad; roster y bundles destino están diseñados en [entra-soc-user-admin.md](../architecture/entra-soc-user-admin.md) | Sync Graph de solo lectura del grupo único configurado, grants locales persistidos, solicitudes/aprobaciones SoD y auditoría. |
| Usuarios conectados | No existe listado global; sesiones viven en store en memoria y la política runtime difiere de `REJECT_NEW` | Persistencia PostgreSQL compartida, endpoint de sesiones y revocación distribuida, `lastSeenAt` y umbral configurable. |
| Bloqueo | Existe revocación interna de sesiones; no hay comando administrativo ni estado de cuenta bloqueada | Modelo de suspensión, efecto sobre sesiones actuales y futuras, recuperación y auditoría. |
| Salud/cobertura | El BFF solo comprueba disponibilidad básica | Agregación por fuente y ruta de salud operacional. |
| Búsqueda de eventos | No hay ruta de consulta de producto | API paginada con filtros y permisos sobre datos crudos. |
| Conteos de cola | La UI calcula sobre páginas consultadas | Endpoints de agregados por estado/prioridad, con alcance temporal. |
| Investigación | El contrato de alertas omite nota/historial y relaciones más profundas | Modelo y API para cronología, notas/evidencia y pivotes de investigación. |

## 6. Orden de trabajo recomendado

### P0 · Contrato y seguridad de administración

- Acordar si “administrador SOC” es el rol actual o uno nuevo; enumerar sus
  capacidades y límites en [`docs/rbac.md`](../rbac.md) y el inventario.
- Diseñar autorización server-side para usuarios, grants, sesiones y bloqueo;
  añadir auditoría y pruebas de denegación, elevación y auto-bloqueo.
- Definir el alcance del bloqueo (solo QAPAQ o también Microsoft Entra) y el
  significado de “activo” para una sesión.

### P1 · Operación confiable de alertas

- Agregados reales, búsqueda remota y filtros paginados.
- Salud/cobertura de fuentes y frescura visible.
- Contexto de investigación, cronología y vínculos de entidades/incidentes.
- Continuidad de detalle por ID y navegación por correlación.

### P2 · Consola administrativa y eficiencia del analista

- Vistas de usuarios/sesiones con cambios de acceso y revocación confirmados.
- Asignación mediante directorio y carga de trabajo por analista.
- Revisión responsive, teclado, accesibilidad y captura visual de estados
  normales/degradados en resoluciones objetivo.

## 7. Criterios de aceptación propuestos

- La vista de resumen nunca presenta el total de una sola página como total
  global; las cifras muestran fuente, ventana temporal y hora de corte.
- Búsquedas por texto, identidad, activo y correlación consultan el conjunto
  autorizado en servidor y conservan filtros al paginar/abrir un enlace.
- Un retraso de ingesta se distingue claramente de una API sana, falta de datos
  y fallo al consultar; cada fuente muestra última actividad y acción sugerida.
- La persona analista puede seguir una alerta desde detección hasta triaje,
  asignación, incidente y resultado de respuesta, con cronología auditable.
- Un administrador autorizado ve todos los módulos cubiertos por su rol y ve
  usuarios/sesiones; un usuario sin capability no puede invocar los comandos,
  incluso llamando directamente al API.
- Cambios de nivel, bloqueos y revocaciones requieren motivo y dejan evidencia
  consultable. Al bloquear, se aplica el alcance elegido a sesiones existentes
  y futuros inicios de sesión.
- La interfaz comunica nombres legibles, antigüedad de los datos y estado de
  cada operación; errores conservan `correlationId`.

## 8. Referencias de implementación

- [Consola vigente](../../apps/web/src/components/soc/SocConsole.tsx)
- [Cola de alertas](../../apps/web/src/components/soc/AlertQueuePage.tsx)
- [Detalle de alerta](../../apps/web/src/components/soc/AlertDetailDrawer.tsx)
- [Resumen operativo](../../apps/web/src/components/soc/SocSummaryPage.tsx)
- [Auditoría](../../apps/web/src/components/soc/AuditPage.tsx)
- [Cliente y contrato HTTP](../../apps/web/src/api/client.ts)
- [Roles y rutas disponibles](01-inventario-backend.md)
- [Arquitectura de información propuesta](03-arquitectura-de-informacion.md)
- [Brechas API y funcionalidades planificadas](08-brechas-y-decisiones.md)

## 9. Mejoras implementadas y validadas

- Búsqueda y prioridad de alertas se consultan en el BFF; estado, prioridad y
  búsqueda forman parte del cursor. Incidentes permiten búsqueda remota,
  filtro de estado y acceso por ID.
- El resumen presenta totales del servidor para alertas abiertas e incidentes
  activos. El contrato administrativo concede al rol de plataforma la unión
  explícita de las capabilities SOC actuales, sin wildcard ni herencia futura.
- Los controles de filtro y filas usan semántica de teclado; los títulos
  navegables son botones, con foco visible y atajos `j`/`k` y `/`. El detalle de
  incidentes cierra con `Escape` y devuelve el foco a la fila.
- Se unificaron márgenes/gaps sobre escala de 4 px, se ajustaron objetivos
  táctiles y tipografía de campos para móvil. La cola se validó a 390 px sin
  desbordamiento horizontal.
- Validación de esta revisión: 75 pruebas unitarias dirigidas, 8 pruebas E2E,
  compilación de web y chequeos de tipos web/API/access. La administración de
  usuarios, sesiones globales, niveles y bloqueos sigue pendiente de un store
  persistente, endpoints y enforcement/auditoría de identidad.

## 10. Estado actualizado · 2026-10-12

Este apartado actualiza los hallazgos de la revisión del 6 de octubre. Conserva la arquitectura documentada: Wazuh es la plataforma de telemetría, búsqueda y detección; QAPAQ es el plano multitenant de operación, autorización y rendición de cuentas.

### Vistas con contrato de producto existente

- **Resumen:** muestra alertas e incidentes con totales del servidor; ahora consulta `/api/health/ready` para disponibilidad del BFF. El estado global de ingesta sigue explícitamente sin datos de salud.
- **Alertas:** cola con filtros del servidor, navegación por entidad/alerta relacionada y detalle de señal rotulada como táctica inferida. El evento original continúa en Wazuh.
- **Incidentes:** búsqueda, estados, enlaces profundos y comandos de ciclo de vida. `contained`/`eradicated` son estados del registro, no prueba de ejecución de contención externa.
- **Notificaciones:** estados, acuse humano y paginación cursor. Claude informa que implementó cola PostgreSQL con lease, dispatcher automático y capacidad `notifications.dispatch`; los unitarios reportados pasan, pero la recuperación con PostgreSQL real no está verificada porque Docker está detenido por falta de espacio en disco. Mantener la entrega como pendiente de aceptación hasta poder correr integración PG.
- **Auditoría e integridad:** consulta autorizada, redacción, filtros server-side, cursor y verificación limitada a 1 000 eventos por la API actual. Aún no equivale a informe/regulatorio exportable con manifiesto.
- **Mi sesión:** identidad y todas las capabilities efectivas devueltas por la sesión, incluidas observabilidad, despacho y sesiones administrativas; no es administración de usuarios ni listado de sesiones ajenas.
- **Eventos:** `GET /api/events` aún no está expuesto; la ruta directa informa el bloqueo, pero ya no se anuncia en navegación. No se simula búsqueda del Indexer. Contrato objetivo: [eventos-investigacion.md](eventos-investigacion.md).

`apps/web/src/components/admin/*` y `mock-admin.ts` son material heredado de demostración, no funcionalidad conectada ni superficie que deba anunciarse como administración activa. Las reglas de detección, evidencia/adjuntos, playbooks completos, identidades y sesiones globales siguen ligadas a brechas de dominio/API, no se resuelven agregando controles web falsos.

### Decisión de producto

QAPAQ merece existir mientras reduzca trabajo manual y haga verificable el trayecto `alerta Wazuh → prioridad explicable → responsable → investigación/incidente → acción aprobada → resultado externo → registro/auditoría`. Si solo replica eventos, filtros, dashboards, agentes o Rule Test, Wazuh ya ofrece esa superficie y mantener la copia duplica fuentes de verdad. El diferenciador debe medirse con alertas sin asignar/antiguas, cobertura de fuentes, tiempo de triaje/acuse/resolución, acciones confirmadas, falsos positivos y completitud de evidencia.

El benchmark abierto sugiere integración por capas: Wazuh para telemetría/detección y agentes; DFIR-IRIS como referencia o backend opcional de casos, evidencia, timeline y reportes; Shuffle como posible ejecutor de workflows cuando exista necesidad multiherramienta. No se debe reconstruir un SIEM, ni un motor visual general de playbooks, ni un segundo repositorio integral de logs para justificar QAPAQ.

### Orden de cierre

1. **P0 · Outbox SOAR durable:** Claude reporta claim con lease, intentos/fallback persistentes, reintento, dispatcher automático, capability propia y retiro del relay a RAM. La revisión estática encontró que reclama 20 mensajes con lease de 120 s pero los envía serialmente con timeout de 10 s (hasta 200 s por lote); sin fencing, un claim posterior puede ser modificado por el dueño anterior. El cierre forzado del proceso vence a 6 s aunque el dispatcher espere el lote. Requiere corregir ownership/lease y alinear apagado antes de aceptar. Las pruebas de recuperación/multiconcurrencia contra PostgreSQL también quedan pendientes mientras Docker no arranque.
2. **P1 · Telemetría utilizable:** `GET /api/events` por tenant con filtros paginados, permiso diferenciado para payload crudo y links de pivote; `GET /api/platform/health` con disponibilidad separada de collector, dataset/content-type, último intento/éxito/evento y lag. No inferir salud solo por silencio o estado del manager.
3. **P1 · Caso y evidencia:** historial de decisiones/asignación, notas y artefactos con hash/procedencia/custodia/acceso, vínculo a alertas Wazuh, acción aprobada, respuesta del control de destino y reporte con ventana, actor, evidencia y limitaciones.
4. **P2 · Ingeniería de detecciones:** fixtures reales autorizados y redactados, regresiones, logtest/pruebas de reglas, falsos positivos, cobertura MITRE y estado de validación por versión. Preferir deep-links y evidencia de Wazuh Rule Test antes de clonar su editor.
5. **P2 · Integraciones optativas:** validar IRIS/Shuffle con un caso piloto, aislamiento tenant, RBAC, secreto/rotación, fallos, licencias, upgrades y propiedad de cada registro antes de integrarlos.

### SBS y evidencia

El catálogo oficial consultado publica la Resolución SBS 504-2021 en versión 5.0 y estado vigente. La aplicabilidad y el mapeo de controles deben verificarse por tipo de entidad/régimen y texto consolidado vigente. La consola puede conservar artefactos que apoyen el procedimiento, pero el cumplimiento también requiere gobierno, personas, controles, pruebas, operación y criterio de la entidad; la UI no certifica conformidad.

### Verificación de este delta

Verificación actual: typecheck web PASS; build de producción Vite PASS; web 3 archivos / 19 pruebas PASS; API/SOAR/SOC/access 13 archivos / 196 pruebas PASS; contrato KrakenD 7/7 PASS; detector de diseño `[]`; `git diff --check` sin hallazgos de whitespace (avisos CRLF de Git). No hubo captura de navegador. No hay prueba E2E del nuevo Admin porque el endpoint BFF aún no existe; la vista permanece oculta para todos los roles actuales y no usa mocks. Las pruebas reales PostgreSQL/Wazuh y el cierre de fencing C-20 siguen pendientes por Docker/disco y revisión de Claude.

## 12. Revisión de vistas por rol · 2026-10-12

La consola activa tiene cuatro roles runtime y filtra rutas y acciones por capability. La
composición concreta está en [10-vistas-por-rol-y-referencias.md](10-vistas-por-rol-y-referencias.md).
`/admin/sessions` consulta y revoca sesiones con C-10(b). `/operations` entrega secciones
distintas a analyst, lead y platform admin según su sesión. `/me` expone el conjunto completo
de capabilities efectivas emitido por el BFF.

No hay una ruta web que pueda completar por sí sola la búsqueda de eventos, cobertura
Wazuh/Microsoft 365 por dataset, roster de Entra y grants. Faltan respectivamente
`GET /api/events`, `GET /api/platform/health` (C-5) y las rutas/store de C-10(c). Hasta que
esos contratos estén publicados y probados, las superficies se ocultan o describen el
bloqueo; no se presenta el cliente Indexer/Graph ni los contratos futuros como activos.
