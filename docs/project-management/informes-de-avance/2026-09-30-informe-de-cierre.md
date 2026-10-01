# Informe de cierre del día — 2026-09-30

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 30 de septiembre de 2026

**Asunto:** Cierre de jornada — C-12 construido con evidencia; C-13, C-14 y C-15 con dominio completo; corrección de un conteo de pruebas inflado

Este informe cierra la jornada del 2026-09-30 y recoge el trabajo continuado
hasta la madrugada del 2026-10-01. Complementa el
[Daily Scrum del 30](2026-09-30-informe-de-avance.md), que comprometió **un solo
componente**, y reporta el resultado contra ese compromiso.

> **El compromiso del día se cumplió, y se superó.** El plan del 30 comprometía
> cerrar C-12 y dejaba C-13 como objetivo extendido condicionado. C-12 cerró con
> sus seis specs, y el trabajo continuó sobre C-13, C-14 y C-15 hasta completar
> el dominio de los tres. Ninguno se declara `DONE`: lo que falta en cada uno
> está escrito abajo sin suavizar.

## Resumen ejecutivo

| Frente | Estado al cierre |
| --- | --- |
| **C-12 — normalizador Wazuh** | **Construido**, seis specs obligatorias en verde, documentado en [c-12](../c-12/README.md) |
| **C-13 — resiliencia** | Dominio completo y verificado; **`IN_PROGRESS`** — faltan integration specs con PostgreSQL y Redis reales |
| **C-14 — proyección y consulta** | Dominio completo y verificado; **`IN_PROGRESS`** — OpenSearch no provisionado |
| **C-15 — observabilidad** | Dominio completo y verificado; **`IN_PROGRESS`** — falta baseline Collector/Prometheus/Loki e instrumentar las etapas |
| Suite de unidad | **27 archivos / 320 tests PASS** (eran 21 / 212 al abrir) |
| Conteo de pruebas | **Corregido**: se venían reportando 570 por recolección duplicada |
| PBI-007 | Sigue `BLOCKED`; sin movimiento |

Ningún PBI se declara `DONE`. Los cuatro componentes tienen dominio construido y
verificado localmente; **ninguno tiene aceptación**, porque las dependencias
reales siguen fuera de alcance.

## C-12 — normalizador: construido

Mapping versionado de alerta Wazuh a `SecurityEvent`, en
[`wazuh-normalization.ts`](../../../modules/telemetry/src/wazuh-normalization.ts).
Severidad y categoría salen de catálogos fijos, no del texto del proveedor; la
versión del mapping viaja dentro del evento; el documento crudo no se difunde a
la salida.

**Defecto real encontrado por las specs durante la construcción:** `Date.parse`
acepta `2026-02-31` y lo desplaza en silencio al 3 de marzo. Una marca temporal
desplazada corrompe el orden del incremento y la ventana de reproceso. Ahora el
calendario se valida aparte del parseo.

| Verificación | Resultado |
| --- | --- |
| Suite propia de C-12 | **19/19 PASS** |
| Las seis specs obligatorias del plan | Cubiertas |

## C-13 — resiliencia: dominio completo

Ciclo de vida de la bandeja, reintentos, replay, avance de cursor y cuarentena
con linaje. Todo dominio puro: decide, no ejecuta.

Lo sustantivo que queda garantizado por construcción:

- **Un registro ya procesado absorbe la reentrega sin efecto** — "al menos una
  vez" sin duplicar.
- **Un fallo venenoso no consume reintentos**: va directo a cuarentena, porque
  reintentarlo solo repite el rechazo y bloquea la fuente.
- **El cursor no retrocede, no se adelanta a lo confirmado, y detecta escritura
  concurrente** por compare-and-set sobre `revision`.
- Si la fuente cambia de generación, **se escala en vez de adivinar**: comparar
  posiciones entre generaciones distintas saltaría eventos.
- **El linaje de cuarentena es obligatorio** y sobrevive a toda transición. Sin
  él la cuarentena es un cementerio: se sabe que algo falló, no qué era.

**36/36 PASS.** Detalle en [c-13](../c-13/README.md).

## C-14 — proyección y consulta: dominio completo

Proyección idempotente —el identificador del documento es el `recordId`, así que
reproyectar sobrescribe en lugar de duplicar— y modelo de consulta autorizable.

- **Deny por defecto** (ADR-009): sin `events.read` no hay resultado, y se
  resuelve antes de tocar el índice.
- **El tenant sale del lector autenticado, nunca de la petición.**
- **`raw` oculto por defecto** (ADR-018): sin `events.read_raw` la clave se
  elimina del documento entregado; no se vacía ni se enmascara, desaparece.
- Página 50 por defecto, 200 máxima. **Un tamaño mayor se rechaza en vez de
  recortarse en silencio**, porque recortar haría creer al llamante que recibió
  todo y pediría la página siguiente desde una posición equivocada.
- El contenido crudo nunca entra al índice de consulta: solo referencia y huella.

**26/26 PASS.** Detalle en [c-14](../c-14/README.md).

## C-15 — observabilidad: dominio completo

`platform/observability` dejó de ser solo un dashboard y es ahora un paquete
ejecutable, `@qapaq/observability`.

La guarda de etiquetas cierra dos riesgos distintos: **fuga de datos** —una
etiqueta con IP, usuario o token convierte el sistema de métricas, que suele
tener permisos más laxos que la base, en una copia no gobernada— y
**cardinalidad**. Política de allowlist: lo que no está declarado, no se emite.

**Segundo hallazgo de las propias specs:** un UUID pasaba la guarda sin objeción.
Como etiqueta, un identificador por evento produce una serie por evento. Se
agregó su detección, separada de la de secretos porque el remedio es distinto: no
se redacta, simplemente no es una etiqueta.

Los tres estados de salud se provocan y se observan, cada uno con las razones que
lo produjeron.

**27/27 PASS.** Detalle en [c-15](../c-15/README.md).

## Corrección de cifras: el conteo de pruebas estaba inflado

`vitest.config.ts` declaraba `exclude`, lo cual **anulaba el excluido por defecto
de `node_modules`**. Los enlaces de workspace de pnpm hacían que las mismas specs
se recogieran varias veces, y la suite reportaba 43 archivos / 570 tests donde
existían 21 / 212 reales.

**Ninguna prueba fallaba: el defecto era de conteo, no de calidad.** Corregido;
las cifras de los informes del 28, 29 y 30 quedaron rectificadas con nota
explícita en cada uno.

Se reporta como hallazgo propio y no se minimiza: una cifra de calidad inflada en
un informe a dirección es exactamente el tipo de error que destruye la confianza
en todos los demás números del proyecto.

## Estado de Sprint 2

Ocho componentes. **Los ocho tienen código construido**; ninguno tiene
aceptación.

| Componente | Dominio | Aceptación |
| --- | --- | --- |
| C-10, C-11, C-24, C-28 | Construido | Condicionada a PBI-007 e infraestructura |
| C-12 | Construido y verificado | Provider specs contra Wazuh real pendientes |
| C-13 | Construido y verificado | Integration specs con PostgreSQL/Redis pendientes |
| C-14 | Construido y verificado | OpenSearch no provisionado |
| C-15 | Construido y verificado | Baseline e instrumentación pendientes |

## Riesgos y bloqueos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| PBI-007: falta admin consent sobre `ActivityFeed.Read` | `BLOCKED` desde el 2026-09-28, sin movimiento | Franco Clavo Santander | Otorgar el consentimiento en Azure Portal |
| Docker Desktop / WSL sin levantar el daemon | Activo desde el 2026-09-25 | Cesar / Infraestructura | Es ahora el bloqueo técnico dominante: impide la aceptación de C-11, C-13 y C-24 |
| OpenSearch no provisionado | Bloquea la aceptación de C-14 | Infraestructura | Confirmar provisión |
| Ocho componentes construidos, cero aceptados | **Riesgo concentrado** | Cesar / Franco | La deuda del sprint ya no es de construcción sino de verificación contra sistemas reales |

## Confianza en el Sprint Goal

**ÁMBAR, con el riesgo desplazado.** La situación cambió de naturaleza respecto
al 29: ya no falta construir, falta verificar.

Toda la construcción local de Sprint 2 está hecha y en verde. Pero **ningún
componente puede aceptarse sin infraestructura**, y los tres bloqueos —admin
consent, Docker y OpenSearch— están fuera de lo que este lado puede resolver con
código.

El Sprint Goal formal —una alerta Wazuh real originada en Microsoft 365, admitida
y consultable— **no se alcanzó**, y no se alcanzará mientras PBI-007 siga sin
consentimiento. El incremento a reportar en la Review es un pipeline completo,
verificado en dominio, a la espera de los sistemas contra los cuales demostrarse.
Se reportará exactamente así.

---

[Daily Scrum](../daily-scrum.md) · [Informe de avance del 30](2026-09-30-informe-de-avance.md) ·
[C-12](../c-12/README.md) · [C-13](../c-13/README.md) · [C-14](../c-14/README.md) · [C-15](../c-15/README.md) ·
[Sprint 2 — plan completo](../sprints/02-ingesta-microsoft-wazuh.md) ·
[Informe de cierre de 2026-09-29](2026-09-29-informe-de-cierre.md)
