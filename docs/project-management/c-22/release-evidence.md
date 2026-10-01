# C-22 — Matriz de evidencia del candidato

Commit: `b7bdf11c347f2da35e0c025b8fae96a642dd64c4`
Ambiente: local-windows-node24
Generada: 2026-10-01T23:00:26.131Z
Toolchain: node 24.21.0, pnpm 12.4.2

## Decisión: LIMITED

Existe incremento usable, pero 4 gate(s) P0 impiden la promoción.

Resumen: PASS: 14 · FAIL: 0 · BLOCKED: 6 · NOT_RUN: 0

| ID | Componente | Prioridad | Estado | Requisito | Evidencia | Bloqueo · dueño · fecha |
| --- | --- | --- | --- | --- | --- | --- |
| C-16-prioritization | C-16 | P0 | ✅ PASS | Priorización con reason codes y promoción idempotente. | pnpm exec vitest run --config vitest.config.ts modules/detection/test · 3.4s | — |
| C-17-lifecycle | C-17 | P0 | ✅ PASS | Lifecycle, concurrencia y atomicidad estado/auditoría/outbox. | pnpm exec vitest run --config vitest.config.ts modules/soc/test · 3.2s | — |
| C-18-C-25-access | C-18/C-25 | P0 | ✅ PASS | OIDC, sesión única, red QAPAQ, passkey, Smart Lockout y rate limit. | pnpm exec vitest run --config vitest.config.ts modules/access/test · 3.8s | — |
| C-19-audit | C-19 | P0 | ✅ PASS | Cadena de hash, tamper/gap, archivo y reconciliación. | pnpm exec vitest run --config vitest.config.ts platform/audit/test · 3.2s | — |
| C-20-notification | C-20 | P0 | ✅ PASS | Outbox, reintento, timeout ambiguo, fallback y acuse. | pnpm exec vitest run --config vitest.config.ts modules/soar/test · 6.0s | — |
| C-18-bff-http | C-18/C-27 | P0 | ✅ PASS | Autorización, denegación y catálogo de errores sobre HTTP real. | pnpm exec vitest run --config vitest.config.ts apps/api/test · 9.1s | — |
| C-27-error-catalog | C-27 | P1 | ✅ PASS | Catálogo de errores con helpRef, acción y no enumeración. | pnpm exec vitest run --config vitest.config.ts packages/contracts/test · 4.9s | — |
| C-26-observability | C-26 | P1 | ✅ PASS | Señales SOC, dashboards versionados, hardening y retención. | pnpm exec vitest run --config vitest.config.ts platform/observability/test · 2.9s | — |
| C-23-coupling | C-23 | P1 | ✅ PASS | Acoplamiento a proveedor acotado y conformidad del adapter real. | pnpm exec vitest run --config vitest.config.ts tests/architecture · 6.6s | — |
| C-22-evidence | C-22 | P0 | ✅ PASS | Matriz de evidencia y decisión derivadas, no narradas. | pnpm exec vitest run --config vitest.config.ts platform/testing/test/release-evidence.spec.ts · 2.7s | — |
| C-28-gateway | C-28 | P1 | ✅ PASS | Cuota por réplica, failover configurado y dashboards por ruta. | node --test platform/gateway/krakend/test/contract.test.mjs platform/gateway/krakend/test/ha.test.mjs · 0.7s | — |
| C-07-boundaries | C-07 | P0 | ✅ PASS | Límites de arquitectura y entrypoints. | pnpm run boundaries · 10.4s | — |
| C-01-typecheck | C-01 | P0 | ✅ PASS | Tipado estricto en todo el workspace. | pnpm run typecheck · 28.2s | — |
| C-21-C-22-e2e | C-21/C-22 | P0 | ✅ PASS | Recorrido vertical en navegador contra backend real. | pnpm exec playwright test · 22.7s | — |
| C-10-wazuh-real | C-10 | P0 | ⛔ BLOCKED | Provider spec contra Wazuh Indexer autorizado (paginación, cursor, errores). | modules/connectors/test/c28-live-probe.ts (requiere endpoint e identidad autorizados) | Sin tenant ni identidad técnica autorizada para Wazuh. · Infraestructura · 2026-10-31 |
| C-18-entra-real | C-18 | P0 | ⛔ BLOCKED | Flujo OIDC completo contra el tenant de Microsoft Entra aprobado. | apps/api/test/bff.spec.ts cubre el flujo con emisor local; falta app registration real. | App registration, redirect URIs y claims pendientes de aprobación. · Seguridad · 2026-10-31 |
| C-20-teams-real | C-20 | P0 | ⛔ BLOCKED | Entrega real en el canal de Teams con acuse y deduplicación observada. | modules/soar/test/teams-transport.spec.ts ejercita HTTP real contra servidor local. | Teams Workflow, canal y secretRef no provisionados. · Infraestructura · 2026-10-31 |
| C-19-postgres-adapter | C-19 | P0 | ⛔ BLOCKED | AuditEvent sobre PostgreSQL con privilegios sin UPDATE/DELETE y rollback atómico. | platform/database/test/postgres-c19.integration.spec.ts (requiere Docker). | Adapter Prisma y suite de integración pendientes de ejecutar con Docker disponible. · Plataforma · 2026-10-20 |
| C-28-ha-runtime | C-28 | P1 | ⛔ BLOCKED | Failover y rolling update observados sobre el perfil HA en ejecución. | platform/gateway/krakend/compose.ha.yaml y test/ha.test.mjs validan la configuración. | Requiere Docker Engine con capacidad para tres contenedores y un LB. · Plataforma · 2026-10-20 |
| C-26-grafana-runtime | C-26 | P1 | ⛔ BLOCKED | Backup/restore de Grafana, Loki y Prometheus ejecutado y verificado. | platform/observability/test/grafana-provisioning.spec.ts valida provisioning y plan. | Stack OSS no desplegado en el ambiente de evaluación. · Plataforma · 2026-11-07 |
