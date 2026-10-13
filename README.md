# QAPAQ SecOps

**Un espacio de trabajo para investigar y coordinar incidentes de seguridad.**

QAPAQ reúne en una misma consola el trabajo que ocurre después de que una señal
de seguridad merece atención: revisar alertas, asignar responsables, abrir
incidentes, documentar el análisis y conservar quién hizo qué. Se integra con
las fuentes de seguridad del entorno y aporta el flujo operativo que un equipo
SOC necesita para convertir detecciones en investigaciones trazables.

QAPAQ complementa Wazuh. Wazuh conserva su papel en la recolección y detección;
QAPAQ organiza el triaje, la investigación, las notificaciones y la evidencia
operativa alrededor de esas señales.

## Qué incluye hoy

- **Operación de alertas:** colas de trabajo, asignación y triaje según el rol de
  cada persona.
- **Investigación de incidentes:** estado, alertas relacionadas, tareas,
  bitácora de notas y línea de tiempo.
- **Búsqueda de eventos:** consulta acotada de eventos disponibles en Wazuh,
  con filtros y resultados legibles para el analista.
- **Continuidad de fuentes:** estado, observaciones y actividad de las fuentes
  que reporta el servicio.
- **Avisos y acuses:** bandeja de notificaciones, distribución por rol y
  preferencias voluntarias de avisos en dispositivos.
- **Gobierno y trazabilidad:** acceso institucional, capacidades por rol,
  sesiones, padrón SOC de Entra, auditoría e integridad de registros.
- **Visibilidad operativa:** señales internas de salud pertinentes para los
  perfiles autorizados.

Las vistas y los contratos ya están representados en el producto. La aceptación
de cada conexión contra los proveedores y el ambiente demo se documenta por
separado; una pantalla por sí sola no prueba que el servicio externo esté activo.

## Diferencia frente a Wazuh

QAPAQ no pretende reemplazar el motor de reglas, los agentes ni la operación de
Wazuh. Su foco es el trabajo coordinado del SOC: quién toma una alerta, cómo se
convierte en incidente, qué tareas y hallazgos deja la investigación, cómo se
escala y dónde queda la evidencia y el acuse. Esto da al equipo una historia
operativa compartida a través de sus fuentes sin trasladar la autoridad de
detección fuera de Wazuh.

## Vistas del producto

La consola adapta navegación y acciones a las capacidades efectivas de cada
persona: **Analista SOC, Líder SOC, Auditor y Administrador de plataforma**. La
tabla enlaza la referencia visual más reciente disponible para cada superficie.
Las láminas con datos ilustrativos se identifican como conceptos y no son
capturas de un entorno conectado.

| Vista                         | Para qué sirve                                                   | Referencia visual                                                                                         |
| ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Acceso institucional          | Entrada a la consola de trabajo                                  | [Sistema visual QAPAQ](docs/frontend-design/02-sistema-visual.md)                                         |
| Resumen SOC                   | Orientar el turno hacia alertas, incidentes y asuntos pendientes | [Operación SOC y casos](docs/frontend-design/references/operacion-soc-y-casos-concepto.png)               |
| Salud operativa               | Consultar señales de operación disponibles según el rol          | [Salud operativa por rol](docs/frontend-design/references/salud-operativa-por-rol-concepto.png)           |
| Cola de alertas               | Priorizar y tomar trabajo de detección                           | [Operación SOC y casos](docs/frontend-design/references/operacion-soc-y-casos-concepto.png)               |
| Investigación de alerta       | Revisar contexto y acciones de triaje disponibles                | [Operación SOC y casos](docs/frontend-design/references/operacion-soc-y-casos-concepto.png)               |
| Incidentes                    | Seguir el ciclo de vida y las alertas relacionadas               | [Investigación de incidentes](docs/frontend-design/references/incidentes-investigacion-timeline-v1.png)   |
| Tareas de investigación       | Coordinar responsables y trabajo pendiente                       | [Vista de tareas](docs/frontend-design/references/incidentes-investigacion-tareas-v2.png)                 |
| Bitácora de investigación     | Mantener notas append-only y correcciones trazables              | [Vista de bitácora](docs/frontend-design/references/incidentes-investigacion-bitacora-v1.png)             |
| Línea de tiempo del incidente | Reconstruir cambios y eventos del caso                           | [Vista de timeline](docs/frontend-design/references/incidentes-investigacion-timeline-v1.png)             |
| Bandeja de notificaciones     | Revisar intentos de entrega y registrar acuses humanos           | [Operación SOC y casos](docs/frontend-design/references/operacion-soc-y-casos-concepto.png)               |
| Avisos en dispositivos        | Activar, probar y retirar avisos push personales                 | [Avisos en dispositivos · escritorio y móvil](docs/frontend-design/references/avisos-dispositivos-v1.png) |
| Eventos de seguridad          | Buscar y abrir eventos para apoyar una investigación             | [Eventos de seguridad · escritorio y móvil](docs/frontend-design/references/eventos-seguridad-v6.png)     |
| Salud de fuentes              | Entender estado, observaciones y actividad medida                | [Salud de fuentes · escritorio y móvil](docs/frontend-design/references/salud-fuentes-v5.png)             |
| Usuarios SOC                  | Consultar el grupo de acceso y los roles efectivos               | [Usuarios de Entra](docs/frontend-design/references/admin-usuarios-entra-v3.png)                          |
| Sesiones                      | Revisar accesos recientes y revocaciones administrativas         | [Gobierno y auditoría](docs/frontend-design/references/admin-entra-y-auditoria-concepto.png)              |
| Auditoría e integridad        | Consultar acciones y verificar la cadena de registros            | [Gobierno y auditoría](docs/frontend-design/references/admin-entra-y-auditoria-concepto.png)              |
| Mi sesión                     | Revisar la identidad, rol y capacidades propias                  | [Mapa de vistas por rol](docs/frontend-design/10-vistas-por-rol-y-referencias.md)                         |

### Vistas futuras, aún no disponibles para operar

La dirección de producto también contempla cuarentena y reproceso, credenciales,
ingeniería de detecciones, automatizaciones de respuesta, informes y capacidades
de gestión adicionales. Sus referencias ayudan a discutir el alcance futuro; no
representan controles activos ni funciones listas para producción.

| Área futura                      | Referencia conceptual                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cuarentena y reproceso           | [Eventos, salud y cuarentena](docs/frontend-design/references/eventos-salud-cuarentena-concepto.png) |
| Detección e ingeniería de reglas | [Detección y SOAR futuro](docs/frontend-design/references/deteccion-y-soar-futuro-concepto.png)      |
| Automatización de respuesta      | [Detección y SOAR futuro](docs/frontend-design/references/deteccion-y-soar-futuro-concepto.png)      |
| Administración y aprobaciones    | [Gobierno Entra y auditoría](docs/frontend-design/references/admin-entra-y-auditoria-concepto.png)   |

## Guía de documentación

| Si quieres saber…                                       | Empieza aquí                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Qué se considera parte del producto y qué falta         | [Mapa de vistas, roles y estado real](docs/frontend-design/10-vistas-por-rol-y-referencias.md)                                               |
| Cómo se comporta y presenta cada pantalla               | [Diseño de frontend](docs/frontend-design/README.md)                                                                                         |
| Qué datos, permisos y servicios respalda cada vista     | [Inventario funcional](docs/frontend-design/01-inventario-backend.md)                                                                        |
| Cómo trabaja el equipo SOC en incidentes                | [Investigación de incidentes](docs/frontend-design/incidentes-investigacion.md)                                                              |
| Qué integra QAPAQ y dónde termina su responsabilidad    | [Arquitectura y fronteras](docs/architecture/system-context.md)                                                                             |
| Qué decisiones y límites de seguridad guían el sistema  | [ADRs y decisiones](docs/adr/README.md) · [Seguridad y cumplimiento](docs/security/)                                                         |
| Qué falta para cerrar la demo y las siguientes entregas | [Plan operativo y sprints](docs/project-management/plan-operativo-sprints-post-mvp.md) · [Estado de AWS demo](docs/architecture/aws-demo.md) |
| Cómo preparar un entorno de trabajo                     | [Guía del entorno local](docs/development/local-environment.md)                                                                              |
| Cómo encontrar el resto de documentación                | [Índice completo de `docs/`](docs/README.md)                                                                                                 |

## Estado y alcance

QAPAQ está evolucionando desde una vertical conectada hacia una consola SOC más
completa. La interfaz distingue capacidades implementadas, aceptación de
integraciones reales y propuestas futuras. Wazuh sigue siendo responsable de sus
agentes y detecciones; QAPAQ conserva el flujo de investigación y gobierno que
añade valor al equipo de respuesta.

Las pruebas con proveedores reales, el despliegue y la preparación para uso
productivo tienen evidencias y gates propios. Revisa los documentos enlazados
antes de interpretar una lámina conceptual como demostración de disponibilidad.
