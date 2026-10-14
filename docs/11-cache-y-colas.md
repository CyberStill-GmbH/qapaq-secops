# 11 · Redis/Valkey: caché y colas para resiliencia

Decisión del dueño (2026-10-14): Valkey vuelve a la arquitectura (ADR-030), con un rol definido. Este
documento fija **dónde** es fundamental, **qué técnica** usa cada punto y **qué pasa si Valkey cae**.

## Principios

1. **Postgres es la verdad; Valkey acelera y transporta.** Perder Valkey nunca pierde un caso, una
   auditoría, una notificación ni una decisión de acceso. Las lecturas vuelven a Postgres (*fail-open*
   hacia la fuente) y las colas se reconstruyen desde el outbox.
2. **La seguridad no depende de una caché vieja.** Ninguna decisión de acceso se sirve desde caché más
   de 5 s, y toda revocación borra su entrada al instante (invalidación explícita, no solo TTL).
3. **Solo referencias en las colas.** Un job lleva IDs (`outboxId`, `sourceId`), nunca raw, PII ni
   secretos (N2).
4. **Toda clave de caché tiene TTL.** Valkey usa `maxmemory-policy noeviction`, que BullMQ exige para no
   perder jobs. Por eso la caché nunca crece sin límite.
5. **Sin Valkey, el sistema funciona** con el comportamiento actual (una réplica, loops en proceso). Se
   activa solo si `QAPAQ_REDIS_HOST` está definido.

## Dónde es fundamental

| # | Punto | Por qué Valkey | Técnica | TTL e invalidación | Si Valkey cae |
| - | --- | --- | --- | --- | --- |
| 1 | **Handshake OIDC** (state, nonce, code_verifier) | Hoy vive en memoria: con 2 réplicas, un callback que cae en la otra réplica rompe el login | Estado efímero compartido; `GETDEL` lo hace de un solo uso | 10 min | Con 1 réplica, memoria. Con más, el login responde 503 `DEPENDENCY_DEGRADED` (no se arriesga un replay) |
| 2 | **Lockout y rate limit de login** | Los contadores en memoria se reinician por réplica y un atacante los evade repartiendo intentos | `INCR` + `EXPIRE` en ventana deslizante | Ventana de la política | Contador local por réplica, con el umbral dividido entre las réplicas |
| 3 | **Sesión → actor** (cada request y cada `introspect` del dashboard) | Ruta más caliente del sistema: cada pantalla del dashboard consulta la sesión | **Cache-aside (lazy loading):** se busca en Valkey y, si falta, se lee de Postgres y se guarda. Single-flight para que N requests simultáneos hagan 1 sola lectura | 5 s ± 1 s de jitter. **DEL** en revoke, supersede, cambio de rol, baja del grupo o cuenta deshabilitada, más publicación en `sess:revoked` | Postgres directo, más lento pero correcto |
| 4 | **Cambios en vivo** (`/api/changes`, el long-poll se mantiene) | Hoy cada cliente consulta Postgres cada 400 ms mientras espera: N clientes multiplican la carga | Pub/sub: cada commit de auditoría publica `chg:{tenant}` con la secuencia y los long-polls despiertan con esa señal | — | Vuelve al sondeo de 400 ms actual |
| 5 | **Lecturas caras y estables**: padrón de usuarios (sincronizado de Graph), salud de fuentes, salud operativa | Consultas agregadas que repiten muchas personas a la vez | Lazy loading más *stale-while-revalidate*: se sirve lo vigente y se refresca en segundo plano con un solo refresco por clave | Padrón 30 s (DEL al terminar cada sync de Graph). Salud 10 s | Lectura directa |

**Lo que no se cachea:** casos (alertas, incidentes, tareas y notas: escritura frecuente y concurrencia
optimista), la cadena de auditoría, búsquedas libres de texto en el Indexer y cualquier PII fuera de lo
indicado abajo.

## Caché que sirve al SIEM (lecturas del Wazuh Indexer)

El SIEM tiene dos lectores del Indexer: el **dashboard** (OSD lee directo) y la **API QAPAQ** (enriquecer
una alerta, conteos de la cola, frescura de las fuentes, salud). Cada uno usa una capa distinta:

| Capa | Para quién | Qué cachea | TTL |
| --- | --- | --- | --- |
| **Request cache de OpenSearch** (nativa, por shard) | Dashboard y API | Agregaciones (`size: 0`): histogramas, conteos, top N de los paneles | Hasta que el índice cambia |
| **Lazy loading en Valkey** (`siem:{scope}:{sha256(consulta normalizada)}`) | API QAPAQ | Conteos y agregados de la cola, frescura por fuente, y el **evento original de una alerta por `_id`** (inmutable una vez indexado) | Según el tier del índice consultado, abajo |

El TTL depende del tier, porque cuanto más frío es el dato, menos cambia:

| Tier (ISM, [05](05-datos-y-retencion.md)) | Estado del índice | TTL en Valkey | Motivo |
| --- | --- | --- | --- |
| **hot** (0–30 d) | Escritura activa | 15 s | Llegan alertas nuevas |
| **warm** (30–90 d) | `read_only` y fusionado | 10 min | Ya no cambia; la request cache nativa también acierta siempre |
| **restored** (cold traído de S3) | `read_only`, TTL 7 d | 1 h | Inmutable mientras exista; se borra con el índice |
| Evento por `_id` | Inmutable | 5 min | El documento no cambia, pero contiene PII: TTL corto |

### Sistema de resiliencia del SIEM (no solo lazy loading)

El lazy loading protege del costo, pero no de una caída o una saturación del Indexer. El sistema
elegido combina técnicas que se cubren entre sí:

| Técnica | Qué resuelve | Cómo se aplica |
| --- | --- | --- |
| **Refresh-ahead (precalentado)** | Que nadie espere la primera lectura de lo más consultado | El worker recalcula cada 15 s los contadores de la cola, la frescura de las fuentes y la salud, así las lecturas casi siempre aciertan |
| **Caché en 3 niveles** | Picos de la misma consulta | L1 en proceso (1–2 s, absorbe ráfagas por réplica) → L2 Valkey (TTL por tier) → L3 request cache de OpenSearch |
| **Single-flight** | Estampida al expirar una clave | Una sola lectura por clave en curso, en el proceso (promesa compartida) y entre réplicas (`SET NX PX`) |
| **Stale-while-revalidate** | Latencia al refrescar | Se responde lo vigente y se refresca en segundo plano |
| **Stale-if-error** | Caída o lentitud del Indexer | Se sirve el último valor bueno hasta 10 min, marcado `stale: true` con `asOf`. La UI muestra «dato desactualizado» y nunca lo presenta como ausencia de amenazas (regla de producto) |
| **Circuit breaker por dependencia** (Indexer y KrakenD) | Fallas en cascada | Tras N errores o timeouts se abre, sirve lo cacheado y prueba en medio-abierto con baja frecuencia |
| **Bulkheads** | Que los paneles dejen sin capacidad al trabajo del analista | Concurrencia separada por clase: interactivo (detalle de alerta) > contadores > restauraciones |
| **Timeouts y reintentos con jitter** | Errores transitorios | Solo en lecturas idempotentes y con un presupuesto de reintentos. Las escrituras nunca se reintentan a ciegas |
| **Load shedding por prioridad** | Saturación | Se rechaza primero lo de segundo plano (503 con `Retry-After`) y se protege lo interactivo |

Señales en «Salud operativa»: hit ratio por nivel, edad del dato servido, estado de cada breaker y
rechazos por bulkhead.

Reglas:
- **La clave incluye el scope de autorización** (tenant y conjunto de capacidades). Dos personas con
  permisos distintos nunca comparten una entrada. La autorización se evalúa **antes** de leer la caché.
- Se normaliza la consulta (orden de claves, ventana de tiempo redondeada a 1 min en hot) para que
  consultas equivalentes compartan la entrada.
- Nada de texto libre ni de consultas que el navegador arme: solo las consultas allowlist del conector.
- Datos con PII (evento por `_id`) solo con TTL corto, en Valkey privado con TLS y cifrado en reposo.

## Idempotencia

Tres niveles. Postgres sigue siendo el respaldo final (revisión optimista y restricciones únicas):

| Nivel | Dónde | Cómo | Retención |
| --- | --- | --- | --- |
| **HTTP** | Mutaciones que crean cosas: `POST /api/incidents`, tareas, notas, revocar sesión, acuse de notificación y, en adelante, restaurar historia y ejecutar playbooks | Cabecera `Idempotency-Key` (UUID del cliente). `SET NX` de `idem:{actor}:{clave}` marca «en curso», guarda la respuesta y una huella del cuerpo. Un reintento con la misma clave devuelve la **misma respuesta**; con un cuerpo distinto responde `409 IDEMPOTENCY_KEY_REUSED` | 24 h |
| **Productor de cola** | `jobId` determinista | BullMQ ignora un job con el mismo `jobId` mientras exista | Mientras viva el job |
| **Consumidor** | Antes del efecto externo (Teams, push, Shuffle o restauración) | `done:{cola}:{clave}` más el estado en Postgres (outbox `SENT`). Un job reintentado después de un envío exitoso **no reenvía** | 7 d |

Las transiciones de estado (comandos con `expectedRevision`) ya son idempotentes por la concurrencia
optimista, así que no necesitan la cabecera.

### Warm y cold: restauración idempotente

`POST /api/history/restore` (capacidad `history.restore` y aprobación del Líder SOC):
- **Clave de idempotencia = hash de los índices a restaurar.** Pedir el mismo rango dos veces, aunque lo
  pidan personas distintas, devuelve el mismo trabajo o el índice `restored-*` que ya existe. No se
  restaura dos veces el mismo snapshot.
- Cola `history-restore`, con concurrencia 1, porque restaurar consume disco y CPU del Indexer. El
  estado (`queued`, `restoring`, `ready`, `expired`) queda en Postgres y se cachea para la UI.
- **Catálogo de snapshots** (`GET _snapshot/qapaq-s3/_all`, lento) cacheado 10 min, e invalidado cuando
  ISM crea un snapshot nuevo.
- **Registro de índices restaurados** con el mismo TTL de 7 días que la política `qapaq-restored-ttl`.

## Colas (BullMQ sobre Valkey)

Patrón: **outbox o lease en Postgres → job con la referencia → consumidor idempotente → reconciliador**.
La cola es transporte rápido; Postgres conserva qué falta procesar.

| Cola | Productor | Consumidor | Garantías |
| --- | --- | --- | --- |
| `notifications` (Teams y push) | La API, tras el commit que escribe el outbox | Worker | `jobId = idempotencyKey` (dedupe). Backoff exponencial de 5 s a 5 min, 5 intentos (ADR-022). Fencing token antes de enviar. El reconciliador reencola cada 60 s lo pendiente con más de 30 s |
| `ingestion` (polling de Wazuh por fuente o dataset) | Scheduler repetible con jitter | Worker, concurrencia 1 por fuente | `jobId = ingest:{source}:{ventana}`: nunca dos ejecuciones de la misma ventana. El lease con fencing en Postgres sigue siendo la autoridad |
| `directory-sync` (delta del grupo SOC en Graph) | Scheduler repetible cada 5 min | Worker, concurrencia 1 | Al terminar invalida el padrón (punto 5) y dispara las revocaciones (punto 3) |
| `history-restore` (warm/cold) | La API, tras la aprobación | Worker, concurrencia 1 | `jobId` = hash de los índices. Antes de restaurar comprueba `done:` y si ya existe `restored-*` |
| `ankay` (siguiente scope: Shuffle) | La API, tras una aprobación | Worker | Un timeout queda en `UNKNOWN`, sin reintento ciego (ADR-028) |
| `*:dlq` | Jobs que agotan sus intentos | Visible en «Salud operativa» | No se reintentan solos |

**Dónde corren:** la API **produce** y el worker (`apps/worker`, servicio ECS) **consume**. Así la API
queda libre para las personas y los picos de ingesta o de notificaciones no la saturan. Si Valkey cae, la
API vuelve a los loops en proceso actuales (degradado pero sin pérdida) y el reconciliador recupera al
volver.

## Infraestructura

- ElastiCache Valkey 8, `cache.t4g.micro` (demo), un nodo, TLS obligatorio y AUTH. El token AUTH vive en
  Secrets Manager (`qapaq-secops/demo/valkey/auth-token`) y llega a la API y al worker como secreto de ECS.
- Parameter group propio `valkey8` con `maxmemory-policy = noeviction`.
- Producción: réplica con failover automático (`num_cache_clusters = 2`).
- Señales en «Salud operativa»: hit ratio por punto, profundidad y antigüedad de cada cola, tamaño de las
  DLQ y estado de la conexión a Valkey.

## Aceptación

1. Con 2 réplicas de la API, un login cuyo callback cae en la otra réplica termina bien.
2. Revocar una sesión la saca de la consola y del dashboard en ≤ 5 s, con Valkey activo y caído.
3. Con 50 long-polls abiertos y sin cambios, Postgres no recibe consultas de `/api/changes`.
4. Al apagar Valkey, la consola sigue funcionando. Al volver, el reconciliador envía las notificaciones
   pendientes sin duplicarlas.
5. Ninguna clave de caché queda sin TTL (prueba de escaneo).
6. Repetir un `POST /api/incidents/:id/notes` con la misma `Idempotency-Key` crea una sola nota y
   devuelve la misma respuesta. Con otro cuerpo responde 409.
7. Pedir dos veces la restauración del mismo día produce un solo índice `restored-*`.
8. Dos personas con capacidades distintas que consultan lo mismo nunca comparten una entrada de la
   caché del SIEM.
