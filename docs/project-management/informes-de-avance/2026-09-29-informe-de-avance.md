# Informe de avance — 2026-09-29

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 29 de septiembre de 2026

**Asunto:** Daily Scrum — objetivo del día: cerrar Sprint 2 en su totalidad (C-10 a C-15, C-24)

Preparado para el Daily Scrum de **2026-09-29**. Facilitador: Cesar Adrian
Guevara Salcedo. Formato y vocabulario según [Daily Scrum](../daily-scrum.md)
y [Definition of Done](../definition-of-done.md).

**Verificación de origen:** este informe se redacta contra `main` en el
commit **`3e10d73`** (`merge: integrate C-28 KrakenD gateway`), el mismo
commit que cerró la jornada de ayer. Complementa y no reemplaza el
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
- Ningún componente de la ruta crítica de datos (**C-10, C-11, C-12, C-13,
  C-14**) ni los transversales (**C-15, C-24**) tienen código construido
  todavía; C-10 solo tiene el diagnóstico de bloqueo documentado.

## Objetivo de hoy — cerrar Sprint 2 completo, no dos componentes

A diferencia del enfoque de WIP acotado a uno o dos componentes que se venía
aplicando desde el 2026-09-28, **hoy el objetivo es completar en su
totalidad el alcance construible de Sprint 2**: toda la ruta crítica
**C-28 → C-10 → C-11 → C-12 → C-13 → C-14**, más los transversales **C-15**
(telemetría/Grafana OSS) y **C-24** (control plane write-only de
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
| 1 | PBI-008 — Adapter Wazuh read-only | C-10 | C-05, C-08, C-28 | Contrato + specs locales completos; paginación y errores de frontera |
| 2 | PBI-009 — Raw, manifiesto y checkpoint | C-11 | C-04, C-06, C-10 | Admisión durable con raw/ref/hash y checkpoint antes de publicar referencia |
| 3 | PBI-010 — Mapping Wazuh → SecurityEvent | C-12 | C-05, C-10, C-11 | Mapping versionado, validación previa a indexación, rechazo de inválidos |
| 4 | PBI-011 — Idempotencia, replay y cuarentena | C-13 | C-11, C-12 | Inbox, duplicados, restart, cursor/checkpoint, cuarentena con lineage |
| 5 | PBI-012 — Indexación y consulta | C-14 | C-12, C-13 | Proyección OpenSearch y consulta tipada/autorizable, paginada, sin raw por defecto |
| 6 | PBI-013 — Telemetría, Collector, Loki/Prometheus, Grafana | C-15 (transversal) | C-10…C-14 | Baseline autogestionado con versiones fijadas y dashboard mínimo del pipeline |
| 7 | PBI-029 — Alta write-only de credenciales | C-24 (transversal) | C-03, C-08 | Contrato create/rotate/revoke sin GET/export/plaintext |

Ruta crítica de datos: **C-28 (ya en `main`) → C-10 → C-11 → C-12 → C-13 →
C-14**. C-15 y C-24 se trabajan de forma transversal conforme cada
componente de la ruta crítica libera capacidad, no como tarea final del
día. Límite de WIP: hasta dos componentes de la ruta crítica activos en
simultáneo para no perder failure-path por componente, más C-15/C-24 en
paralelo cuando el estado del día lo permita.

## Plan de hoy

1. **C-10** — adapter Wazuh read-only en `modules/connectors`, consumiendo
   el Indexer a través de C-28: registro de fuente, paginación, cursor,
   timeouts y errores de frontera (401/403/429/5xx) contra el contrato local
   de C-08. Specs y suite ejecutable antes de avanzar a C-11.
2. **C-11** — admisión durable: raw/ref/hash, manifiesto y checkpoint en
   PostgreSQL antes de publicar cualquier referencia en Redis/BullMQ,
   preservando la invariante de ADR-026 (KrakenD nunca escribe a la cola).
3. **C-12** — mapping Wazuh → SecurityEvent versionado, con validación y
   rechazo explícito de documentos inválidos o sobredimensionados.
4. **C-13** — idempotencia, replay, duplicado concurrente y cuarentena con
   causa y raw verificable; probar restart y cursor/checkpoint.
5. **C-14** — proyección e indexación en OpenSearch con consulta
   tipada/autorizable, paginada, sin exponer raw por defecto.
6. **C-15** (transversal, en paralelo según disponibilidad) — Collector,
   Loki/Prometheus y provisioning mínimo de Grafana con versiones fijadas;
   dashboard del pipeline con cobertura, lag y tasa de cuarentena.
7. **C-24** (transversal) — contrato write-only create/rotate/revoke de
   credenciales, custodiado por `SecretProvider`, sin endpoint de lectura ni
   plaintext persistido.
8. Registrar en paralelo, sin bloquear el trabajo local: seguimiento del
   admin consent pendiente de PBI-007 con Franco. Si se otorga hoy, ejecutar
   de inmediato los tres pasos de verificación de
   [C-10 — diagnóstico](../c-10/README.md) contra el tenant real.
9. Mantener la regla de evidencia: cada componente publica su suite local
   real (contract/unit/integration según corresponda) antes de declararse
   `DONE`; ningún cierre se afirma solo por el volumen de código escrito hoy.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` en el tenant Entra | `BLOCKED`, bloquea el Sprint Goal E2E aunque C-10…C-14 lleguen a `DONE` local | Franco Clavo Santander | Otorgar el permiso y el admin consent en Azure Portal hoy si es posible |
| Docker Desktop/WSL sin levantar el daemon en el host de desarrollo | Activo desde el 2026-09-25 | Cesar | Reintentar el runbook ampliado ayer en [`local-environment.md`](../../development/local-environment.md); escalar con Diagnostic ID si persiste |
| C-28: sin digest inmutable, LB, `SecretProvider`, JWKS ni Indexer reales | `TO_BE_PROVIDED`, no bloquea el trabajo local de hoy pero sí el HA/E2E de PBI-030 (Sprint 3) | Infraestructura / Cesar | Fijar versión y digest en el BOM |
| Alcance de hoy es deliberadamente amplio (siete componentes/PBI en un día) | Riesgo de sobrecompromiso aceptado explícitamente para intentar cerrar Sprint 2 | Cesar | Si al final del día algún componente no alcanza evidencia real, se registra `IN_PROGRESS` con lo pendiente exacto, no se fuerza `DONE` |

## Confianza en el Sprint Goal

ÁMBAR al abrir el día, con una ambición explícita: el objetivo de hoy es
completar toda la construcción local de Sprint 2 en una sola jornada, lo
cual excede el ritmo de avance de los días previos (un componente por día).
Es alcanzable porque C-28 y el contrato de C-08 ya están en `main` y no
requieren reconstruirse, pero el riesgo real está en mantener evidencia
verificable (specs, failure paths, suites ejecutadas) en los siete
componentes/PBI restantes sin recortar ese estándar por la presión del
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
