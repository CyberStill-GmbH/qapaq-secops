# Operación del correlador 24/7

Este runbook aplica al servicio `correlator` del Compose PowerUser. El correlador consulta alertas por el gateway de solo lectura y publica candidatos a través de la API privada. Su lógica es determinista; Claude/Qapaqzito no decide estas puntuaciones ni ejecuta respuesta a incidentes.

## Límites y valores iniciales

- `correlator` no publica puertos. Solo comparte la red Docker `qapaq-correlator-internal` con `api` y `wazuh-gateway`; esa red es `internal`.
- Corre como UID/GID `65532`, con sistema de archivos de solo lectura, capacidades Linux retiradas, `no-new-privileges`, límites de memoria/PID/CPU y reinicio automático.
- Docker comprueba `GET /healthz`. El operador revisa además `GET /readyz`, que expresa si terminó la carga inicial y el último ciclo está vigente. La imagen es distroless (sin shell ni `wget`): la liveness la comprueba el propio binario (`qapaq-correlator healthcheck`) y `readyz`/`metrics` se leen desde el contenedor `api`, que comparte la red interna, sin publicar puertos.
- La imagen se construye desde el SHA del árbol enviado a `/opt/qapaq/src`; la versión de despliegue debe quedar ligada a ese SHA y a la salida de `docker image inspect`.
- `QAPAQ_CORRELATOR_EMIT=false` por defecto en `/opt/qapaq/config/correlator.env`. En este estado no crea alertas a partir de candidatos. La opción de auto-supresión también permanece desactivada por defecto.
- Un reinicio vuelve a ejecutar el backfill configurado en el runtime. Los datos durables y la idempotencia de las alertas pertenecen a la API/PostgreSQL; el contenedor no monta un volumen de estado local.

## Preparación de credenciales

`deploy-host.sh` llama `setup-ingestion.sh` y después `bootstrap-correlator.sh`. El helper:

1. Reutiliza el token de gateway de `/opt/qapaq/secrets/gateway.env`.
2. Crea un token de servicio una sola vez y lo guarda en `/opt/qapaq/secrets/api.env` como `QAPAQ_CORRELATOR_SERVICE_TOKEN`; el mismo valor se monta en el correlador. La API rechaza las rutas `/api/internal/correlator/*` si este token falta.
3. Crea un token de lectura local para `/v1/*` y conserva los tokens del correlador bajo `/opt/qapaq/secrets/correlator` con modo `0400`, propiedad UID/GID `65532`; no imprime sus valores. La API de hoy solo usa el token de servicio para la ingestión: el API/frontend aún no consume el modelo de lectura `/v1/*`.
4. El correlador usa `/opt/qapaq/pki/ca.pem` para validar el certificado del gateway. No desactives la validación TLS.

La opción existente `SKIP_API_BUILD=1` conserva el runtime API anterior; por eso omite también bootstrap, build y start del correlador. Usar esa opción no actualiza esta integración.

La rotación del token de servicio requiere actualizar el valor en `api.env` y volver a ejecutar el helper; después se recrean juntos `api` y `correlator`. El helper rechaza referencias externas del token para no arrancar con credenciales discordantes. No copiar secretos desde `.env` a Compose, argumentos, logs, Terraform ni este repositorio.

## Despliegue y comprobación

En el host, con el código ya sincronizado y la ingesta configurada:

```bash
cd /opt/qapaq/wazuh-docker/single-node
COMPOSE=(docker compose --env-file /opt/qapaq/secrets/compose.env \
  -f docker-compose.yml -f /opt/qapaq/src/infra/aws-poweruser/host/compose.qapaq.yaml)
sudo bash /opt/qapaq/src/infra/aws-poweruser/scripts/bootstrap-correlator.sh
sudo "${COMPOSE[@]}" build correlator
sudo "${COMPOSE[@]}" up -d --wait correlator
sudo "${COMPOSE[@]}" ps correlator
sudo "${COMPOSE[@]}" exec -T correlator /usr/local/bin/qapaq-correlator healthcheck && echo healthy
sudo "${COMPOSE[@]}" exec -T api node -e "fetch('http://correlator:8080/readyz').then(async r=>console.log(r.status,await r.text()))"
# Replay de 7 días en seco (sin emitir ni auditar), informe JSON con entidades enmascaradas:
sudo "${COMPOSE[@]}" run --rm --no-deps -e QAPAQ_CORRELATOR_BACKFILL=168h correlator replay --redact --top 15
sudo "${COMPOSE[@]}" logs --since=15m --tail=200 correlator
```

El primer estado listo puede tardar mientras procesa el backfill. `healthz` responde por liveness; que `readyz` aún no esté listo se investiga con los logs y métricas, no se interpreta como éxito. La métrica `qapaq_correlator_ready` debe ser `1`; revisar `qapaq_correlator_gateway_errors_total`, `qapaq_correlator_api_errors_total`, `qapaq_correlator_candidates_emit_errors_total` y `qapaq_correlator_ingest_lag_seconds`. Los endpoints `/metrics` y `/v1/*` solo quedan accesibles dentro de la red privada Docker. Nunca publiques el puerto 8080 en el host o el ALB.

Registrar como evidencia: SHA desplegado, `docker image inspect qapaq/correlator:local` (ID/digest), `docker compose ps`, respuesta de health/ready, métricas redactadas y ventana de logs. Excluir valores de entorno, cabeceras bearer, eventos crudos y secretos.

## Activar emisión gobernada

La emisión es un cambio operativo explícito. Antes de habilitarla:

1. Verificar `readyz`, un ciclo de consulta sin errores y que el gateway sigue con rol de lectura (búsqueda permitida y escritura rechazada).
2. Revisar el endpoint de alertas, agrupación, regla, entidades resueltas, feedback y los límites de emisión configurados. Usar solo eventos sintéticos aprobados para el entorno.
3. Confirmar que el API acepta el token de servicio y que las alertas pasan por su deduplicación, auditoría y outbox de notificación. El correlador no ejecuta acciones de respuesta.
4. Cambiar `QAPAQ_CORRELATOR_EMIT=false` a `true` en `/opt/qapaq/config/correlator.env`. Para la primera ventana, fijar `QAPAQ_CORRELATOR_EMIT_MAX_PER_HOUR=1` y observar la alerta generada, la auditoría y la entrega configurada.
5. Recrear solo el correlador y conservar la evidencia. Elevar el límite de tasa después de revisar la canary y el ruido con el responsable SOC.

```bash
sudoedit /opt/qapaq/config/correlator.env
cd /opt/qapaq/wazuh-docker/single-node
sudo docker compose --env-file /opt/qapaq/secrets/compose.env \
  -f docker-compose.yml -f /opt/qapaq/src/infra/aws-poweruser/host/compose.qapaq.yaml \
  up -d --force-recreate --wait correlator
```

La ruta de notificación usa la infraestructura ya configurada en QAPAQ. Si el outbox/canal no está sano, mantener emisión apagada. No hay auto-remediación ni aislamiento de agentes desde este servicio.

### Candidatos tardíos por acumulación de ingesta

Un candidato es "fresco" si su evidencia más reciente tiene como máximo `QAPAQ_CORRELATOR_EMIT_MAX_AGE` (6 h). Si la ingesta estuvo atrasada (cursor atascado, reinicio tras una caída), cadenas reales llegan al correlador ya viejas y antes se descartaban todas como `stale`. Ahora los candidatos **P1/P2** con evidencia de hasta `QAPAQ_CORRELATOR_EMIT_LATE_MAX_AGE` (por defecto 72 h; `0` lo desactiva; debe ser 0 o >= `EMIT_MAX_AGE`) se emiten como alertas marcadas `[Detección tardía: ...]` en el resumen, comparten el límite `EMIT_MAX_PER_HOUR` y la idempotencia/auditoría normales, y el orden de emisión es prioridad y luego puntaje (los P1 usan primero los cupos). Los P3 y todo lo más viejo siguen descartándose. La métrica `qapaq_correlator_candidates_emitted_late_total` cuenta las tardías.

## Diagnóstico y rollback

| Síntoma | Acción |
| --- | --- |
| `unhealthy` | Revisar liveness y logs; verificar API/gateway y certificados desde el contenedor. Corregir causa y recrear el correlador. |
| `readyz` devuelve fallo | Revisar último poll, backfill/cursor, salud TLS del gateway y `qapaq_correlator_gateway_errors_total` / `qapaq_correlator_api_errors_total`. No habilitar emisión hasta recuperar estado fresco. |
| `401/403` hacia la API | Confirmar que `api.env` y `service.token` contienen la misma credencial mediante comparación local sin imprimirla; comprobar que API fue recreada después del helper. |
| Emisión ruidosa o fallida | Poner `QAPAQ_CORRELATOR_EMIT=false` y recrear correlator; luego revisar feedback, deduplicación y outbox con el SOC. |
| Release regresivo | Desactivar emisión, detener solo el correlador y devolver `/opt/qapaq/src` al SHA anterior conocido; construir la imagen anterior desde ese árbol y arrancar con `EMIT=false`. No borrar PostgreSQL, auditoría ni datos de Wazuh. |

Rollback inmediato:

```bash
sudoedit /opt/qapaq/config/correlator.env   # QAPAQ_CORRELATOR_EMIT=false
cd /opt/qapaq/wazuh-docker/single-node
sudo docker compose --env-file /opt/qapaq/secrets/compose.env \
  -f docker-compose.yml -f /opt/qapaq/src/infra/aws-poweruser/host/compose.qapaq.yaml \
  up -d --force-recreate correlator
```

Si el contenedor no debe operar mientras se investiga, usar `docker compose stop correlator`; el resto del SIEM continúa en ejecución. El script de despliegue no detiene ni modifica fuentes de Wazuh por fallos de correlación.

## Límites pendientes

El servicio mantiene estado de ejecución en memoria y repite el backfill en reinicios. El límite de tasa está en memoria y vuelve a cero con un reinicio. La API expone el contrato interno del servicio; aún no se instrumenta desde el frontend una operación de start/stop, edición de parámetros o activación de emisión. No declarar el panel de Qapaqzito como plano de control del correlador hasta que exista contrato de configuración, autorización/auditoría y pruebas de concurrencia.

## Lectura para la consola y Qapaqzito

La API expone `GET /api/risk/entities?top=N`, `GET /api/risk/entities/{type}/{ref}` y `GET /api/risk/candidates`
con la sesión QAPAQ y la capacidad `alerts.read` (la ruta solo admite referencias opacas `ent_…`). La API llega al
correlador por `QAPAQ_CORRELATOR_URL=http://correlator:8080` con `QAPAQ_CORRELATOR_READ_TOKEN`; ambos los deja
`bootstrap-correlator.sh`. El edge permite el prefijo `risk`.
