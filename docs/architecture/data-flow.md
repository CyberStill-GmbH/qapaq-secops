# Flujos, entrega y resiliencia

Estado: PROPOSAL. [ADR-006](../adr/006-redis-bullmq.md) y
[ADR-014](../adr/014-internal-communication.md).

La notificación `CRITICAL` es una excepción ya aceptada por
[ADR-022](../adr/022-microsoft-teams-critical-alert-notifications.md): la misma
transacción que persiste la alerta crea `NotificationRequested`; un dispatcher y
worker idempotentes entregan a Teams después del commit. El fallo externo no
revierte ni duplica la alerta. Detalle en
[notificaciones críticas](critical-alert-notifications.md).

## Admisión durable y checkpoint

1. Collector identifica fuente y permisos, obtiene un lote acotado y cursor sin adelantarlo.
2. Ingestion valida envoltura, límites y procedencia; conserva bytes originales en object storage inmutable lógico junto con digest y metadatos de recepción.
3. Tras confirmar escritura durable según contrato del store, registra manifiesto de lote y outbox de procesamiento en PostgreSQL. Es metadata por lote, no telemetría masiva.
4. Devuelve recibo de aceptación; connectors persiste el checkpoint. Si cae antes del checkpoint, se repite el lote y la clave de admisión evita duplicar efectos.
5. Dispatcher publica referencias pequeñas en BullMQ y marca progreso. Si publica y cae antes de marcar, puede publicar otra vez; consumidor idempotente.
6. Parser, normalizer y enrichment validan contratos; fallos permanentes se ponen en cuarentena conservando raw/reason. Un lote parcialmente inválido identifica registros fallidos, no descarta los válidos silenciosamente.

Object storage y PostgreSQL no tienen transacción distribuida: una escritura raw
sin manifiesto queda huérfana. Un reconciliador la detecta por sesión de admisión,
la recupera o expira tras ventana gobernada; nunca borra objetos con legal hold.
Una referencia a raw no confirmado nunca obtiene recibo de éxito. Si no hay store,
pausar polling antes de avanzar cursor; para push rechazar/reintentar según protocolo.
No usar el ACK del transporte como promesa de procesamiento terminado.

ADR-019 acepta checkpoints independientes por conector y estados `FETCHED`,
`DURABLE`, `NORMALIZED`, `PROCESSED`, `CHECKPOINTED`. Pull no implica ACK al
proveedor. Un webhook recibe 2xx solo tras validación y persistencia/cola durable.
Cada dataset declara FULL_REPLAY, BOUNDED_REPLAY, BEST_EFFORT o NO_REPLAY.
En recovery: partir del último checkpoint durable, calcular la ventana mínima
recuperable, rewind, fetch, deduplicar, normalizar, procesar y reconciliar. Una
fuente sin replay limita el RPO y registra un gap explícito.

Fuentes sin replay ni ACK fiable, como Syslog UDP, no permiten prometer cero pérdida:
priorizar un transporte fiable o collector con spool durable gestionado; registrar
la limitación y medir gaps. No introducir ese collector sin decisión operacional.

## Indexación y análisis de la primera vertical

En la primera vertical aceptada por ADR-015, el evento normalizado se indexa en
OpenSearch antes de correlación determinista. Las tareas conservan estado
recuperable por lote/stage; si el índice falla, ese análisis espera sin perder raw.
Desacoplar ambas rutas después es propuesta técnica que necesita decisión explícita. Enrichment
no esencial puede degradar con estado incomplete y versión de contexto; reglas que
requieren ese dato quedan pendientes o emiten cobertura insuficiente, no un negativo.

Detection evalúa reglas simples y crea candidatos. Correlation agrupa eventos o
candidatos por ventanas y claves autorizadas. Tanto reglas simples como compuestas producen Detection; su
Alert Candidate recibe enrichment/deduplicación antes de promoverse a Alert. No
toda detección se promueve. soc persiste alertas idempotentes
por origen, versión de regla y conjunto/ventana estable. No basar claves en tiempo
de ejecución ni deduplicar eventos distintos con el mismo mensaje.

Raw y evento normalizado son inmutables por versión. Reprocesar con parser/regla
nueva genera una versión derivada con lineage; replay tiene modo explícito para
evitar abrir incidentes o notificar masivamente sin autorización.

## Reintentos, cola y fallos

Asumir entrega al menos una vez. Reintentar errores transitorios con backoff,
jitter y presupuesto; respetar Retry-After del proveedor. Errores de schema y
credenciales inválidas no consumen reintentos infinitos. DLQ es una estrategia de
aplicación sobre jobs fallidos/cuarentena, no una garantía automática del framework.

La deduplicación de jobs no sustituye la unicidad transaccional del efecto. Indexar
por ID estable y versión; persistir alertas con clave única; consumidores durables
mantienen inbox/resultado cuando su efecto lo requiere. Manejar carrera y caída
después de commit, antes de ack. Ver [patrón BullMQ](https://docs.bullmq.io/patterns/idempotent-jobs).

Backpressure limita lotes, bytes, concurrencia por proveedor, antigüedad y disco
disponible. Priorizar tráfico crítico según política pendiente, sin descartar raw
a escondidas. Separar presupuestos de búsquedas/exportaciones de admisión/alertas.
Circuit breaker solo en llamadas donde reduce presión; timeout en todo IO.
Graceful shutdown deja de admitir, drena o abandona jobs recuperables y cierra recursos.

Redis requiere persistencia y política de memoria compatibles con la cola; la guía
oficial indica noeviction. Esto no elimina el riesgo de pérdida: manifiestos y
reconciliación permiten detectar/reencolar. [BullMQ producción](https://docs.bullmq.io/guide/going-to-production).

## Flujo de control

Request autorizada → validación de negocio → transacción del módulo + AuditEvent
local + outbox si hace falta → commit → respuesta. Consumers actualizan vistas y
notificaciones posteriormente; fallos se observan. No comunicar éxito de una acción
externa hasta conocer su resultado; timeout ambiguo se resuelve consultando estado
o mediante idempotency key, nunca repitiendo una remediación a ciegas.

## Pruebas decisivas

Caída entre raw/manifiesto, entre commit/publicación, entre efecto/ack; duplicados
concurrentes; pérdida de Redis; schema venenoso; disco lleno; source cursor vencido;
índice no disponible con correlación de primera vertical pendiente; replay sin side
effects no autorizados. [Estrategia](../testing-strategy.md).

[Ingesta](../diagrams/04-ingestion.mmd) ·
[Detección/correlación](../diagrams/10-detection-correlation.mmd).
