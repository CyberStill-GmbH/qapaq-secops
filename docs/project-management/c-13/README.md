# C-13 — resiliencia: bandeja, idempotencia, replay y cuarentena

Componente de Sprint 2 asociado a **PBI-011**. Decide qué hacer con un registro
admitido: procesarlo, reintentarlo, aislarlo o reprocesarlo, sin duplicar efectos
y sin perder nada.

**Estado:** dominio construido con suite local en verde el 2026-10-01.
**`IN_PROGRESS`, no `DONE`**: las integration specs contra PostgreSQL y Redis
reales no se han ejecutado (Docker Desktop caído en este host desde el
2026-09-25). Sin esa corrida no hay aceptación.

## Qué decide y qué no

Este componente **decide**; no ejecuta. Todo el módulo es dominio puro: no
importa clientes de base de datos, no lee el reloj del sistema y no realiza
efectos. Las decisiones se devuelven como valores explícitos, incluido el
rechazo.

La separación es deliberada: la unicidad real vive en la base
(`event_inbox_source_idempotency_key`, de C-04) y el linaje de cuarentena es una
clave foránea compuesta, no una convención. **El dominio decide, la base impide,
y ninguna capa se confía a la otra.**

## Ciclo de vida de la bandeja

Estados: `admitted`, `processing`, `processed`, `quarantined`, `failed`.

| Desde | Comando | Resultado |
| --- | --- | --- |
| `admitted` | `lease` | `processing`, intento +1, vencimiento del lease |
| `processing` | `lease` | `noop` — el lease sigue tomado |
| `processing` | `complete` | `processed` |
| `processing` | `fail` (poison) | cuarentena, **sin consumir reintentos** |
| `processing` | `fail` (transient) | `admitted` con backoff, o `failed` si el presupuesto se agotó |
| `quarantined` / `failed` | `reprocess` | `admitted`, conservando el contador de intentos |
| `processed` | cualquiera | `noop` o rechazo — es terminal |

**Un registro ya procesado absorbe la reentrega sin efecto.** Ésa es la garantía
de "al menos una vez" sin duplicar: el productor puede reenviar con libertad.

### Reintentos

Presupuesto por defecto de 5 intentos, backoff exponencial `base · 2^(n−1)`
acotado a 300 s. **Sin jitter**: un reintento debe ser reproducible en una spec,
y la dispersión entre trabajadores se obtiene del lease, no del cálculo.

Un fallo `poison` no se reintenta nunca. Reintentarlo solo repite el mismo
rechazo y bloquea la fuente; va directo a cuarentena. Agotado el presupuesto de
un fallo transitorio, el registro queda `failed` y **visible**, no reintentándose
en silencio para siempre.

## Replay de una ventana

`planReplay` separa lo nuevo de lo ya visto y colapsa los duplicados dentro de la
propia página. Reprocesar una ventana completa admite solo lo que falta;
reprocesar una ventana ya procesada no admite nada.

La invariante verificada: **lo admitido más lo duplicado siempre iguala lo
recibido.**

## Avance de cursor

Tres formas de perder eventos en silencio, y cómo se cierran:

| Riesgo | Decisión |
| --- | --- |
| El cursor retrocede | `ignore` / `WOULD_REGRESS` — el orden total es (instante, desempate) |
| El cursor se adelanta a lo procesado | El avance se calcula sobre la página **confirmada**, no la leída |
| Dos trabajadores avanzan a la vez | `conflict` / `REVISION_STALE` — compare-and-set sobre `revision` |

Si la fuente cambia de generación, el resultado es `conflict` /
`SOURCE_GENERATION_CHANGED`: comparar posiciones entre generaciones distintas no
significa nada, y avanzar a ciegas saltaría eventos. **Se escala, no se adivina.**

El conflicto de revisión se evalúa antes que cualquier otra condición: ante una
escritura concurrente el llamante debe releer antes de concluir nada sobre la
posición.

## Cuarentena con linaje

`buildQuarantineEntry` exige el linaje completo (`sourceId`, `manifestId`,
`inboxId`, `rawEventReferenceId`, `recordId`) y falla si falta cualquier parte.

> Sin linaje la cuarentena es un cementerio: se sabe que algo falló, no qué era
> ni cómo repararlo. Con él, reprocesar es volver al original, no reconstruirlo.

Estados: `quarantined`, `reprocessing`, `resolved`, `discarded`. El presupuesto
de reproceso (3 intentos) evita que un veneno permanente consuma la cola. **El
linaje sobrevive a toda transición**: reprocesar no lo reescribe.

`fromNormalizationQuarantine` traduce la cuarentena que produce C-12 —que trabaja
con referencias al crudo— a la entrada persistible de C-13 —que trabaja con
identidades de la base—. La correspondencia la aporta la admisión (C-11).

## Puertos

Declarados en [`ports.ts`](../../../modules/telemetry/src/ports.ts), solo tipos:
`EventInboxStore`, `QuarantineStore`, `CheckpointStore`. **Ningún adaptador
existe todavía.** Fijan qué debe cumplir el que se escriba.

## Tests y Definition of Done

```
npx vitest run modules/telemetry/test/inbox-lifecycle.spec.ts \
               modules/telemetry/test/checkpoint-advance.spec.ts \
               modules/telemetry/test/quarantine-reprocess.spec.ts
```

| Verificación | Resultado 2026-10-01 |
| --- | --- |
| Ciclo de vida, reintentos y replay | **17/17 PASS** |
| Avance de cursor y orden | **10/10 PASS** |
| Cuarentena y reproceso | **9/9 PASS** |
| Suite de unidad del monorepo | **27 archivos / 320 tests PASS** |
| Typecheck `@qapaq/telemetry` | PASS |
| **Integration specs con PostgreSQL y Redis reales** | **No ejecutadas** — bloqueadas por entorno |

### Lo que falta explícitamente para `DONE`

Las cuatro specs de integración que el plan de Sprint 2 exige, y que **no**
pueden sustituirse por dobles:

1. Duplicado concurrente resuelto a un solo efecto, con dos trabajadores reales.
2. Reinicio a mitad de página sin perder ni adelantar el cursor.
3. Poison event aislado sin bloquear la fuente, verificado en la tabla.
4. Reproceso que conserva la trazabilidad al crudo original.

## Archivos

- [`inbox-lifecycle.ts`](../../../modules/telemetry/src/inbox-lifecycle.ts) — estados, reintentos y replay.
- [`checkpoint-advance.ts`](../../../modules/telemetry/src/checkpoint-advance.ts) — orden y avance de cursor.
- [`quarantine-reprocess.ts`](../../../modules/telemetry/src/quarantine-reprocess.ts) — cuarentena, linaje y reproceso.
- [`ports.ts`](../../../modules/telemetry/src/ports.ts) — contratos de adaptador.

---

[Plan de componentes](../component-delivery-plan.md) ·
[C-11 — admisión durable](../c-11/README.md) ·
[C-12 — normalización](../c-12/README.md) ·
[C-14 — proyección y consulta](../c-14/README.md) ·
[Daily Scrum](../daily-scrum.md)
