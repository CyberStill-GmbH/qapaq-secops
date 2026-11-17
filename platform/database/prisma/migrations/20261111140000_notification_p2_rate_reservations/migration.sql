-- Atomic rolling-window reservations keep the P2 immediate quota consistent across API replicas.
BEGIN;

CREATE TABLE "notification_p2_rate_reservations" (
    "tenant_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "notification_p2_rate_reservations_pkey"
        PRIMARY KEY ("tenant_id", "idempotency_key")
);

CREATE INDEX "notification_p2_rate_reservations_window_idx"
    ON "notification_p2_rate_reservations" ("tenant_id", "reserved_at");

COMMIT;
