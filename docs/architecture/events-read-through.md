# Consulta de eventos hacia Wazuh Indexer

Estado: **C-8 diseño de lectura; implementación C-14/C-7 requiere extender el port**.
La consulta sigue siendo de solo lectura y pasa por el gateway C-28. No se añade una
conexión directa de la aplicación o del navegador al Indexer.

## Estado del port actual

`SecurityEventProvider.readPage()` recibe hoy `sourceId`, `dataset`, `from`, `to`,
`pageSize`, `cursor` y `signal`. El adapter `WazuhSecurityEventProvider` construye:

```json
{
  "size": 51,
  "query": { "range": { "timestamp": { "gte": "<from>", "lte": "<to>" } } },
  "sort": [{ "timestamp": { "order": "asc" } }, { "id": { "order": "asc" } }],
  "search_after": ["<timestamp>", "<id>"]
}
```

El tamaño real es `pageSize + 1` para decidir si hay siguiente página. La búsqueda usa
`POST /wazuh/_search` en KrakenD, que fija el índice desde `WAZUH_INDEX_PATTERN`; el caller
no puede elegir URL ni índice. El cursor de proveedor se firma con HMAC y liga source,
dataset, from, to, pageSize, valores de sort y expiración. Orden actual: timestamp ascendente
y `_id`/`id` como desempate; el campo de desempate tiene que confirmarse con el mapping real
del Indexer antes de producción.

## Extensión propuesta de `EventQuery`

Añadir filtros ya validados a `planQuery`; nunca aceptar DSL OpenSearch desde el navegador:

```ts
interface ProviderEventFilters {
  readonly severity?: readonly NormalizedSeverity[];
  readonly category?: readonly SecurityEventCategory[];
  readonly kind?: readonly SecurityEventKind[];
  readonly outcome?: readonly SecurityEventOutcome[];
}
```

El adapter compila una consulta construida por código:

```json
{
  "query": {
    "bool": {
      "filter": [
        { "range": { "timestamp": { "gte": "<from>", "lte": "<to>" } } },
        { "terms": { "rule.groups": ["authentication_failed", "sshd"] } },
        { "range": { "rule.level": { "gte": 8, "lte": 11 } } }
      ]
    }
  }
}
```

- Tiempo es `timestamp`, como ya usa el adapter.
- Severidad normalizada debe compilarse con la tabla versionada de
  `wazuh-normalization.ts` (level 0 informational; 1–3 low; 4–7 medium; 8–11 high;
  12–15 critical). Un multi-select se expresa como cláusulas OR por bandas, no una
  envolvente que incluya severidades no seleccionadas.
- Categoría/outcome se derivan hoy de `rule.groups` y la proyección Office 365. El mapper
  debe exponer a este adapter una inversión versionada del catálogo de grupos, mantener
  exclusión de grupos desconocidos y declarar qué categorías/outcomes no pueden empujarse
  hacia Wazuh. No aproximar filtros semánticos usando texto de `rule.description`.
- `kind` es `alert` para este dataset; rechazar valores incompatibles o devolver cero sin
  ampliar a documentos fuera de contrato.
- `dataset` solo admite valores en `allowedDatasets`; actualmente el adapter restringe a
  `wazuh-alerts`.
- `search_after` se aplica después de todos los filtros. Cursor firmado debe incorporar un
  hash canónico de filtros además de ventana/página para rechazar su reutilización con otra
  consulta.

## Rangos y volumen

El dominio `planQuery` permite hasta 90 días, pero el adapter Wazuh actual limita la consulta
a **31 días**. El BFF debe calcular el máximo efectivo como el menor entre límite de dominio,
límite configurado del adapter y retención disponible del dataset. La UI muestra el límite
efectivo y nunca ofrece hasta 90 días mientras el adapter siga en 31. Cualquier ampliación
requiere confirmar retención real del índice, costo y gateway timeout.

La página solicita 50 resultados de forma predeterminada y nunca excede el menor de 200 y
`maximumPageSize` anunciado por el adapter. Mantener `maximumResponseBytes`, timeout finito,
cancelación al abandonar consulta, backoff/jitter solo para fallos transitorios y
`Retry-After` cuando sea válido. No agregar scroll profundo sin cursor, wildcard, aggregations
sin límite ni búsqueda textual genérica.

## Seguridad y consistencia

1. El BFF resuelve actor, tenant, `events.read` y filtros canónicos antes de llamar el port.
2. El gateway recibe identidad de workload y solo permite los paths allowlisted
   `/wazuh/_search` y `/wazuh/_cluster/health`; no aceptar Authorization del usuario final
   como credencial de Indexer.
3. La consulta no incluye tenant arbitrario. La instalación Wazuh/Indexer debe aislar por
   índices y seguridad documental; confirmar filtro/tenant de la fuente antes de habilitar
   multi-tenant productivo. No confiar en que todos los tenants comparten un índice.
4. `raw` pasa por `shapeEventForReader`; ocultar el campo completo sin `events.read_raw`.
   Retener raw/descargar exige el port de custodia y permisos distintos.
5. Cursor inválido/expirado/incompatible es error de validación; gateway degradado es
   dependencia indisponible; página vacía válida no es fallo del collector.
6. Los errores públicos no llevan query, DSL, host, índices, body raw, tokens o nombres de
   alias internos. El `correlationId` del BFF sí se conserva.

## Criterios de aceptación de la extensión

- Specs exactas para DSL por fechas/filtro/página/sort/search-after con filtros aplicados
  antes de paginar y sin resultados repetidos al empatar timestamps.
- Verificar compatibilidad del mapping de índice para `rule.level`, `rule.groups`, timestamp
  e identificador de desempate en una instancia Wazuh autorizada.
- Cursor rechaza filtros alterados, otra fuente/dataset, página distinta, vencimiento y
  firma incorrecta.
- Tamaño y rango respetan simultáneamente dominio, proveedor, índice y deadline.
- Integración de proveedor autorizada (no mock solamente) demuestra tenant/source scoping,
  sort y límites. Sin esa instancia, `QAPAQ_EVENTS_SOURCE=disabled` responde
  `RESOURCE_UNAVAILABLE` con claridad y no hay resultado simulado.

