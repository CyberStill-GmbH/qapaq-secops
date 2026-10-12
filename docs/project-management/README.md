# Plan Scrum profesional — MVP QAPAQ SecOps

Estado: BASELINE DE PLANIFICACIÓN · Inicio: 2026-09-19 · Fin del timebox: 2026-10-20.
Horizonte: 32 días calendario con tres Sprints: dos semanas, dos días laborables y
dos semanas. La disponibilidad horaria debe declararse en cada Sprint Planning; el
calendario no presupone trabajo en fines de semana.

## Propósito

Este plan convierte la arquitectura aceptada en un sistema de trabajo inspeccionable
para producir un candidato de MVP. Scrum organiza el aprendizaje y la entrega; no
convierte dependencias externas pendientes en compromisos falsos. El Product
Backlog es único y emergente, el Sprint Goal guía cada Sprint y solo el trabajo que
cumple la [Definition of Done](definition-of-done.md) forma parte del incremento.

Fuentes de método: [Scrum Guide 2020](https://scrumguides.org/scrum-guide.html),
[Product Backlog](https://www.scrum.org/resources/introduction-product-backlog),
[Definition of Done](https://www.scrum.org/resources/definition-done) y
[GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields).

## Product Goal

Entregar una plataforma QAPAQ SecOps capaz de convertir actividad autorizada de
Microsoft 365, analizada por Wazuh, en eventos canónicos, alertas y casos trazables,
con autorización, auditoría y operación medible; su arquitectura debe permitir
incorporar nuevas APIs mediante adapters sin cambiar el dominio ni los consumidores.
Las APIs directas atraviesan KrakenD CE on-premises y se admiten de forma durable
antes de publicar referencias en Redis/BullMQ.
La observabilidad del SOC usa Grafana OSS, Loki y Prometheus autogestionados para
mantener control QAPAQ sobre logs e información operacional sin contratar ese servicio.

## Objetivo del timebox

Producir un **MVP Candidate** ejecutable en ambiente controlado con esta ruta real:

```text
Microsoft 365 → Wazuh → Wazuh Indexer ← KrakenD ← QAPAQ connector
                                         → admisión durable → QAPAQ SecurityEvent
              → priorización → alerta/caso → auditoría → Teams si es CRITICAL
```

El candidato demuestra con specs automatizadas:

- build e instalación reproducibles;
- Microsoft 365 y Wazuh reales, con configuración autorizada;
- raw/referencia/hash, checkpoint, idempotencia, replay y cuarentena;
- mapping Wazuh → SecurityEvent versionado;
- consulta, alerta, triaje, caso y auditoría mínimos;
- autorización y notificación crítica cuando los accesos corporativos existan;
- fallo y recuperación de dependencias internas;
- una ruta documentada y verificada para añadir otro proveedor sin modificar
  dominio o consumidores.

`MVP Candidate` no equivale a producción. La promoción requiere los gates de
identidad, retención, continuidad, seguridad, infraestructura y soporte ya
documentados.

## Scrum Team y accountabilities

### Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

- ordena el Product Backlog por valor, riesgo y dependencia;
- define y comunica Product Goal y Sprint Goals junto con el equipo;
- acepta criterios de negocio y evidencia de riesgo;
- obtiene o escala accesos, dueños y decisiones corporativas;
- participa en Planning, Review y Retrospective;
- no declara Done un PBI que incumpla la Definition of Done.

### Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

- implementa, integra, documenta y ejecuta las specs;
- mantiene Sprint Backlog, tablero, riesgos y evidencia técnica;
- facilita Daily Scrum, refinamiento y Retrospective durante el timebox;
- eleva bloqueos sin ocultarlos ni sustituir dependencias por fakes;
- solicita revisión para decisiones o cambios de seguridad.

La doble accountability se revisa en cada Retrospective para evitar que la presión
de entrega silencie impedimentos. No convierte al Scrum Master en jefe del Product
Owner ni del proceso técnico. Dado
que existe un único Developer principal, vacaciones, reuniones o tareas externas
afectan directamente el forecast. El Product Owner no asigna trabajo diario; el
Developer decide cómo alcanzar el Sprint Goal dentro de las políticas aprobadas.

## Calendario

- Inicio administrativo y baseline: sábado 2026-09-19.
- [Sprint 1 — Base ejecutable y contratos](sprints/01-base-ejecutable.md):
  2026-09-19 a 2026-10-02.
- [Sprint 2 — Ingesta Microsoft 365/Wazuh](sprints/02-ingesta-microsoft-wazuh.md):
  2026-10-05 a 2026-10-06, dos días laborables.
- [Sprint 3 — Operación SOC y evidencia](sprints/03-operacion-soc.md):
  2026-10-07 a 2026-10-20.

Los Sprints empiezan en la fecha indicada, pero el trabajo ordinario y los eventos
se realizan en días laborables declarados. Planning ocurre el primer día laborable;
Review y Retrospective, el último. No se usa un “Sprint 0”: la preparación técnica
produce incrementos verificables desde Sprint 1.

El corte 2026-10-12 detectó que Sprint 3 tiene código materializado, pero conserva
gates `BLOCKED` de integración real y aceptación. El plan de
[cierre operativo post-timebox](plan-operativo-sprints-post-mvp.md) extiende la
numeración desde Sprint 4, propone owners Codex/Claude y DoD específico por incremento.
Al aceptar el PO esa replanificación, el nuevo plan gobierna el forecast futuro; los
tres sprints anteriores permanecen como registro histórico y no se reetiquetan como
completos por fecha.

## Cadencia de eventos

- Sprint Planning: máximo 90 minutos; confirma disponibilidad, Sprint Goal, PBIs
  seleccionados y plan técnico.
- Daily Scrum: 15 minutos cada día laborable; inspecciona avance al Sprint Goal,
  siguiente acción y bloqueo. No es reporte jerárquico; usa el
  [registro operativo](daily-scrum.md).
- Refinement: dos sesiones de 45 minutos en Sprint 1 y Sprint 3. Sprint 2 queda
  refinado y preparado antes de su Planning por tener solo dos días.
- Sprint Review: 60 minutos con evidencia ejecutada, no diapositivas como sustituto
  del incremento.
- Sprint Retrospective: 45 minutos; selecciona una mejora verificable para el
  siguiente Sprint.

Franco debe asistir a Planning y Review. Si no puede, define previamente un delegado
con autoridad; de lo contrario no se asume aceptación de negocio.

## Planificación de capacidad

No existe velocidad histórica y no se inventan story points. En cada Planning:

1. ambos declaran horas o días laborables realmente disponibles;
2. se descuentan reuniones, soporte, formación y ausencias conocidas;
3. se seleccionan PBIs completos en orden hasta el límite prudente;
4. cada PBI debe caber en el Sprint y producir evidencia independiente;
5. trabajo adicional se toma solo después de proteger el Sprint Goal.

Las tallas `S`, `M` y `L` sirven para conversación, no para medir productividad.
Un `L` debe dividirse antes de entrar al Sprint. El Sprint Backlog es un forecast,
no una promesa de alcance fijo; el Sprint Goal se conserva mientras el detalle se
adapta con el Product Owner.

## Política de evidencia: sin fakes

- Unit specs comprueban dominio puro, funciones deterministas y schemas.
- Contract specs ejecutan el schema y la suite de conformidad del adapter.
- Integration specs usan PostgreSQL, Redis/BullMQ, object storage y Wazuh reales
  en ambientes aislados y reproducibles.
- Provider specs usan Microsoft 365 autorizado y una instancia Wazuh real.
- E2E specs recorren la vertical desplegada en el ambiente de integración.
- Datos sintéticos controlados pueden generar actividad dentro de los sistemas
  reales; una respuesta simulada no demuestra integración.
- Si falta licencia, credencial, red o tenant, el PBI queda `BLOCKED`; no se marca
  Done, no se omite la spec y no se afirma funcionamiento.

## Gestión del trabajo en GitHub

El repositorio mantiene un solo Product Backlog. GitHub Project usa estos campos:

- `Status`: Backlog, Ready, In Progress, In Review, Blocked, Done.
- `Iteration`: Sprint 1, Sprint 2, Sprint 3 o Post-MVP.
- `Priority`: P0, P1, P2.
- `Type`: Feature, Security, Enabler, Defect, Spike.
- `Area`: contracts, platform, integrations, ingestion, detection, soc, access,
  audit, observability, web.
- `Risk`: high, medium, low.
- `Evidence`: enlace al PR, ejecución de CI o reporte sin secretos.

Cada Sprint tiene un milestone con su fecha final. Cada PBI vive en un issue y los
sub-issues se usan solo cuando entregan resultados revisables. Límite WIP para el
equipo: máximo dos items `In Progress` y uno `In Review`. `Blocked` conserva dueño,
causa, fecha, siguiente acción y fecha de escalamiento.

Las provider specs de Microsoft 365, Entra, Teams y Wazuh remoto se ejecutan desde
una rama confiable en un ambiente protegido, nunca desde una PR no confiable. Usan
secretRefs/OIDC y publican solo evidencia redactada. CI de PR conserva specs puras
y de servicios locales reales que no requieren credenciales corporativas.

Convenciones:

- rama `feat/<pbi>-<slug>`, `fix/<pbi>-<slug>` o `docs/<pbi>-<slug>`;
- Conventional Commits en español, por ejemplo
  `feat(ingesta): persistir checkpoint de Microsoft 365`;
- un PR pequeño por resultado coherente, vinculado al PBI;
- author y reviewer diferentes; Franco revisa valor/riesgo y Cesar atiende la
  evidencia técnica. Cambios críticos requieren el reviewer especializado definido
  por los ADR, aunque esté fuera del Scrum Team;
- squash solo si conserva una descripción final y trazabilidad suficiente.

## Planificación por componentes

El [plan de construcción por componentes](component-delivery-plan.md) asigna cada
PBI a una ruta, responsabilidad, dependencia y evidencia. Un item no entra al
Sprint Backlog con expresiones generales como «hacer backend» o «integrar Wazuh»:
debe indicar el componente `C-xx`, contrato afectado, specs aplicables y criterio
de salida.

Los entrypoints se mantienen delgados y la lógica compartida vive en `modules/`.
El Sprint 1 materializa workspace, contratos, plataforma mínima y fronteras; el
Sprint 2 construye connectors/telemetry de extremo a extremo; el Sprint 3 añade
detection, SOC, access, auditoría, SOAR y evidencia final. La ruta crítica y los
cortes de capacidad del plan prevalecen sobre ejecutar todos los PBI en paralelo.

Sprint 2 es un timebox intensivo de dos días. Por decisión del Product Owner del
2026-09-25, su desarrollo local puede iniciar con los contratos C-08 aunque falte
acceso operativo a Wazuh/Indexer o Microsoft 365. Los PBI y pruebas que dependen de
esos sistemas conservan el estado `BLOCKED`; sus gates pasan a la aceptación E2E
final del MVP. El Sprint Goal y MVP Candidate siguen pendientes hasta completar el
recorrido autorizado real. Esta excepción no autoriza fakes ni a presentar una
prueba unitaria como integración.

Esta duración es una replanificación excepcional decidida antes de Sprint 2. Al
terminar el MVP, la Retrospective debe fijar una cadencia estable para el siguiente
Product Goal usando la capacidad observada.

## Flujo del PBI

`Backlog → Ready → In Progress → In Review → Done`. `Blocked` puede aplicarse desde
cualquier estado activo. Los [criterios de refinamiento](definition-of-done.md) dan
transparencia, pero no constituyen una puerta contractual de Scrum.

Un PBI vuelve al Product Backlog cuando no cumple Done al final del Sprint. No se
asigna porcentaje parcial al incremento. Defectos descubiertos se ordenan en el
mismo backlog; no existe un backlog separado de “deuda” o “QA”.

## Dependencias y escalamiento

Antes de seleccionar el PBI afectado deben estar visibles:

- acceso administrado a Microsoft 365 y configuración Office 365 de Wazuh;
- instancia/versión Wazuh, Indexer y ruta de red;
- secretRefs y permisos mínimos, sin secretos en issues o repositorio;
- entorno de integración y recursos para dependencias reales;
- configuración Entra para login de QAPAQ;
- Teams Workflow, canal, propietario alterno y secretRef;
- aprobación de Seguridad para contrato/mapping y de Riesgos para criterios.

Un bloqueo técnico se registra el mismo día. Tras un día laborable sin resolución,
Cesar lo escala a Franco; Franco obtiene dueño y fecha objetivo. Si compromete el
Sprint Goal, ambos renegocian alcance sin reducir calidad ni reemplazar la prueba
real. Tras dos días laborables sin plan externo, el PBI vuelve al Product Backlog y
se toma el siguiente item independiente.

## Métricas de inspección

Se observan tendencias, no cuotas individuales:

- Sprint Goal logrado o no, con causa;
- PBIs Done frente a seleccionados;
- cycle time y tiempo bloqueado por PBI;
- antigüedad de WIP;
- defectos escapados y regresiones;
- duración y estabilidad de CI/specs;
- cobertura de criterios del MVP;
- riesgos abiertos y dependencias sin dueño.

No se usa velocidad para comparar personas ni se aumenta alcance para “llenar” una
cifra. El burn-up del Product Goal muestra alcance total y trabajo Done.

## Artefactos del plan

- [Product Backlog ordenado](product-backlog.md).
- [PBI-007 — diagnóstico y plan de desbloqueo Microsoft 365/Wazuh](pbi-007/README.md).
- [C-24 — control plane write-only de secretos](c-24/README.md).
- [C-12 — normalización de alertas Wazuh](c-12/README.md).
- [C-13 — resiliencia: bandeja, idempotencia, replay y cuarentena](c-13/README.md).
- [C-14 — proyección al índice y consulta tipada](c-14/README.md).
- [C-15 — observabilidad del pipeline](c-15/README.md).
- [Definition of Done y criterios de refinamiento](definition-of-done.md).
- [Plan de construcción por componentes](component-delivery-plan.md).
- [Daily Scrum y registro](daily-scrum.md).
- [Informes de avance](informes-de-avance/README.md).
- [Sprint 1](sprints/01-base-ejecutable.md).
- [Sprint 2](sprints/02-ingesta-microsoft-wazuh.md).
- [Sprint 3](sprints/03-operacion-soc.md).
- [Plan de cierre operativo post-timebox, Sprints 4–12](plan-operativo-sprints-post-mvp.md).
- [ADR-024 — vertical Microsoft 365/Wazuh](../adr/024-microsoft-365-wazuh-mvp-vertical.md).

El Product Owner puede reordenar el backlog. Cambiar Product Goal, fuente MVP,
ownership, controles de seguridad o arquitectura requiere actualizar el ADR
correspondiente. Cada Review actualiza forecast, riesgos y backlog para el Sprint
siguiente.
