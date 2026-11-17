-- Bound in-flight P2 quota reservations and distinguish them from accepted deliveries.
BEGIN;

ALTER TABLE "notification_p2_rate_reservations"
    ADD COLUMN "lease_until" TIMESTAMPTZ(3),
    ADD COLUMN "confirmed_at" TIMESTAMPTZ(3);

-- Existing rows were counted as consumed quota. Preserve that behavior for the remainder
-- of their original one-hour window while new rows use a short in-flight lease.
UPDATE "notification_p2_rate_reservations"
   SET "lease_until" = "reserved_at" + INTERVAL '2 minutes',
       "confirmed_at" = "reserved_at";

ALTER TABLE "notification_p2_rate_reservations"
    ALTER COLUMN "lease_until" SET NOT NULL;

CREATE INDEX "notification_p2_rate_reservations_lease_idx"
    ON "notification_p2_rate_reservations" ("tenant_id", "lease_until")
    WHERE "confirmed_at" IS NULL;

COMMIT;
