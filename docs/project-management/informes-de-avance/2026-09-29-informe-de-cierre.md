# Informe de cierre del día — 2026-09-29

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 29 de septiembre de 2026

**Asunto:** Cierre de jornada — endurecimiento de C-24 en `main`; el objetivo del día (cerrar C-12, C-13, C-14 y C-15) **no se alcanzó**

Este informe cierra la jornada del 2026-09-29 sobre `main` en el commit
**`29d19a4`** (`docs(scrum): detalla el plan de cierre de todos los componentes
de Sprint 2`), último commit del día. Complementa el
[Daily Scrum](../daily-scrum.md) y el
[informe de avance de hoy](2026-09-29-informe-de-avance.md); no lo reemplaza,
lo cierra con el resultado real.

> **Lectura honesta del día.** El informe de la mañana declaró un objetivo
> explícitamente ambicioso: cerrar cuatro componentes en una jornada, tres de
> ellos secuenciales. Ese objetivo **no se cumplió**: C-12, C-13, C-14 y C-15
> terminan el día sin código construido, igual que lo empezaron. Se aplicó la
> regla que el propio plan fijó —registrar el pendiente exacto en lugar de
> forzar un `DONE`— y este informe la ejecuta sin matizarla.

## Resumen ejecutivo

| Frente | Estado al cierre |
| --- | --- |
| C-24 — control plane write-only | **Endurecido y en `main`** (`4e0bd5a`, integrado por `18c26f2`): mapeo al catálogo público de errores y guardas de ciclo de vida en PostgreSQL, con 12 specs propias |
| C-12 — normalizador Wazuh (PBI-010) | **Pendiente, sin avance**: no hay código de mapping en `modules/telemetry` |
| C-13 — resiliencia, idempotencia y cuarentena (PBI-011) | **Pendiente, sin avance** |
| C-14 — proyección OpenSearch y consulta (PBI-012) | **Pendiente, sin avance** |
| C-15 — observabilidad del pipeline (PBI-013) | **Pendiente, sin avance**: `platform/observability` sigue conteniendo solo el dashboard de KrakenD |
| PBI-007 (Microsoft 365 → Wazuh) | Sigue `BLOCKED`. El admin consent sobre `ActivityFeed.Read` **no se otorgó hoy** |
| Entorno local (Docker Desktop / WSL) | Sigue caído; sin cambio respecto al 2026-09-28 |
| Suite de unidad completa | **21 archivos / 212 tests PASS** (`npx vitest run`) |

Ningún PBI se declara `DONE` en este informe. El avance del día es de
endurecimiento de un componente ya construido (`C-24`) y de planificación
detallada, no de nuevos componentes.

## Lo único que aterrizó como código: endurecimiento de C-24

El commit **`4e0bd5a`** (`feat(configuration): mapea errores C-24 al catalogo
publico y endurece el ciclo de vida en base`), integrado en `main` por el merge
**`18c26f2`**, es aditivo: no altera datos ni estructura existente, solo agrega
una tabla de traducción y guardas en base.

### Mapeo al catálogo público de errores

[`secret-public-errors.ts`](../../../platform/configuration/src/control-plane/secret-public-errors.ts)
traduce cada código interno del control plane a la forma publicada en
`docs/error-catalog.md` (`code`, `status`, `helpRef`, `retryable`). La
presentación HTTP de Sprint 3 debe consumir exclusivamente esa tabla: los
códigos internos describen la causa para diagnóstico y no se exponen tal cual,
de modo que un cambio interno no rompa el contrato externo ni revele la
topología del control plane. Ningún mensaje se deriva del error interno; el
texto seguro lo fija el catálogo por `helpRef`. Decisión de diseño relevante
para seguridad: **403 y 404 comparten código público** (`ACCESS_DENIED`), para
no permitir enumerar qué secretos existen.

### Guardas de ciclo de vida en PostgreSQL

La migración añadida en `platform/database/prisma/migrations/` incorpora
funciones y triggers que hacen cumplir **en la base**, no solo en el código, las
invariantes del ciclo de vida del secreto gestionado: identidad inmutable,
revisión que solo avanza, estado revocado terminal, y versión ya reemplazada o
revocada no reactivable. Las violaciones se reportan con el mismo código de
error de restricción que ya usaba C-04, manteniendo un único contrato de fallo
para la capa de datos. La migración es estrictamente aditiva: no altera datos ni
estructura previa, y solo referencia columnas declaradas por la migración base.

### Evidencia real ejecutada

| Verificación | Resultado |
| --- | --- |
| `npx vitest run platform/configuration/test/secret-public-errors.spec.ts platform/database/test/c24-lifecycle-guards.spec.ts` | **2 archivos / 12 tests PASS** |
| `npx vitest run` (suite de unidad completa del monorepo) | **21 archivos / 212 tests PASS** |
| Integración PostgreSQL real de las guardas (`postgres-c24.integration.spec.ts`) | **No ejecutada localmente** — Docker Desktop sigue sin levantar el daemon en este host |

> **Nota de procedencia y corrección de cifras.** Las dos ejecuciones anteriores
> se corrieron al redactar este cierre (2026-09-30) contra `29d19a4`, el commit
> final del día 29. Se declaran así, y no como corridas del propio 29, para no
> atribuir a la jornada una evidencia que no se registró dentro de ella.
>
> La cifra de la suite completa **corrige un conteo inflado** que esta serie de
> informes venía arrastrando. `vitest.config.ts` declaraba `exclude`, lo cual
> anulaba el excluido por defecto de `node_modules`; los enlaces de workspace de
> pnpm hacían que las mismas specs se recogieran varias veces y la suite
> reportara 43 archivos / 570 tests donde existen 21 archivos / 212 tests
> reales. Ninguna prueba fallaba: el defecto era de conteo, no de calidad. Se
> detectó y corrigió el 2026-09-30; las cifras de este informe ya son las
> reales.

## El objetivo del día no se alcanzó: C-12, C-13, C-14 y C-15

El [informe de avance de hoy](2026-09-29-informe-de-avance.md) planteó cerrar
los cuatro componentes restantes de Sprint 2. Al cierre, el estado verificado
en el árbol de `main` es:

| Componente | Entregable comprometido | Estado real al cierre |
| --- | --- | --- |
| C-12 — normalizador | Mapping versionado Wazuh → `SecurityEvent` en `modules/telemetry` | `modules/telemetry/src` contiene solo `admission.ts`, `index.ts` y `s3-raw-store.ts`: **no hay mapping** |
| C-13 — resiliencia | Idempotencia, replay, cuarentena con lineage | Sin código; las tablas de C-04 siguen sin consumidor de C-13 |
| C-14 — proyección y consulta | Proyección OpenSearch + API de consulta tipada | Sin código ni contrato escrito |
| C-15 — observabilidad | Instrumentación y baseline Collector/Prometheus/Loki | `platform/observability` sigue con solo `README.md` y `grafana/` (dashboard de KrakenD) |

No hubo cierre parcial ni trabajo en curso sin commitear: el árbol de trabajo
está limpio y el último commit del día es documental. **Los cuatro componentes
se declaran `PENDIENTE`, no `IN_PROGRESS`**, porque `IN_PROGRESS` implicaría un
artefacto iniciado que aquí no existe.

### Causa, sin adorno

El alcance planteado en la mañana era irrealizable en el tiempo disponible: tres
de los cuatro componentes son estrictamente secuenciales en la ruta crítica, y
dos de ellos (C-13 y C-14) exigen PostgreSQL, Redis y OpenSearch reales que el
bloqueo de Docker Desktop mantiene inaccesibles desde el 2026-09-25. El riesgo
de sobrecompromiso estaba registrado explícitamente en el informe de la mañana y
en el Daily Scrum; se materializó. La jornada se consumió en el endurecimiento
aditivo de C-24 y en la planificación por componente —trabajo útil y con
evidencia— pero que no mueve la ruta crítica de Sprint 2.

**Consecuencia directa para la planificación:** el alcance construible de
Sprint 2 no se completará replicando el mismo plan mañana. Lo que corresponde es
secuenciar C-12 —que **no** depende de infraestructura real y por tanto sí es
cerrable con evidencia local— antes que C-13 y C-14, y dejar C-14 fuera del
compromiso diario mientras OpenSearch no esté disponible.

## PBI-007 — sin movimiento

El admin consent sobre `ActivityFeed.Read` en el tenant de Entra **no se otorgó
durante la jornada**. El diagnóstico de causa raíz del 2026-09-28
(`401 AF10001`: el app registration autentica pero no tiene permisos de
aplicación concedidos) sigue siendo la última evidencia real disponible; no hubo
nueva verificación porque no hubo cambio que verificar. **PBI-007 abre y cierra
el día `BLOCKED`, sin avance.**

Esto mantiene intacta la conclusión del plan de Sprint 2: aunque los ocho
componentes lleguen a construirse, el Sprint Goal formal —admitir una alerta
Wazuh real originada en Microsoft 365— no puede declararse logrado.

## Backlog y estado vigente de Sprint 2

Sprint 2 comprende ocho componentes. Al cierre del 29:

- **Construidos (4):** C-10 (adapter Wazuh), C-11 (admisión durable), C-24
  (control plane write-only, endurecido hoy), C-28 (gateway KrakenD). Su
  aceptación sigue condicionada a PBI-007 y a infraestructura real.
- **Pendientes (4):** C-12, C-13, C-14 y C-15. Sin cambio respecto a la apertura
  del día.
- **C-01…C-09:** `DONE` o `DONE` con excepción documentada, sin cambio. C-08
  sigue siendo el gate de entrada con su excepción del Product Owner del
  2026-09-25.
- **Ningún PBI se declara `DONE`.** PBI-006 y PBI-007 siguen abiertos.

## Riesgos y bloqueos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` en el tenant Entra | `BLOCKED`; sin movimiento hoy; bloquea el Sprint Goal completo | Franco Clavo Santander | Otorgar permiso y admin consent en Azure Portal; re-ejecutar la verificación de tres pasos de C-10 |
| Cuatro componentes de Sprint 2 sin construir, con el sprint avanzado | **Escalado**: el alcance construible de Sprint 2 está en riesgo real | Cesar | Re-secuenciar: C-12 primero (no depende de infraestructura); C-14 fuera del compromiso diario mientras no haya OpenSearch |
| Docker Desktop / WSL sin levantar el daemon | Activo desde el 2026-09-25; bloquea integración de C-13, C-14 y la suite PostgreSQL de C-24 | Cesar | Reintentar el runbook de [`local-environment.md`](../../development/local-environment.md); escalar a Infraestructura con Diagnostic ID |
| C-14 depende de OpenSearch operativo | No provisionado | Cesar / Infraestructura | Confirmar disponibilidad antes de comprometer el componente |
| Sobrecompromiso del plan diario | Materializado hoy | Cesar | Comprometer un componente por jornada con evidencia, no cuatro |
| C-10, C-11, C-24 y C-28 sin aceptación contra dependencias reales | Suites locales PASS (212 tests) | Cesar / Franco | No declarar `DONE` de PBI hasta el E2E con infraestructura real |

## Confianza en el Sprint Goal

**ÁMBAR con deterioro.** No cambia de color porque la base construida no
retrocedió —C-24 quedó más duro que ayer y la suite completa pasa en verde—,
pero la señal del día es negativa: se consumió una jornada completa sin mover
ninguno de los cuatro componentes que faltan, y quedan menos días que
componentes pendientes.

El Sprint Goal formal sigue condicionado enteramente al admin consent de
PBI-007, que hoy tampoco avanzó. Lo que sí está bajo nuestro control —completar
la construcción local de Sprint 2— pasó hoy de "ambicioso pero alcanzable" a
"requiere re-secuenciar el plan". El escenario realista al cierre de Sprint 2 es
un incremento con C-12 y C-13 construidos, C-14 y C-15 parciales o pendientes, y
el Sprint Goal registrado como **no logrado** por la dependencia externa. Ese
resultado se reportará como tal, sin reetiquetarlo.

---

[Daily Scrum](../daily-scrum.md) · [Informe de avance de hoy](2026-09-29-informe-de-avance.md) ·
[Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Plan de componentes](../component-delivery-plan.md) ·
[C-24 — control plane write-only](../c-24/README.md) ·
[C-10 — diagnóstico PBI-007](../c-10/README.md) ·
[ADR-027 — Ciclo de vida write-only de secretos](../../adr/027-write-only-secret-lifecycle-control-plane.md) ·
[Decisiones sin resolver](../../decisions/unresolved.md) ·
[Informe de cierre de 2026-09-28](2026-09-28-informe-de-cierre.md)
