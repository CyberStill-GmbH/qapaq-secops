# ADR-026 — KrakenD on-premises como API Gateway de proveedores

- Estado: **ACCEPTED / IMPLEMENTATION GATED**
- Fecha: 2026-09-28
- Decisores: Franco Clavo, Security, Platform, Infraestructura y SOC Development
- Alcance: APIs de proveedores consumidas directamente por QAPAQ y webhooks futuros

## Contexto

QAPAQ incorporará APIs heterogéneas —por ejemplo Microsoft Graph, Cato o Sophos—
con credenciales, cuotas, timeouts y contratos distintos. Exponer cada adapter
directamente a Internet o permitir que cada uno implemente controles transversales
duplicaría configuración y dificultaría observar y revocar una integración.

Redis/BullMQ es transporte asíncrono, no registro de evidencia. Publicar la
respuesta de un proveedor directamente en la cola antes de conservar raw,
manifiesto y checkpoint permitiría pérdida no detectable, avance incorrecto del
cursor o efectos duplicados. Un gateway tampoco conoce la semántica suficiente
para decidir idempotencia, replay o cobertura de una fuente.

El MVP vigente no consume Microsoft 365 mediante Graph: Wazuh recolecta Office 365
y QAPAQ consulta Wazuh Indexer. Insertar KrakenD entre Microsoft 365 y Wazuh
cambiaría una frontera operada por Infraestructura sin necesidad demostrada.

## Decisión

Se selecciona **KrakenD Community Edition on-premises** como gateway de las APIs de
proveedores que QAPAQ consume directamente. Se desplegarán al menos dos instancias
stateless detrás de un balanceador interno, con configuración versionada, validada
y promovida como artefacto inmutable. La versión y digest exactos se fijarán en el
BOM del ambiente; no se usará `latest`.

### Flujo de polling

```text
scheduler/connector worker
  → balanceador interno → KrakenD egress → API del proveedor
  → validación del adapter → raw durable
  → transacción PostgreSQL: manifiesto + inbox + checkpoint + outbox
  → dispatcher → Redis/BullMQ con IDs/referencias pequeñas
  → consumidores idempotentes
```

El job que despierta un poller puede vivir en BullMQ; la invariante es que **la
respuesta del proveedor no se publica como trabajo downstream ni avanza el cursor
antes de la admisión durable**.

### Flujo de webhook

```text
proveedor → control perimetral/LB → KrakenD ingress → API QAPAQ
  → autenticidad/firma/replay + validación
  → la misma admisión durable → outbox → Redis/BullMQ
```

QAPAQ solo devuelve 2xx cuando el contrato del proveedor permita confirmar que la
recepción quedó durable. El gateway no convierte aceptación HTTP en promesa de
procesamiento terminado.

### Responsabilidades de KrakenD

- publicar únicamente rutas, métodos y upstreams allowlisted; nunca aceptar una URL
  de destino aportada por el request;
- TLS, autenticación técnica compatible, OAuth 2.0 Client Credentials cuando
  corresponda, headers construidos desde configuración confiable y límites de
  exposición;
- timeouts, rate limiting hacia backend y circuit breaker por ruta de proveedor;
- propagación de `traceparent`/correlation ID y telemetría técnica sin bodies,
  tokens, raw ni datos personales como labels;
- health/readiness, configuración validada y rollout con drenaje.

### Responsabilidades que permanecen en QAPAQ

- paginación, cursor, `Retry-After`, presupuesto de reintentos y cuota exacta;
- validación semántica, mapping a SecurityEvent y normalización de errores;
- raw, manifiesto, inbox/outbox, checkpoint, deduplicación, replay y gaps;
- autorización de la fuente, auditoría de negocio, cuarentena y publicación a
  BullMQ.

No se configura fan-out o agregación de varios proveedores en una misma ruta. No
se habilitan retries ocultos en el gateway: un timeout después de que el proveedor
aceptó una petición puede ser ambiguo y debe resolverse en el adapter con el
contrato/idempotency key del proveedor.

### Secretos

KrakenD no sustituye al `SecretProvider`. La API de alta write-only pertenece al
control plane de QAPAQ; el gestor custodia el valor y entrega una referencia. Para
runtime, una identidad técnica materializa la versión autorizada mediante un
archivo/volumen o variable protegida al iniciar KrakenD. El secreto no se guarda en
Git, plantilla renderizada, artefacto, log, endpoint de configuración ni Redis.

OAuth2 Client Credentials de KrakenD obtiene y renueva tokens sin revelar el
client secret al usuario. Las API keys estáticas se inyectan solo desde runtime. La
rotación usa `create → validate → rolling switch → revoke`, sin fallback tras la
revocación.

KrakenD CE aplica TLS de cliente de forma global. Si dos proveedores exigen
certificados cliente diferentes, se separan pools/configuraciones de KrakenD o se
eleva una nueva decisión; no se documenta como disponible una función por-backend
que corresponda a otra edición.

### Alta disponibilidad, cuotas y rendimiento

- mínimo dos nodos en dominios de fallo distintos y un balanceador on-premises;
- KrakenD es stateless: la caída de un nodo no pierde cursor ni evidencia;
- límites locales se calculan por réplica: el máximo agregado puede ser
  `réplicas × límite por nodo`; el adapter conserva el presupuesto autoritativo y
  margen ante la cuota del proveedor;
- `timeout_proveedor < timeout_gateway < deadline_worker`, medidos por ruta;
- conexiones persistentes y concurrencia se dimensionan con benchmark, sin cifras
  no demostradas;
- no hay cache de feeds de seguridad salvo contrato explícito y prueba de semántica
  cursor-aware;
- backpressure pausa adquisición antes de agotar almacenamiento o cuota y expone
  cobertura degradada; nunca descarta raw silenciosamente.

### Observabilidad y seguridad

KrakenD exporta métricas/trazas por OpenTelemetry o endpoint scrapeable hacia el
stack interno. Prometheus/Grafana agregan por nodo, ruta lógica, proveedor y clase
de estado; Loki recibe logs redactados. Quedan prohibidos token, API key, body,
event ID, user ID o IP completa como label.

Se observan al menos latencia, errores, throttling, timeout upstream, circuit
breaker, fallos TLS/OAuth, health y versión de configuración. Los gaps, lag y
coverage son métricas de QAPAQ, no inferencias del estado de un nodo KrakenD.

La red permite egress solo a endpoints aprobados. Se valida DNS/TLS, no se desactiva
la verificación de certificados en producción, se eliminan headers no confiables y
se protege ingress contra SSRF, request smuggling, oversized payloads y bypass del
balanceador.

## Consecuencias

### Positivas

- control on-premises y una política uniforme de exposición, cuota y telemetría;
- adapters más pequeños sin perder la semántica específica de cada proveedor;
- escalado horizontal y mantenimiento sin convertir al gateway en sistema de
  registro;
- incorporación repetible mediante ruta declarativa, secretRef, adapter y suite de
  conformidad.

### Costes y límites

- Platform opera gateway, balanceador, configuración, certificados y upgrades;
- rate limiting y circuit breaker locales no sustituyen coordinación de cuota ni
  estado de cobertura;
- usar APIs SaaS de Microsoft/Cato/Sophos sigue siendo una relación con esos
  proveedores; alojar KrakenD internamente no elimina obligaciones contractuales;
- la configuración errónea puede centralizar el impacto, por lo que requiere
  canary, rollback, tests y segregación por rutas/pools.

## Gate de implementación

La ruta no pasa a `enabled` hasta demostrar: topología HA, versión/digest, rutas y
egress allowlisted, TLS/OAuth, no revelación, timeout/circuit breaker/rate limit,
401/403/429/5xx, caída de cada nodo, rolling update, admisión durable antes de
BullMQ, replay/checkpoint, métricas/logs redactados y benchmark con headroom.

## Referencias oficiales

- [KrakenD: clustering and load balancing](https://www.krakend.io/docs/deploying/clustering/)
- [KrakenD: traffic management](https://www.krakend.io/docs/throttling/)
- [KrakenD: OAuth2 Client Credentials](https://www.krakend.io/docs/v2.3/authorization/client-credentials/)
- [KrakenD: TLS and mTLS](https://www.krakend.io/docs/service-settings/tls/)
- [KrakenD: environment variables and flexible configuration](https://www.krakend.io/docs/configuration/environment-vars/)
- [KrakenD: configuration structure and validation](https://www.krakend.io/docs/configuration/structure/)
- [KrakenD: OpenTelemetry](https://www.krakend.io/docs/telemetry/opentelemetry-by-endpoint/)
