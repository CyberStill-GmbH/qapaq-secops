# Flujos, entrega y resiliencia

Esta guía define los contratos de procesamiento sobre la topología de
[arquitectura resiliente](qapaq-secops-resilient-architecture.md) y
[ADR-030](../adr/030-resilient-platform-architecture.md). Los diagramas muestran
el orden durable; no convierten capacidades futuras en integraciones activas.

Estado: PROPOSAL. [ADR-006](../adr/006-redis-bullmq.md) y
[ADR-014](../adr/014-internal-communication.md).

La notificación `CRITICAL` es una excepción ya aceptada por
[ADR-022](../adr/022-microsoft-teams-critical-alert-notifications.md): la misma
transacción que persiste la alerta crea `NotificationRequested`; un dispatcher y
worker idempotentes entregan a Teams después del commit. El fallo externo no
revierte ni duplica la alerta. Detalle en
[notificaciones críticas](critical-alert-notifications.md).

## Admisión durable y checkpoint

Para una API directa, Collector llama por el balanceador interno y KrakenD
on-premises. El gateway aplica allowlist, TLS/OAuth, timeout, throttling y circuit
breaker; el adapter conserva paginación, cuota exacta, retry semántico y cursor.
KrakenD no publica en Redis/BullMQ ni transforma el contrato del proveedor. Ver
[arquitectura del gateway](provider-api-gateway.md) y [ADR-026](../adr/026-on-premises-krakend-provider-api-gateway.md).

1. Collector identifica fuente y permisos, obtiene por KrakenD un lote acotado y cursor sin adelantarlo.
2. Ingestion valida envoltura, límites y procedencia; conserva bytes originales en object storage inmutable lógico junto con digest y metadatos de recepción.
3. Tras confirmar raw durable según contrato del store, ejecuta una sola transacción PostgreSQL: manifiesto, referencias raw, inbox de recepciones, cuarentena inicial si corresponde, outbox por lote y checkpoint mediante revisión esperada. El [ER C-04](c-04-admission-er.md) fija pertenencia, límites e idempotencia de esa operación. Hay metadata por recepción y por lote; su volumen debe medirse.
4. Solo después del commit devuelve recibo. No hay una segunda escritura de checkpoint tras aceptar. Ante respuesta perdida, reintenta el mismo comando con las mismas identidades y recupera el recibo; una nueva adquisición/replay crea nuevos recordIds. La deduplicación de efectos lógicos pertenece a C-13 y no se deduce de eventUid.
5. Dispatcher publica referencias pequeñas en BullMQ y marca progreso. Si publica y cae antes de marcar, puede publicar otra vez; consumidor idempotente.
6. Parser y normalizer producen `qapaq.security-event` 1.0.0 y validan su JSON
   Schema; antes de indexar y exportar se vuelve a validar. Un fallo conserva raw,
   código, conector y versión del parser en cuarentena/DLQ reprocesable. Un lote
   parcialmente inválido identifica registros fallidos y no descarta los válidos.

Object storage y PostgreSQL no tienen transacción distribuida: una escritura raw
sin manifiesto queda huérfana. Un reconciliador la detecta por sesión de admisión,
la recupera o expira tras ventana gobernada; nunca borra objetos con legal hold.
Una referencia a raw no confirmado nunca obtiene recibo de éxito. Si no hay store,
pausar polling antes de avanzar cursor; para push rechazar/reintentar según protocolo.
No usar el ACK del transporte como promesa de procesamiento terminado.
Por tanto, “gateway antes de Redis/BullMQ” significa que la respuesta atraviesa
KrakenD **y luego admisión durable**; nunca un pipe directo `KrakenD → BullMQ`.

ADR-019 acepta checkpoints independientes por conector y estados `FETCHED`,
`DURABLE`, `NORMALIZED`, `PROCESSED`, `CHECKPOINTED`. Pull no implica ACK al
proveedor. Un webhook recibe 2xx solo tras validación y persistencia/cola durable.
Esos estados describen etapas del pipeline: el checkpoint C-04 solo conserva el
cursor confirmado, no el progreso de normalización/procesamiento.
Cada dataset declara FULL_REPLAY, BOUNDED_REPLAY, BEST_EFFORT o NO_REPLAY.
En recovery: partir del último checkpoint durable, calcular la ventana mínima
recuperable, rewind, fetch, deduplicar, normalizar, procesar y reconciliar. Una
fuente sin replay limita el RPO y registra un gap explícito.

Fuentes sin replay ni ACK fiable, como Syslog UDP, no permiten prometer cero pérdida:
priorizar un transporte fiable o collector con spool durable gestionado; registrar
la limitación y medir gaps. No introducir ese collector sin decisión operacional.

## Indexación y análisis de la primera vertical

En la primera vertical revisada por ADR-024, Wazuh recolecta Microsoft 365 y genera
la alerta base. QAPAQ la normaliza e indexa como SecurityEvent antes de priorización
o correlación complementaria. Las tareas conservan estado
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

Raw y SecurityEvent son inmutables por versión. Reprocesar con parser/mapping/regla
nueva genera una revisión derivada con lineage; conserva `eventUid` y crea un
`recordId` UUIDv7 nuevo. Replay tiene modo explícito para
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
