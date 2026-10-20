# ADR-AZ-001 — Backend PostgreSQL para jobs Azure

**Estado: Proposed; pendiente de revisión de aplicación y aceptación.**
**Fecha:** 2026-10-19.
**Ámbito:** despliegue Azure únicamente. No modifica ADR-006/ADR-016 ni la cola
Redis/BullMQ que usa o pueda usar AWS.

> **Revisión de dirección 2026-10-20:** esta propuesta no está aprobada y no
> sustituye A9 de `docs/10-decisiones.md`, que fija Valkey/BullMQ como objetivo.
> Azure Managed Redis (Redis 7.4.x) queda como candidato de servicio administrado
> compatible a evaluar, no como Valkey ni como decisión de despliegue. El worker
> actual todavía no consume BullMQ; por eso no se debe provisionar un broker
> Azure hasta implementar y probar el consumidor, el manejo de `noeviction`, TLS,
> autenticación, failover y el costo en Chile Central. Esta aclaración no cambia
> la infraestructura AWS.

## Contexto

Azure requiere trabajo durable para desacoplar adaptadores de M365, Sophos y
Cato, aplicar backpressure y reintentar fallas sin perder cursores. El diseño
actual fija BullMQ 5.81.5/Redis 8.10.1. BullMQ documenta un backend PostgreSQL
en v6, pero la baseline vigente no aprobó BullMQ 6. Evitar un Redis administrado
o autogestionado reduciría servicios y costo, aunque concentra más carga en
PostgreSQL.

## Propuesta

Para el stack Azure usar BullMQ v6 `createPostgresBackend` con PostgreSQL 13+
(el Terraform fija PostgreSQL 16) y una base `qapaq_jobs` separada de
`qapaq_secops`. Aplicación y worker seleccionan el backend mediante una
configuración Azure explícita. AWS mantiene su backend/versión actual hasta una
migración independiente aprobada.

Jobs transportan IDs, cursores o referencias pequeñas; raw de proveedor se
conserva primero en Blob y PostgreSQL admission/outbox. Los workers son
idempotentes porque la entrega al menos una vez puede repetir trabajos. La cola
no contiene credenciales, contenido raw ni estado de auditoría.

## Alternativas

| Opción | Ventajas | Costos/limitaciones |
| --- | --- | --- |
| Azure Service Bus | Broker administrado, cola de mensajes fallidos y entrega durable | Servicio/costo adicional y un adapter distinto; no es drop-in BullMQ |
| Valkey autogestionado | Conserva BullMQ 5, baja latencia | VM/contenedor stateful, parches, persistencia, failover y guardias propios |
| BullMQ v6 PostgreSQL | Reutiliza PostgreSQL y API Queue/Worker; evita servicio Redis | Major nuevo, todavía no aprobado; menor throughput esperado y más carga/connexiones en DB |
| Tabla/outbox propia | Evita dependencia de BullMQ | Hay que implementar locking/leases/retries/scheduler/metrics y validar condiciones de carrera |

## Consecuencias y controles

- Separar base/schema de jobs reduce el acoplamiento lógico, pero no aísla CPU,
  IOPS ni conexiones si comparte el mismo servidor Flexible Server.
- Migraciones BullMQ se ejecutan como etapa controlada antes de desplegar API y
  workers; no ocurren durante cada arranque de réplica.
- Configurar `max_connections`, pool por proceso y límite de replicas antes de
  escalar. La conexión `LISTEN` dedicada cuenta aparte del pool.
- Backups de PostgreSQL cubren datos de la cola y SOC en su respectiva base;
  replay desde outbox/checkpoint es obligatorio ante estados inconsistentes.
- La autenticación del runtime debe quedar en Key Vault y TLS. Nunca se usa la
  cuenta bootstrap desde aplicación.

## Criterios para aceptar

1. Implementar backend selectable sin cambiar AWS; conservar default Redis en
   AWS y añadir sólo la composición Azure requerida.
2. Actualizar `bullmq` y `pg` con lockfile, SBOM, licencias y escaneo CI.
3. Superar pruebas de migración de schema, enqueue/consume, retries,
   backoff/rate-limit/delayed jobs, dedupe, worker shutdown, conexiones agotadas,
   failover/restart y reconstrucción desde outbox.
4. Benchmark reproducible con los tamaños reales de lotes y tres conectores;
   comparar Redis y PostgreSQL con 30% de margen y medir impacto en DB de la app.
5. Registrar idempotencia extremo a extremo y observabilidad (depth, lag,
   retries, stalled/failed, pool saturation); no declarar conectores operativos
   hasta una prueba sintética por proveedor.

## Evidencia

La guía oficial de BullMQ describe este backend y su factory
[`createPostgresBackend`](https://docs.bullmq.io/guide/postgresql). También
advierte medir pools/conexiones y que el backend Redis sigue siendo el default
más probado. No hay evidencia de runtime QAPAQ usando ese backend todavía; por
eso esta decisión sigue Proposed.
