-- Serialize notification quiet windows by tenant and group across API replicas.
BEGIN;

CREATE TABLE "notification_group_dispatch_reservations" (
    "tenant_id" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "fencing_token" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "quiet_until" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "notification_group_dispatch_reservations_pkey"
        PRIMARY KEY ("tenant_id", "group_key"),
    CONSTRAINT "notification_group_dispatch_reservations_state_check"
        CHECK ("state" IN ('leased', 'uncertain', 'confirmed'))
);

CREATE INDEX "notification_group_dispatch_reservations_lease_idx"
    ON "notification_group_dispatch_reservations" ("tenant_id", "lease_until");

COMMIT;
