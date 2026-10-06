# 09 · Evaluación del frontend y brechas para un SOC operativo

Fecha de revisión e implementación: 2026-10-06. Alcance: revisión del frontend,
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
| Búsqueda de eventos | No hay ruta de producto en el BFF | El menú actual no ofrece Eventos aunque exista la capability; no se puede investigar pivoteando desde una alerta. |
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

El requisito del producto es que el administrador pueda usar todas las
funciones SOC y, además, administrar usuarios y sesiones. El sistema actual no
lo implementa de esa forma: `qapaq.platform.admin` ahora recibe la unión
explícita y finita de las capabilities SOC registradas actualmente, pero la
consola de producto no tiene sección de usuarios o sesiones. El mock `admin/*` sí muestra pantallas sintéticas de
sesiones, pero no se conecta al BFF real.

El dominio de acceso conserva estado de sesión y una función para revocar una
sesión, pero `SessionStore` solo permite crear, buscar por ID, listar sesiones
activas por sujeto y actualizar. No existe una ruta para que el administrador
liste, cambie roles/niveles o bloquee una cuenta. Tampoco hay ruta que exponga
sesiones de todos los usuarios. La única vista de sesión es la del propio
usuario. Por tanto, “usuarios conectados”, asignación de nivel y bloqueo son
brechas de backend, autorización, auditoría y UI, no controles que se puedan
resolver solo añadiendo botones.

### 4.1 Comportamiento esperado

Agregar una sección **Administración** visible solo para la capability
administrativa. Debe permitir:

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

“Administrador con todas las funciones SOC” es ahora una regla explícita: el rol
recibe cada capability SOC actualmente registrada en el runtime, incluidas
auditoría sensible y escritura de secretos. El conjunto es finito y la prueba
de autorización lo verifica; las capabilities futuras no se heredan. El rol no
administra usuarios, roles ni sesiones globales porque esas capacidades y sus
endpoints aún no existen. Antes de añadirlas hacen falta scope de tenant,
auditoría reforzada, política de doble control y protección contra auto-bloqueo
o auto-retiro del último administrador.

Esta definición no reemplaza controles de Entra: si el bloqueo pedido debe
impedir también el inicio de sesión en Microsoft, se requiere integración con
el proveedor de identidad y permisos de directorio apropiados. Si solo bloquea
QAPAQ, debe rotularse como “acceso a QAPAQ suspendido”.

## 5. Brechas de plataforma necesarias para cerrar el objetivo

| Capacidad | Estado observado | Trabajo requerido |
| --- | --- | --- |
| Usuarios / niveles | Sin endpoint de administración; `platform.admin` sí tiene las capabilities SOC actuales, no las de identidad | Definir catálogo, ámbito, política de asignación y endpoints de lectura/escritura. |
| Usuarios conectados | No existe listado global; sesiones viven en store en memoria; una sesión nueva reemplaza la anterior | Persistencia compartida, endpoint de sesiones activas, heartbeat/actividad y umbral documentado. |
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
