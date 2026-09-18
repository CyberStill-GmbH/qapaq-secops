# Índice de Architecture Decision Records

ADR-015 y ADR-016 están Accepted por resolución explícita del usuario, con fecha
aportada 2026-09-18. ADR-015 fija alcance/ownership; ADR-016 fija toolchain, límites
y metodología de capacidad. ADR-001…014 mantienen Proposed salvo los aspectos
explícitamente sustituidos por decisiones aceptadas. Aceptación documental no
equivale a software desplegado ni benchmark aprobado.

- [ADR-001 — Modular Monolith](001-modular-monolith.md).
- [ADR-002 — NestJS + TypeScript](002-backend-stack.md).
- [ADR-003 — Hexagonal Architecture](003-hexagonal-architecture.md).
- [ADR-004 — PostgreSQL for operational data](004-postgresql-operational-data.md).
- [ADR-005 — OpenSearch/Wazuh for telemetry](005-opensearch-wazuh-telemetry.md).
- [ADR-006 — Redis/BullMQ for asynchronous jobs](006-redis-bullmq.md).
- [ADR-007 — Python workers for analytics](007-python-analytics.md).
- [ADR-008 — Hot/Warm/Cold retention](008-hot-warm-cold-retention.md).
- [ADR-009 — RBAC capability-based permissions](009-capability-rbac.md).
- [ADR-010 — Vendor integrations through adapters](010-vendor-adapters.md).
- [ADR-011 — SecurityEvent normalization strategy](011-security-event-normalization.md).
- [ADR-012 — Audit trail strategy](012-audit-trail.md).
- [ADR-013 — Secret management abstraction](013-secret-management.md).
- [ADR-014 — Event-driven internal communication strategy](014-internal-communication.md).

- [ADR-015 — Alcance operacional, módulos y ownership](015-operational-scope-and-ownership.md), Accepted.
- [ADR-016 — Baseline de toolchain, límites y medición de capacidad](016-toolchain-and-capacity-baseline.md), Accepted.

## Compatibilidad con los archivos anteriores

001-modular-monolith y 002-backend-stack conservan sus nombres. Los antiguos
003-event-storage, 004-authentication-authorization y 005-observability-strategy
eran archivos vacíos, sin decisiones aceptadas: quedan como notas de traslado.
No son ADR adicionales ni conservan la numeración semántica anterior.

La numeración nueva cumple el adjunto actual. Las skills fuera de docs/ no se
modificaron; resolver referencias antiguas por tema/título, usando este índice.
No hay ADR específico nuevo de observabilidad: su diseño propuesto vive en
[observabilidad](../architecture/observability.md); proveedor y SLO siguen pendientes.
