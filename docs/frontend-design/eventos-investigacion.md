# Vista Eventos e investigación

Estado: **contrato frontend listo para implementación; API pendiente de C-7**.
La ruta `/events` todavía no está conectada al BFF. No desplegar controles que
parezcan operativos hasta que exista `GET /api/events` y el backend confirme el
contrato de respuesta.

## Propósito y frontera

La vista sirve para buscar y revisar eventos normalizados durante una
investigación. Wazuh/OpenSearch conserva la indexación y la búsqueda primaria;
el BFF aplica tenant, capability y límites antes de consultar el gateway. QAPAQ
presenta el resultado con procedencia legible y puede enlazar una investigación
con alertas/incidentes cuando exista una relación explícita. No es otro SIEM ni
un visor genérico de documentos crudos.

## Contrato de lectura esperado

```http
GET /api/events?from=<ISO-8601>&to=<ISO-8601>&pageSize=50
  &cursor=<opaco>&severity=high&category=authentication&kind=event
  &outcome=failure&dataset=<nombre>
```

Parámetros múltiples para `severity`, `category`, `kind` y `outcome` se envían
como parámetros repetidos. El tenant siempre se deriva de la sesión; no se acepta
`tenantId` del cliente. El contrato de dominio ya define `RawEventQuery`,
`EventPage` y `ReadableEvent` en `modules/telemetry/src/event-query.ts`.

Respuesta:

```json
{
  "events": [],
  "nextCursor": null,
  "pageSize": 50
}
```

Cada evento usa `SecurityEvent` 1.0.0. Sin `events.read_raw`, el servidor omite
por completo `raw`; la interfaz no debe inferir acceso por rol o por el texto de
un identificador. La API sigue siendo la autoridad. `events.read_raw` permite
ver la referencia y metadatos `ref`, `sha256`, `mediaType` y `sizeBytes`; no
implica que exista un endpoint para descargar el objeto. No añadir un enlace de
descarga hasta que haya ruta de evidencia con autorización y auditoría propias.

### Límites

- `from` y `to` son obligatorios. El dominio acepta 90 días, pero el provider Wazuh actual
  limita a 31 días; la interfaz usa y muestra el máximo efectivo (menor límite de dominio,
  adapter y retención confirmada), por ahora 31 días para Wazuh. Ver
  [events-read-through.md](../architecture/events-read-through.md).
- `pageSize` predeterminado 50, máximo 200; excederlo se rechaza.
- Cursor opaco, conservado al pedir más resultados; filtros y ventana no cambian
  mientras se usa ese cursor.
- Severidad: `unknown`, `informational`, `low`, `medium`, `high`, `critical`.
- Categorías, tipos (`event`, `alert`, `finding`, `state`) y resultados se toman
  de los enums canónicos de `@qapaq/contracts`, nunca de opciones inventadas.
- `dataset` es un filtro exacto del origen normalizado.
- No existe búsqueda de texto libre ni orden configurable en el contrato actual.
  La página no mostrará una caja de texto que parezca buscar en el índice.
- El backend debe fijar un orden estable y compatible con el cursor. La API debe
  documentar la clave de orden y el desempate antes de habilitar paginación.

## Diseño de interacción

La primera carga usa la ventana reciente de 24 horas, explicitada en el control de
fechas, y permite cambiarla hasta el límite de 90 días. Al aplicar filtros se
reinicia el cursor. «Cargar más» añade una página y conserva filtros; si el cursor
expira, se explica el error y se ofrece recargar la consulta desde el inicio.

La tabla densa tiene: hora del evento (UTC visible/local accesible), severidad,
categoría, tipo, acción, resultado, origen/dataset, entidad principal y regla de
detección. Al abrir una fila, un panel de detalle expone los tiempos de ocurrencia,
observación y recepción por separado; fuente, proveedor, instancia, dataset;
identidades/recursos normalizados; regla/proveedor/grupos; ruta de ingesta y
calidad del timestamp. Los campos ausentes se muestran como «No informado».
No se construye un resumen de amenaza con campos ausentes ni se trata texto del
evento como instrucciones.

La entidad principal puede contener PII. Enmascarar valores de identidad según
la política de alertas existente y no usar correo/nombre como clave de URL o como
atributo de analítica. Los identificadores técnicos se pueden copiar con acción
explícita. `raw` permanece en un bloque separado que solo se monta si la sesión
tiene `events.read_raw` y la respuesta realmente trae el objeto.

## Permisos y errores

- Ruta y consulta requieren `events.read`; el BFF resuelve tenant desde el actor.
- `events.read_raw` gobierna solamente la proyección raw; no sustituye
  `evidence.read` ni `evidence.export`.
- Sin `events.read`, la navegación no presenta el enlace y el backend responde
  deny por defecto. Un ID pegado manualmente nunca evita esa comprobación.
- Rango invertido, rango mayor a 90 días, tamaño excesivo y filtros enum
  desconocidos se muestran como validación específica, no como «sin resultados».
- `DEPENDENCY_DEGRADED` comunica caída del gateway; una respuesta vacía válida
  comunica «No hay eventos en este período con estos filtros».
- Mostrar `correlationId` en errores de API según el patrón global del SOC.
- No conservar datos crudos en `localStorage`, telemetría de producto o URL.

## Integración de investigación

En la primera entrega, eventos relacionados con un incidente solo se muestran si
la API devuelve una relación explícita. El dominio SecurityEvent actual no tiene
`caseId` ni timeline de caso; no se deben fabricar vínculos por coincidencia de
texto o entidad.

La siguiente etapa de caso debe aportar una línea de tiempo append-only con
actor, hora, tipo de actividad, referencia a evento/alerta/evidencia y
`correlationId`. Evidencia requiere endpoint propio, hashes/verificación,
procedencia, control de acceso, exportación con propósito y registro de acceso.
Las acciones externas de respuesta requieren playbook/versionado, autorización
contextual, aprobación según riesgo, idempotency key, estado durable, resultado
verificable del proveedor, manejo de resultado ambiguo y auditoría. Hasta que ese
contrato exista, `contained`/`eradicated` significan cambio de estado del caso,
no contención o erradicación en infraestructura.

## Aceptación antes de conectar

1. BFF consulta únicamente a través del gateway existente, aplica tenant y
   `events.read`, valida todos los límites y aplica `events.read_raw` en servidor.
2. Respuesta tipada es `EventPage`; cursores y orden son estables bajo inserciones.
3. Casos de permisos deny, tenant cruzado, raw ausente, vacío válido, proveedor
   caído, cursor inválido y filtros/rangos inválidos están cubiertos en backend.
4. UI distingue vacío, carga, página adicional, expiración de cursor y dependencia
   degradada; filtros reinician cursor.
5. El panel muestra procedencia y tiempos sin juntar ocurrido/recibido ni afirmar
   que un evento pruebe por sí solo la salud de su fuente.
6. La revisión de accesibilidad verifica teclado, foco, etiquetas y tabla
   responsive. No se introducen icon packs SVG de React; se usa el sistema de
   iconos interno o elementos tipográficos existentes.

## Dependencias y responsables

- Claude Code: `GET /api/events`, gateway/indexer, orden/cursor estable y tests de
  aislamiento/consulta, de acuerdo con la asignación en
  `COORDINACION-CLAUDE-CODEX.md`.
- Codex: integrar la vista en `/events` cuando el endpoint y su contrato estén
  listos; mantener la vista explícitamente no disponible hasta ese momento.
- Backend futuro: timeline/custodia de caso y ejecución verificable de acciones
  externas; se implementan sobre los módulos y ADR existentes, no como otro
  almacenamiento SIEM paralelo.

