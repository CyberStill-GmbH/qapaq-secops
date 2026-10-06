# C-28 — KrakenD provider gateway

Estado de entrega: **configuración y validación local implementadas; producción bloqueada por insumos operativos**. La decisión de producto sigue [ADR-026](../../../docs/adr/026-on-premises-krakend-provider-api-gateway.md). Este paquete no crea ni despliega infraestructura.

## Límites y flujo

```text
QAPAQ connector worker
  → LB interno (pendiente) → KrakenD CE 3.0.0 (réplicas stateless)
  → Wazuh Indexer read-only (URL/TLS/identidad pendientes)
  → adapter valida y admite durablemente → PostgreSQL/outbox → Redis/BullMQ
```

El inventario C-28 `routes.json` conserva exactamente sus dos rutas de lectura: `GET /wazuh/_cluster/health` y `POST /wazuh/_search`. La ruta de búsqueda fija el patrón del índice mediante configuración confiable; el cliente no puede elegir upstream ni índice. Para Fase 4 se añade por separado `application-routes.json`, un allowlist de 16 rutas del BFF QAPAQ hacia el API privado. El test comprueba las dos superficies por separado para evitar cambiar el contrato C-28 sin detectarlo. No se publican APIs entrantes de proveedores, Graph/M365, Cato ni Sophos. Microsoft 365 continúa llegando a QAPAQ a través de Wazuh conforme a ADR-024.

## Versiones, rutas y controles

- Imagen oficial de ejecución fijada al índice multi-arquitectura `krakend:3.0.0@sha256:e93eed25554145dc4f2727d203e96c655bd2e609459f05e13afcbf590582496f`. Trivy 0.74.0 reporta cero vulnerabilidades HIGH/CRITICAL (2026-10-02). El template usa formato de configuración 4, requerido por KrakenD 3.x.
- `routes.json` es la allowlist contractual. `krakend.tmpl` es configuración Flexible Config renderizada por KrakenD; no se genera configuración efectiva con un parser local casero.
- JWT RS256, issuer, audience y JWKS son configuración obligatoria, hoy `TO_BE_PROVIDED`. La ausencia o invalidez de credencial se modela como 401. La autorización de dominio queda en QAPAQ/Indexer y sus permisos read-only; una denegación autenticada upstream conserva 403, sin remapear todos los errores a 401.
- El access log de KrakenD está apagado en el router para que los callbacks OIDC no dejen el código de autorización y `state` en stdout. La telemetría de métricas permanece activa; Nginx ya tenía `access_log off`.
- El límite de Community Edition configurado es por identidad de workload y por réplica; no es cuota global sincronizada. Control exacto de cuota y `Retry-After` semántico quedan en el adapter. Dimensionar cada límite respecto del número máximo de réplicas es gate de release.
- Timeout integral por endpoint: 4 s en el perfil local y configurable; no se ofrece un falso timeout backend independiente porque KrakenD CE aplica aquí el límite de tiempo de la tubería/endpoint. El timeout de conexión y los valores del SDK se alinean en el perfil productivo antes de habilitar tráfico.
- Circuit breaker acota fallos consecutivos de backend. No hay retries automáticos en KrakenD: la política de retries segura y el presupuesto pertenecen al adapter.
- CORS no habilita origins. El gateway no acepta URL upstream del cliente; solo permite `Content-Type`, `X-Request-Id` y contexto W3C seleccionado. Respuestas del Indexer pasan por `header.Blacklist` de Martian para eliminar `X-Internal-Topology`, `Server` y `X-Powered-By`. No se admite query string como label de telemetría.
- Las rutas de aplicación usan `no-op`, un único upstream API Cloud Map fijado por `QAPAQ_API_UPSTREAM`, y allowlists explícitas de headers/query strings. Reenvían `Cookie`, `Origin` y `X-Csrf-Token` para que el BFF conserve sesión, CSRF, redirects y cookies. No se configura CORS: producción debe usar el rewrite same-origin del proyecto Vercel. El inventario no contiene `/api/ingest/security-events`, rutas locales de login ni comodines.
- Filesystem de solo lectura, capabilities retiradas excepto `SETUID`/`SETGID` que requiere el entrypoint oficial para bajar privilegios, `no-new-privileges`, puertos ligados a loopback para ejecución local.

La autenticación Basic hacia Wazuh se añade al backend desde `WAZUH_BASIC_AUTH_B64`, suministrado por un origen secreto de runtime; el nombre es un contrato, no un valor para Git. La verificación TLS de backend conserva el pool de CA del sistema; el proveedor puede montar un bundle PEM aprobado y pasar su ruta por `WAZUH_INDEXER_CA_FILE`. `WAZUH_INDEXER_URL` debe ser HTTPS en producción; el backend HTTP solo existe en el perfil efímero de pruebas. La referencia real de CA sigue `TO_BE_PROVIDED`. El token OAuth del worker y su renovación no están cableados en esta rama: no hay tráfico productivo hasta materializar y probar esa identidad.

La configuración ejecutable recibe su perfil por variables requeridas en `compose.yaml`. No interpolar secretos desde `.env` versionado. `.env.example` contiene solo valores sintéticos `.invalid` para explicar el contrato; no se usa para una conexión real.

## Configuración y validación local

Requisitos: Docker Engine/Compose y Node.js 24.21.0 conforme al `.nvmrc`.

```powershell
node --test platform/gateway/krakend/test/contract.test.mjs
pwsh -NoProfile -File platform/gateway/krakend/validate.ps1
node platform/gateway/krakend/test/integration.mjs
```

`validate.ps1` comprueba allowlist/contrato, `docker compose config` y usa el checker del contenedor oficial fijado con `krakend check -t -n -c <config>` (schema local y pruebas de rutas embebidas). No se define `FC_OUT` en runtime: no se escriben configuraciones renderizadas que contengan valores secretos a disco. La startup usa Flexible Config desde el template montado como solo lectura.

La prueba de integración levanta un mock Indexer efímero y un JWKS RSA generado en memoria; valida 401, 403, 429, 5xx, timeout, reset, 404/método, filtro de header, scrape Prometheus y recovery. En esta prueba aislada, el harness activa `OIDC_DISABLE_JWK_SECURITY=true` porque el JWKS sintético usa HTTP dentro de la red local de test; `.env.example` y el perfil de validación conservan `false`, y producción exige HTTPS. Detiene solo los servicios de su proyecto Compose al finalizar. Requiere Docker Engine sano; no usa cuentas ni endpoints productivos.

No apuntar la ejecución local a producción. El ejemplo usa `.invalid`; para pruebas de runtime deben usarse fixtures efímeros y credenciales desechables.

## Códigos y degradación esperada

| Condición                                                         | Contrato exterior                                                                                 | Acción operativa                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Bearer ausente, inválido, expirado o issuer/audience no coinciden | 401                                                                                               | no reintentar; revisar identidad/JWKS/reloj                                     |
| Token válido pero capability insuficiente / denegación Indexer    | 403                                                                                               | no reintentar; revisar RBAC y privilegio read-only                              |
| Política local de tasa superada                                   | 429                                                                                               | backoff/jitter y presupuesto en adapter; límite agregado depende de réplicas    |
| Backend devuelve 500/502/503/504                                  | status upstream controlado cuando KrakenD lo conserva; errores de transporte producen 5xx gateway | circuit breaker/alarma; no retry oculto                                         |
| Conexión rechazada/reset                                          | 5xx controlado                                                                                    | comprobar red, servicio y CA; recuperar automáticamente al normalizarse backend |
| Timeout                                                           | 504/5xx según capa que expire primero; body no debe filtrar topología                             | reducir concurrencia; verificar latencia y budgets alineados                    |
| Ruta/método no registrado                                         | 404/4xx                                                                                           | revisar release allowlist; no fallback a rutas internas                         |
| Template/config inválida                                          | contenedor no saludable/no inicia; gate CI falla                                                  | rollback a digest+config anterior                                               |
| JWKS/IdP no disponible                                            | fallo cerrado: autenticación no se degrada a anónima                                              | restaurar origen JWKS; monitorear 401/5xx de validación                         |

La integración de la imagen oficial 2.13.11 comprobó los status upstream 429/500/502/503/504, timeout, reset, 404/método y recuperación contra mocks locales. Falta validar la misma matriz con el Indexer y la identidad corporativos autorizados antes de producción.

## HA, balanceo y cambio de configuración

KrakenD no guarda sesión ni checkpoint. Cada instancia toma decisiones locales; el límite de tasa también es local y el circuito puede divergir entre réplicas. El diseño objetivo exige al menos dos réplicas iguales detrás de un LB interno con health check, conexión drenada antes de terminación y sin sticky sessions. El LB, health endpoint corporativo, certificados, política de health, número máximo de réplicas y red siguen `TO_BE_PROVIDED` en `source-inventory.yaml`; por tanto, esto aún no demuestra HA de producción.

Cuando un backend tenga varios hosts, KrakenD balancea solicitudes entre los hosts configurados; mantener lista, confianza TLS, health/egress y recuperación corresponde al despliegue aprobado. Esta primera configuración usa un backend lógico único y no inventa replicas. No activa retry en gateway para evitar duplicación/cascada. El adapter conserva cursor y solo avanza tras admisión durable.

Rollout: versionar config + digest; ejecutar validación/checks; promover una instancia canary; revisar salud y métricas; drenar y reemplazar la restante; rollback reinstala el par previo config/digest. La rotación de JWKS depende de solapamiento de signing keys en IdP; CA/certificado y credencial Basic backend cambian en el SecretProvider y requieren el reload/restart validado para la imagen fijada. No hay proveedor de secretos materializado. `WAZUH_BASIC_AUTH_B64` es una variable de runtime write-only, nunca argumento de línea de comandos, log, evidencia ni archivo renderizado.

## Observabilidad

Se exportan métricas Prometheus de KrakenD con `service_name=qapaq-provider-gateway` y scrape dedicado al puerto 9091. El endpoint de métricas se debe restringir a red de monitoreo; no se publica al LB cliente. Los dashboards fuente viven en `platform/observability/grafana/dashboards/krakend-overview.json`; las series deben verificarse contra el exporter efectivo antes de asociar alertas productivas. No etiquetar IPs arbitrarias, tokens, usernames, IDs, query strings ni URLs completas.

El log de gateway se dirige a stdout para el colector de plataforma. No habilitar registro de bodies, headers de autorización, query string o configuración renderizada; el collector y destino Loki requieren política de retención/ACL y no están provisionados en este repo.

## Benchmark

`benchmark.mjs` ejecuta carga HTTP reproducible contra un gateway y reporta throughput, p50/p95/p99, error rate y conteos de status. Se requiere endpoint/identidad de prueba; la ejecución no es válida contra producción. Los valores son métricas observadas, no SLO. `BENCHMARK_SCENARIO` permite `healthy`, `slow`, `error` o `rate-limit`; `--concurrency` permite repetir perfiles de concurrencia. Las entradas `slow`/`error` requieren el mock indexer del harness. Por ejemplo, desde PowerShell con el harness activo:

Muestras locales del 2026-09-28 con 4 workers, 2 s y respuestas 200 sin errores: 584 solicitudes (292 req/s; p50 5.60 ms, p95 61.23 ms, p99 181.22 ms), 160 (80 req/s; p50 5.80 ms, p95 166.62 ms, p99 431.24 ms) y 1,540 (770 req/s; p50 4.51 ms, p95 8.36 ms, p99 16.67 ms). La variación confirma que son pruebas loopback con mocks y de corta duración, no una prueba de capacidad ni fundamento de SLO: no representan TLS corporativo, LB, Indexer real, contención del host, límites de CPU/memoria o concurrencia productiva.

```powershell
$env:BENCHMARK_URL = 'http://127.0.0.1:18080/wazuh/_search'
$env:BENCHMARK_BEARER_TOKEN = '<token efímero de prueba>'
$env:BENCHMARK_METHOD = 'POST'
$env:BENCHMARK_SCENARIO = 'healthy'
node platform/gateway/krakend/benchmark.mjs --confirm-nonprod=true --concurrency=8 --duration-seconds=10
```

La corrida runtime satisfactoria del 2026-09-28 está incluida en el [registro de evidencia C-10/C-28](../../../docs/project-management/c-10/assets/2026-09-28-c10-c28-contract-run.json). Docker Desktop estaba disponible para esa ejecución. Este resultado cubre solo el gateway oficial en contenedor con mock Indexer y JWKS de prueba; no habilita producción ni aceptación con proveedores reales.

## Pendientes de producción (`TO_BE_PROVIDED`)

Ver el bloque `provider_gateway` del [inventario de fuentes](../../../docs/integrations/source-inventory.yaml): digest/mirror, balanceador, secret provider, TLS, issuer/JWKS/audience, URL/CA de Indexer, scrape Prometheus y destino de provisioning Grafana. Además, el owner de identidad deberá confirmar claim de workload, permisos mínimos y rotación. No promover a `enabled` hasta cerrar esos puntos y ejecutar integración con Indexer real autorizado.
