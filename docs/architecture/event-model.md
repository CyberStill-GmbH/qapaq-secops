# SecurityEvent y contratos de frontera

Estado: PROPOSAL v1; no schema desplegado ni interoperabilidad certificada.
[ADR-011](../adr/011-security-event-normalization.md).

## ECS frente a OCSF

ECS ofrece nombres, tipos y semántica de campos útiles para búsqueda; su referencia
está orientada a indexación Elasticsearch. OCSF organiza eventos de ciberseguridad
en categorías/clases con diccionario y extensiones. Son especificaciones, no
sustitutos del ownership de Qapaq. [ECS](https://www.elastic.co/docs/reference/ecs) ·
[OCSF](https://github.com/ocsf/ocsf-schema).

Recomendación de diseño: núcleo interno acotado independiente del motor, con
mapeos semánticos documentados. ECS inspira separación de tiempo de ocurrencia/
ingesta y entidades host/user/source/destination; OCSF sirve para revisar categorías
y futura interoperabilidad. No adoptar todo ECS ni clases OCSF hasta comparar
fixtures de fuentes piloto, cobertura y coste de mantenimiento. No anunciar
compatibilidad por usar nombres parecidos. La versión de ambos estándares a
mapear debe fijarse al implementar.

## Campos propuestos y semántica

- schemaVersion: string de versión mayor/menor del contrato interno; obligatorio.
- id: identificador interno string estable para una observación admitida; obligatorio, no numérico. Se conserva en reintentos del mismo registro.
- eventId: identificador opaco nativo opcional. No equivale al código de tipo del evento; este último va en metadata.vendorEventCode. No usar eventId solo como unicidad global.
- timestamp: instante de ocurrencia RFC 3339 UTC, o null si desconocido; nunca inventar hora del vendor. metadata.timeQuality señala origen, offset original y errores.
- ingestionTimestamp: recepción de la plataforma en UTC, obligatoria; timestamps de procesamiento son metadata separada.
- sourceType, sourceVendor, sourceProduct, sourceInstance: strings de catálogo/identidad de fuente. sourceInstance es ID de configuración validada, no valor confiado al payload. Tipo/vendor/producto desconocidos se explicitan.
- host: objeto opcional con identificador local/externalIds y atributos permitidos; hostname: nombre observado opcional, no identidad única. Si difiere de inventario, preservar procedencia.
- user: objeto opcional con ID de origen y referencia interna resuelta si existe; no inferir que coincide con un usuario de la plataforma.
- srcIp, dstIp: IP validada opcional; srcPort, dstPort: enteros 0…65535, solo si aplican; protocol: valor de catálogo extensible. No rellenar ausencias con 0 ni direcciones ficticias.
- action: acción normalizada; category: categoría interna versionada, inicialmente extensible con unknown. Diccionario y mapping de cada vendor deben aprobarse antes de reglas productivas.
- severity: unknown, informational, low, medium, high o critical; mapeo por fuente/version. Conservar valor original en metadata. No comparar escalas de vendors por simple igualdad numérica.
- ruleId, ruleName: referencia opcional a regla del origen, namespaced por fuente. No reemplazarla con ID de regla Qapaq; DetectionResult mantiene su propia regla/version.
- message: resumen opcional acotado/redactado para búsqueda; no sustituye raw.
- rawEvent: referencia obligatoria a evidencia original con objectId lógico, digest SHA-256, mediaType, encoding y byteLength. Bytes originales permanecen en storage restringido, no en cada job/documento de dominio. El port de evidencia resuelve la referencia con autorización.
- metadata: campos namespaced de procedencia, parserVersion, normalizerVersion, tiempo, calidad y lineage. Tamaño/profundidad/keys limitados; no indexación dinámica ilimitada.
- tags: strings de catálogo o namespace controlado, opcionales y acotados.
- correlationId: ID interno de trazabilidad obligatorio; no es clave de deduplicación ni session token.

Los campos opcionales ausentes se omiten; null solo donde el contrato lo permita
explícitamente. Prohibir claves extra en envoltura y entidades; extensiones pasan
por metadata validada. Limitar longitud, profundidad y número de elementos antes
de parsear. ADR-016 fija 256 KiB por evento normalizado, 500 eventos/5 MiB
descomprimidos por batch y 256 KiB por payload BullMQ. La semántica de cada fuente
sigue [U-005/ADR-019](source-integration-strategy.md).

La procedencia aceptada añade `sourceId`, `datasetId`, `vendor`, `sourceRecordId`,
`sourceEventTime`, `sourceIngestTime`, `platformReceivedAt`, `semanticLevel`,
`contentHash`, `cursorReference` y `rawReference`. El schema ejecutable sigue U-010;
esta lista fija intención y lineage, no tipos físicos adicionales sin versión.

Niveles semánticos: `VENDOR_RAW`, `WAZUH_ARCHIVED_EVENT`, `WAZUH_ALERT`,
`NORMALIZED_EVENT`, `CORRELATED_ALERT` e `INCIDENT`. Una alerta Wazuh es resultado
derivado y no reemplaza el evento del producto original.

## Identidad y preservación

Distinguir admisión duplicada de dos eventos legítimos iguales. Si el proveedor
garantiza ID estable, deduplicar con sourceInstance + native ID + discriminador
de stream/documento; si no, usar identidad de lote/cursor y posición estable.
Un hash de payload solo detecta bytes iguales, no prueba mismo evento. La
estrategia de cada fuente es parte de su contrato. Si el mismo hecho llega directo
y por Wazuh, se aplica la política por dataset de ADR-019 y se conserva
`relatedEventIds`; no se deduplica solo por tiempo o texto.

Mantener receiptId y digest original. Si una API entrega objetos ya transformados,
conservar la respuesta recibida o el registro tal como fue transportado y
declarar que no equivale al evento previo al proveedor. Un archivo comprimido
puede preservar sus bytes originales y el digest del contenido descomprimido
como dos evidencias diferentes.

La preservación de raw está limitada por retención/hold y permisos. No ponerlo en
logs, fixtures públicos ni índices generales. Si contiene secretos, aislar y
rotar el secreto comprometido; conservar evidencia restringida conforme a política,
sin difundirlo en derivados.

## JSON Node/Python

Antes de habilitar Python, materializar schemas JSON versionados para SecurityEvent,
AnalysisRequest y DetectionResult en el paquete de contratos, validarlos en ambos
extremos y probar corpus compartido. No usar pickle, eval ni objetos Python/ORM
como contrato. Versiones desconocidas se rechazan o ponen en cuarentena.

AnalysisRequest propuesto: requestId, schemaVersion, analysisType, ruleVersion,
eventRefs, contextRefs y correlationId. Contexto de permisos/scope viene del job
autenticado; no se permite que el worker lo eleve en su respuesta. Artefactos
grandes se referencian por ID interno, nunca URL arbitraria aportada por el evento.

DetectionResult propuesto: idempotencyKey, schemaVersion, ruleId/ruleVersion,
eventIds, windowStart/windowEnd si aplica, severity, reasonCode, evidenceRefs,
contextVersion y processingStatus. confidence es opcional y nunca «probabilidad»
sin calibración documentada. El backend valida referencias y autorización antes
de crear una alerta.

IDs e enteros fuera del rango seguro de JavaScript se transportan como strings.
No NaN/Infinity, timestamps locales ambiguos ni bytes binarios sin encoding.
Campo requerido nuevo o cambio semántico exige versión mayor; cambios aditivos
requieren schema lector compatible, no confiar en que todo consumidor ignore extras.
Una tarea lleva versión fijada; actualizar productor/consumidor con fixtures de
compatibilidad antes de cambiarla.

## Ejemplo sintético reducido

Este fragmento ilustra semántica, no es un evento completo validable:

```json
{
  "schemaVersion": "1.0",
  "id": "synthetic-event-001",
  "timestamp": "2026-09-17T12:00:00Z",
  "ingestionTimestamp": "2026-09-17T12:00:02Z",
  "sourceInstance": "synthetic-source-01",
  "hostname": "endpoint.example",
  "srcIp": "192.0.2.10",
  "action": "authentication-failed",
  "category": "authentication",
  "severity": "low",
  "correlationId": "synthetic-trace-001"
}
```

No incluye rawEvent ni el resto de campos obligatorios deliberadamente; los
fixtures de implementación deben ser completos, autocontenidos y sin datos reales.
