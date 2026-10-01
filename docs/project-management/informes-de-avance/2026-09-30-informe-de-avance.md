# Informe de avance — 2026-09-30

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 30 de septiembre de 2026

**Asunto:** Daily Scrum — plan re-secuenciado tras el incumplimiento del 29: un componente por jornada, C-12 primero

Preparado para el Daily Scrum de **2026-09-30**. Facilitador: Cesar Adrian
Guevara Salcedo. Formato y vocabulario según [Daily Scrum](../daily-scrum.md)
y [Definition of Done](../definition-of-done.md).

**Verificación de origen:** este informe se redacta contra `main` en el commit
**`29d19a4`**, último commit del 2026-09-29. El árbol de trabajo está limpio y
no hay trabajo sin integrar.

## Cierre de ayer

La jornada del 29 **no cumplió su objetivo**. El plan comprometía cerrar C-12,
C-13, C-14 y C-15; ninguno tiene código al cierre. Lo único que aterrizó fue el
endurecimiento aditivo de **C-24** (`4e0bd5a`, integrado por `18c26f2`): mapeo
de los códigos internos del control plane al catálogo público de errores y
guardas de ciclo de vida en PostgreSQL, con 12 specs propias. PBI-007 tampoco
se movió: el admin consent sigue sin otorgarse. Detalle completo en el
[informe de cierre de 2026-09-29](2026-09-29-informe-de-cierre.md).

El riesgo de sobrecompromiso estaba escrito en el propio plan de ayer y se
materializó. Este informe corrige el método, no solo el alcance.

## Estado real de Sprint 2

Ocho componentes: cuatro construidos, cuatro pendientes. Sin cambio respecto a
la apertura de ayer.

| Componente | PBI | Estado en `main` | Matiz obligatorio |
| --- | --- | --- | --- |
| C-10 — adapter Wazuh | 007, 008 | Construido | Provider specs contra Wazuh real siguen `BLOCKED` |
| C-11 — admisión durable | 009 | Construido | Falta ejercitar caída en cada frontera con PostgreSQL real |
| C-24 — control plane write-only | 029 | Construido y endurecido el 29 | Integración PostgreSQL y E2E en Sprint 3 |
| C-28 — gateway KrakenD | 030 | Construido | HA, digest inmutable y LB `TO_BE_PROVIDED` |
| **C-12 — normalizador Wazuh** | 010 | **Pendiente** | **Alcance comprometido de hoy** |
| C-13 — resiliencia | 011 | Pendiente | Objetivo extendido, solo si C-12 cierra |
| C-14 — proyección y consulta | 012 | Pendiente | **Fuera del compromiso**: requiere OpenSearch operativo |
| C-15 — observabilidad del pipeline | 013 | Pendiente | Transversal; se instrumenta junto a C-12, no al final |

**Línea base verificada hoy:** `npx vitest run` → **21 archivos / 212 tests
PASS**. La suite de unidad del monorepo está en verde sobre `29d19a4`. Esta cifra
corrige un conteo inflado (se venían reportando 570): `vitest.config.ts` anulaba
el excluido de `node_modules` y recogía las mismas specs varias veces por los
enlaces de workspace. Ninguna prueba fallaba; el defecto era de conteo.

## Objetivo del día

**Cerrar C-12 — normalizador Wazuh → `SecurityEvent` (PBI-010) — con evidencia
local real.** Un componente, no cuatro.

C-12 es la elección correcta por una razón concreta: **es el único de los cuatro
pendientes que no depende de infraestructura bloqueada**. Su entrada
(`TelemetryProviderRecord` de C-11) y su contrato de salida (`SecurityEvent` de
C-05, con schema, catálogos y corpus de fixtures válidos e inválidos en
`packages/contracts`) ya están en `main`. Por tanto es cerrable hoy con
`vitest` puro, sin Docker, sin PostgreSQL y sin OpenSearch.

### Entregable

Mapping versionado en `modules/telemetry` que convierte una alerta Wazuh en un
`SecurityEvent`: versión de mapping explícita en el evento, procedencia y
severidad derivadas de catálogo, y rechazo seguro de todo lo que no cumpla el
contrato.

### Specs obligatorias antes de declarar el componente

1. El corpus válido produce documentos que validan contra el schema de C-05.
2. Cada fixture inválido se rechaza con un código de error estable.
3. Un documento sobredimensionado se rechaza **antes** de construir el evento.
4. El mapping no deja pasar campos no declarados.
5. La versión de mapping viaja en el evento emitido.
6. **Failure path:** un documento inválido no aborta la página completa — se
   marca para cuarentena y el resto avanza. Esta es la precondición de C-13 y no
   es opcional.

### Instrumentación C-15 en el mismo paso

C-15 no se difiere. Conforme C-12 cierre, se exponen sus señales —eventos
normalizados, rechazados y marcados para cuarentena— con cardinalidad acotada y
sin IP, token, usuario, query string ni URL completa en las etiquetas. Es un
avance parcial de C-15, y se declarará como parcial, no como componente cerrado.

## Objetivo extendido, condicionado

**Solo si C-12 cierra con las seis specs en verde**, se abre **C-13**
(idempotencia por clave estable, replay sin efecto duplicado, cuarentena con
lineage al raw y reproceso). Las tablas `event_inbox`, `quarantined_events`,
`outbox_messages` y `source_checkpoints` existen desde C-04, y C-11 ya escribe
manifiesto y outbox: la entrada está lista.

**Restricción declarada por adelantado:** las specs de C-13 exigen PostgreSQL y
Redis reales. Con Docker Desktop caído, o se ejecutan en CI, o C-13 queda
`IN_PROGRESS` con el comando y el entorno declarados. **No se sustituyen por
dobles** y no se declara `DONE` sin esa corrida.

## Lo que este objetivo NO incluye

- **C-14 queda fuera del compromiso de hoy.** Depende de OpenSearch operativo,
  que no está provisionado. Comprometerlo otra vez sería repetir el error de
  ayer. Se retoma cuando Infraestructura confirme el entorno.
- **El Sprint Goal formal no se alcanza hoy.** Admitir una alerta Wazuh real
  originada en Microsoft 365 depende enteramente del admin consent pendiente de
  PBI-007. Aunque C-12 y C-13 cierren, el Sprint Goal se registra como no
  logrado mientras esa acción no ocurra.
- **Ningún PBI se declara `DONE`** por tener su componente construido: la
  aceptación exige las provider specs contra sistemas reales.

## Cambio de método, no solo de alcance

Tres reglas que este informe adopta a partir de hoy, como respuesta directa al
incumplimiento de ayer:

1. **Un componente comprometido por jornada.** El resto se declara objetivo
   extendido y condicionado, nunca compromiso.
2. **Nada que dependa de infraestructura caída entra en el compromiso diario.**
   Entra como objetivo condicionado con su entorno declarado.
3. **Un componente se abre solo cuando el anterior cerró su failure path con
   suite ejecutada.** El orden no se paraleliza para aparentar avance.

## Bloqueos y riesgos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` en el tenant Entra | `BLOCKED`; sin movimiento desde el 2026-09-28; bloquea el Sprint Goal aunque C-12…C-15 cierren | Franco Clavo Santander | Otorgar permiso y admin consent en Azure Portal; avisar para re-ejecutar de inmediato la verificación de C-10 |
| Cuatro componentes pendientes con el sprint avanzado | Escalado ayer; el alcance construible de Sprint 2 está en riesgo | Cesar | Re-secuenciación adoptada hoy; reportar al PO si C-12 no cierra |
| Docker Desktop / WSL sin levantar el daemon | Activo desde el 2026-09-25; bloquea C-13, C-14 y la integración PostgreSQL de C-24 | Cesar | Reintentar el runbook de [`local-environment.md`](../../development/local-environment.md); escalar a Infraestructura con Diagnostic ID |
| C-14 sin OpenSearch operativo | Excluido del compromiso de hoy | Cesar / Infraestructura | Confirmar provisión antes de volver a comprometerlo |
| C-10, C-11, C-24 y C-28 sin aceptación contra dependencias reales | Suites locales PASS (212 tests) | Cesar / Franco | No declarar `DONE` de PBI hasta el E2E con infraestructura real |
| C-28: sin digest inmutable, LB ni JWKS reales | `TO_BE_PROVIDED` | Infraestructura / Cesar | Fijar versión y digest en el BOM |

## Confianza en el Sprint Goal

**ÁMBAR.** La base construida es sólida y está verificada: cuatro componentes en
`main` y 212 tests en verde sobre el commit de partida. Lo que ayer se demostró
no es que el trabajo esté mal, sino que el plan diario estaba mal dimensionado.

El objetivo de hoy es deliberadamente más pequeño y por eso es creíble: C-12 no
toca ninguna dependencia bloqueada y tiene corpus listo desde C-05, así que su
cierre depende solo del tiempo de desarrollo. Si cierra, Sprint 2 pasa a cinco
de ocho componentes con la ruta crítica recorrida hasta la normalización.

El Sprint Goal formal —una alerta Wazuh real originada en Microsoft 365,
admitida y consultable— **no se alcanza hoy** salvo que Franco otorgue el admin
consent de PBI-007 durante la jornada. El resultado esperado al cierre de
Sprint 2 sigue siendo un incremento con la construcción local avanzada y el
Sprint Goal registrado como no logrado por la única dependencia externa que
ningún código de este lado puede resolver.

---

[Daily Scrum](../daily-scrum.md) · [Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Plan de componentes](../component-delivery-plan.md) · [Product Backlog](../product-backlog.md) ·
[Definition of Done](../definition-of-done.md) ·
[C-11 — admisión durable](../c-11/README.md) ·
[C-24 — control plane write-only](../c-24/README.md) ·
[C-10 — diagnóstico PBI-007](../c-10/README.md) ·
[Informe de cierre de 2026-09-29](2026-09-29-informe-de-cierre.md)
