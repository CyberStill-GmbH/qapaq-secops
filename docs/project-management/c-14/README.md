# C-14 — proyección al índice y consulta tipada

Componente de Sprint 2 asociado a **PBI-012**. Proyecta un `SecurityEvent` hacia
el índice de consulta y expone un modelo de consulta autorizable, acotado y
tipado.

**Estado:** dominio construido con suite local en verde el 2026-10-01.
**`IN_PROGRESS`, no `DONE`**: OpenSearch no está provisionado, así que ni la
indexación ni la recuperación ante caída se han demostrado. Era el componente con
mayor riesgo declarado, y el riesgo se confirmó.

## Proyección

`buildProjectionDocument` construye el documento consultable campo por campo.

**El identificador del documento es el `recordId` del evento.** Por eso
reproyectar el mismo evento sobrescribe en lugar de duplicar: una caída a mitad
de página no deja copias, sin necesidad de lógica de compensación.

El documento lleva `projectionVersion`. Un cambio de esquema obliga a reindexar,
y por eso la versión viaja dentro del documento y no en una tabla aparte.

| Decisión | Cuándo |
| --- | --- |
| `index` | El documento no existe |
| `skip` / `ALREADY_CURRENT` | Existe y su versión es la vigente — no cuesta una escritura |
| `reindex` | Existe con versión anterior — la migración es **explícita**, no un efecto colateral |

### El contenido crudo no entra al índice

La proyección guarda `rawRef` y `rawSha256` —referencia y huella— y nada más. El
documento original nunca se copia al índice de consulta. Una spec lo verifica
sobre el documento serializado.

## Consulta

Dos invariantes que no se negocian:

### 1. Deny por defecto (ADR-009)

Sin la capability `events.read` no hay resultado, y la ausencia de permiso se
resuelve **antes** de tocar cualquier índice.

**El tenant sale del lector autenticado, nunca de la petición.** Una consulta no
puede pedir los eventos de otro tenant aunque lo declare en el cuerpo; el campo
se ignora.

### 2. `raw` oculto por defecto (ADR-018)

La referencia al objeto crudo solo viaja al lector con capability
`events.read_raw`. No basta con poder leer eventos.

Cuando falta la capability, la clave `raw` **se elimina** del documento
entregado: no se vacía ni se enmascara, desaparece. La regla se aplica a la
página entera, no solo al primer elemento.

## Límites

Canónicos de ADR-016 y `docs/architecture/toolchain-and-capacity.md`:

| Límite | Valor | Comportamiento al excederlo |
| --- | --- | --- |
| Página por defecto | 50 | — |
| Página máxima | 200 | **Rechaza** con `PAGE_SIZE_EXCEEDED` |
| Ventana temporal | 90 días | Rechaza con `RANGE_TOO_WIDE` |
| Ventana ausente o invertida | — | `RANGE_REQUIRED` / `RANGE_INVERTED` |
| Valor de filtro desconocido | — | `FILTER_VALUE_UNKNOWN` con el campo |

**Un tamaño de página mayor al permitido se rechaza en vez de recortarse.** Si se
recortara en silencio, el llamante creería haber recibido todo lo que pidió y
pediría la página siguiente desde una posición equivocada.

Una consulta sin ventana acotada degenera en un barrido del índice completo, así
que la ventana es obligatoria.

## Puertos

`EventProjectionStore` y `EventQueryStore` en
[`ports.ts`](../../../modules/telemetry/src/ports.ts). El puerto de lectura
recibe una consulta **ya autorizada y acotada**: el adaptador no decide permisos.
Ningún adaptador existe todavía.

## Tests y Definition of Done

```
npx vitest run modules/telemetry/test/event-query.spec.ts
```

| Verificación | Resultado 2026-10-01 |
| --- | --- |
| Proyección, idempotencia y reindexación | **5/5 PASS** |
| Autorización y aislamiento de tenant | **4/4 PASS** |
| Límites de página, ventana y filtros | **11/11 PASS** |
| `raw` oculto por defecto | **3/3 PASS** |
| Suite de unidad del monorepo | **27 archivos / 320 tests PASS** |
| **Integration specs contra OpenSearch real** | **No ejecutadas** — OpenSearch no provisionado |

### Lo que falta explícitamente para `DONE`

1. Indexación y consulta contra OpenSearch real.
2. Caída y recuperación del Indexer sin pérdida ni duplicación de proyección.
3. Pruebas negativas de autorización contra la API real, no solo sobre el modelo.

## Archivos

- [`event-projection.ts`](../../../modules/telemetry/src/event-projection.ts) — documento proyectable y decisión de escritura.
- [`event-query.ts`](../../../modules/telemetry/src/event-query.ts) — modelo de consulta, autorización y forma del resultado.
- [`ports.ts`](../../../modules/telemetry/src/ports.ts) — contratos de adaptador.

---

[Plan de componentes](../component-delivery-plan.md) ·
[C-12 — normalización](../c-12/README.md) ·
[C-13 — resiliencia](../c-13/README.md) ·
[C-15 — observabilidad](../c-15/README.md) ·
[Daily Scrum](../daily-scrum.md)
