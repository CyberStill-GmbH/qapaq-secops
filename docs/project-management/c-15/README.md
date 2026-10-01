# C-15 — observabilidad del pipeline

Componente transversal de Sprint 2 asociado a **PBI-013**. Señales del recorrido
con cardinalidad acotada y sin datos sensibles, y un estado de salud que se puede
provocar y observar.

**Estado:** dominio construido con suite local en verde el 2026-10-01.
**`IN_PROGRESS`, no `DONE`**: falta el baseline autogestionado de Collector,
Prometheus, Loki y el provisioning de Grafana que exige ADR-025, y falta
instrumentar las etapas reales con estas primitivas.

Hasta hoy `platform/observability` contenía solo el dashboard de KrakenD y no era
un paquete ejecutable. Ahora lo es: `@qapaq/observability`.

## Guarda de etiquetas

Cierra **dos riesgos distintos**, que conviene no confundir:

**1. Fuga de datos.** Una etiqueta con IP, usuario, token o URL completa
convierte el sistema de métricas —que suele tener permisos más laxos que la base
de datos— en una copia no gobernada de datos sensibles (ADR-021).

**2. Cardinalidad.** Una etiqueta con valores no acotados multiplica las series
hasta tumbar la recolección.

La política es **allowlist**: lo que no está declarado, no se emite. Claves
permitidas: `component`, `stage`, `dataset`, `source_kind`, `severity`,
`outcome`, `status`, `result`, `error_code`.

| Violación | Qué detecta |
| --- | --- |
| `KEY_NOT_ALLOWED` | Clave fuera del catálogo — p. ej. `principal` |
| `VALUE_LOOKS_LIKE_IP` | IPv4 o IPv6 en el valor |
| `VALUE_LOOKS_LIKE_PRINCIPAL` | Usuario o correo |
| `VALUE_LOOKS_LIKE_URL` | URL, query string o par `?clave=valor` |
| `VALUE_LOOKS_LIKE_SECRET` | `Bearer …`, JWT, o huella hexadecimal larga |
| `VALUE_LOOKS_LIKE_IDENTIFIER` | UUID — **una serie por evento** |
| `VALUE_EMPTY` / `VALUE_TOO_LONG` / `VALUE_NOT_SLUG` | Forma inaceptable |

La guarda reporta **todas** las violaciones del juego, no solo la primera: un
operador necesita corregir de una vez, no descubrirlas en cadena.

### El hallazgo del UUID

La detección de identificadores se agregó porque la propia spec encontró el
hueco: un UUID pasaba la guarda sin objeción. Como etiqueta, un identificador por
evento produce una serie por evento. Se detecta aparte de los secretos porque el
remedio es distinto: **no se redacta, simplemente no es una etiqueta.**

### Presupuesto de cardinalidad

`CardinalityBudget` vigila en ejecución lo que la forma no puede detectar: una
etiqueta válida puede seguir siendo peligrosa si toma miles de valores distintos.
Admite valores hasta el tope por clave, no consume presupuesto al repetir, y
expone `exceededKeys()` para alertar.

## Salud del pipeline

El criterio del plan es que `healthy`, `degraded` y `failed` se puedan
**provocar y observar**, no que exista un endpoint que casi siempre diga "ok".

El estado se deriva de umbrales explícitos sobre señales medibles, y **cada
estado llega con las razones que lo produjeron**: un `degraded` sin motivo
legible no es accionable.

| Señal | Degraded | Failed |
| --- | --- | --- |
| Dependencia dura caída | — | cualquiera |
| Sin éxito reciente | 900 s | 3 600 s |
| Retraso de ingesta | 300 s | 1 800 s |
| Tasa de cuarentena | 5 % | 25 % |
| Tasa de error | 10 % | 50 % |

Se evalúan **todas** las condiciones y se conserva la más grave; las razones se
acumulan. Si algo está caído y además hay retraso, el informe dice ambas cosas.

## Series derivadas del recorrido

`deriveRates` expone cobertura, tasa de cuarentena y tasa de duplicados. La
invariante que importa de verdad es `lossless`: **todo lo recibido salió por
alguna puerta.** Una ventana sin tráfico no se reporta como pérdida ni divide por
cero.

## Tests y Definition of Done

```
npx vitest run platform/observability/test/pipeline-signals.spec.ts
```

| Verificación | Resultado 2026-10-01 |
| --- | --- |
| Guarda de etiquetas | **13/13 PASS** |
| Presupuesto de cardinalidad | **4/4 PASS** |
| Estados de salud provocados y observados | **7/7 PASS** |
| Series derivadas | **3/3 PASS** |
| Suite de unidad del monorepo | **27 archivos / 320 tests PASS** |
| Typecheck `@qapaq/observability` | PASS |

### Lo que falta explícitamente para `DONE`

1. Baseline de Collector, Prometheus y Loki con versiones fijadas, y provisioning
   mínimo de Grafana (ADR-025).
2. Instrumentar C-10 a C-14 con estas primitivas: hoy existen las primitivas, no
   los puntos de medición.
3. Provocar cada estado contra el pipeline corriendo, no solo sobre el modelo.

## Archivos

- [`label-guard.ts`](../../../platform/observability/src/label-guard.ts) — allowlist, redacción y cardinalidad.
- [`pipeline-health.ts`](../../../platform/observability/src/pipeline-health.ts) — señales, umbrales y series.

---

[Plan de componentes](../component-delivery-plan.md) ·
[C-13 — resiliencia](../c-13/README.md) ·
[C-14 — proyección y consulta](../c-14/README.md) ·
[Daily Scrum](../daily-scrum.md)
