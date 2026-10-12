# Salud operativa de fuentes

Estado: **DISEÑO C-5 ACEPTADO; implementación posterior al P0 del outbox**.
Este documento no afirma que salud por fuente esté operativa hasta que existan
persistencia, job, endpoint y una fuente de observación verificable.

## Propósito

Mostrar si cada fuente está recolectando, entregando y procesando datos a tiempo. La vista
debe diferenciar una consulta correcta que encontró cero eventos de una consulta que no
ocurrió, falló o dejó de avanzar. «Sin eventos» no equivale a «fuente sana» ni a «fuente
caída».

QAPAQ justifica esta función sobre Wazuh porque el estado operativo por fuente, su impacto
en la cobertura de detección, la asignación del responsable y la evidencia de interrupción
deben enlazarse con alertas, incidentes y auditoría. Wazuh sigue siendo dueño de agentes,
collector, manager, reglas e indexer; QAPAQ no debe duplicar el dashboard de agentes ni
presentar su propio buscador como reemplazo del Indexer.

## Lo que existe y su límite

- `platform/observability/src/pipeline-health.ts` evalúa disponibilidad de dependencias,
  edad del último éxito, retraso de ingesta, cuarentena y errores. Sus umbrales globales
  ayudan a proteger el pipeline QAPAQ, pero no modelan intentos por proveedor o dataset.
- `deriveRates()` devuelve cobertura `1` y `lossless: true` cuando `received === 0`. Es
  correcto para la aritmética de un lote vacío, pero no demuestra que el origen se haya
  consultado ni que haya eventos disponibles. La salud de fuente necesita una señal aparte.
- `SourceCheckpoint` / `IngestionManifest` representan el cursor de lectura de QAPAQ,
  admisión durable, tiempos de evento y contadores de procesamiento. No son un heartbeat
  del collector ni confirman qué suscripción de origen completó su consulta.
- El resumen de administración muestra estado y «Último evento» por fuente. Esa fecha es
  una observación de datos; por sí sola no expone último intento, último éxito vacío,
  errores del collector, latencia ni cobertura que se perdió durante una interrupción.
- La consola SOC todavía no ofrece ruta de salud de fuentes; `/events` muestra una vista
  no disponible porque no existe su ruta BFF. No se debe ocultar esa limitación con datos
  sintéticos o valores por defecto que parezcan reales.
- La documentación de Wazuh define para Office 365 el `interval`, las suscripciones
  (`Audit.AzureActiveDirectory`, `Audit.Exchange`, `Audit.SharePoint`, `Audit.General`,
  `DLP.All`) y el registro de logs internos en `ossec.log`. También indica que una
  configuración inválida puede generar advertencia y alerta después de tres intentos.
  Esto permite observar ciertos fallos, pero no documenta un heartbeat de éxito con
  resultado por cada content type; un tipo sin eventos puede no producir una alerta.

## Contrato de observación

No se deben usar nombres ni campos de Microsoft/Wazuh en el dominio. El adapter de la
fuente traduce a una observación neutral, identificada por tenant, fuente y dataset:

```text
SourcePollObservation
  tenantId
  sourceId
  datasetId
  observationId             // estable para idempotencia
  attemptedAt
  completedAt
  outcome                   // success | retryable_error | permanent_error
  recordsSeen               // puede ser 0 en un poll exitoso
  sourceWatermark           // opaco y protegido; opcional
  oldestEventOccurredAt     // opcional
  newestEventOccurredAt     // opcional
  errorClass                // catálogo neutral; nunca mensaje con token/PII
  collectorVersion
```

El estado derivado conserva por separado `lastAttemptAt`, `lastSuccessAt`, `lastEventAt`,
`lastWatermarkAt`, `consecutiveFailures`, retraso de ingesta y el conteo de la ventana.
Un éxito con cero filas actualiza `lastSuccessAt`, nunca `lastEventAt`.

### Decisión aceptada para el primer incremento

El worker de QAPAQ consultará el Indexer para observar documentos de Office 365 por
`Subscription` y los eventos de error `wazuh-modulesd:office365`. No se añade instrumentación
ni credenciales Microsoft duplicadas en QAPAQ para el MVP. Esta señal puede probar
actividad reciente y errores conocidos; **no demuestra un poll exitoso vacío**. Si no hay
documentos recientes ni error verificable, `lastSuccessAt` se mantiene desconocido y el
estado no puede pintarse verde. El contrato de observación conserva esa incertidumbre.

Un incremento posterior podrá añadir señal explícita de ciclo exitoso por suscripción si
Wazuh/Infra la ofrece. No se infiere de la mera conexión del agente, del estado global del
manager, del checkpoint de admisión QAPAQ ni de ausencia de logs de error. El adaptador
normaliza mensajes a `errorClass`; no persiste el texto que pudiera contener tokens o PII.

## Estados y umbrales iniciales

Estados por fuente/dataset: `unknown`, `healthy`, `degraded`, `failed`, `disabled`.

1. `unknown`: la fuente está habilitada pero no hay observación de éxito confiable; también
   es el estado inicial después de crearla. La interfaz no lo pinta verde.
2. `healthy`: existe un poll exitoso reciente, el cursor/watermark avanzó cuando el origen
   debía avanzar y el pipeline QAPAQ admite los datos dentro de la latencia esperada.
3. `degraded`: hay retraso, fallos transitorios repetidos, avance detenido o una etapa
   posterior está rechazando una fracción fuera de umbral. Se muestra la etapa y la razón.
4. `failed`: poll permanentemente rechazado (por ejemplo credencial/permisos), dependencia
   crítica no disponible o ningún éxito durante la ventana de fallo configurada.
5. `disabled`: exclusión explícita, aprobada y auditable; no es sinónimo de `unknown`.

Configurar ventanas por fuente, no codificar un timeout universal. Como punto de partida
para un interval de 10 minutos: degradar tras dos intervalos sin éxito observado y fallar
tras tres; agregar jitter, `Retry-After`, límites de API y tiempo de arranque antes de
evaluar. Wazuh documenta 10m como intervalo Office 365 por defecto y que al iniciar puede
esperar el intervalo antes del primer scan. El umbral definitivo requiere mediciones del
tenant y del plan de recolección.

Separar estas señales:

- **Disponibilidad del collector:** manager/proceso/módulo en ejecución y consulta reciente.
- **Disponibilidad de origen:** autenticación, permisos, throttling, error de API y tipo de
  resultado del poll.
- **Progreso:** watermark/cursor cubierto hasta una hora del origen, si el conector lo
  entrega. Un watermark que no avanza puede ser correcto para una fuente sin cambios; se
  combina con el estado del poll.
- **Actividad:** edad del evento más reciente. Es informativa; cero eventos por sí solos no
  producen `failed`.
- **Entrega y procesamiento:** tiempo desde ocurrencia hasta recepción/admisión, cuarentena,
  duplicados y errores de proyección. No confundir `receivedAt`, `occurredAt` y watermark.
- **Expectativa de negocio:** «se esperaba actividad» solo se evalúa si el owner configuró
  horario, calendario y criticidad; se presenta como anomalía de volumen separada de la
  disponibilidad técnica.

Los valores actuales de `DEFAULT_HEALTH_THRESHOLDS` (15/60 minutos para éxito viejo,
5/30 minutos para retraso y tasas globales) pueden alimentar el resumen del pipeline. No
deben copiarse automáticamente para M365 ni reemplazar los umbrales por dataset.

## Modelo de persistencia

Persistir estado de colección por `(tenantId, sourceId, datasetId)` y transiciones
append-only en `source_health_transitions` con retención de un año. No reutilizar
`SourceCheckpoint` como sensor: su semántica actual es progreso durable de admisión. No
guardar cada poll indefinidamente; se requiere idempotencia de observaciones, ventanas
agregadas y evidencia de las transiciones (degradación, fallo, ack, recuperación y actor).
Las tablas existentes
`sources`, `source_checkpoints` e `ingestion_manifests` pueden aportar identidad y
procesamiento, sin almacenar secretos, cuerpos crudos del proveedor ni mensajes de error
que incluyan tokens o datos personales.

El cálculo debe ser determinista y estar separado de adapters. Las lecturas y transiciones
deben filtrar `tenantId`; la identidad del actor de una confirmación o mantenimiento se
registra en el audit ledger. Una observación repetida no debe abrir incidentes duplicados.

## Operación y automatización

- Un error de credencial/API crea una sola alerta **operativa** por fuente y causa; no una
  alerta de amenaza. Reintentos aplican backoff y respetan cuotas/`Retry-After`.
- Una fuente crítica en `failed` crea o actualiza un incidente operativo asignable, notifica
  al owner y queda abierto hasta ver recuperación fiable o una desactivación aprobada. La
  lista y acknowledge viven en una cola de salud separada; no se mezclan con detecciones.
- La recuperación cierra/actualiza la alerta con los tiempos, duración, causa y evidencia
  del último poll; no borra el historial anterior.
- La consola muestra owner, datasets afectados, último intento/éxito/evento, edad del
  watermark, causa normalizada, ventana de evaluación y enlaces a eventos/alertas incidentes
  afectados. Si una medición no está disponible, muestra «Sin telemetría».
- El informe exportable resume cobertura habilitada, estado y períodos degradados, con
  origen de cada medición y límites de observabilidad. Mantener la cadena de auditoría,
  pero no declarar cumplimiento regulatorio por tener el informe.

## Límites y referencia regulatoria

La Resolución SBS 504-2021 figura como vigente, versión consolidada 5.0 en el catálogo SBS.
El texto oficial consultado atribuye al régimen general procedimientos de incidentes,
clasificación, respuesta/recuperación, un servicio de operaciones con detección/respuesta y
monitoreo de comunicaciones/funcionamiento de infraestructura, además de preservar
evidencias. Su aplicación concreta depende del tipo de entidad y régimen. Esta propuesta
aporta visibilidad operativa; no sustituye personas, procesos, alcance legal ni auditoría de
la entidad.

## Secuencia de implementación acordada

1. Después del P0 del outbox, consultar el Indexer por `Subscription` Office 365 y errores
   conocidos del módulo; dejar éxito vacío y watermark como desconocidos mientras no haya
   señal verificable.
2. Guardar observaciones/transiciones por tenant y dataset, con idempotencia, retención de
   un año, tenant isolation y auditoría.
3. Componer evaluación determinista a partir de observaciones del collector + métricas del
   pipeline; añadir especificaciones para éxito con cero eventos, error/reintento,
   watermark estancado, cuarentena, recuperación, idempotencia y aislamiento por tenant.
4. Exponer una API BFF de solo lectura con `platform.health.read`, filtros y paginación; la vista
   `/events` es un producto aparte y no debe servir para simular salud.
5. Construir cola/vista de salud del SOC separada, con acknowledge/mantenimiento auditables y
   notificación deduplicada. Validar con datos sintéticos y después con tenant sandbox
   autorizado, sin exponer secretos o PII en evidencia.

## Referencias

- Wazuh, configuración del módulo Office 365 (intervalo, primer scan, content types y
  fallos de configuración):
  https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/office365-module.html
- Wazuh, estado de conexión de agentes (útil para salud de endpoint/manager, no prueba por
  sí solo la salud de cada content type):
  https://documentation.wazuh.com/current/user-manual/agent/agent-management/agent-connection.html
- Wazuh, logs internos del server (`ossec.log`, `api.log`, `cluster.log`):
  https://documentation.wazuh.com/current/user-manual/manager/event-logging.html
- OpenTelemetry Collector health check (proceso/collector; no equivale a poll exitoso de
  un proveedor):
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/healthcheckextension
- SBS, ficha consolidada vigente de la Resolución SBS 504-2021 (v5.0):
  https://www.sbs.gob.pe/app/pp/INT_CN/Paginas/Busqueda/BusquedaPortal.aspx?normaId=2046
- SBS, resolución y texto oficial consultado (versión 4.0; contrastar modificaciones
  posteriores con la ficha consolidada aplicable):
  https://intranet2.sbs.gob.pe/dv_int_cn/2046/v4.0/Adjuntos/504-2021.R.pdf
