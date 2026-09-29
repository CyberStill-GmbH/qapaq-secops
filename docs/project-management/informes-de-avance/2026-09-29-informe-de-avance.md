# Informe de avance — 2026-09-29

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 29 de septiembre de 2026

**Asunto:** Daily Scrum — plan de cierre de todos los componentes de Sprint 2

Preparado para el Daily Scrum de **2026-09-29**. Facilitador: Cesar Adrian
Guevara Salcedo. Formato y vocabulario según [Daily Scrum](../daily-scrum.md)
y [Definition of Done](../definition-of-done.md).

**Verificación de origen:** este informe se redacta contra `main` en el commit
**`18c26f2`**, que integra el endurecimiento aditivo de C-24 sobre `7e46282`
(`feat(platform): endurece lifecycle de secretos e ingesta`), el cual a su vez
incorporó C-10, C-11 y C-24 tras el merge `3e10d73` de C-28.

## Estado real de Sprint 2

Sprint 2 comprende **ocho componentes**: la ruta crítica C-10 → C-14 y los
transversales C-15, C-24 y C-28. Cuatro están construidos y cuatro pendientes.

| Componente | PBI | Estado en `main` | Matiz obligatorio |
| --- | --- | --- | --- |
| C-10 — adapter Wazuh | 007, 008 | Construido | Contract/unit local y probe por KrakenD contra mock; provider specs contra Wazuh real siguen `BLOCKED` |
| C-11 — admisión durable | 009 | Construido | `admitPage`, raw/ref/hash y outbox en `modules/telemetry`; falta ejercitar caída en cada frontera con PostgreSQL real |
| C-24 — control plane write-only | 029 | Construido y endurecido hoy | Mapeo al catálogo público de errores y guardas de ciclo de vida en PostgreSQL; E2E en Sprint 3 |
| C-28 — gateway KrakenD | 030 | Construido | Contrato/baseline con gate CI obligatorio; HA, digest y LB `TO_BE_PROVIDED` |
| **C-12 — normalizador Wazuh** | 010 | **Pendiente** | Alcance de hoy |
| **C-13 — resiliencia** | 011 | **Pendiente** | Alcance de hoy |
| **C-14 — proyección y consulta** | 012 | **Pendiente** | Alcance de hoy |
| **C-15 — observabilidad del pipeline** | 013 | **Pendiente** | Alcance de hoy |

Quedan **cuatro componentes** para completar el alcance construible de Sprint 2.
La ruta crítica de datos ya está recorrida hasta C-11: **C-28 → C-10 → C-11**.
C-08 (contrato operativo Wazuh, Sprint 1) sigue siendo el gate de entrada y
mantiene su excepción del Product Owner del 2026-09-25.

## Objetivo del día

Cerrar **C-12, C-13, C-14 y C-15**, completando así todos los componentes de
Sprint 2. El objetivo es explícitamente ambicioso y se declara como tal: son
cuatro componentes en una jornada, tres de ellos en la ruta crítica y por tanto
estrictamente secuenciales.

La regla de evidencia no se relaja por el volumen: cada componente cierra su
failure path con suite ejecutada antes de abrir el siguiente. Si uno no alcanza
evidencia real al final del día, se registra `IN_PROGRESS` con lo pendiente
exacto; no se fuerza un `DONE`.

## Plan de cierre por componente

### C-12 — normalizador Wazuh → SecurityEvent (PBI-010)

**Entrada disponible:** `TelemetryProviderRecord` de C-11 y el contrato
`SecurityEvent` de C-05, que ya aporta schema, catálogos y corpus de fixtures
válidos e inválidos en `packages/contracts`.

**Entregable:** mapping versionado en `modules/telemetry` que convierte una
alerta Wazuh en `SecurityEvent`, con versión de mapping explícita, procedencia
y severidad derivadas de catálogo, y rechazo seguro de lo que no cumple.

**Specs obligatorias:** corpus válido produce documentos que validan contra el
schema; cada fixture inválido se rechaza con código estable; documento
sobredimensionado rechazado antes de construir el evento; el mapping no deja
pasar campos no declarados; la versión de mapping viaja en el evento.

**Failure path:** un documento inválido no aborta la página completa — se marca
para cuarentena y el resto avanza, que es la precondición de C-13.

### C-13 — inbox, idempotencia, replay y cuarentena (PBI-011)

**Entrada disponible:** las tablas `event_inbox`, `quarantined_events`,
`outbox_messages` y `source_checkpoints` ya existen desde C-04, y C-11 ya
escribe manifiesto y outbox.

**Entregable:** idempotencia por clave estable, replay de una ventana ya
procesada sin efecto duplicado, cuarentena con causa y lineage al raw, y
reproceso de un evento en cuarentena.

**Specs obligatorias:** duplicado concurrente resuelto a un solo efecto;
reinicio a mitad de página sin perder ni adelantar el cursor; poison event
aislado en cuarentena sin bloquear la fuente; reproceso que conserva la
trazabilidad al raw original.

**Restricción real:** estas specs exigen PostgreSQL y Redis reales. Con Docker
Desktop caído en este host, se ejecutan en CI o se registran como pendientes
con el comando y el entorno declarados; no se sustituyen por dobles.

### C-14 — proyección OpenSearch y consulta (PBI-012)

**Entrada disponible:** `SecurityEvent` admitido y deduplicado por C-12 y C-13.

**Entregable:** proyección del evento hacia OpenSearch y una API de consulta
tipada y autorizable, paginada, que **no expone `raw` por defecto**.

**Specs obligatorias:** consulta autorizada con filtros y límites; `raw` oculto
salvo capability explícita; caída y recuperación del Indexer sin pérdida ni
duplicación de proyección; límites de página aplicados según ADR-016 (50/200).

**Gate real:** requiere OpenSearch operativo. Es el componente con mayor riesgo
de no cerrarse hoy, porque depende del mismo entorno que Docker bloquea. Si no
hay OpenSearch disponible, C-14 queda `IN_PROGRESS` con el contrato y las specs
escritas pero sin evidencia de integración, y así se declara.

### C-15 — observabilidad del pipeline (PBI-013, transversal)

**Entrada disponible:** `platform/observability` solo contiene hoy el dashboard
de KrakenD; no hay código de instrumentación.

**Entregable:** métricas, logs y health de cada etapa del pipeline con
cardinalidad acotada, más el baseline autogestionado de Collector,
Prometheus y Loki con versiones fijadas y provisioning mínimo de Grafana, según
amplió ADR-025.

**Specs obligatorias:** cada estado `healthy`, `degraded` y `failed` se provoca
y se observa; ninguna etiqueta contiene IP, token, usuario, query string ni URL
completa; cobertura, lag y tasa de cuarentena quedan expuestos como series.

**Nota de secuencia:** C-15 no se difiere al final. Se instrumenta cada
componente conforme cierra, de modo que sus señales existan cuando C-14 esté
listo, no después.

## Lo que este objetivo NO incluye

- **El Sprint Goal formal no se alcanza hoy.** Admitir una alerta Wazuh real
  originada en Microsoft 365 depende enteramente del admin consent pendiente de
  PBI-007. Aunque los nueve componentes lleguen a `DONE` local, el Sprint Goal
  se registra como no logrado mientras esa acción no ocurra, conforme a la regla
  de salida del [plan de Sprint 2](../sprints/02-ingesta-microsoft-wazuh.md).
- **Ningún PBI se declara `DONE`** por tener su componente construido: la
  aceptación exige las provider specs contra sistemas reales.
- El E2E de C-24 y C-28 permanece planificado para Sprint 3, por diseño del
  propio contrato.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` en el tenant Entra | `BLOCKED`; bloquea el Sprint Goal aunque C-12…C-15 cierren | Franco Clavo Santander | Otorgar permiso y admin consent en Azure Portal |
| Docker Desktop/WSL sin levantar el daemon | Activo desde el 2026-09-25; bloquea specs de integración de C-13 y C-14 | Cesar | Ejecutar el runbook de [`local-environment.md`](../../development/local-environment.md); si persiste, apoyarse en CI y escalar con Diagnostic ID |
| C-14 depende de OpenSearch operativo | Riesgo alto de no cerrarse hoy | Cesar / Infraestructura | Confirmar entorno; si no hay, declarar `IN_PROGRESS` sin fingir evidencia |
| Cuatro componentes en una jornada, tres secuenciales | Riesgo de sobrecompromiso aceptado explícitamente | Cesar | Registrar `IN_PROGRESS` con pendiente exacto en lugar de forzar `DONE` |
| C-10, C-11 y C-24 sin aceptación contra dependencias reales | Contrato y suites locales PASS | Cesar / Franco | No declarar `DONE` de PBI hasta el E2E con infraestructura real |
| C-28: sin digest inmutable, LB ni JWKS reales | `TO_BE_PROVIDED` | Infraestructura / Cesar | Fijar versión y digest en el BOM |

## Confianza en el Sprint Goal

ÁMBAR. El punto de partida es mejor de lo previsto: cuatro de los ocho
componentes de Sprint 2 ya están construidos, la ruta crítica llega hasta C-11 y
el contrato `SecurityEvent` de C-05 aporta corpus listo para C-12. Eso hace
alcanzable cerrar C-12 y C-13 hoy con evidencia real.

El riesgo se concentra en **C-14**, cuyo cierre depende de OpenSearch operativo
y por tanto del mismo bloqueo de entorno que arrastramos desde el 25, y en
sostener el estándar de evidencia en cuatro componentes bajo presión de timebox.

El Sprint Goal formal —una alerta Wazuh real originada en Microsoft 365, admitida
y consultable— **no se alcanza hoy** salvo que Franco otorgue el admin consent de
PBI-007 durante la jornada. Si eso no ocurre, el resultado esperado es un Sprint 2
con todos sus componentes construidos y verificados en local, y el Sprint Goal
registrado como no logrado por la única dependencia externa que ningún código de
este lado puede resolver. Ese resultado se reporta como incremento utilizable, no
como Sprint Goal cumplido.

[Daily Scrum](../daily-scrum.md) · [Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Plan de componentes](../component-delivery-plan.md) · [Product Backlog](../product-backlog.md) ·
[Definition of Done](../definition-of-done.md) ·
[C-10 — diagnóstico PBI-007](../c-10/README.md) ·
[C-24 — control plane write-only](../c-24/README.md) ·
[Informe de cierre de 2026-09-28](2026-09-28-informe-de-cierre.md)
