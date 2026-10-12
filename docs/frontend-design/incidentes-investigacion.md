# Investigación de incidentes en QAPAQ

**Estado:** primera capa conectada; workbench de investigación pendiente de backend.
**Revisado:** 2026-10-12. Este documento separa estado implementado de diseño objetivo.

## Qué hace la vista actual

`/incidents` permite buscar y paginar incidentes, abrir el detalle, leer severidad,
propietario, resumen, alertas vinculadas y estado; los usuarios autorizados pueden avanzar
el lifecycle. Desde el detalle, la UI carga los registros de alertas referenciados por el
incidente (`GET /api/alerts/:id`) y, cuando la sesión incluye `audit.read`, consulta
`GET /api/audit/events` filtrando por recurso `incident` y su ID. El historial usa el
cursor del BFF. El botón de cierre requiere confirmar los veredictos de todas las alertas
vinculadas cargadas; el BFF/dominio conserva la validación autoritativa.

Los estados `contained` y `eradicated` describen el registro del incidente en QAPAQ. No
prueban ejecución en Wazuh, Entra, EDR ni hosts. Esta vista no ejecuta respuestas externas.

## Resultado de investigar plataformas SOC abiertas

La referencia de gestión de casos de TheHive estructura una investigación con alertas,
observables, tareas asignadas, TTPs/ATT&CK y adjuntos; sus tareas documentan acciones,
observaciones y decisiones mediante logs y permiten exigir tareas antes del cierre. La
documentación de DFIR-IRIS describe un registro de caso colaborativo con assets, IOCs,
tareas, evidencia, timeline, access control y reportes. Wazuh Dashboard se enfoca en
telemetría, detección y consultas; la investigación de caso y su cadena de decisiones
necesitan un plano complementario como QAPAQ.

Referencias primarias:

- [TheHive: About Cases](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/)
- [TheHive: About Tasks](https://docs.strangebee.com/thehive/user-guides/analyst-corner/tasks/about-tasks/)
- [DFIR-IRIS: documentación de la plataforma](https://docs.dfir-iris.org/)
- [DFIR-IRIS: API v2](https://docs.dfir-iris.org/latest/_static/iris_api_reference_v2.1.0.html)
- [Wazuh Dashboard: repositorio y licencia](https://github.com/wazuh/wazuh-dashboard)
- [DFIR-IRIS: licencia y avisos de seguridad](https://github.com/dfir-iris/iris-web/security)

La dirección adecuada para QAPAQ es adaptar capacidades y límites al monolito modular,
no copiar una aplicación ni incrustar código ajeno. DFIR-IRIS declara LGPL-3.0; el
repositorio de plantillas de TheHive declara AGPL-3.0; Wazuh Dashboard declara Apache-2.0.
La licencia de la función que se toma debe verificarse en su archivo y versión exacta,
con atribución y obligaciones aplicables antes de redistribuir derivados. Además, los
avisos publicados para DFIR-IRIS (incluidos autorización, CSRF y cargas de archivo) son
razón adicional para usarlo como referencia funcional y mantener revisiones de seguridad
propias, no para transplantar código sin una auditoría.

## Composición por rol

Solo existen hoy los cuatro roles runtime de `modules/access/src/capabilities.ts`:

| Rol runtime | Investigación disponible | Límite efectivo |
| --- | --- | --- |
| `qapaq.soc.analyst` | Consultar incidente y alertas; operar comandos de incidente permitidos; revisar resumen y fases. | No tiene `audit.read` ni cierre. No hay tareas ni notas colaborativas. |
| `qapaq.soc.lead` | Capacidades de analista, historial de auditoría, cierre y despacho de notificaciones. | No convierte un cambio de estado en respuesta ejecutada en infraestructura. |
| `qapaq.auditor` | Incidente en lectura y verificación/consulta de auditoría conforme a su sesión. | Sin acciones mutantes de incidentes, alertas o notificaciones. |
| `qapaq.platform.admin` | Unión explícita actual: lectura/escritura/cierre SOC, observabilidad, sesiones y secretos. | No es Access Admin; no obtiene padrón de Entra ni gestión de grants. |

Los roles de producto `SOC_L1`, `SOC_L2`, `SOC_MANAGER` y `DETECTION_ENGINEER` figuran
en ADR-017 y la matriz objetivo, pero no se emiten en el runtime. No se les asigna una
pantalla o permiso ejecutable hasta que access publique grants/scopes y pruebas allow/deny.
Dirección propuesta: L1 trabaja triage y tareas acotadas; L2 lleva investigación y evidencia
con permisos separados; SOC Manager supervisa asignación, escalamiento y reportes; Detection
Engineer relaciona señales y versiones de reglas sin obtener administración de casos ni
respuesta técnica por defecto.

## Brechas funcionales y contratos requeridos

Estas capacidades no están implementadas por la vista actual ni deben mostrarse como
controles activos:

1. **Trabajo asignable:** entidades de tarea con responsable, estado, prioridad, fecha,
   requisito/criterio, notas de actividad y auditoría. Cerrar solo si las tareas
   obligatorias están completas o se registró excepción autorizada.
2. **Bitácora de analista:** notas append-only con actor, hora, revisión, visibilidad y
   referencia a evidencia/evento; correcciones como nuevos eventos, no edición silenciosa.
3. **Timeline de caso:** consulta paginada que combine transiciones y acciones auditadas,
   alertas/eventos asociados y notas/evidencia con tipo, timestamp de origen/recepción,
   actor y correlation ID; mantener orden estable y distinguir tiempo del proveedor de
   tiempo de registro.
4. **Observables y activos:** IP, dominio, identidad y hash tipados, con normalización,
   enmascaramiento, scope de tenant, procedencia y pivotes autorizados. Una coincidencia
   no prueba que dos casos sean el mismo incidente.
5. **Evidencia:** carga desde el BFF con límites de tamaño/tipo, cuarentena de archivo,
   SHA-256, metadata mínima, almacenamiento versionado, eventos de custodia inmutables,
   clasificación, retención/hold y reevaluación de autorización al descargar.
6. **Informes:** exportación asíncrona con ventana, alcance, manifiesto, hash, expiración,
   propósito y capability de export separada de lectura.
7. **Respuesta externa:** playbook versionado, dry-run, permisos por destino, idempotencia,
   aprobación/step-up por riesgo, resultado comprobable del proveedor, estado ambiguo,
   rollback cuando exista y audit event. No inferir remediación de `incidents.write`.

Antes de habilitarlas, el backend debe decidir si incidente sigue siendo el contenedor de
investigación o si se separa `Case`; resolver U-008 para vínculos, publicar capabilities
específicas de tarea/nota/IOC/evidencia/export, scopes por recurso y auditoría, persistencia,
migración/retención, límites/paginación y pruebas tenant-cross/deny/CSRF/concurrencia.
El contrato objetivo vive en `docs/architecture/data-model-mer.md`, ADR-017, ADR-018,
ADR-024 y U-008.

## Entrega

| Etapa | Resultado | Estado |
| --- | --- | --- |
| UI base | Alertas vinculadas más actividad auditada en detalle; acceso limitado por capabilities; guardia visible de cierre. | Implementada en esta entrega sobre rutas existentes. |
| Contrato de investigación | Timeline unificada, tareas, bitácora, observables y assets persistentes. | Backend required; asignar C-xx tras cerrar U-008 y RBAC. |
| Custodia y reportes | Evidencia inmutable, exportación gobernada y reportes con procedencia. | Backend required; requiere ADR/retención y pruebas integrales. |
| SOAR | Ejecución externa verificable y controles por riesgo. | Futuro; dispatcher de notificaciones no lo satisface. |

