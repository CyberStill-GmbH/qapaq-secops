# 10 · Vistas SOC por rol y referencias visuales

**Estado:** mapa de producto para orientar implementación. **Corte de capacidades:**
2026-10-12. **Referencias:** conceptos generados antes de los siguientes cambios de UI.
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
| Administrador de plataforma · `qapaq.platform.admin` | Unión explícita de las 18 capabilities actuales, incluidas `observability.read_soc`, `observability.read_platform`, `sessions.read`, `sessions.revoke` y `secrets.write`. | Observabilidad conectada en `/operations`; sesiones conectadas en `/admin/sessions`. Usuarios y grants Entra siguen bloqueados por C-10(c), Graph y store persistente. |

Validar el mapa exacto en [RBAC](../requirements/04-rbac-matrix.md) y
[capabilities de runtime](../architecture/rbac.md) antes de cambiar menú o condiciones.
La comprobación server-side se mantiene aun cuando la acción no esté en el cliente.

### Composición de la consola por rol

La consola no cambia de shell por rol: filtra la navegación y las acciones con las
capabilities recibidas en la sesión. El resumen combina secciones y las muestra solo
cuando la capability de esa sección está presente.

| Rol runtime | Vistas navegables actuales | Acciones particulares |
| --- | --- | --- |
| Analista SOC | Resumen, Salud operativa (resumen/frescura), Alertas, Incidentes, Notificaciones, Mi sesión | Triaje/asignación permitidos por estado; acuse de notificación. Sin cierre de incidente, despacho manual ni detalle SOC de outbox. |
| Líder SOC | Vistas del analista, Auditoría | Raw de alerta según `events.read_raw`, cierre de incidente, despacho manual acotado, sección SOC de operaciones. No tiene verificación de integridad (`audit.verify`). |
| Auditor | Resumen (secciones permitidas), Incidentes (lectura), Auditoría, Integridad, Mi sesión | Lectura y verificación de cadena; sin comandos de alerta, incidente, acuse o despacho. `/operations` requiere `alerts.read` y no está disponible para este rol. |
| Administrador de plataforma | Vistas del líder, Integridad, Salud de plataforma, Sesiones de acceso, Mi sesión | Puede ver runtime/base, outbox y revocar sesiones ajenas con motivo/CSRF/auditoría. No puede administrar padrón/roles Entra mientras C-10(c) no provea API y grants. |

La URL `/events` responde con un estado informativo para enlaces guardados, pero no aparece
en navegación ni búsqueda rápida mientras falte `GET /api/events`. La capability
`events.read` por sí sola no convierte esa ruta en una función disponible.

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
| Resumen SOC | `/` | UI y APIs para alertas, incidentes, notificaciones y auditoría; health por fuente no está conectado. | Analista, lead, auditor/admin por sección; capability específica |
| Salud operativa | `/operations` | Conectada en código a `GET /api/operations/health` por la allowlist de KrakenD; falta aceptación en el despliegue. Analista ve frescura/cobertura; lead agrega outbox y despacho; platform admin agrega runtime y DB. Auditor denegado. La cobertura queda `NO_DATA` hasta C-5; intentos se agregan por estado en ventana fija de 24 h; métricas de proceso pueden venir sin dato. | `alerts.read`, `observability.read_soc`, `observability.read_platform` |
| Cola de alertas + detalle/investigación | `/alerts` | API/BFF, filtros disponibles, cursor, detalle, raw con permiso, triage y correlación. | `alerts.read`, triage/assign y raw según capability |
| Incidentes/casos + timeline | `/incidents` | Lifecycle de alert/incidente API, auditoría y concurrencia construidos; persistencia del runtime y provider E2E requieren aceptación. | `incidents.read`, write/close según acción |
| Notificaciones, intentos y acuse | `/notifications` | API y vista; outbox requiere cerrar fencing/worker y probar persistencia con PG real. | Lectura y acuse actual usan `notifications.read`; dispatch solo si `notifications.dispatch` |
| Auditoría e integridad | `/audit`, `/audit/integrity` | API read/verify y vista; retención/archive/restore productivos continúan gate. | `audit.read`, `audit.read_sensitive`, `audit.verify` |
| Eventos e investigación | `/events` | URL directa conserva estado explicativo; el menú no anuncia esta vista hasta que exista query normalizada y ruta BFF. Usar alertas correlacionadas como pivote disponible. | `events.read`; raw solo con `events.read_raw` según matriz |
| Salud de fuentes y pipeline | `/platform/health` | Salud detallada por dataset aún pendiente de C-5; `/operations` no la sustituye y deja cobertura como `NO_DATA`. | `platform.health.read`; ack requiere permiso mutante |
| Cuarentena / reproceso | `/platform/quarantine` | Diseño; no exponer botones hasta tener API de cuarentena y budget/audit reales. | Capabilities de lectura/reproceso por definir y publicar |
| Credenciales | `/platform/credentials` | Contrato write-only y dominio parcial; runtime/SecretProvider E2E pendiente. | Platform capability explícita; nunca read/export |
| Sesiones de acceso | `/admin/sessions` | Conectada al listado administrativo de sesiones de los últimos 7 días (máximo 2.000) y revocación auditable con CSRF, motivo y revisión. Muestra actividad autenticada reciente, no presencia en pantalla. | `sessions.read`, `sessions.revoke` |
| Administración Entra | `/admin/users` | UI creada detrás de `users.read`, actualmente sin capability/API de runtime; debe permanecer no disponible. El padrón del grupo, presencia y cambio de roles requieren cerrar C-10(c), consentimiento Graph y store de grants. | Access Admin y revisión de Seguridad futuros |
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

Las referencias anteriores de [Eventos/Salud](references/eventos-y-salud-concepto.png)
y [Entra](references/usuarios-entra-concepto.png) siguen disponibles como variaciones
pre-implementación. Para cualquier implementación, comprobar primero el código y usar
la especificación de pantalla/API correspondiente, no la imagen como contrato.

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
