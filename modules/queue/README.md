# Adaptadores BullMQ para el outbox de notificaciones

Esta carpeta implementa el transporte BullMQ 5 para referencias de outbox: publicación con `jobId` determinista, consumidor explícito, reintentos exponenciales, cola terminal de DLQ, cierre gradual y callbacks de métricas. El payload persistido es exactamente `{ schemaVersion, outboxId }`; se rechazan campos extra para impedir que eventos, PII o credenciales entren a Redis.

## Contrato de uso

- El productor solo debe ejecutarse después del commit que creó el outbox. Repetir el enqueue usa el mismo `jobId`.
- El handler del consumidor debe volver a leer y reclamar el mensaje por `outboxId` en la persistencia durable, aplicar lease/fencing, usar la clave de idempotencia del outbox antes del efecto y marcar el resultado en la misma fuente de verdad. Nunca debe deducir que un mensaje terminó solo porque BullMQ terminó un job.
- Errores del handler se guardan en BullMQ como códigos acotados; el texto del proveedor no se registra ni se copia a la DLQ. La DLQ contiene solo la referencia.
- El caller debe pasar opciones Redis privadas con TLS y AUTH/identidad, mantener `maxmemory-policy=noeviction`, y reportar profundidad/errores mediante `QueueMetricsSink`. El módulo no obtiene secretos ni crea conexiones desde el entorno.

## Límite actual de integración

Los adaptadores no están conectados al composition root de `apps/api` ni al proceso principal de `apps/worker`. El despacho existente sigue reclamando el outbox directamente desde la API. `SocPersistence` expone claim por lote con fencing, pero no claim por `outboxId`; antes de activar este consumidor se necesita que el owner del runtime defina esa transición sin perder el lease ni duplicar el efecto. Tampoco existe aún un handler de notificaciones en el worker que comparta la persistencia y transportes actuales.

Por eso, el test real de Redis valida transporte, deduplicación, consumo, retry, DLQ y graceful drain, pero **no acredita entrega Teams/push ni recuperación extremo a extremo**. No activar la cola en AWS/Azure por este paquete. EUS2 no tiene broker ni runtime de queue configurados; el backend PostgreSQL de BullMQ v6 continúa fuera de alcance y no se usa.
