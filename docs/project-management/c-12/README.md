# C-12 — normalización de alertas Wazuh al contrato `SecurityEvent`

Componente de Sprint 2 asociado a **PBI-010**. Convierte una alerta Wazuh en un
documento `SecurityEvent` versionado (contrato C-05), o la aísla en cuarentena
con causa y linaje si no cumple.

**Estado:** construido con suite local en verde el 2026-09-30. **No se declara
`DONE` de PBI**: la aceptación exige las provider specs contra un Wazuh real,
que siguen condicionadas a PBI-007 y a infraestructura.

## Propósito y límites

C-12 es el eslabón entre la admisión durable (C-11) y todo lo que consulta
eventos. Su entrada es el `TelemetryProviderRecord` que C-11 ya admitió, más la
prueba del objeto crudo (`ref`, `sha256`, `mediaType`, `sizeBytes`). Su salida es
un `SecurityEvent` válido o una cuarentena.

Lo que **no** hace, por diseño:

- No persiste. No escribe a PostgreSQL, a la bandeja de entrada ni a la cola.
  Eso es C-13.
- No decide idempotencia ni deduplica. Deriva identidades estables y se detiene
  ahí.
- No consulta ni proyecta. Eso es C-14.

## Decisiones de mapeo

| Campo del contrato | Origen | Regla |
| --- | --- | --- |
| `kind` | fijo | Toda alerta Wazuh entra como `alert` |
| `eventUid` | `instanceId:dataset:sourceRecordId` | `eventUidType` siempre `native` |
| `recordId` | derivado | UUIDv7 determinista sobre `sha256` del crudo más el identificador de origen: el mismo registro reprocesado produce el mismo `recordId` |
| `severity` | `rule.level` (0–15) | Tabla fija de cinco bandas; el nivel original se conserva en `originalValue` |
| `category` | `rule.groups` | Catálogo cerrado grupo→categoría; lo no reconocido cae en `unclassified`, nunca se inventa |
| `outcome` | `rule.groups` | `authentication_success` → `success`; fallos de autenticación → `failure`; resto `unknown` |
| `entities.resources` | `agent` | Un recurso `host` de tipo `endpoint` |
| `entities.identities` | `data.srcuser`, `data.dstuser`, `data.office365.UserId` | Una identidad `user`; si no hay ninguna, el arreglo queda vacío |
| `detection.rule` | `rule` | `id`, `description` y hasta 32 grupos |
| `provenance` | contexto | Incluye `mappingVersion` y la cadena de ingesta (colector Wazuh → adaptador QAPAQ) |

**La severidad y la categoría salen de catálogo, no del texto del proveedor.**
Wazuh puede cambiar la descripción de una regla sin que cambie la severidad con
que la registramos.

### Banda de severidad

| Nivel Wazuh | Normalizada | Score |
| --- | --- | --- |
| 0 | `informational` | 0 |
| 1–3 | `low` | 25 |
| 4–7 | `medium` | 50 |
| 8–11 | `high` | 75 |
| 12–15 | `critical` | 95 |

## El documento crudo no se difunde

El evento se construye campo por campo desde rutas declaradas. En ningún punto
se copia el crudo al evento ni se usa propagación de objetos. Una spec lo
verifica de forma directa: inyecta un campo no declarado y una contraseña en el
documento de entrada y comprueba que ninguno aparece en el evento serializado.

## Failure path: la página no se detiene

`normalizeWazuhPage` nunca lanza por un documento malo. Cada registro sale
normalizado o en cuarentena, y la suma de ambos siempre iguala lo recibido.
Toda cuarentena conserva `rawRef` y `rawSha256`, de modo que el original se
puede revisar o reprocesar. Ésa es la precondición de C-13.

Códigos de rechazo estables: `RAW_TOO_LARGE`, `RAW_NOT_OBJECT`,
`MISSING_TIMESTAMP`, `INVALID_TIMESTAMP`, `MISSING_RULE`, `INVALID_RULE_LEVEL`,
`INVALID_RULE_IDENTITY`, `CONTRACT_VALIDATION_FAILED`.

### Fechas imposibles

`Date.parse` acepta `2026-02-31` y lo desplaza en silencio al 3 de marzo. Una
marca desplazada corrompe el orden del incremento y la ventana de reproceso, así
que el calendario se valida aparte del parseo (mes 1–12, día real del mes,
bisiestos, hora/minuto/segundo en rango). Este defecto lo encontró la propia
spec durante la construcción, no una revisión posterior.

## Tests y Definition of Done

Suite: `modules/telemetry/test/wazuh-normalization.spec.ts`.

```
npx vitest run modules/telemetry/test/wazuh-normalization.spec.ts
```

| Verificación | Resultado 2026-09-30 |
| --- | --- |
| Suite propia de C-12 | **19/19 PASS** |
| Suite de unidad del monorepo | **22 archivos / 231 tests PASS** |
| Typecheck de `@qapaq/telemetry` | PASS |
| Provider specs contra Wazuh real | **No ejecutadas** — `BLOCKED` por PBI-007 e infraestructura |

Cubre las seis specs obligatorias del plan: corpus válido contra el schema,
rechazo con código estable, documento sobredimensionado rechazado antes de
construir, ningún campo no declarado en la salida, versión de mapping dentro del
evento, y failure path de página.

## Corrección de alcance encontrada hoy

`vitest.config.ts` declaraba `exclude`, lo cual anulaba el excluido por defecto
de `node_modules`. Los enlaces de workspace de pnpm hacían que las mismas specs
se recogieran varias veces y la suite reportara 43 archivos / 570 tests donde
existen 22 / 231 reales. Ninguna prueba fallaba: el defecto era de conteo, no de
calidad. Corregido en este mismo cambio; las cifras de los informes anteriores
quedaron rectificadas.

## Archivos

- [`modules/telemetry/src/wazuh-normalization.ts`](../../../modules/telemetry/src/wazuh-normalization.ts) — mapping y failure path.
- [`modules/telemetry/src/deterministic-id.ts`](../../../modules/telemetry/src/deterministic-id.ts) — derivación de identidades compartida con C-11.
- [`modules/telemetry/test/wazuh-normalization.spec.ts`](../../../modules/telemetry/test/wazuh-normalization.spec.ts) — suite del componente.

---

[Plan de componentes](../component-delivery-plan.md) ·
[Sprint 2](../sprints/02-ingesta-microsoft-wazuh.md) ·
[C-11 — admisión durable](../c-11/README.md) ·
[Daily Scrum](../daily-scrum.md)
