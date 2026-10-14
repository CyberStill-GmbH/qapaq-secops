# Telemetry

`@qapaq/telemetry` owns the C-11 durable-admission orchestration. It consumes the
public C-10 `ProviderRecord` contract, stores canonical raw JSON through a
durable object-store port, verifies SHA-256, and delegates the PostgreSQL
manifest/inbox/outbox/checkpoint transaction to C-04 through
`AdmissionRepository`. It does not import provider-specific DTOs, Prisma, app
workers, or queue clients.

Delivery is at-least-once. The exact prepared admission must be retried using the
same `manifestId`, `manifestKey`, `receivedAt`, page, and checkpoint revision.
Only C-04's committed receipt represents durable admission. Unreferenced raw
objects may remain after an interrupted cross-store operation; this module never
deletes them. Reconciliation, retention/GC, outbox dispatch, production worker
composition, and Prometheus instrumentation remain later delivery work.

See [docs/05-datos-y-retencion.md](../../docs/05-datos-y-retencion.md) (C-11 history in git `050f9fa`).
