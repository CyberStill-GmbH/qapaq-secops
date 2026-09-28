# QAPAQ provider gateway — C-28 System Design

| Field | Value |
| --- | --- |
| System | QAPAQ SecOps — provider API egress |
| Status | Configuration baseline implemented; production gated |
| Decision owner | Franco Clavo / Security / Platform |
| Updated | 2026-09-28 |
| Scope | KrakenD CE gateway contract for authorized provider reads |
| Related decisions | [ADR-026](../adr/026-on-premises-krakend-provider-api-gateway.md), [ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md), [ADR-025](../adr/025-security-access-observability-hardening.md) |

## Executive decision

Deploy an on-premises, stateless KrakenD Community Edition gateway as the common egress control for provider APIs that QAPAQ consumes directly. The repository delivers a versioned KrakenD 2.13.11 configuration baseline, an explicit route registry, a reproducible official config-check command, a constrained local Compose profile, a normalized-route Grafana dashboard source, and CI gating for the route contract and gateway schema check.

This does not create a provider adapter, choose a production identity provider, create a load balancer, provision certificates/secrets, or claim production high availability. These values remain `TO_BE_PROVIDED` in the source inventory. Microsoft 365 still flows through Wazuh for the MVP; QAPAQ queries the Wazuh Indexer, and it does not route Microsoft Graph behind Wazuh.

## Goals and non-goals

Goals: centralize provider API transport controls; deny routes/methods by default; authenticate service callers; constrain egress to declared backends; preserve status semantics; apply finite timeouts and bounded per-instance throttling; expose low-cardinality metrics; enable config validation and rollback.

Non-goals: data ingestion semantics, source authorization decisions, cursor/replay, durable admission, event mapping, exact provider quota, queueing, raw storage, Kubernetes/Helm/Terraform, cloud resources, user-facing ingress, or a production LB/secret manager. KrakenD must never enqueue provider response bodies into Redis/BullMQ.

## Context and trust boundaries

```text
QAPAQ connector worker (workload identity)
   │ HTTPS + signed JWT; fixed route/method
   ▼
Internal LB (not provisioned; no sticky session)
   ├───────────────┐
   ▼               ▼
KrakenD A        KrakenD B       (stateless; same release/config)
   └───────┬───────┘
           │ TLS + read-only backend identity; fixed upstream
           ▼
      Wazuh Indexer
           │ bounded response
           ▼
QAPAQ adapter → validate → raw durable → PostgreSQL transaction
                                     └→ outbox → Redis/BullMQ IDs only
```

The first delivered route slice is limited to Wazuh Indexer health and search. `routes.json` is the exposure inventory; `krakend.tmpl` is the runtime configuration. The request cannot provide a target host. The response body is returned to the adapter and becomes accepted only after the QAPAQ durable-admission contract completes. KrakenD is a transport boundary, not an evidence store.

## Request and identity contracts

Every published endpoint validates an RS256 bearer JWT against configured JWKS, issuer and audience. Missing/invalid/expired credentials fail authentication (401). `sub` is the bounded workload identity forwarded as `X-Qapaq-Workload` for the stateless token-bucket limiter. Do not trust an unvalidated caller-supplied value for that header. A valid identity without backend/domain permission receives 403; gateway does not replace domain RBAC. Do not log Authorization/JWT, request body, credentials or configuration expansion.

Backend Basic authentication is added only at the Wazuh backend boundary from `WAZUH_BASIC_AUTH_B64` supplied by a runtime secret source. This name is a runtime contract, not a tracked credential. Backend TLS verification/CA is mandatory for production; the current deployed CA reference is not known and is explicitly gated. The worker’s actual OAuth client/token renewal wiring is not present in this C-28 slice; production traffic remains disabled until the caller identity integration and refresh lifecycle are supplied and tested.

## Route and policy model

| Route ID | Method/path | Upstream operation | Caller auth | Rate key | Timeout | Data class |
| --- | --- | --- | --- | --- | --- | --- |
| `wazuh-cluster-health` | `GET /wazuh/_cluster/health` | `GET /_cluster/health` | JWT | validated workload `sub` | endpoint bounded | internal operational |
| `wazuh-search` | `POST /wazuh/_search` | `POST /<configured-alert-index-pattern>/_search` | JWT | validated workload `sub` | endpoint bounded | security event query |

The fixed index pattern is deployment configuration, not caller input. No catch-all backend, host header routing, API aggregation, arbitrary URL, wildcard endpoint, CORS origin, or provider write method is published. QAPAQ adapter validates the exact allowed index and query; it enforces semantic page/response bounds.

## Resilience and status behavior

- **401:** absent or invalid JWT; fail closed; repair caller token/JWKS/clock, do not retry blindly.
- **403:** authenticated but insufficient backend/domain privilege; preserve and alert; no auth-loop.
- **429:** per-replica token bucket keyed on authenticated workload identity. KrakenD Community counters are in-memory/local, so aggregate effective capacity scales with replicas and is not a global provider quota. Adapter owns exact quotas, backoff, jitter, Retry-After and retry budget.
- **5xx:** preserve meaningful upstream status where KrakenD permits; transport refusal/reset and circuit-open produce controlled gateway failure. Error payloads must not reveal names, paths, secrets or topology.
- **Timeout:** finite endpoint budget; KrakenD CE applies it to the full endpoint pipeline. Align client connect/request timeout beneath the configured route budget. Never retry at the gateway; safe polling retry/reconciliation stays at the adapter.
- **Unavailable backend:** fail request, open local circuit after configured threshold, leave cursor/checkpoint unchanged, alert and recover automatically after the backend resumes.
- **Unknown route/method:** no fallback; return 4xx and do not pass request to any upstream.
- **Invalid config:** checker/startup failure and unhealthy instance; rollback to last known config+image pair.

The runtime integration harness against official KrakenD 2.13.11 has verified authentication, 403, rate limiting, upstream error status, timeout, reset, route/method rejection, response-header filtering, Prometheus scraping, and backend recovery. Corporate Indexer/identity tests, two-node rollout parity, and capacity benchmarking remain pre-production gates.

## High availability and load balancing

The process keeps no session, durable cursor or shared mutable request state. Same configuration and compatible identity keys are deployed to each node. A future internal LB should use active health checks, connection draining, no affinity, bounded connection/time budgets, and remove unhealthy nodes. Readiness/liveness path and health semantics must be confirmed against the pinned image and LB implementation; no public health endpoint is exposed by the current allowlist. Loss of one gateway node should not change connector cursor semantics because those live in QAPAQ durable state.

Provider upstream balancing is not materially configured yet: production Wazuh endpoint inventory lists no backend instance addresses. If multiple hosts are later approved, validate KrakenD's round-robin behavior, TLS identity, failure/recovery and connection limits with the actual edition. No implicit retry is enabled. A circuit breaker is local to each gateway process and therefore can temporarily differ across nodes.

## Configuration, secret and certificate lifecycle

Only route/policy and non-secret defaults belong in Git. Inject JWKS URL/issuer/audience, Indexer URL/pattern, backend credential, certificates, monitoring target and release digest from approved environment/secret tooling at runtime. The provider/identity secret provider is not selected yet.

Rotation runbook: stage the new key/certificate/credential in the approved source; ensure old/new signing keys overlap in JWKS for token TTL and cache; issue a test call; roll one canary with the new config; observe 401/5xx/latency; roll remaining nodes after healthy; revoke old material after the overlap; keep prior image/config digest for rollback. Secret rotation requires a process restart/reload whose behavior must be tested for the selected secret delivery method. Never dump rendered config or environment in CI artifacts/logs.

## Observability and privacy

Prometheus scrape is isolated from client traffic. Grafana dashboard source plots request rate and p95 latency by normalized route and status classes 401/403/429/5xx. Confirm exact metric/label names from the official exporter at integration time before alerting. Do not label by IP, user/email, token, request/event identifier, query string, or full URL. Loki receives operational stdout through the existing internal telemetry path; bodies/auth headers/config secrets remain excluded. Observability destination and retention are still operational inputs, not deployed resources.

## Verification and rollout gates

Local, non-production checks:

```powershell
node --test platform/gateway/krakend/test/contract.test.mjs
pwsh -NoProfile -File platform/gateway/krakend/validate.ps1
```

The CI job additionally validates Compose and runs the KrakenD 2.13.11 checker using its embedded schema and Gin route tests (`krakend check -t -n -c <config>`), then executes the HTTP failure harness. Before enabling traffic, still test two-node parity/config rollout and run repeatable healthy/concurrency/slow/error/rate-limit benchmarks. Record measured throughput, p50/p95/p99 and error rate against allocated CPU/memory; do not infer SLO from synthetic localhost numbers.

Two loopback/mock trials (4 workers, 2 seconds) returned only 200s with 0% errors: 584 requests (292 req/s, p50 5.60 ms, p95 61.23 ms, p99 181.22 ms) and 160 requests (80 req/s, p50 5.80 ms, p95 166.62 ms, p99 431.24 ms). The spread reinforces that this is a functional smoke measurement, not production capacity or an SLO.

## Decision record and remaining inputs

The architecture selection is on-premises KrakenD Community Edition, independent from externally supplied LB and secret services. It supports QAPAQ’s aim to operate the SOC telemetry and logs under its own control (Grafana OSS/Loki/Prometheus per ADR-025), not a claim that the regulator mandates KrakenD or this monitoring stack.

Production inventory gates: image digest and approved mirror; LB/DNS/certificate; workload identity issuer/JWKS/audience and token renewal; backend Indexer URL/CA/read-only credential; Prometheus scrape reachability and Grafana provisioning destination; maximum replica count and aggregate rate/timeout budgets. These remain `TO_BE_PROVIDED` in [source-inventory.yaml](../integrations/source-inventory.yaml).

## References

- [KrakenD 2.13.11 configuration checker](https://www.krakend.io/docs/configuration/check/)
- [KrakenD Flexible Configuration](https://www.krakend.io/docs/configuration/flexible-config/)
- [KrakenD JWT validation](https://www.krakend.io/docs/authorization/jwt-validation/)
- [KrakenD Martian request/response header modifiers](https://www.krakend.io/docs/backends/martian/)
- [KrakenD router rate limiting](https://www.krakend.io/docs/endpoints/rate-limit/)
- [KrakenD load balancing](https://www.krakend.io/docs/throttling/load-balancing/)
- [C-28 implementation runbook](../../platform/gateway/krakend/README.md)
