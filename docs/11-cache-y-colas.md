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
optimista), la cadena de auditoría, búsquedas en el Indexer (consultas variables con datos sensibles) y
cualquier PII fuera del snapshot de sesión.

## Colas (BullMQ sobre Valkey)

Patrón: **outbox o lease en Postgres → job con la referencia → consumidor idempotente → reconciliador**.
La cola es transporte rápido; Postgres conserva qué falta procesar.

| Cola | Productor | Consumidor | Garantías |
| --- | --- | --- | --- |
| `notifications` (Teams y push) | La API, tras el commit que escribe el outbox | Worker | `jobId = idempotencyKey` (dedupe). Backoff exponencial de 5 s a 5 min, 5 intentos (ADR-022). Fencing token antes de enviar. El reconciliador reencola cada 60 s lo pendiente con más de 30 s |
| `ingestion` (polling de Wazuh por fuente o dataset) | Scheduler repetible con jitter | Worker, concurrencia 1 por fuente | `jobId = ingest:{source}:{ventana}`: nunca dos ejecuciones de la misma ventana. El lease con fencing en Postgres sigue siendo la autoridad |
| `directory-sync` (delta del grupo SOC en Graph) | Scheduler repetible cada 5 min | Worker, concurrencia 1 | Al terminar invalida el padrón (punto 5) y dispara las revocaciones (punto 3) |
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
