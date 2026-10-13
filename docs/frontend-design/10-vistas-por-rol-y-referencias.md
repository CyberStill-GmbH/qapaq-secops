# 10 · Vistas SOC por rol y referencias visuales

**Estado:** mapa de producto verificado contra la implementación frontend del 2026-10-12.
**Corte de capacidades:** 2026-10-12. Las imágenes son conceptos sintéticos, nunca evidencia
de integración desplegada.
Una imagen ilustra composición; nunca comprueba que una ruta, fuente, dato o capability
exista.

## Personas y acceso actual

La autorización de la API, no la ruta del navegador, decide el acceso final. Los nombres
de abajo corresponden a los cuatro app roles runtime del repositorio. Las capacidades
aspiracionales de ADR-017/contratos no son roles disponibles.

| Persona / app role actual | Puede operar hoy | Límites que la UI debe mantener |
| --- | --- | --- |
| Analista SOC · `qapaq.soc.analyst` | Consultar alertas, triar/asignar y trabajar incidentes conforme a transitions autorizadas; leer notificaciones. | No mostrar acción de cierre, raw ni dispatch sin capability. El vacío de una cola nunca implica salud de fuente. |
| Líder SOC · `qapaq.soc.lead` | Funciones del analista; `incidents.close`, `audit.read`, `events.read_raw` y despacho manual acotado mediante `notifications.dispatch`, según capabilities de sesión. | `Despachar ahora` es una operación excepcional; el despacho normal corresponde al worker. Entregado no es acusado. |
| Auditor · `qapaq.auditor` | `audit.read`, `audit.read_sensitive`, `audit.verify` e incidentes de lectura, según token/runtime. | Lectura sin cambios de estado; hash/metadata sensibles con política de redacción. |
| Administrador de plataforma · `qapaq.platform.admin` | Unión explícita de capabilities SOC/runtime; puede leer salud, sesiones y padrón de admisión si la capability está en su sesión. | La vista Usuarios es de solo lectura; no concede capacidad para cambiar app roles ni membresía Entra. |

Validar el mapa exacto en [RBAC](../requirements/04-rbac-matrix.md) y
[capabilities de runtime](../architecture/rbac.md) antes de cambiar menú o condiciones.
La comprobación server-side se mantiene aun cuando la acción no esté en el cliente.

### Composición de la consola por rol

La consola no cambia de shell por rol: filtra la navegación y las acciones con las
capabilities recibidas en la sesión. El resumen combina secciones y las muestra solo
cuando la capability de esa sección está presente.

| Rol runtime | Vistas navegables actuales | Acciones particulares |
| --- | --- | --- |
| Analista SOC | Resumen, Salud operativa (resumen/frescura), Alertas, Incidentes, Notificaciones, Avisos en dispositivos, Mi sesión | Triaje/asignación permitidos por estado; acuse y push opt-in de notificaciones. Sin cierre de incidente, despacho manual ni detalle SOC de outbox. |
| Líder SOC | Vistas del analista, Auditoría, Eventos, Salud de fuentes | Raw de evento según `events.read_raw`, cierre de incidente, despacho manual acotado, avisos push opt-in y sección SOC de operaciones. No tiene verificación de integridad (`audit.verify`). |
| Auditor | Resumen (secciones permitidas), Incidentes (lectura), Auditoría, Integridad, Eventos, Salud de fuentes, Mi sesión | Lectura y verificación de cadena; sin comandos de alerta, incidente, acuse o despacho. `/operations` requiere `alerts.read` y no está disponible para este rol. |
| Administrador de plataforma | Vistas del líder, Integridad, Salud de plataforma, Sesiones de acceso, Usuarios SOC, Mi sesión | Puede ver runtime/base, outbox y revocar sesiones ajenas con motivo/CSRF/auditoría. El padrón es lectura; no cambia grants ni membresía Entra. |

`/events` y `/sources` aparecen en la navegación únicamente con sus capabilities efectivas.
`/events` consume telemetría de Wazuh por read-through; `/sources` requiere
`sources.health.read` y no aparece al analista.

## Perfiles futuros: diseñar, no anunciar como activos

| Perfil previsto | Superficie objetivo | Gate de activación |
| --- | --- | --- |
| Access Admin | Roster sincronizado del grupo Entra SOC, grants QAPAQ, solicitudes y primera aprobación. | Graph read-only delta, persistencia, grupo configurado, auditable, sin autoaprobación y con al menos dos aprobadores operables. |
| Revisor de Seguridad privilegiado | Segunda etapa de grants privilegiados. | Capability separada, step-up, distinto de solicitante, objetivo y aprobador previo. |
| Detection Engineer | Catálogo/versiones, cambio, corpus de evaluación, resultados y aprobación. | Catálogo/backend/versiones, autorización, corpus y métricas reales de calidad; no sustituir el ruleset de Wazuh. |
| SOC Manager | Vista agregada de operación, SLA/cobertura, informes y asignación según scope. | API paginada/series con definición, tenant scope, retención y permisos acordados. |
| Viewer / SOC L1 / L2 | Bundles de lectura u operación diferenciados. | No publicar el bundle hasta mapearlo en servidor a capabilities y scopes. |

El panel de usuarios debe mostrar **solo** miembros del grupo Entra `QAPAQ-SecOps-Users`,
incluyendo miembros sin grant QAPAQ. El estado «Activo ahora» deriva de sesión QAPAQ
vigente con actividad dentro del umbral acordado; no afirma presencia en Teams. No
buscar el tenant completo ni alterar membresía/cuenta Entra.

## Catálogo de pantallas y nivel real

| Superficie | Ruta | Estado al corte | Roles/capability de referencia |
| --- | --- | --- | --- |
| Acceso, error de login y retorno | `/login`, BFF OIDC | Login Entra implementado; proveedores corporativos reales y cierre del gate de identidad siguen siendo de release. | Sin sesión / inicio autorizado |
| Resumen SOC | `/` | UI y APIs para alertas, incidentes, notificaciones y auditoría; los cambios relevantes refrescan la vista por `/api/changes`. | Analista, lead, auditor/admin por sección; capability específica |
| Salud operativa | `/operations` | Conectada a `GET /api/operations/health`. Analista ve frescura/cobertura; lead agrega outbox y despacho; platform admin agrega runtime y DB. Auditor denegado. La cobertura queda `NO_DATA` hasta C-5; intentos se agregan por estado en ventana fija de 24 h; métricas de proceso pueden venir sin dato. | `alerts.read`, `observability.read_soc`, `observability.read_platform` |
| Cola de alertas + detalle/investigación | `/alerts` | API/BFF, filtros disponibles, cursor, detalle, raw con permiso, triage y correlación. | `alerts.read`, triage/assign y raw según capability |
| Incidentes e investigación | `/incidents` | Lista, búsqueda, lifecycle, alertas vinculadas, reasignación, tareas, bitácora append-only, timeline y guardas de cierre. Evidencia/observables dedicados siguen fuera. | `incidents.read`, `incidents.tasks.write`, `incidents.notes.write`, `incidents.write`, `incidents.close`; timeline de transiciones depende de `audit.read` |
| Notificaciones, intentos y acuse | `/notifications` | API y vista; outbox requiere cerrar fencing/worker y probar persistencia con PG real. | Lectura y acuse actual usan `notifications.read`; dispatch solo si `notifications.dispatch` |
| Preferencias de avisos push | `/settings/notifications` | API personal, suscripción VAPID, prueba y baja de dispositivos; service worker recupera pendientes autenticados, no almacena contenido. Aún requiere aceptación contra runtime push real. | `notifications.read`; la ruta de API vuelve a comprobar sesión/capability |
| Auditoría e integridad | `/audit`, `/audit/integrity` | API read/verify y vista; retención/archive/restore productivos continúan gate. | `audit.read`, `audit.read_sensitive`, `audit.verify` |
| Eventos e investigación | `/events` | Read-through `GET /api/events`, rango máximo 31 días, filtros normalizados multivalor o gramática `qapaq-events-v1`, cursor y estados disabled/error veraces. Consulta solo en estado de componente; resultados traducen outcome y fuente a datos legibles. | `events.read`; pestaña crudo solo con `events.read_raw` |
| Salud de fuentes | `/sources` | `GET /api/sources/health`; muestra evaluación, observaciones, transiciones y medición de cada suscripción en ventana de 24 h. Cero eventos es neutral y no determina salud; `unknown`/`disabled` también son neutrales. | `sources.health.read` (lead, auditor, admin) |
| Cuarentena / reproceso | `/platform/quarantine` | Diseño; no exponer botones hasta tener API de cuarentena y budget/audit reales. | Capabilities de lectura/reproceso por definir y publicar |
| Credenciales | `/platform/credentials` | Contrato write-only y dominio parcial; runtime/SecretProvider E2E pendiente. | Platform capability explícita; nunca read/export |
| Sesiones de acceso | `/admin/sessions` | Conectada al listado administrativo de sesiones de los últimos 7 días (máximo 2.000) y revocación auditable con CSRF, motivo y revisión. Explica la revocación por baja de grupo o pérdida de propiedad. Muestra actividad autenticada reciente, no presencia en pantalla. | `sessions.read`, `sessions.revoke` |
| Usuarios SOC | `/admin/users` | `GET /api/admin/users` y detalle `/:oid`; integrantes/dueños del grupo configurado más identidades del deploy. Muestra estado de sync, origen del rol, acceso efectivo y sesiones QAPAQ. Solo lectura; las sesiones revocadas por baja/cambio de propietario deben mostrar el motivo cuando el detalle API lo exponga. | `users.read` (admin runtime) |
| Perfil / sesión | `/me` | Identidad, roles y todas las capabilities efectivas de la sesión; se puede abrir desde pie de navegación o búsqueda rápida. No es una lista de sesiones ajenas. | Cualquier sesión autenticada |
| Detecciones | `/detections` | Concepto de producto futuro; no hay catálogo operativo para gestionar desde QAPAQ. | Detection Engineer futuro |
| Playbooks / acciones | `/playbooks`, `/actions` | Futuro; dispatcher de notificación no implica remediación de endpoints. Dry-run antes de cualquier ejecución real. | SOC/Automation separado, doble control por riesgo |
| Ayuda / errores | `/errors/:code` | Catálogo contractual en progreso; cada error conserva `correlationId`. | Sesión según la página de origen |

Los endpoints y permisos efectivos se validan antes de implementar el estado de una
superficie. «Pantalla especificada», «componente en React», «endpoint disponible» e
«integración real aceptada» son etapas distintas.

## Dirección visual y uso de conceptos

La dirección preserva el sistema existente: negro `#080808`, grises para jerarquía,
ámbar reservado a la marca/selección, tipografía Segoe UI/sistema, tablas legibles y
detalle contextual, botones de acción primaria blancos, severidad por rótulo y forma y
color semántico limitado. Se diseña para uso de turno: escaneo veloz, foco en la tarea,
estados explicables y evidencia accesible.

| Imagen | Superficies ilustradas | Alcance |
| --- | --- | --- |
| [Salud operativa por rol](references/salud-operativa-por-rol-concepto.png) | Comparación de `/operations` para analista, líder SOC y platform admin. | Datos ilustrativos y cobertura sin datos; guía visual, no evidencia de salud ni contrato de API. |
| [Eventos, salud y cuarentena](references/eventos-salud-cuarentena-concepto.png) | Investigación de eventos, salud Wazuh/M365 e inbox de cuarentena. | Las cifras/estados son sintéticos; la API todavía no está completa. |
| [Operación SOC y casos](references/operacion-soc-y-casos-concepto.png) | Resumen, cola de alertas, caso/timeline, notificaciones y acuse. | Referencia de layout; algunos datos/estados no coinciden con la implementación y no deben copiarse como features. |
| [Admin Entra y auditoría](references/admin-entra-y-auditoria-concepto.png) | Solo-miembros roster, sesiones, aprobación segregada, integridad. | Objetivo de diseño según `entra-soc-user-admin.md`; todavía no refleja runtime conectado. |
| [Detección y SOAR futuro](references/deteccion-y-soar-futuro-concepto.png) | Editor/versionado de reglas, corpus, dry-run y revisión de acción. | Todo panel lleva «objetivo futuro»; no habilitar catálogo ni respuesta hasta superar los gates. |
| [Avisos en dispositivos v1](references/avisos-dispositivos-v1.png) | Configuración push de escritorio y móvil, preview y política por rol. | Dispositivos y permiso sintéticos; contrato y UI se documentan en 04 §6.4; no prueba envío real. |

Las referencias anteriores de [Eventos/Salud](references/eventos-y-salud-concepto.png)
y [Entra](references/usuarios-entra-concepto.png) siguen disponibles como variaciones
pre-implementación. Para cualquier implementación, comprobar primero el código y usar
la especificación de pantalla/API correspondiente, no la imagen como contrato.

### Referencias Sprint 5 · estado de diseño y revisión

Generados el 2026-10-12 con escritorio y móvil en cada lámina. Son referencias visuales
con datos sintéticos, no capturas de una función desplegada. El plan
[Sprint 5](../development/plan-sprint5-eventos-salud-usuarios-casos.md) y los contratos
efectivos de API son la fuente de verdad. Las pantallas ya conectadas deben seguir el
contrato efectivo y no simular estados que la referencia no puede probar.

| Mockup | Vista/estado | Nota de alcance |
| --- | --- | --- |
| [Eventos de seguridad v1](references/eventos-seguridad-v1.png) | `/events`, borrador inicial | Obsoleto: navegación y paginación aún no respetaban revisión. |
| [Eventos de seguridad v5](references/eventos-seguridad-v5.png) | `/events`, escritorio/móvil | Referencia visual aceptada con acción explícita «Ver evento». Contrato actual agrega modo de consulta `q`; outcomes se traducen como Exitoso/Fallido/Desconocido. Datos sintéticos; no es captura de producción. |
| [Eventos de seguridad v6](references/eventos-seguridad-v6.png) | `/events`, escritorio/móvil, modo Consulta | Actualiza v5 con el editor `q` seguro y muestra outcomes válidos; guía del estado implementado, datos sintéticos. |
| [Salud de fuentes v4](references/salud-fuentes-v4.png) | `/sources`, escritorio/móvil | Una sola fuente Wazuh; medición de suscripciones de Office 365 anidada, ventana de 24 h y cero eventos explicado neutralmente. Reemplaza la lámina v3, que afirmaba una salud M365 separada inexistente. |
| [Salud de fuentes v5](references/salud-fuentes-v5.png) | `/sources`, escritorio/móvil, fuente medida | Corrige la razón de fuente y alinea la fecha de último intento con la medición mostrada. Datos sintéticos; backend debe conservar ambas marcas con semántica propia. |
| [Usuarios SOC v3](references/admin-usuarios-entra-v3.png) | `/admin/users`, estados actual/sincronizado | Solo lectura; muestra origen de rol, filas sin acceso y estado de sincronización sin inventar usuarios en el estado actual. Aceptada por Claude; sync global en cabecera, no por fila. |
| [Investigación · tareas v1](references/incidentes-investigacion-tareas-v1.png) | `/incidents/:id`, pestaña Tareas | Borrador superado por feedback de Claude. |
| [Investigación · tareas v2](references/incidentes-investigacion-tareas-v2.png) | `/incidents/:id`, pestaña Tareas | Incluye `required`, asignación (`assigneeId`), cancelación con motivo de 10–500 caracteres, acciones válidas y cierre bloqueado; aceptada por Claude. |
| [Investigación · bitácora](references/incidentes-investigacion-bitacora-v1.png) | `/incidents/:id`, pestaña Bitácora | Notas append-only y corrección por nueva nota. |
| [Investigación · timeline](references/incidentes-investigacion-timeline-v1.png) | `/incidents/:id`, pestaña Timeline | Distingue ocurrencia de fuente y registro en QAPAQ. |

Las imágenes son guía y no prueba de comportamiento desplegado. Claude aceptó el contenido
de Eventos v3, Tareas v2 y Usuarios v3; Eventos v5 conserva su contrato y ajusta el estilo
de acciones. Salud de fuentes v5 mantiene el modelo de una sola fuente y suscripciones
medidas con estados neutrales. La matriz de rutas/capabilities y el contrato
backend son la fuente de verdad; Bitácora y Timeline se implementan con las correcciones
de contenido revisadas.

## Lo que el diseño debe evitar

- tarjetas KPI vacías, tendencias calculadas desde una página parcial, gráficas sin
  definición del período, de la fuente o de sus límites;
- texto de relleno, claims de marketing, títulos genéricos, etiquetas repetidas,
  tutoriales dentro de cada panel, “AI insights” sin operación sustentada;
- estados verdes inventados, “online” por falta de errores, fuente sana por consulta
  vacía, caso cerrado cuando una remediación fue solo propuesta;
- controles sin acción conectada, acciones visibles sin capability, confirmaciones que
  no resumen el impacto, errores sin instrucción o `correlationId`;
- `react-icons` o packs de iconos que inyectan SVG genéricos; preferir etiqueta textual,
  shape/estado, CSS simple o SVG propio revisado y consistente con el sistema existente;
- copiar píxel a píxel Splunk/Sentinel/Elastic/Wazuh o código de proyectos OSS. Estudiar
  comportamientos y contratos operativos; implementar el concepto adecuado a QAPAQ y
  registrar licencia/atribución cuando se reutiliza código o assets bajo licencia;
- interfaces de respuesta automática con privilegio implícito: dry-run, alcance, permiso,
  versión, aprobadores, efecto y rollback siempre se entienden antes de ejecutar;
- ruido visual: glow/neón, gradientes de fondo, grid de tarjetas idénticas, animación sin
  respuesta a una acción, fuentes pequeñas de bajo contraste o severidad comunicada solo
  por color.

## Skills de agentes

- Codex: [`qapaq-soc-engineering`](../../.agents/skills/qapaq-soc-engineering/SKILL.md).
- Claude Code: [`qapaq-soc-engineering`](../../.claude/skills/qapaq-soc-engineering/SKILL.md).
- El plan de sprints y responsabilidades: [plan de cierre operativo](../project-management/plan-operativo-sprints-post-mvp.md).

Ambas skills deben abrir primero las reglas actuales de coordinación y comprobar locks,
estado de git, ADR y DoD pertinentes. Si la implementación discrepa de este mapa, corregir
el mapa a partir del comportamiento probado; no falsear la interfaz para que encaje con un
concepto.
