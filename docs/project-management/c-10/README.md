# C-10 — Wazuh adapter hardening

Verificación local: 2026-09-28 · Estado: `LOCAL PASS` para el contrato/baseline; CI de este árbol de trabajo no afirmado.

## Architecture

```text
Application / Domain
        |
        v
SecurityEventProvider (C-08)
        ^
        |
WazuhSecurityEventProvider (C-10)
        |
        v
C-28 KrakenD
        |
        v
Wazuh Indexer
```

`SecurityEventProvider` continúa siendo la autoridad del contrato. C-10 no crea un
port alternativo. El único boundary de red del adapter es C-28 y sus dos rutas
allowlisted: `GET /wazuh/_cluster/health` y `POST /wazuh/_search`.

**Direct Wazuh Indexer access from modules/connectors is unsupported and prohibited.**

## Responsibilities and contract decision

C-10 construye consultas de lectura acotadas, usa `search_after`, valida la
respuesta, traduce fallos y entrega los `ProviderRecord` neutrales definidos por
C-08. C-28 aplica routing, autenticación, rate limiting, timeout y acceso al
backend. Wazuh Indexer almacena y consulta alertas.

El nombre histórico `SecurityEventProvider` no significa que el port devuelva el
contrato canónico C-05. Su firma vigente devuelve `EventPage<ProviderRecord>` con
`raw` para que el normalizador posterior produzca `SecurityEvent`, persista raw y
asigne `recordId`, `tenant`, referencia y hash de custodia. Fabricar esos campos en
C-10 violaría C-08 y ADR-011. Por ello C-10 valida estructura, ID, cursor y
timestamp del registro Wazuh, pero no afirma una normalización canónica que el port
no soporta. Esta decisión preserva compatibilidad y evita inventar datos.

## Configuration

Runtime acepta exclusivamente:

- `QAPAQ_WAZUH_GATEWAY_BASE_URL`;
- `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF`;
- dataset, límites, timeout, retry y clave de cursor ya gobernados por C-03.

Producción requiere HTTPS. HTTP solo se acepta explícitamente para loopback en
desarrollo/integración. URLs con credenciales, path, query o fragment se rechazan.
Las variables legacy de Indexer o Manager ya no forman parte del schema conocido:
si están presentes, el arranque falla como configuración controlada no válida.

El bearer token se resuelve mediante `SecretProvider`, se encapsula en
`SecretCredential` y nunca aparece en mensajes de error ni telemetría. La URL y
credencial productivas permanecen `TO_BE_PROVIDED`.

## Query, pagination and limits

La única operación de datos es `POST /wazuh/_search`. El caller aporta filtros del
port (source, dataset, rango y page size), nunca DSL. C-10 genera el DSL con rango
`timestamp`, orden determinista `timestamp` + `id`, tamaño máximo configurado y
cursor HMAC opaco con TTL y binding a todos los filtros. El adapter solicita un
registro adicional para determinar `hasMore`; no usa offsets.

Se rechazan rango mayor a 31 días, timestamps no RFC 3339, dataset/source no
permitidos, page size fuera de límite, cursor alterado/expirado/incompatible,
respuesta sobredimensionada, JSON inválido, hits incompletos y timestamps inválidos.

## Failure semantics

| Condition | Provider error | Retryable |
| --- | --- | --- |
| 400 | `PROVIDER_QUERY_REJECTED` | no |
| 401 | `PROVIDER_AUTHENTICATION_FAILED` | no |
| 403 | `PROVIDER_AUTHORIZATION_DENIED` | no |
| 429 | `PROVIDER_RATE_LIMITED` | yes, bounded policy; preserves capped `Retry-After` |
| 500 | `PROVIDER_UPSTREAM_SERVER_ERROR` | no |
| 502/503/504 | `PROVIDER_UPSTREAM_UNAVAILABLE` | yes |
| DNS/reset/refused | `PROVIDER_GATEWAY_UNAVAILABLE` | yes |
| local timeout/cancellation | `PROVIDER_TIMEOUT` | no |
| malformed/oversized response | `PROVIDER_RESPONSE_INVALID` | no |

Retries apply only to idempotent reads, are bounded by `retryLimit`, honor
`Retry-After` up to 60 seconds and otherwise use capped jitter. No error activates
a fallback.

## Observability and safe logging

El provider expone un sink de telemetría inyectable con dimensiones de baja
cardinalidad: `connector=wazuh`, `operation`, `result`, `errorClass` y duración.
Esto permite derivar request/success/failure, timeout, rate-limit, auth y upstream
failure counts sin usar event IDs, query, URL, IP o token como labels. El adapter no
registra payloads ni headers; los errores públicos usan códigos estables y mensajes
sanitizados. C-28 conserva sus métricas Prometheus de routing y backend.

## Automated enforcement and tests

`wazuh-architecture.spec.ts` es el control explícito **C-10 cannot bypass C-28**:
escanea código runtime y manifest en busca de SDK OpenSearch, configuración legacy,
puerto/host directo y Basic auth; además compara rutas/métodos usados por C-10 con
`platform/gateway/krakend/routes.json`.

La integración de C-28 levanta una red Docker donde KrakenD es el único endpoint
entregado a C-10. `c28-live-probe.ts` ejecuta health y una consulta read-only con el
adapter real; el mock Indexer está disponible por nombre de servicio solo dentro de
Compose. Esto prueba `C-10 -> C-28 -> controlled Wazuh Indexer`, además de la matriz
401/403/429/5xx/timeout/reset/recovery de C-28.

Comandos:

```powershell
pnpm exec vitest run --config vitest.config.ts modules/connectors/test
pnpm exec vitest run --config vitest.config.ts platform/configuration/test/runtime-config.spec.ts
node --test platform/gateway/krakend/test/contract.test.mjs
node platform/gateway/krakend/test/integration.mjs
pnpm run verify
```

### Resultado local verificado — 2026-09-28

Con Node `24.21.0`, pnpm `12.4.2`, Docker Desktop `29.4.3` y Docker Compose
`5.1.3`, se obtuvo:

| Validación | Resultado |
| --- | --- |
| Unit y contract suite de `modules/connectors/test` | PASS, 47/47 en 3 archivos |
| Contrato runtime de configuración C-03 usado por C-10 | PASS, 49/49 |
| Contract suite de C-28 (`contract.test.mjs`) | PASS, 6/6 |
| `validate.ps1`, incluido `krakend check` de la imagen oficial fijada por tag | PASS; `Syntax OK` |
| Runtime C-28 + probe C-10 + Indexer simulado | PASS; health y consulta read-only, matriz de errores, métricas y recuperación |

El runtime local usa un mock Indexer, JWKS efímero y red Compose aislada. Es
evidencia de compatibilidad entre el adapter y el contrato/gateway desplegado
localmente; no valida Graph/Office 365, un Manager/Indexer corporativo, secretos,
balanceador, HA ni infraestructura KrakenD real. El resumen reproducible está en
[`2026-09-28-c10-c28-contract-run.json`](assets/2026-09-28-c10-c28-contract-run.json).
La causa externa PBI-007 y su acción de desbloqueo constan en
[`PBI-007`](../pbi-007/README.md); PBI-007 permanece `BLOCKED`.

**Decisión de planificación:** al pasar los contratos locales C-10 y C-28,
pueden iniciarse C-11 (admisión durable) y C-24 (control plane write-only) dentro
del WIP acordado. El gate real Microsoft 365/Wazuh y los insumos de producción
C-28 no se consideran satisfechos por estas suites.

## Migration

| Previous behavior | New behavior | Reason |
| --- | --- | --- |
| OpenSearch SDK and direct Indexer URL | HTTP client for C-28 base URL | Enforce the network boundary |
| Indexer user/password/CA in C-10 | C-28 bearer credential only | Remove backend credentials and bypass capability |
| Direct Manager health | C-28 cluster-health route | All Wazuh network access crosses C-28 |
| Generic unavailable errors | Auth, authorization, rate, gateway and upstream typed errors | Preserve operational semantics |
| Unbounded parsed response | Bounded streamed JSON decoding | Limit memory exposure |
| Route assumptions in code | Route-to-allowlist architecture test | Break CI on C-28 incompatibility |

## Troubleshooting

- `PROVIDER_AUTHENTICATION_FAILED`: renovar/verificar identidad de workload de C-28;
  nunca usar credenciales del Indexer.
- `PROVIDER_AUTHORIZATION_DENIED`: revisar capability/RBAC en C-28/upstream.
- `PROVIDER_RATE_LIMITED`: respetar `retryAfterMs`; reducir concurrencia.
- `PROVIDER_GATEWAY_UNAVAILABLE`: revisar DNS/TLS/LB de C-28, no el Indexer desde C-10.
- `PROVIDER_RESPONSE_INVALID`: comparar el contrato de respuesta y ejecutar la
  compatibilidad C-28 antes de promover.

## Remaining production dependencies

LB interno, URL/certificado de C-28, issuer/JWKS/audience, identidad read-only,
secret provider, backend Indexer/CA y validación con infraestructura corporativa:
`TO_BE_PROVIDED`. No son necesarios para la prueba controlada ni se inventan aquí;
sí son gate de promoción productiva.
