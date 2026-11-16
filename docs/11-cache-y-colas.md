# 11 · Colas y caché (SQS, Scheduler, DynamoDB TTL)

> Leyenda: **[verificado]**, **[sin verificar]** (código existente) y **[propuesto]**. Todo lo de
> AWS aquí es propuesto. Arquitectura: [02](02-arquitectura.md).

## Qué hay realmente en el código

Antes de decidir qué cambia, el estado real del repositorio:

| Pieza | Realidad en el código | Consecuencia |
| --- | --- | --- |
| `apps/worker` | Es un **cascarón**: `package.json` declara `bullmq` e `ioredis`, pero `src/` solo tiene arranque, apagado ordenado y un `WorkerRuntime` sin consumidores (`run()` existe, ningún productor lo usa; el comentario dice que C-02 no envía tareas ficticias) | No hay colas BullMQ funcionando que migrar: se **elimina** el worker y se construyen consumidores SQS desde cero |
| Trabajo en segundo plano | Corre **en proceso dentro de `apps/api`**: `ingestion-poller.ts`, `directory-sync.ts`, `notification-dispatcher.ts` | Lo que cambia es *dónde se dispara* (Scheduler/SQS), no la lógica |
| Idempotencia y exactly-once | Ya está en Postgres: lease con fencing en la ingesta (`modules/soc/src/ingestion.ts`), outbox con lease (`modules/soar`, `postgres-attempt-store.ts`) y concurrencia optimista (`expectedRevision`) | SQS es at-least-once: esas defensas siguen siendo la autoridad |
| `platform/cache` | **No existe** en este repositorio. No hay cliente Valkey/Redis en `apps/api` | La caché y los puntos 1–5 de abajo son diseño, no código a migrar |
| Cabecera `Idempotency-Key` HTTP | No está implementada en `apps/api` | Es trabajo nuevo, no una migración |
| `platform/gateway` (KrakenD) | Existe | Se retira ([02](02-arquitectura.md)) |

## Principios (se conservan)

1. **Aurora es la verdad; la cola transporta.** Perder un mensaje o la caché nunca pierde un
   caso, una auditoría, una notificación ni una decisión de acceso. El outbox en Aurora
   conserva qué falta procesar y un reconciliador reencola.
2. **La seguridad no depende de una caché vieja.** Ninguna decisión de acceso se sirve de caché más
   de 5 s y toda revocación invalida su entrada al instante.
3. **Solo referencias en los mensajes.** Un mensaje lleva IDs (`outboxId`, `sourceId`), nunca raw,
   PII ni secretos (N2).
4. **Toda clave de caché tiene TTL.**
5. **Sin caché, el sistema funciona** leyendo de Aurora (más lento, correcto).

## Qué reemplaza a BullMQ [propuesto]

| Antes (diseño BullMQ/Valkey) | Ahora | Cómo |
| --- | --- | --- |
| Colas BullMQ sobre Valkey | **SQS** estándar, una cola por tarea, cada una con **DLQ** | Lambda consume con *event source mapping*; `maxReceiveCount` = 5 |
| `jobId` determinista (dedupe) | SQS **FIFO** con `MessageDeduplicationId` solo donde el orden o el dedupe lo exijan; en las demás, dedupe en el consumidor | FIFO limita el rendimiento y no admite todas las integraciones: no se usa por defecto |
| Backoff exponencial 5 s – 5 min, 5 intentos (ADR-022) | `VisibilityTimeout` más reintentos de SQS; para backoff exponencial real, el consumidor extiende la visibilidad (`ChangeMessageVisibility`) o reencola con `DelaySeconds` | SQS no trae backoff exponencial nativo |
| Schedulers repetibles con jitter | **EventBridge Scheduler** (`rate()`/cron) con ventana flexible como jitter | Cada disparo encola un mensaje |
| Worker (ECS) y su proceso persistente | Lambdas consumidoras (arm64) | Sin servicio que operar |
| `*:dlq` visible en «Salud operativa» | Métricas CloudWatch (`ApproximateAgeOfOldestMessage`, profundidad de DLQ) | Alarma al superar umbral |
| Reconciliador cada 60 s | Una ejecución de Scheduler que reencola del outbox lo pendiente > 30 s | Misma lógica que el diseño actual |

### Mapa de colas y tareas

| Tarea | Productor | Consumidor | Garantías |
| --- | --- | --- | --- |
| `notifications` (Teams, push, correo) | API, tras el commit que escribe el outbox | Lambda | Dedupe por `idempotencyKey` (en Aurora, no en la cola), fencing token antes de enviar, backoff y DLQ |
| `ingestion` por fuente | Scheduler cada pocos minutos | Lambda, concurrencia reservada 1 por fuente | La ventana `ingest:{source}:{ventana}` es la clave; el lease con fencing en Aurora es la autoridad |
| Ingesta push y cloud-native | Endpoint `ingest/wazuh` y reglas de EventBridge | Lambda normalizadora | Dedupe por `_id` / id del evento; DLQ |
| `directory-sync` (grupo SOC de Graph) | Scheduler cada 5 min | Lambda, concurrencia 1 | Al terminar invalida el padrón y dispara revocaciones |
| `history-restore` (warm/cold) | API, tras aprobación | Lambda o Step Functions | Clave = hash de los índices a restaurar; un solo trabajo por clave. La restauración dura minutos: Step Functions encaja mejor que una Lambda de 15 min |
| `ankay` | API, tras aprobación | **Step Functions Standard** (no SQS) | Ver [07](07-deteccion-ml-y-soar.md) y [13](13-ankay-qapaq.md) |

Límites a respetar: Lambda dura máximo 15 min, SQS retiene mensajes hasta 14 días y SQS es
*at-least-once* (el consumidor debe ser idempotente).

## Caché: qué sigue haciendo falta [propuesto]

Los puntos de caché del diseño original eran 5. Con Lambda, el estado en memoria no se comparte
entre invocaciones, y eso cambia qué se necesita:

| # | Punto | Antes | Ahora |
| --- | --- | --- | --- |
| 1 | Handshake OIDC (state, nonce, verifier) | Valkey, `GETDEL`, 10 min | **Lo asume Cognito** (flujo con PKCE). Si QAPAQ conserva el flujo propio, **DynamoDB con TTL** y escritura condicional de un solo uso |
| 2 | Lockout y rate limit de login | Valkey `INCR`+`EXPIRE` | Cognito/WAF (límite de tasa en el borde); contadores de lockout propios, si hacen falta, en **DynamoDB con TTL** |
| 3 | Sesión → actor (cada `introspect`) | Valkey, 5 s, DEL al revocar | Ruta caliente. Primero **Aurora directo** con consulta por clave (medir). Si no alcanza: **DynamoDB TTL** (5 s) o **ElastiCache Serverless (Valkey)** opcional. La revocación borra la entrada |
| 4 | Cambios en vivo (pub/sub) | Valkey pub/sub | Sin pub/sub: el long-poll consulta la secuencia de auditoría ([08](08-frontend-unificado.md)). Si la carga lo exige, ElastiCache Serverless |
| 5 | Lecturas caras y estables (padrón, salud) | Valkey, *stale-while-revalidate* | **Refresh-ahead**: una Lambda programada precalcula y guarda el resultado en **DynamoDB** (con `asOf`); la API solo lee. Sin invalidación compleja |

**Decisión por defecto:** arrancar **sin ElastiCache**. DynamoDB on-demand con TTL cubre los
puntos 1, 2 y 5 con costo casi nulo en reposo. ElastiCache Serverless (Valkey) entra solo si una
medición real de latencia en el punto 3 lo justifica (tiene costo mínimo mensual aun sin tráfico,
a verificar con la calculadora de precios).

Se conservan las reglas de la caché del SIEM (lecturas del Indexer): clave con el scope de
autorización (tenant y capacidades), autorización **antes** de leer la caché, consultas
normalizadas y allowlist, y PII solo con TTL corto. Las técnicas de resiliencia siguen
vigentes con estos cambios:

| Técnica | Cómo queda en Lambda |
| --- | --- |
| Request cache de OpenSearch | Sin cambio (vive en el Indexer) |
| Refresh-ahead | Lambda programada precalcula contadores, frescura y salud; guarda en DynamoDB |
| Stale-if-error | Se sirve el último valor bueno hasta 10 min con `stale: true` y `asOf`; la UI nunca lo presenta como ausencia de amenazas |
| Circuit breaker | **Estado por contenedor Lambda**: no es global. Se aproxima con timeouts cortos, concurrencia reservada y un indicador de apertura en DynamoDB si se requiere coordinación |
| Bulkheads | **Concurrencia reservada por función** (interactivo vs. segundo plano) en vez de pools en proceso |
| Load shedding | Throttling de API Gateway por ruta y concurrencia reservada; 503 con `Retry-After` |
| Single-flight | Solo dentro de un contenedor. Entre invocaciones se acepta algún duplicado: las lecturas son idempotentes |

## Idempotencia

Aurora (revisión optimista y restricciones únicas) sigue siendo el respaldo final.

| Nivel | Dónde | Cómo | Estado |
| --- | --- | --- | --- |
| Transiciones | Comandos con `expectedRevision` | Concurrencia optimista | Existe [sin verificar en Lambda] |
| **HTTP** | Mutaciones que crean cosas | Cabecera `Idempotency-Key`; registro en **DynamoDB** con escritura condicional (`attribute_not_exists`) y TTL 24 h; mismo cuerpo → misma respuesta, otro cuerpo → `409 IDEMPOTENCY_KEY_REUSED` | [propuesto]; no implementado |
| **Productor** | Al encolar | `MessageDeduplicationId` solo en FIFO; si no, el id viaja en el mensaje | [propuesto] |
| **Consumidor** | Antes del efecto externo | Estado del outbox en Aurora (`SENT`) más lease con fencing: un mensaje repetido tras un envío exitoso **no reenvía** | Outbox con lease existe [sin verificar]; fencing en notificaciones por confirmar |
| **Step Functions** | Respuesta | Nombre de la ejecución = id de la solicitud | [propuesto] |

## Aceptación [propuesto]

1. Un mensaje de `notifications` que falla 5 veces llega a la DLQ y dispara una alarma.
2. Dos entregas del mismo mensaje producen un solo envío a Teams.
3. Revocar una sesión la saca de la consola y del dashboard en ≤ 5 s con la caché activa y vacía.
4. Ninguna entrada de DynamoDB para caché queda sin TTL (prueba de escaneo).
5. Repetir un `POST /api/incidents/:id/notes` con la misma `Idempotency-Key` crea una sola nota.
6. Pedir dos veces la restauración del mismo día produce un solo índice `restored-*`.
7. Dos personas con capacidades distintas que consultan lo mismo nunca comparten una entrada.
8. Con el Scheduler detenido, al reanudarlo el reconciliador envía lo pendiente sin duplicar.
