# Informe de avance — 2026-10-01

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 1 de octubre de 2026

**Asunto:** Daily Scrum — la deuda de Sprint 2 ya no es de construcción sino de verificación

Preparado para el Daily Scrum de **2026-10-01**. Facilitador: Cesar Adrian
Guevara Salcedo. Formato y vocabulario según [Daily Scrum](../daily-scrum.md) y
[Definition of Done](../definition-of-done.md).

**Verificación de origen:** este informe se redacta contra la rama
`feat/sprint2-c12-c15`, commit **`3666189`**
(`feat(telemetry): construye C-12 a C-15 y corrige el conteo de la suite`), sobre
`29d19a4` en `main`. Pendiente de integrar.

## Cierre de ayer

La jornada del 30 cumplió y superó su compromiso: cerró C-12 y continuó hasta
completar el dominio de C-13, C-14 y C-15. Con eso **los ocho componentes de
Sprint 2 tienen código construido**. Se corrigió además un conteo de pruebas
inflado que esta serie de informes venía arrastrando. Detalle en el
[informe de cierre de 2026-09-30](2026-09-30-informe-de-cierre.md).

## Estado real de Sprint 2

| Componente | PBI | Dominio | Aceptación |
| --- | --- | --- | --- |
| C-10 — adapter Wazuh | 007, 008 | Construido | `BLOCKED` por PBI-007 |
| C-11 — admisión durable | 009 | Construido | Falta crash/fault en cada frontera con PostgreSQL real |
| C-12 — normalizador | 010 | Construido y verificado | Faltan provider specs contra Wazuh real |
| C-13 — resiliencia | 011 | Construido y verificado | Faltan integration specs con PostgreSQL y Redis |
| C-14 — proyección y consulta | 012 | Construido y verificado | OpenSearch no provisionado |
| C-15 — observabilidad | 013 | Construido y verificado | Falta baseline e instrumentación de etapas |
| C-24 — control plane | 029 | Construido y endurecido | E2E planificado para Sprint 3 |
| C-28 — gateway KrakenD | 030 | Construido | HA, digest y LB `TO_BE_PROVIDED` |

**Ocho de ocho construidos. Cero aceptados.** Línea base verificada:
`npx vitest run` → **27 archivos / 320 tests PASS**, typecheck de los once
proyectos, `oxlint` y `dependency-cruiser` sin hallazgos.

El trabajo cambió de naturaleza y conviene decirlo con claridad: **ya no falta
escribir código de dominio, falta demostrar que funciona contra sistemas
reales.** Ninguna de las tres cosas que faltan se resuelve escribiendo más
dominio.

## Objetivo del día

**Levantar el entorno local y ejecutar las integration specs de C-13 contra
PostgreSQL y Redis reales.**

Docker Desktop es hoy el bloqueo técnico dominante: por sí solo impide la
aceptación de **C-11, C-13 y C-24 a la vez**. Resolverlo desbloquea tres
componentes; cualquier otra tarea de hoy desbloquea como mucho uno.

El objetivo se declara con timebox: **media jornada**. Si a mitad de día el
daemon no levanta, se escala a Infraestructura con Diagnostic ID y se pasa al
plan alterno, sin seguir insistiendo.

### Si el entorno levanta

Las cuatro specs que el plan de Sprint 2 exige para C-13, y que **no** pueden
sustituirse por dobles:

1. Duplicado concurrente resuelto a un solo efecto, con dos trabajadores reales.
2. Reinicio a mitad de página sin perder ni adelantar el cursor.
3. Poison event aislado en cuarentena sin bloquear la fuente, verificado en tabla.
4. Reproceso que conserva la trazabilidad al crudo original.

### Plan alterno, si no levanta

Escribir el adaptador PostgreSQL de `EventInboxStore` y `CheckpointStore` —hoy
los puertos están declarados y **ningún adaptador existe**— junto con su suite de
conformidad, lista para ejecutarse en cuanto haya base. Es trabajo real que no
depende del entorno, aunque su verificación sí.

En paralelo, y sin depender de nada: instrumentar C-11 y C-12 con las primitivas
de C-15. Hoy existen las primitivas, no los puntos de medición.

## Lo que este objetivo NO incluye

- **C-14 sigue fuera del compromiso diario.** Depende de OpenSearch, que no está
  provisionado. Se retomará cuando Infraestructura confirme el entorno.
- **Ningún PBI se declara `DONE` hoy.** Tener el dominio construido no es
  aceptación; esa distinción es la que sostiene la credibilidad de este tablero.
- **El Sprint Goal formal no se alcanza hoy** y no se alcanzará mientras PBI-007
  siga sin consentimiento de administrador.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| Docker Desktop / WSL sin levantar el daemon | **Bloqueo dominante**, activo desde el 2026-09-25; impide la aceptación de C-11, C-13 y C-24 | Cesar / Infraestructura | Runbook de [`local-environment.md`](../../development/local-environment.md) con timebox de media jornada; escalar con Diagnostic ID |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` | `BLOCKED`; sin movimiento desde el 2026-09-28 | Franco Clavo Santander | Otorgar el consentimiento en Azure Portal; escalar al PO antes de la Review |
| OpenSearch no provisionado | Bloquea la aceptación de C-14 | Infraestructura | Confirmar provisión o declarar que no habrá en este timebox |
| Ocho componentes construidos y cero aceptados | Riesgo concentrado del sprint | Cesar / Franco | Reportar el incremento como tal en la Review, sin reetiquetarlo |
| Ningún adaptador implementado para los puertos declarados | Los contratos existen, las implementaciones no | Cesar | Plan alterno de hoy |
| `feat/sprint2-c12-c15` sin integrar a `main` | Trabajo fuera de la línea principal | Cesar | Integrar tras revisar |

## Confianza en el Sprint Goal

**ÁMBAR, con el riesgo desplazado.** El color no cambia, pero la causa sí, y eso
importa para decidir dónde poner el esfuerzo.

Hasta el 29 el riesgo era no terminar de construir. Esa parte está resuelta: el
pipeline completo existe, está verificado en dominio y pasa en verde. El riesgo
de hoy es que **nada de eso pueda demostrarse** porque los tres sistemas contra
los cuales debería probarse —el tenant de Entra, el entorno local y OpenSearch—
están fuera de nuestro alcance técnico.

El Sprint Goal formal —una alerta Wazuh real originada en Microsoft 365, admitida
y consultable— no se alcanzará sin el admin consent de PBI-007. El incremento que
se llevará a la Review es un pipeline completo y verificado en dominio, a la
espera de los sistemas contra los cuales demostrarse. Se reportará exactamente
así, sin convertir construcción en aceptación.

---

[Daily Scrum](../daily-scrum.md) · [Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Plan de componentes](../component-delivery-plan.md) · [Definition of Done](../definition-of-done.md) ·
[C-12](../c-12/README.md) · [C-13](../c-13/README.md) · [C-14](../c-14/README.md) · [C-15](../c-15/README.md) ·
[Informe de cierre de 2026-09-30](2026-09-30-informe-de-cierre.md)
