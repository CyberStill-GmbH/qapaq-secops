# Investigación de incidentes en QAPAQ

**Estado:** primera entrega de investigación operativa conectada a API.
**Revisado:** 2026-10-12. Fuente de contratos: [inventario de backend](01-inventario-backend.md#141-tareas-bitácora-y-timeline-del-incidente-sprint-5--fase-4).

## Decisión de arquitectura

`Incident` es el caso canónico. No se crea una entidad `Case` paralela: duplicaría
asignación, estados y auditoría. Una alerta pertenece a un incidente como máximo. Wazuh
sigue siendo la autoridad de telemetría, alertas y reglas; QAPAQ registra la investigación,
el trabajo asignado y las decisiones humanas. `contained` y `eradicated` describen el estado
del incidente en QAPAQ y no confirman una acción ejecutada por Wazuh, Entra o un endpoint.

## Flujo disponible

`/incidents` ofrece lista, filtros por estado y búsqueda; su detalle enlaza alertas mediante
una lectura paginada por cursor. El workbench tiene cuatro pestañas: Resumen, Tareas,
Bitácora y Timeline.

- **Tareas:** creación, responsable, vencimiento, indicador obligatoria y transiciones
  `start`, `complete`, `reopen`, `cancel` y `assign`. Cancelar una tarea obligatoria exige
  motivo. El cierre permanece bloqueado mientras haya tareas obligatorias abiertas o la
  vista no haya podido consultarlas; el backend aplica la guarda autoritativa.
- **Bitácora:** notas append-only. «Corregir» crea otra nota con `correctsNoteId`; no se
  editan ni borran notas. El autor aparece como «Tú» para la sesión actual o como ID abreviado
  si no hay directorio disponible.
- **Timeline:** combina apertura/cierre, alertas vinculadas, tareas, notas y transiciones
  auditadas. En alertas distingue `at` (hora de la fuente) de `recordedAt` (alta en QAPAQ).
  Si las transiciones no son legibles o el historial es parcial, la UI declara ese límite.
- **Actualización en vivo:** `/api/changes` long-poll pausa cuando la pestaña está oculta.
  Las vistas recargan el recurso afectado, muestran «Dato nuevo entrando» y animan filas
  durante 200 ms; se respeta `prefers-reduced-motion`.
- **Cierre:** requiere motivo, revisión de todas las alertas vinculadas y veredicto en cada
  una; también exige cero tareas obligatorias abiertas. La UI falla cerrada si el listado está
  truncado, hay vínculos no disponibles o la API de tareas no responde.

## Acceso por rol runtime

La UI usa capabilities de la sesión; el servidor vuelve a autorizar cada lectura y mutación.

| Rol runtime | Investigar | Límite |
| --- | --- | --- |
| `qapaq.soc.analyst` | Leer alertas/incidentes, operar transiciones permitidas, escribir tareas y notas. | No tiene cierre ni lectura de transiciones de auditoría. |
| `qapaq.soc.lead` | Funciones de analista, `incidents.close`, `audit.read`; lectura raw/eventos según sesión. | El cierre sigue sujeto a alertas con veredicto y tareas requeridas. |
| `qapaq.auditor` | Lectura de incidente y auditoría según sesión. | Sin escritura de tareas/notas ni transiciones operativas. |
| `qapaq.platform.admin` | Unión explícita de capabilities SOC que entregue su sesión. | El nombre «admin» no permite saltar aislamiento de tenant/caso ni sustituye capabilities. |

No hay bundles runtime `SOC_L1`, `SOC_L2`, `SOC_MANAGER` ni `DETECTION_ENGINEER`.
Las personas y permisos futuros siguen siendo propuestas hasta implementarse y probarse en
el catálogo y en servidor.

## Referencias SOC abiertas

La selección adapta conceptos y contratos; no copia código, assets ni la UI de terceros.

- [TheHive: casos](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/about-cases/),
  [tareas](https://docs.strangebee.com/thehive/user-guides/analyst-corner/tasks/about-tasks/) y
  [observables](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/observables/about-observables/):
  trabajo asignable, logs de tarea y pivotes; verificar edición/capability antes de adoptar
  funciones dependientes de producto.
- [DFIR-IRIS docs](https://docs.dfir-iris.org/) y repositorios
  [`iris-web`](https://github.com/dfir-iris/iris-web) /
  [`iris-backend`](https://github.com/dfir-iris/iris-backend): casos colaborativos, tareas,
  evidencia, timeline y reportes. Revisar la licencia exacta del tag y avisos de seguridad
  antes de usar una dependencia o código.
- [Wazuh: alert management](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html)
  y [API](https://documentation.wazuh.com/current/user-manual/api/index.html): Wazuh conserva
  el ownership de alertas, agentes y reglas.
- [Shuffle](https://github.com/Shuffle/Shuffle) sirve como referencia futura de workflows,
  no de registro de caso ni cadena de custodia. La respuesta externa no forma parte de este
  workbench.

## Brechas restantes

| Capacidad | Estado y gate |
| --- | --- |
| Observables normalizados/correlación | No hay entidad QAPAQ dedicada ni enriquecimiento externo. Se muestran únicamente entidades que ya vienen en las alertas. |
| Evidencia y cadena de custodia | Bloqueada: el demo no tiene almacenamiento privado de objetos. No aceptar bytes en disco local ni PostgreSQL. Requiere storage seguro, SHA-256, eventos append-only, límites, retención y pruebas de integridad. |
| Métricas de cola e informes | Pendiente de contrato de métricas/series, definición de período, permisos y procedencia. No inferir cifras desde una página incompleta. |
| Respuesta externa | Futura. Requiere motor duradero, allowlist, aprobación humana, idempotencia, resultado confirmado y auditoría. Un comando de incidente no ejecuta contención. |

El software facilita evidencia y proceso; no certifica cumplimiento SBS/ISO ni sustituye la
validación institucional de alcance, retención y controles.

## Entrega Sprint 5

| Etapa | Estado |
| --- | --- |
| I-1: alertas, tareas, notas, timeline y audit trail | Contrato backend LISTO; frontend conectado en este cambio; queda revisión estática de Claude y aceptación de release. |
| I-2: observables | Diferido; reutiliza por ahora `AlertView.entities[]` sin catálogo ni enriquecimiento. |
| I-3: evidencia | Bloqueada por falta de object storage privado y política de retención. |
| I-4: métricas/reportes | Pendiente de API de métricas y diseño del reporte auditable. |
