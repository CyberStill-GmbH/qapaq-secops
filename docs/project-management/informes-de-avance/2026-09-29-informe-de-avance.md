# Informe de avance — 2026-09-29

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 29 de septiembre de 2026

**Asunto:** Daily Scrum — objetivo del día: cerrar Sprint 2 en su totalidad (C-10 a C-15, C-24)

Preparado para el Daily Scrum de **2026-09-29**. Facilitador: Cesar Adrian
Guevara Salcedo. Formato y vocabulario según [Daily Scrum](../daily-scrum.md)
y [Definition of Done](../definition-of-done.md).

**Verificación de origen:** este informe se redacta contra `main` en el
commit **`7e46282`** (`feat(platform): endurece lifecycle de secretos e
ingesta`), que cierra la jornada de ayer e incorpora C-10, C-11 y C-24
después del merge `3e10d73` de C-28. Complementa y no reemplaza el
[informe de cierre de 2026-09-28](2026-09-28-informe-de-cierre.md).

## Punto de partida — lo que ayer quedó cerrado

- **C-28** (gateway KrakenD, contrato/baseline) fusionado en `main`, con
  contrato local 6/6 PASS y gate CI `c28-krakend` obligatorio. Integración
  local (`validate.ps1`, `integration.mjs`) sin ejecutar en este host por el
  fallo persistente de Docker Desktop/WSL; sí corre en CI.
- **PBI-007** permanece `BLOCKED`, pero con diagnóstico real de causa raíz:
  el app registration de Microsoft Entra autentica correctamente y no tiene
  ningún permiso de aplicación concedido (`401 AF10001` al consultar el
  endpoint real que usa el módulo `o365` de Wazuh). Falta exclusivamente que
  Franco (o quien tenga rol `Application Administrator`) agregue el permiso
  `ActivityFeed.Read` y otorgue **admin consent** sobre el tenant — ver
  [C-10 — diagnóstico](../c-10/README.md).
- **C-10** (adapter Wazuh), **C-11** (admisión durable) y **C-24** (control
  plane write-only de credenciales) quedaron construidos en `7e46282`, con
  sus suites locales y [ADR-027](../../adr/027-write-only-secret-lifecycle-control-plane.md)
  registrado. Su aceptación real sigue condicionada a PBI-007 y a una
  instancia PostgreSQL real.
- **C-12, C-13, C-14 y C-15** no tienen código construido: son el alcance
  restante de Sprint 2.

## Objetivo de hoy — cerrar el alcance construible que queda

A diferencia del enfoque de WIP acotado a uno o dos componentes que se venía
aplicando desde el 2026-09-28, **hoy el objetivo es completar el alcance
construible restante de Sprint 2**: la ruta crítica ya avanzó hasta
**C-28 → C-10 → C-11**, y queda **C-12 → C-13 → C-14**, más los
transversales **C-15**
(telemetría/Grafana OSS) y el endurecimiento de **C-24** (control plane write-only de
credenciales). Es un objetivo ambicioso para una sola jornada — se declara
así explícitamente, no como promesa de aceptación garantizada — y se
mantiene con la misma regla que gobierna todo el proyecto: cada componente
se cierra con su suite local real y su failure path demostrado antes de
pasar al siguiente; no se declara `DONE` nada que no tenga evidencia
ejecutada.

**Lo que este objetivo NO incluye**, por estar fuera del control de hoy:

- El Sprint Goal formal (admitir una alerta Wazuh real originada en
  Microsoft 365) sigue condicionado enteramente a que se otorgue el admin
  consent pendiente de PBI-007. Si esa acción no ocurre hoy en Azure
  Portal, todos los componentes de la ruta crítica pueden llegar a `DONE`
  local con specs y mocks, pero la aceptación E2E contra Microsoft
  365/Wazuh real queda igual de bloqueada que ayer.
- La validación local de C-28 contra Docker (`validate.ps1`,
  `integration.mjs`) sigue dependiendo de que el daemon de Docker Desktop
  levante en este host; si no, se apoya en el gate CI como hoy.

### Forecast del día

| Orden | PBI | Componente | Depende de | Objetivo de hoy |
| --- | --- | --- | --- | --- |
| — | PBI-008 — Adapter Wazuh read-only | C-10 | C-05, C-08, C-28 | Ya construido en `7e46282`; sin trabajo nuevo hoy |
| — | PBI-009 — Raw, manifiesto y checkpoint | C-11 | C-04, C-06, C-10 | Ya construido en `7e46282`; sin trabajo nuevo hoy |
| 1 | PBI-010 — Mapping Wazuh → SecurityEvent | C-12 | C-05, C-10, C-11 | Mapping versionado, validación previa a indexación, rechazo de inválidos |
| 2 | PBI-011 — Idempotencia, replay y cuarentena | C-13 | C-11, C-12 | Inbox, duplicados, restart, cursor/checkpoint, cuarentena con lineage |
| 3 | PBI-012 — Indexación y consulta | C-14 | C-12, C-13 | Proyección OpenSearch y consulta tipada/autorizable, paginada, sin raw por defecto |
| 4 | PBI-013 — Telemetría, Collector, Loki/Prometheus, Grafana | C-15 (transversal) | C-10…C-14 | Baseline autogestionado con versiones fijadas y dashboard mínimo del pipeline |
| 5 | PBI-029 — Alta write-only de credenciales | C-24 (transversal) | C-03, C-08 | Contrato ya construido; hoy solo endurecimiento aditivo |

Ruta crítica de datos: **C-28 → C-10 → C-11** ya están en `main`; queda
**C-12 → C-13 → C-14**. C-15 se trabaja de forma transversal conforme cada
componente de la ruta crítica libera capacidad, no como tarea final del
día. Límite de WIP: hasta dos componentes de la ruta crítica activos en
simultáneo para no perder failure-path por componente.

## Plan de hoy

1. **C-12** — mapping Wazuh → SecurityEvent versionado, con validación y
   rechazo explícito de documentos inválidos o sobredimensionados.
2. **C-13** — idempotencia, replay, duplicado concurrente y cuarentena con
   causa y raw verificable; probar restart y cursor/checkpoint.
3. **C-14** — proyección e indexación en OpenSearch con consulta
   tipada/autorizable, paginada, sin exponer raw por defecto.
4. **C-15** (transversal, en paralelo según disponibilidad) — Collector,
   Loki/Prometheus y provisioning mínimo de Grafana con versiones fijadas;
   dashboard del pipeline con cobertura, lag y tasa de cuarentena.
5. **C-24** (transversal) — endurecimiento aditivo sobre el contrato ya
   construido: mapeo de sus códigos internos al catálogo público de errores y
   guardas de ciclo de vida en PostgreSQL.
6. Registrar en paralelo, sin bloquear el trabajo local: seguimiento del
   admin consent pendiente de PBI-007 con Franco. Si se otorga hoy, ejecutar
   de inmediato los tres pasos de verificación de
   [C-10 — diagnóstico](../c-10/README.md) contra el tenant real.
7. Mantener la regla de evidencia: cada componente publica su suite local
   real (contract/unit/integration según corresponda) antes de declararse
   `DONE`; ningún cierre se afirma solo por el volumen de código escrito hoy.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` en el tenant Entra | `BLOCKED`, bloquea el Sprint Goal E2E aunque C-10…C-14 lleguen a `DONE` local | Franco Clavo Santander | Otorgar el permiso y el admin consent en Azure Portal hoy si es posible |
| Docker Desktop/WSL sin levantar el daemon en el host de desarrollo | Activo desde el 2026-09-25 | Cesar | Reintentar el runbook ampliado ayer en [`local-environment.md`](../../development/local-environment.md); escalar con Diagnostic ID si persiste |
| C-28: sin digest inmutable, LB, `SecretProvider`, JWKS ni Indexer reales | `TO_BE_PROVIDED`, no bloquea el trabajo local de hoy pero sí el HA/E2E de PBI-030 (Sprint 3) | Infraestructura / Cesar | Fijar versión y digest en el BOM |
| Alcance de hoy sigue siendo amplio (C-12, C-13, C-14 y C-15 en un día) | Riesgo de sobrecompromiso aceptado explícitamente para intentar cerrar Sprint 2 | Cesar | Si al final del día algún componente no alcanza evidencia real, se registra `IN_PROGRESS` con lo pendiente exacto, no se fuerza `DONE` |
| C-10, C-11 y C-24 construidos pero sin aceptación contra dependencias reales | Contrato y suites locales PASS; falta PostgreSQL real y PBI-007 | Cesar / Franco | No declarar `DONE` de PBI hasta ejecutar el E2E con infraestructura real |

## Confianza en el Sprint Goal

ÁMBAR al abrir el día. El objetivo es completar la construcción local
restante de Sprint 2 en una sola jornada, lo cual sigue excediendo el ritmo
de los días previos, aunque el punto de partida es mejor de lo previsto: la
jornada del 28 cerró con C-10, C-11 y C-24 ya construidos además de C-28, de
modo que quedan C-12, C-13, C-14 y C-15. El riesgo real está en mantener
evidencia verificable (specs, failure paths, suites ejecutadas) en esos
cuatro componentes sin recortar ese estándar por la presión del
timebox. El Sprint Goal formal —admitir una alerta Wazuh real originada en
Microsoft 365— sigue sin poder cerrarse hoy salvo que Franco otorgue el
admin consent de PBI-007 durante la jornada; si eso no ocurre, el resultado
esperado de hoy es un Sprint 2 con **todos los componentes locales en
`DONE`** y el Sprint Goal formal todavía `BLOCKED` por la única dependencia
externa que ningún código puede resolver.

[Daily Scrum](../daily-scrum.md) · [Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Plan de componentes](../component-delivery-plan.md) · [Product Backlog](../product-backlog.md) ·
[Definition of Done](../definition-of-done.md) ·
[C-10 — diagnóstico real de Microsoft 365 en Wazuh](../c-10/README.md) ·
[Informe de cierre de 2026-09-28](2026-09-28-informe-de-cierre.md)
